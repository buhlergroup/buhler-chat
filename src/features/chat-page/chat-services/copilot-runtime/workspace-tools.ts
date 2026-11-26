/**
 * `rg` / `grep` / `glob` for the agent workspace, served from the Blob
 * session filesystem, with the SAME interface as the runtime's built-ins.
 *
 * Why: the runtime's own glob / grep / rg run ripgrep on the host disk in the
 * session's working directory and bypass the sessionFs provider (measured: the
 * built-in glob listed a file that existed only on the host disk and missed
 * the file that existed only in the provider). These replacements only see the
 * thread's own Blob namespace.
 *
 * Interface: names, descriptions and JSON schemas are the runtime's own
 * (builtin-search-tools.json, captured from runtime 1.0.116 with
 * session.rpc.tools.getCurrentMetadata()). GPT models get `rg` + `glob`,
 * Claude models `grep` + `glob`, as the runtime does. Output follows ripgrep:
 * `path`, `path:text`, `path:N:text`, context `path-N-text` with `--` between
 * groups, `path:count`; "No matches found." / "No files matched the pattern.".
 *
 * Blob cost per call: ONE flat listing with metadata under the longest literal
 * prefix of path + glob (no per-file stat), read page by page and no further
 * than the limits need. Contents are streamed, DOWNLOAD_PARALLELISM files
 * open at a time, and searched line by line as the bytes arrive.
 *
 * Memory per call is bounded and nothing stays after it: no content cache.
 * Held at any time: the current line (at most MAX_LINE_BYTES; longer lines are
 * truncated, their rest skipped), the -B context lines, the first 8 KB of a
 * file until the binary check, the stream buffers of the open downloads, and
 * the output (MAX_OUTPUT_LINES / MAX_OUTPUT_CHARS). A download stops as soon
 * as the file or the call has what it needs (files_with_matches: the first
 * match; head_limit; output full; binary file), and the whole call stops at
 * MAX_SCAN_BYTES read or SEARCH_TIME_BUDGET_MS. Only `multiline: true` needs a
 * whole file: files up to MAX_MULTILINE_FILE_BYTES, larger ones are skipped
 * with a note.
 *
 * Regex engine: RE2 (the `re2` package), not the JavaScript engine. The
 * pattern comes from the model, and a backtracking engine runs a pattern like
 * `(a+)+$` for hours on a short line while it blocks the Node event loop
 * (every request of the process and the thread-lease timers). RE2 runs in
 * linear time in the input. Its syntax is close to ripgrep's default (Rust)
 * engine, also linear-time:
 *   - no look-around ((?=, (?!, (?<=, (?<!) and no backreferences (\1, \k<n>):
 *     an error that says so;
 *   - inline flags (?i) (?s) (?m) (?U) work anywhere, also as (?i:...);
 *     (?x) does not;
 *   - repetition counts up to 1000, patterns up to MAX_PATTERN_CHARS.
 * Also bounded: glob size (GLOB_LIMITS) and the wall time of one search
 * (SEARCH_TIME_BUDGET_MS, results so far plus a note), and the search yields
 * to the event loop between files and every MB within a file.
 *
 * `re2` is a native addon and loads only when a search runs (loadRe2). When
 * it cannot load (for example a build for another Node.js version), only the
 * search calls fail, with SEARCH_UNAVAILABLE_TEXT; the module itself, the
 * turn and the other tools are not affected.
 */
import type { Readable } from "node:stream";
import type RE2 from "re2";
import type { Tool as CopilotTool, ToolResultObject } from "@microsoft/copilot-sdk";
import { logError } from "@/features/common/services/logger";
import builtin from "./builtin-search-tools.json";
import { spillLargeResult } from "./tool-adapter";
import { normalizeSessionPath, WORKSPACE_ROOT } from "./session-path";
import type { WorkspaceEntry } from "./blob-session-fs";
import { BINARY_SNIFF_BYTES, LineSplitter, readAtMost, scanLines } from "./stream-lines";
import { workspaceToolErrorText } from "./tool-error-text";

/** What the tools need from the filesystem (BlobSessionFs implements it). */
export interface WorkspaceFiles {
  /** One flat listing with metadata, page by page in name order. */
  listEntryPages(dir: string, literalPrefix?: string): AsyncIterable<WorkspaceEntry[]>;
  /** Streams a listed file; destroying the stream (or aborting `signal`) stops the download. */
  openEntry(entry: WorkspaceEntry, signal?: AbortSignal): Promise<Readable>;
}

