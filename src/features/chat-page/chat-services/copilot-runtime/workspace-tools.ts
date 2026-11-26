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
 * prefix of path + glob (no per-file stat), contents from the per-process
 * cache of immutable data blobs, misses downloaded 16 at a time, large and
 * binary files skipped, early stop at head_limit.
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
 * to the event loop between file batches.
 */
import RE2 from "re2";
import type { Tool as CopilotTool, ToolResultObject } from "@microsoft/copilot-sdk";
import builtin from "./builtin-search-tools.json";
import { normalizeSessionPath, WORKSPACE_ROOT } from "./session-path";
import type { WorkspaceEntry } from "./blob-session-fs";

/** What the tools need from the filesystem (BlobSessionFs implements it). */
export interface WorkspaceFiles {
  listEntries(dir: string, literalPrefix?: string): Promise<WorkspaceEntry[]>;
  readEntry(entry: WorkspaceEntry): Promise<Buffer>;
}

export type SearchToolFamily = "gpt" | "claude";
export type SearchToolName = "rg" | "grep" | "glob";

/** Tool names per model family, as the runtime offers them. */
export const SEARCH_TOOLS_BY_FAMILY: Record<SearchToolFamily, readonly SearchToolName[]> = {
  gpt: builtin.toolsByModelFamily.gpt as SearchToolName[],
  claude: builtin.toolsByModelFamily.claude as SearchToolName[],
};
export const ALL_SEARCH_TOOL_NAMES: readonly SearchToolName[] = ["rg", "grep", "glob"];