export type SearchToolFamily = "gpt" | "claude";
export type SearchToolName = "rg" | "grep" | "glob";

/** Tool names per model family, as the runtime offers them. */
export const SEARCH_TOOLS_BY_FAMILY: Record<SearchToolFamily, readonly SearchToolName[]> = {
  gpt: builtin.toolsByModelFamily.gpt as SearchToolName[],
  claude: builtin.toolsByModelFamily.claude as SearchToolName[],
};
export const ALL_SEARCH_TOOL_NAMES: readonly SearchToolName[] = ["rg", "grep", "glob"];

/** Downloads open at a time per search call (the file in work plus the next ones). */
export const DOWNLOAD_PARALLELISM = 4;
/** Bytes one search call reads at most; then the results so far plus a note. */
export const MAX_SCAN_BYTES = 256 * 1024 * 1024;
/** Biggest file `multiline: true` reads (it needs the whole file); larger ones are skipped with a note. */
export const MAX_MULTILINE_FILE_BYTES = 1024 * 1024;
/** Output lines and characters of one call. */
export const MAX_OUTPUT_LINES = 2000;
export const MAX_OUTPUT_CHARS = 1024 * 1024;
/** Characters of -B context held at most (beyond it the oldest context lines are dropped). */
const MAX_BEFORE_CONTEXT_CHARS = 1024 * 1024;
const MAX_GLOB_RESULTS = 1000;

/** Longest regex pattern a search accepts (model input). */
export const MAX_PATTERN_CHARS = 1000;
/** Size limits of a glob (model input): length, `{...}` groups, nesting, alternatives, `[...]` classes. */
export const GLOB_LIMITS = {
  maxChars: 1000,
  maxBraceGroups: 16,
  maxBraceDepth: 3,
  maxAlternatives: 64,
  maxClasses: 16,
} as const;
/** Wall-time budget of one search call; after it the results so far are returned with a note. */
export const SEARCH_TIME_BUDGET_MS = 20_000;

// ── regex engine (loaded on first use) ─────────────────────────────────────

/** The RE2 constructor of the `re2` package. */
export type Re2Constructor = typeof RE2;

/** What the model and the chat get when the regex engine cannot load on this server. */
export const SEARCH_UNAVAILABLE_TEXT = "Error: search is not available on this server right now.";
/** After a failed load, the next search tries again no earlier than this. */
export const RE2_RETRY_MS = 60_000;

let re2Engine: Re2Constructor | undefined;
let re2Loading: Promise<Re2Constructor | undefined> | undefined;
let re2FailedAt: number | undefined;
let re2FailureLogged = false;

/**
 * Loads the `re2` native addon on first use and keeps the constructor.
 * Resolves undefined when it cannot load: logged once, tried again after
 * RE2_RETRY_MS. Never rejects.
 */
export function loadRe2(): Promise<Re2Constructor | undefined> {
  if (re2Engine) return Promise.resolve(re2Engine);
  if (re2FailedAt !== undefined && Date.now() - re2FailedAt < RE2_RETRY_MS) return Promise.resolve(undefined);
  re2Loading ??= import("re2")
    .then((mod) => {
      const ctor = ((mod as { default?: Re2Constructor }).default ?? mod) as Re2Constructor;
      if (typeof ctor !== "function") throw new Error("the re2 module has no constructor");
      re2Engine = ctor;
      re2FailedAt = undefined;
      return ctor;
    })
    .catch((err: unknown) => {
      re2FailedAt = Date.now();
      if (!re2FailureLogged) {
        re2FailureLogged = true;
        logError("copilot-runtime: regex engine re2 could not load; workspace search is off", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return undefined;
    })
    .finally(() => {
      re2Loading = undefined;
    });
  return re2Loading;
}

// ── glob matching ──────────────────────────────────────────────────────────

/** A glob over the limits in GLOB_LIMITS, or one the engine cannot compile. */
export class GlobPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobPatternError";
  }
}

function checkGlobLimits(glob: string): void {
  if (glob.length > GLOB_LIMITS.maxChars) {
    throw new GlobPatternError(`glob is longer than ${GLOB_LIMITS.maxChars} characters`);
  }
  let groups = 0;
  let depth = 0;
  let alternatives = 0;
  let classes = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "{") {
      groups++;
      depth++;
      if (depth > GLOB_LIMITS.maxBraceDepth) {
        throw new GlobPatternError(`glob nests {...} deeper than ${GLOB_LIMITS.maxBraceDepth} levels`);
      }
    } else if (c === "}" && depth > 0) depth--;
    else if (c === "," && depth > 0) alternatives++;
    else if (c === "[") classes++;
  }
  if (groups > GLOB_LIMITS.maxBraceGroups) {
    throw new GlobPatternError(`glob has more than ${GLOB_LIMITS.maxBraceGroups} {...} groups`);
  }
  if (alternatives > GLOB_LIMITS.maxAlternatives) {
    throw new GlobPatternError(`glob has more than ${GLOB_LIMITS.maxAlternatives} {a,b} alternatives`);
  }
  if (classes > GLOB_LIMITS.maxClasses) {
    throw new GlobPatternError(`glob has more than ${GLOB_LIMITS.maxClasses} [...] classes`);
  }
}

/**
 * Converts a glob (`**`, `*`, `?`, `{a,b}`, `[abc]`, `[!abc]`) to an anchored
 * RE2 regex. Throws GlobPatternError over GLOB_LIMITS or when it does not compile.
 */
export function globToRegExp(glob: string, RE2: Re2Constructor): RegExp {
  checkGlobLimits(glob);
  let re = "";
  let inBraces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      inBraces++;
      re += "(?:";
    } else if (c === "}" && inBraces > 0) {
      inBraces--;
      re += ")";
    } else if (c === "," && inBraces > 0) re += "|";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end > i) {
        const body = glob.slice(i + 1, end).replace(/\\/g, "\\\\").replace(/\[/g, "\\[");
        re += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = end;
      } else re += "\\[";
    } else re += c.replace(/[.+^$()|\\{}]/g, "\\$&");
  }
  try {
    return new RE2(`^${re}$`, "u");
  } catch (err) {
    throw new GlobPatternError(`invalid glob: ${(err as Error).message}`);
  }
}

/** Matcher with ripgrep semantics: a pattern without "/" matches the file name at any depth. */
export function globMatcher(pattern: string, RE2: Re2Constructor): (relPath: string) => boolean {
  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const re = globToRegExp(p, RE2);
  if (!p.includes("/")) return (rel) => re.test(rel.split("/").pop() ?? rel);
  return (rel) => re.test(rel);
}

/**
 * Longest literal start of a glob that is safe as a Blob prefix: everything
 * before the first wildcard, cut back to the last "/" when the pattern has
 * no "/" (it then matches at any depth).
 */
export function literalGlobPrefix(pattern: string | undefined): string {
  if (!pattern) return "";
  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p.includes("/")) return "";
  const first = p.search(/[*?[{]/);
  const literal = first === -1 ? p : p.slice(0, first);
  if (literal.split("/").includes("..")) return "";
  return literal;
}

// ── ripgrep file types (subset of `rg --type-list`) ─────────────────────────
const RG_TYPES: Record<string, string[]> = {
  js: ["js", "jsx", "mjs", "cjs", "vue"],
  ts: ["ts", "tsx", "cts", "mts"],
  py: ["py", "pyi"],
  rust: ["rs"],
  go: ["go"],
  java: ["java", "jsp", "properties"],
  c: ["c", "h"],
  cpp: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "h"],
  cs: ["cs", "csx"],
  json: ["json"],
  yaml: ["yaml", "yml"],
  toml: ["toml"],
  md: ["md", "markdown", "mdx"],
  markdown: ["md", "markdown", "mdx"],
  txt: ["txt"],
  csv: ["csv"],
  html: ["html", "htm"],
  css: ["css", "scss", "sass", "less"],
  sh: ["sh", "bash", "zsh"],
  sql: ["sql"],
  xml: ["xml", "xsd", "xsl"],
  ps: ["ps1", "psm1", "psd1"],
  kotlin: ["kt", "kts"],
  swift: ["swift"],
  ruby: ["rb"],
  php: ["php"],
};