/** Biggest file the content search reads. */
export const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_PARALLELISM = 16;
const MAX_GLOB_RESULTS = 1000;
const MAX_OUTPUT_LINES = 2000;

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
export function globToRegExp(glob: string): RegExp {
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
export function globMatcher(pattern: string): (relPath: string) => boolean {
  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const re = globToRegExp(p);
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

/** Lists the files under the roots; a root that is a file becomes that one file. */
async function listRoots(
  fs: WorkspaceFiles,
  roots: SearchRoot[],
  literalPrefix: string,
): Promise<Array<{ root: SearchRoot; entry: WorkspaceEntry }>> {
  const out: Array<{ root: SearchRoot; entry: WorkspaceEntry }> = [];
  for (const root of roots) {
    const entries = await fs.listEntries(root.dir, literalPrefix);
    if (entries.length === 0 && root.dir !== WORKSPACE_ROOT) {
      // Maybe a single file: list its parent narrowed to the file name.
      const slash = root.dir.lastIndexOf("/");
      const parent = root.dir.slice(0, slash);
      const name = root.dir.slice(slash + 1);
      if (parent && normalizeSessionPath(parent)) {
        const hit = (await fs.listEntries(parent, name)).find((e) => e.path === root.dir);
        if (hit) out.push({ root: { ...root, file: root.dir }, entry: hit });
      }
      continue;
    }
    for (const entry of entries) out.push({ root, entry });
  }
  return out;
}

const isBinary = (data: Buffer) => data.subarray(0, 8192).includes(0);

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Reads files in order, PARALLELISM at a time; `visit` returns false to stop
 * early. Yields to the event loop between batches (cached reads resolve as
 * microtasks only) and stops at `deadline` (epoch ms). Returns false when the
 * deadline stopped it.
 */
async function readInOrder<T extends { entry: WorkspaceEntry }>(
  fs: WorkspaceFiles,
  items: T[],
  visit: (item: T, text: string) => boolean,
  deadline: number,
): Promise<boolean> {
  for (let i = 0; i < items.length; i += DOWNLOAD_PARALLELISM) {
    await yieldToEventLoop();
    if (Date.now() >= deadline) return false;
    const batch = items.slice(i, i + DOWNLOAD_PARALLELISM);
    const contents = await Promise.all(
      batch.map(async (item) => {
        if (item.entry.size !== undefined && item.entry.size > MAX_SEARCH_FILE_BYTES) return undefined;
        const data = await fs.readEntry(item.entry);
        if (data.length > MAX_SEARCH_FILE_BYTES || isBinary(data)) return undefined;
        return data.toString("utf8");
      }),
    );
    for (let j = 0; j < batch.length; j++) {
      const text = contents[j];
      if (text === undefined) continue;
      if (!visit(batch[j], text)) return true;
      if (Date.now() >= deadline) return false;
    }
  }
  return true;
}

const timeBudgetNote = (ms: number) =>
  `[The search stopped after ${Math.round(ms / 1000)} s; the results above are incomplete. Narrow paths or glob.]`;

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
 * Line numbers (0-based) that a match touches, per file. `re` is the global
 * regex (multiline mode), `single` the same pattern without "g" (per line).
 */
function matchingLines(
  text: string,
  lines: string[],
  re: RegExp,
  single: RegExp,
  multiline: boolean,
  maxCount: number,
): number[] {
  const hits: number[] = [];
  if (!multiline) {
    for (let i = 0; i < lines.length && hits.length < maxCount; i++) if (single.test(lines[i])) hits.push(i);
    return hits;
  }
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
  options: { timeBudgetMs?: number } = {},
): Promise<ToolResultObject> {
  if (!args.pattern) return failure("Error: pattern is required");
  const mode = args.output_mode ?? "files_with_matches";
  const re = buildSearchRegex(args.pattern, { ignoreCase: args["-i"], multiline: args.multiline });
  if ("error" in re) return failure(re.error);
  const type = typeMatcher(args.type);
  if (type === "unknown") return failure(`Error: rg: unrecognized file type: ${args.type}`);
  const single = new RE2(re, re.flags.replace("g", ""));
  let globMatch: ((rel: string) => boolean) | undefined;
  try {
    globMatch = args.glob ? globMatcher(args.glob) : undefined;
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
  const files = (await listRoots(fs, roots, literalGlobPrefix(args.glob)))
    .filter(({ root, entry }) => {
      const rel = root.file ? entry.path.split("/").pop()! : relTo(root.dir, entry.path);
      return (!globMatch || globMatch(rel)) && (!type || type(rel));
    })
    .sort((a, b) => (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0));

  const out: string[] = [];
  const after = args["-A"] ?? args["-C"] ?? 0;
  const before = args["-B"] ?? args["-C"] ?? 0;
  const numbers = args["-n"] === true;
  let filesListed = 0;
  let firstGroup = true;

  const started = Date.now();
  const complete = await readInOrder(fs, files, ({ root, entry }, text) => {
    const name = show(root, entry);
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "" && text.endsWith("\n")) lines.pop();
    // head_limit in content mode caps matches per file (as ripgrep -m does in the built-in).
    const hits = matchingLines(text, lines, re, single, args.multiline === true, mode === "content" && limit ? limit : Infinity);
    if (hits.length === 0) return true;
    if (mode === "files_with_matches") {
      out.push(name);
      filesListed++;
      return !(limit && filesListed >= limit);
    }
    if (mode === "count") {
      out.push(`${name}:${hits.length}`);
      filesListed++;
      return !(limit && filesListed >= limit);
    }
    const hitSet = new Set(hits);
    const shown = new Set<number>();
    for (const h of hits) for (let l = Math.max(0, h - before); l <= Math.min(lines.length - 1, h + after); l++) shown.add(l);
    let prev = -2;
    for (const l of [...shown].sort((a, b) => a - b)) {
      if ((before > 0 || after > 0) && !firstGroup && l !== prev + 1) out.push("--");
      firstGroup = false;
      const sep = hitSet.has(l) ? ":" : "-";
      out.push(numbers ? `${name}${sep}${l + 1}${sep}${lines[l]}` : `${name}${sep}${lines[l]}`);
      prev = l;
    }
    return out.length < MAX_OUTPUT_LINES;
  }, started + (options.timeBudgetMs ?? SEARCH_TIME_BUDGET_MS));

  const note = complete ? "" : `\n${timeBudgetNote(Date.now() - started)}`;
  if (out.length === 0) return ok(`No matches found.${note}`);
  return ok(`${out.slice(0, MAX_OUTPUT_LINES).join("\n")}${note}`);
}

export async function runGlob(fs: WorkspaceFiles, args: { pattern?: string; paths?: unknown }): Promise<ToolResultObject> {
  if (!args.pattern) return failure("Error: pattern is required");
  let roots: SearchRoot[];
  try {
    roots = searchRoots(args.paths);
  } catch (err) {
    return failure(`Error: ${(err as Error).message}`);
  }
  let match: (rel: string) => boolean;
  try {
    match = globMatcher(args.pattern);
  } catch (err) {
    return failure(`Error: glob: ${(err as Error).message}`);
  }
  const found = (await listRoots(fs, roots, literalGlobPrefix(args.pattern)))
    .filter(({ root, entry }) => match(root.file ? entry.path.split("/").pop()! : relTo(root.dir, entry.path)))
    // Newest first, like the built-in.
    .sort((a, b) => b.entry.lastModified.getTime() - a.entry.lastModified.getTime());
  if (found.length === 0) return ok("No files matched the pattern.");
  return ok(found.slice(0, MAX_GLOB_RESULTS).map(({ root, entry }) => show(root, entry)).join("\n"));
}

/** The search tools for a model family, with the runtime's names and schemas. */
export function workspaceTools(fs: WorkspaceFiles, family: SearchToolFamily): CopilotTool[] {
  return SEARCH_TOOLS_BY_FAMILY[family].map((name) => {
    const def = builtin.tools[name];
    return {
      name: def.name,
      description: def.description,
      parameters: def.parameters as Record<string, unknown>,
      overridesBuiltInTool: true,
      skipPermission: true,
      defer: "never" as const,
      handler: async (args: unknown) => {
        try {
          return name === "glob"
            ? await runGlob(fs, (args ?? {}) as { pattern?: string; paths?: unknown })
            : await runRipgrep(fs, (args ?? {}) as RgArgs);
        } catch (err) {
          return failure(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    };
  });
}