function typeMatcher(type: string | undefined): ((rel: string) => boolean) | undefined | "unknown" {
  if (!type) return undefined;
  const t = type.toLowerCase() === "tsx" ? "ts" : type.toLowerCase() === "jsx" ? "js" : type.toLowerCase();
  const exts = RG_TYPES[t];
  if (!exts) return "unknown";
  return (rel) => exts.includes(rel.split(".").pop()?.toLowerCase() ?? "");
}

// ── regex ──────────────────────────────────────────────────────────────────

const REGEX_NOTE =
  "Note: patterns run on the RE2 engine (linear time, close to ripgrep's default engine). " +
  `Not supported: look-around, backreferences, (?x), repetition counts over 1000, patterns over ${MAX_PATTERN_CHARS} characters.`;

const regexError = (detail: string) => ({ error: `Error: rg: regex parse error: ${detail}\n${REGEX_NOTE}` });

/** True when the pattern has a backreference (\1-\9 or \k<name>) outside an escape. */
function hasBackreference(pattern: string): boolean {
  for (let i = 0; i < pattern.length - 1; i++) {
    if (pattern[i] !== "\\") continue;
    const next = pattern[i + 1];
    if ((next >= "1" && next <= "9") || next === "k") return true;
    i++; // skip the escaped character
  }
  return false;
}

/**
 * Builds the search regex (RE2, global), or an error text for the model.
 * The result has the RegExp interface (exec / test / lastIndex).
 */
export function buildSearchRegex(
  pattern: string,
  opts: { ignoreCase?: boolean; multiline?: boolean },
  RE2: Re2Constructor,
): RegExp | { error: string } {
  if (pattern.length > MAX_PATTERN_CHARS) {
    return regexError(`the pattern is longer than ${MAX_PATTERN_CHARS} characters.`);
  }
  let source = pattern;
  let flags = "g";
  const lead = /^\(\?([imsx]+)\)/.exec(source);
  if (lead) {
    if (lead[1].includes("x")) return regexError("verbose mode (?x) is not supported.");
    source = source.slice(lead[0].length);
    for (const f of lead[1]) if (!flags.includes(f)) flags += f;
  }
  if (opts.ignoreCase && !flags.includes("i")) flags += "i";
  if (opts.multiline && !flags.includes("m")) flags += "m";
  // The re2 package would read \1 as the octal escape \x01: refuse instead.
  if (hasBackreference(source)) return regexError("backreferences are not supported.");
  try {
    return new RE2(source, `${flags}u`);
  } catch (err) {
    return regexError((err as Error).message);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

const ok = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "success" });
const failure = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "failure", error: text });

interface SearchRoot {
  /** Normalised directory to list. */
  dir: string;
  /** How paths are shown: "." for the default (cwd), else the path the model gave. */
  display: string;
  /** Set when the model named a single file. */
  file?: string;
}

interface RootFile {
  root: SearchRoot;
  entry: WorkspaceEntry;
}

function searchRoots(paths: unknown): SearchRoot[] {
  const list = Array.isArray(paths) ? paths : typeof paths === "string" && paths.length > 0 ? [paths] : [];
  if (list.length === 0) return [{ dir: WORKSPACE_ROOT, display: "." }];
  return list.map((raw) => {
    const dir = normalizeSessionPath(String(raw));
    return { dir, display: dir };
  });
}

const relTo = (dir: string, path: string) => path.slice(dir.length + 1);
const show = (root: SearchRoot, entry: WorkspaceEntry) =>
  root.file ? entry.path : `${root.display}/${relTo(root.dir, entry.path)}`;
const relOf = ({ root, entry }: RootFile) => (root.file ? entry.path.split("/").pop()! : relTo(root.dir, entry.path));
const byPath = (a: RootFile, b: RootFile) => (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0);

/**
 * The files under one root, listing page by page (name order); a root that
 * is a file becomes that one file.
 */
async function* rootFiles(fs: WorkspaceFiles, root: SearchRoot, literalPrefix: string): AsyncGenerator<RootFile> {
  let any = false;
  for await (const page of fs.listEntryPages(root.dir, literalPrefix)) {
    for (const entry of page) {
      any = true;
      yield { root, entry };
    }
  }
  if (any || root.dir === WORKSPACE_ROOT) return;
  // Maybe a single file: list its parent narrowed to the file name.
  const slash = root.dir.lastIndexOf("/");
  const parent = root.dir.slice(0, slash);
  const name = root.dir.slice(slash + 1);
  if (!parent || !normalizeSessionPath(parent)) return;
  for await (const page of fs.listEntryPages(parent, name)) {
    const hit = page.find((e) => e.path === root.dir);
    if (hit) {
      yield { root: { ...root, file: root.dir }, entry: hit };
      return;
    }
  }
}

/**
 * Files of all roots that pass `keep`, in path order. One root streams its
 * listing (Blob lists in name order, so a search can stop listing early);
 * several roots are merged by path from their (metadata-only) listings.
 */
async function* filesInPathOrder(
  fs: WorkspaceFiles,
  roots: SearchRoot[],
  literalPrefix: string,
  keep: (file: RootFile) => boolean,
): AsyncGenerator<RootFile> {
  if (roots.length === 1) {
    for await (const file of rootFiles(fs, roots[0], literalPrefix)) if (keep(file)) yield file;
    return;
  }
  const all: RootFile[] = [];
  for (const root of roots) for await (const file of rootFiles(fs, root, literalPrefix)) if (keep(file)) all.push(file);
  yield* all.sort(byPath);
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

interface OpenedFile {
  file: RootFile;
  /** undefined: not opened (skipped by `wanted`) or gone since the listing. */
  stream: Readable | undefined;
  skipped: boolean;
}

/**
 * Opens the files in order, up to DOWNLOAD_PARALLELISM downloads ahead of
 * the consumer, and yields each with its stream. A stream that is not yet
 * consumed holds only its own small buffer (the HTTP response is paused).
 * Leaving the loop early aborts every download opened ahead. A file deleted
 * since the listing is skipped.
 */
async function* openInOrder(
  fs: WorkspaceFiles,
  files: AsyncIterable<RootFile>,
  wanted: (file: RootFile) => boolean,
): AsyncGenerator<OpenedFile> {
  type Pending = { file: RootFile; controller?: AbortController; ready: Promise<Readable | undefined> };
  const queue: Pending[] = [];
  const iterator = files[Symbol.asyncIterator]();
  let listed = false;
  const open = (file: RootFile): Pending => {
    if (!wanted(file)) return { file, ready: Promise.resolve(undefined) };
    const controller = new AbortController();
    const ready = fs.openEntry(file.entry, controller.signal).then(
      (stream) => {
        // An error before the consumer reads must not crash the process; the
        // consumer still sees it (the stream is then errored).
        stream.on("error", () => undefined);
        if (controller.signal.aborted) {
          stream.destroy();
          return undefined;
        }
        return stream;
      },
      (err: unknown) => {
        if (controller.signal.aborted || (err as { code?: string })?.code === "ENOENT") return undefined;
        throw err;
      },
    );
    ready.catch(() => undefined);
    return { file, controller, ready };
  };
  const fill = async () => {
    while (!listed && queue.length < DOWNLOAD_PARALLELISM) {
      const next = await iterator.next();
      if (next.done) listed = true;
      else queue.push(open(next.value));
    }
  };
  try {
    await fill();
    while (queue.length > 0) {
      const head = queue.shift()!;
      await fill();
      yield { file: head.file, stream: await head.ready, skipped: head.controller === undefined };
    }
  } finally {
    for (const p of queue) {
      p.controller?.abort();
      void p.ready.then((s) => s?.destroy(), () => undefined);
    }
    await iterator.return?.(undefined);
  }
}

const timeBudgetNote = (ms: number) =>
  `[The search stopped after ${Math.round(ms / 1000)} s; the results above are incomplete. Narrow paths or glob.]`;
const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

// ── rg / grep ──────────────────────────────────────────────────────────────

export interface RgArgs {
  pattern?: string;
  paths?: unknown;
  output_mode?: "content" | "files_with_matches" | "count";
  glob?: string;
  type?: string;
  "-i"?: boolean;
  "-A"?: number;
  "-B"?: number;
  "-C"?: number;
  "-n"?: boolean;
  head_limit?: number;
  multiline?: boolean;
}

/**
 * Line numbers (0-based) that a match of the global multiline regex touches
 * in a whole text, at most `maxCount` matches.
 */
function multilineMatches(text: string, re: RegExp, maxCount: number): number[] {
  const hits: number[] = [];
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const seen = new Set<number>();
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let matches = 0;
  while ((m = re.exec(text)) && matches < maxCount) {
    matches++;
    const first = lineOf(m.index);
    const last = lineOf(m.index + Math.max(m[0].length - 1, 0));
    for (let l = first; l <= last; l++) if (!seen.has(l)) seen.add(l), hits.push(l);
    if (m[0].length === 0) re.lastIndex++;
  }
  return hits.sort((a, b) => a - b);
}

export async function runRipgrep(
  fs: WorkspaceFiles,
  args: RgArgs,
  options: { timeBudgetMs?: number; maxScanBytes?: number } = {},
): Promise<ToolResultObject> {
  if (!args.pattern) return failure("Error: pattern is required");
  const RE2 = await loadRe2();
  if (!RE2) return failure(SEARCH_UNAVAILABLE_TEXT);
  const mode = args.output_mode ?? "files_with_matches";
  const re = buildSearchRegex(args.pattern, { ignoreCase: args["-i"], multiline: args.multiline }, RE2);
  if ("error" in re) return failure(re.error);
  const type = typeMatcher(args.type);
  if (type === "unknown") return failure(`Error: rg: unrecognized file type: ${args.type}`);
  const single = new RE2(re, re.flags.replace("g", ""));
  let globMatch: ((rel: string) => boolean) | undefined;
  try {
    globMatch = args.glob ? globMatcher(args.glob, RE2) : undefined;
  } catch (err) {
    return failure(`Error: rg: ${(err as Error).message}`);
  }
  const limit = typeof args.head_limit === "number" && args.head_limit > 0 ? Math.floor(args.head_limit) : undefined;

  let roots: SearchRoot[];
  try {
    roots = searchRoots(args.paths);
  } catch (err) {
    return failure(`Error: ${(err as Error).message}`);
  }
  const multiline = args.multiline === true;
  const files = filesInPathOrder(fs, roots, literalGlobPrefix(args.glob), (file) => {
    const rel = relOf(file);
    return (!globMatch || globMatch(rel)) && (!type || type(rel));
  });

  const out: string[] = [];
  let outChars = 0;
  const after = args["-A"] ?? args["-C"] ?? 0;
  const before = args["-B"] ?? args["-C"] ?? 0;
  const context = before > 0 || after > 0;
  const numbers = args["-n"] === true;
  // head_limit in content mode caps matches per file (as ripgrep -m does in the built-in).
  const maxCount = mode === "content" && limit ? limit : Infinity;
  let filesListed = 0;
  let firstGroup = true;
  let multilineSkipped = 0;

  const started = Date.now();
  const deadline = started + (options.timeBudgetMs ?? SEARCH_TIME_BUDGET_MS);
  const maxScanBytes = options.maxScanBytes ?? MAX_SCAN_BYTES;
  let scanned = 0;
  let stop: undefined | "time" | "bytes" | "output" | "limit";
  const beforeChunk = (bytes: number): boolean => {
    if (Date.now() >= deadline) stop ??= "time";
    else if ((scanned += bytes) > maxScanBytes) stop ??= "bytes";
    return stop === undefined;
  };
  const emit = (line: string) => {
    out.push(line);
    outChars += line.length + 1;
    if (out.length >= MAX_OUTPUT_LINES) stop ??= "limit";
    else if (outChars >= MAX_OUTPUT_CHARS) stop ??= "output";
  };
  const listFile = (line: string) => {
    emit(line);
    filesListed++;
    if (limit && filesListed >= limit) stop ??= "limit";
  };

  /** Content mode on a whole text (multiline): lines shown around the hits. */
  const emitWhole = (name: string, lines: string[], hits: number[]) => {
    const hitSet = new Set(hits);
    const shown = new Set<number>();
    for (const h of hits) for (let l = Math.max(0, h - before); l <= Math.min(lines.length - 1, h + after); l++) shown.add(l);
    let prev = -2;
    for (const l of [...shown].sort((a, b) => a - b)) {
      if (context && !firstGroup && l !== prev + 1) emit("--");
      firstGroup = false;
      const sep = hitSet.has(l) ? ":" : "-";
      emit(numbers ? `${name}${sep}${l + 1}${sep}${lines[l]}` : `${name}${sep}${lines[l]}`);
      prev = l;
    }
  };

  /** multiline: the whole file (at most MAX_MULTILINE_FILE_BYTES) in one pass of the global regex. */
  const searchWhole = async (name: string, stream: Readable) => {
    const data = await readAtMost(stream, MAX_MULTILINE_FILE_BYTES, beforeChunk);
    if (data === "stopped") return;
    if (data === undefined) {
      multilineSkipped++;
      return;
    }
    if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return;
    const text = data.toString("utf8");
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "" && text.endsWith("\n")) lines.pop();
    const hits = multilineMatches(text, re, maxCount);
    if (hits.length === 0) return;
    if (mode === "files_with_matches") listFile(name);
    else if (mode === "count") listFile(`${name}:${hits.length}`);
    else emitWhole(name, lines, hits);
  };

  /** One line at a time as the bytes arrive; stops the download as soon as the file is done. */
  const searchLines = async (name: string, stream: Readable) => {
    let hits = 0;
    let handler: (text: string, i: number) => boolean;
    if (mode === "files_with_matches") {
      handler = (text) => {
        if (!single.test(text)) return true;
        hits++;
        return false;
      };
    } else if (mode === "count") {
      handler = (text) => {
        if (single.test(text)) hits++;
        return true;
      };
    } else {
      let afterLeft = 0;
      let lastPrinted = -2;
      // -B context: the lines since the last printed one, at most `before`.
      const ring: Array<{ i: number; text: string }> = [];
      let ringChars = 0;
      const print = (i: number, text: string, sep: string) => {
        if (context && !firstGroup && i !== lastPrinted + 1) emit("--");
        firstGroup = false;
        emit(numbers ? `${name}${sep}${i + 1}${sep}${text}` : `${name}${sep}${text}`);
        lastPrinted = i;
      };
      handler = (text, i) => {
        if (hits < maxCount && single.test(text)) {
          for (const r of ring) print(r.i, r.text, "-");
          ring.length = 0;
          ringChars = 0;
          print(i, text, ":");
          hits++;
          afterLeft = after;
        } else if (afterLeft > 0) {
          print(i, text, "-");
          afterLeft--;
        } else if (before > 0) {
          ring.push({ i, text });
          ringChars += text.length;
          while (ring.length > before || (ringChars > MAX_BEFORE_CONTEXT_CHARS && ring.length > 1)) {
            ringChars -= ring.shift()!.text.length;
          }
        }
        if (stop !== undefined) return false;
        return !(hits >= maxCount && afterLeft === 0);
      };
    }
    const end = await scanLines(stream, new LineSplitter(handler), beforeChunk);
    if (hits === 0 || end === "binary") return;
    if (mode === "files_with_matches") listFile(name);
    // A count is only shown for a file read to its end.
    else if (mode === "count" && end === "eof") listFile(`${name}:${hits}`);
  };

  const wanted = (file: RootFile) =>
    !(multiline && file.entry.size !== undefined && file.entry.size > MAX_MULTILINE_FILE_BYTES);
  for await (const { file, stream, skipped } of openInOrder(fs, files, wanted)) {
    if (skipped) {
      multilineSkipped++;
      continue;
    }
    if (Date.now() >= deadline) stop ??= "time";
    if (stop !== undefined) {
      stream?.destroy();
      break;
    }
    if (!stream) continue;
    await yieldToEventLoop();
    const name = show(file.root, file.entry);
    try {
      if (multiline) await searchWhole(name, stream);
      else await searchLines(name, stream);
    } finally {
      stream.destroy();
    }
    if (stop !== undefined) break;
  }

  const notes: string[] = [];
  if (stop === "time") notes.push(timeBudgetNote(Date.now() - started));
  if (stop === "bytes") {
    notes.push(`[The search stopped after reading ${mb(maxScanBytes)}; the results above are incomplete. Narrow paths or glob.]`);
  }
  if (stop === "output") {
    notes.push(`[The output stopped at ${mb(MAX_OUTPUT_CHARS)}; the results above are incomplete. Narrow the pattern, paths or glob.]`);
  }
  if (multilineSkipped > 0) {
    notes.push(
      `[multiline: ${multilineSkipped} file(s) over ${mb(MAX_MULTILINE_FILE_BYTES)} were not searched. Search them without multiline.]`,
    );
  }
  const note = notes.length > 0 ? `\n${notes.join("\n")}` : "";
  if (out.length === 0) return ok(`No matches found.${note}`);
  return ok(`${out.slice(0, MAX_OUTPUT_LINES).join("\n")}${note}`);
}

export async function runGlob(fs: WorkspaceFiles, args: { pattern?: string; paths?: unknown }): Promise<ToolResultObject> {
  if (!args.pattern) return failure("Error: pattern is required");
  const RE2 = await loadRe2();
  if (!RE2) return failure(SEARCH_UNAVAILABLE_TEXT);
  let roots: SearchRoot[];
  try {
    roots = searchRoots(args.paths);
  } catch (err) {
    return failure(`Error: ${(err as Error).message}`);
  }
  let match: (rel: string) => boolean;
  try {
    match = globMatcher(args.pattern, RE2);
  } catch (err) {
    return failure(`Error: glob: ${(err as Error).message}`);
  }
  // Newest first, like the built-in: keep only the newest MAX_GLOB_RESULTS
  // while listing (ties in listing order), so memory stays bounded.
  const newestFirst = (a: RootFile & { seq: number }, b: RootFile & { seq: number }) =>
    b.entry.lastModified.getTime() - a.entry.lastModified.getTime() || a.seq - b.seq;
  let found: Array<RootFile & { seq: number }> = [];
  let seq = 0;
  const literalPrefix = literalGlobPrefix(args.pattern);
  for (const root of roots) {
    for await (const file of rootFiles(fs, root, literalPrefix)) {
      if (!match(relOf(file))) continue;
      found.push({ ...file, seq: seq++ });
      if (found.length >= 2 * MAX_GLOB_RESULTS) found = found.sort(newestFirst).slice(0, MAX_GLOB_RESULTS);
    }
  }
  if (found.length === 0) return ok("No files matched the pattern.");
  return ok(found.sort(newestFirst).slice(0, MAX_GLOB_RESULTS).map(({ root, entry }) => show(root, entry)).join("\n"));
}

/** The search tools for a model family, with the runtime's names and schemas. */
export interface WorkspaceToolOptions {
  /**
   * Writes a large result into the workspace (our own spill, see
   * tool-adapter.ts spillLargeResult). Every result is marked
   * skipLargeOutputProcessing, so the runtime never spills these itself.
   */
  spill?: (path: string, content: string) => Promise<void>;
  /** Sees an error of a call (for the server log); the model gets workspaceToolErrorText. */
  onError?: (tool: string, err: unknown) => void;
}

/** Large outputs become a workspace file + preview; all results skip the runtime's spill. */
async function finishResult(
  name: string,
  result: ToolResultObject,
  callId: string,
  spill: WorkspaceToolOptions["spill"],
): Promise<ToolResultObject> {
  if (spill && result.resultType === "success") {
    const spilled = await spillLargeResult(name, callId, result.textResultForLlm, spill);
    if (spilled) return spilled.result;
  }
  return { ...result, skipLargeOutputProcessing: true };
}

/** The search tools for a model family, with the runtime's names and schemas. */
export function workspaceTools(
  files: WorkspaceFiles,
  family: SearchToolFamily,
  options: WorkspaceToolOptions = {},
): CopilotTool[] {
  return SEARCH_TOOLS_BY_FAMILY[family].map((name) => {
    const def = builtin.tools[name];
    return {
      name: def.name,
      description: def.description,
      parameters: def.parameters as Record<string, unknown>,
      overridesBuiltInTool: true,
      skipPermission: true,
      defer: "never" as const,
      handler: async (args: unknown, invocation?: { toolCallId?: string }) => {
        try {
          const result =
            name === "glob"
              ? await runGlob(files, (args ?? {}) as { pattern?: string; paths?: unknown })
              : await runRipgrep(files, (args ?? {}) as RgArgs);
          return await finishResult(name, result, invocation?.toolCallId ?? `${Date.now()}`, options.spill);
        } catch (err) {
          options.onError?.(name, err);
          return { ...failure(workspaceToolErrorText(err)), skipLargeOutputProcessing: true };
        }
      },
    };
  });
}
