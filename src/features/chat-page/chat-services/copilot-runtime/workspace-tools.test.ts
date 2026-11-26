import { describe, it, expect, beforeEach } from "vitest";

import builtin from "./builtin-search-tools.json";
import { BlobSessionFs } from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import {
  buildSearchRegex,
  DOWNLOAD_PARALLELISM,
  GLOB_LIMITS,
  GlobPatternError,
  globToRegExp,
  MAX_MULTILINE_FILE_BYTES,
  MAX_PATTERN_CHARS,
  literalGlobPrefix,
  runGlob,
  runRipgrep,
  workspaceTools,
} from "./workspace-tools";

const NS = "userA/thread1";

async function workspace(files: Record<string, string | Buffer>) {
  const store = new FakeBlobStore();
  const fs = new BlobSessionFs(store, NS);
  for (const [path, content] of Object.entries(files)) {
    if (typeof content === "string") await fs.writeFile(path, content);
    else await fs.writeFileBytes(path, content);
  }
  store.requests = [];
  return { store, fs };
}

const downloads = (store: FakeBlobStore) => store.requests.filter((r) => r.startsWith("download"));
/** Data blob name of a workspace file (the pointer's target). */
const dataKeyOf = async (store: FakeBlobStore, path: string) =>
  (await store.getProperties(`${NS}/f${path}`))!.metadata.target;

const text = (r: { textResultForLlm: string }) => r.textResultForLlm;

describe("schema parity with the runtime's built-in search tools", () => {
  it("GPT gets rg + glob, Claude grep + glob, with the captured names, descriptions and schemas", async () => {
    const { fs } = await workspace({});
    const gpt = workspaceTools(fs, "gpt");
    const claude = workspaceTools(fs, "claude");
    expect(gpt.map((t) => t.name)).toEqual(["rg", "glob"]);
    expect(claude.map((t) => t.name)).toEqual(["grep", "glob"]);
    for (const tool of [...gpt, ...claude]) {
      const captured = builtin.tools[tool.name as "rg" | "grep" | "glob"];
      expect(tool.description).toBe(captured.description);
      expect(tool.parameters).toEqual(captured.parameters);
      expect((tool.parameters as { required: string[] }).required).toEqual(["pattern"]);
      expect(tool.overridesBuiltInTool).toBe(true);
    }
    expect(Object.keys((builtin.tools.rg.parameters as { properties: object }).properties)).toEqual([
      "pattern", "paths", "output_mode", "glob", "type", "-i", "-A", "-B", "-C", "-n", "head_limit", "multiline",
    ]);
  });
});

describe("rg / grep output (ripgrep format)", () => {
  let ws: Awaited<ReturnType<typeof workspace>>;
  beforeEach(async () => {
    ws = await workspace({
      "/workspace/a.txt": "alpha-42\nbeta\nalpha again\ngamma\n",
      "/workspace/sub/b.md": "# B\nALPHA upper\n",
      "/workspace/sub/c.txt": "x\nalpha one\ny\nz\nw\nalpha two\n",
      "/workspace/c.js": "const x = 1;\n",
    });
  });

  it("files_with_matches is the default", async () => {
    expect(text(await runRipgrep(ws.fs, { pattern: "alpha" }))).toBe("./a.txt\n./sub/c.txt");
  });

  it("content, -n, count, -i, glob, type", async () => {
    expect(text(await runRipgrep(ws.fs, { pattern: "alpha", output_mode: "content" }))).toBe(
      "./a.txt:alpha-42\n./a.txt:alpha again\n./sub/c.txt:alpha one\n./sub/c.txt:alpha two",
    );
    expect(text(await runRipgrep(ws.fs, { pattern: "alpha", output_mode: "content", "-n": true, paths: "/workspace/sub" }))).toBe(
      "/workspace/sub/c.txt:2:alpha one\n/workspace/sub/c.txt:6:alpha two",
    );
    expect(text(await runRipgrep(ws.fs, { pattern: "alpha", output_mode: "count", "-i": true }))).toBe(
      "./a.txt:2\n./sub/b.md:1\n./sub/c.txt:2",
    );
    expect(text(await runRipgrep(ws.fs, { pattern: "alpha", glob: "*.md", "-i": true }))).toBe("./sub/b.md");
    expect(text(await runRipgrep(ws.fs, { pattern: "const", type: "js", output_mode: "content" }))).toBe("./c.js:const x = 1;");
    expect(text(await runRipgrep(ws.fs, { pattern: "nomatch" }))).toBe("No matches found.");
  });

  it("context lines use '-' and groups are separated by '--'", async () => {
    expect(text(await runRipgrep(ws.fs, { pattern: "alpha", "-A": 1, output_mode: "content" }))).toBe(
      ["./a.txt:alpha-42", "./a.txt-beta", "./a.txt:alpha again", "./a.txt-gamma", "--", "./sub/c.txt:alpha one", "./sub/c.txt-y", "--", "./sub/c.txt:alpha two"].join("\n"),
    );
    expect(text(await runRipgrep(ws.fs, { pattern: "alpha-42", "-C": 1, "-n": true, output_mode: "content" }))).toBe(
      "./a.txt:1:alpha-42\n./a.txt-2-beta",
    );
  });

  it("multiline and Rust-style leading inline flags", async () => {
    expect(text(await runRipgrep(ws.fs, { pattern: "a.*\\n.*b", multiline: true, output_mode: "content", paths: "/workspace/a.txt" }))).toBe(
      "/workspace/a.txt:alpha-42\n/workspace/a.txt:beta",
    );
    expect(text(await runRipgrep(ws.fs, { pattern: "(?i)alpha upper", output_mode: "content" }))).toBe("./sub/b.md:ALPHA upper");
  });

  it("a regex the engine cannot run fails with an explanation, not silently", async () => {
    const res = await runRipgrep(ws.fs, { pattern: "(" });
    expect(res.resultType).toBe("failure");
    expect(text(res)).toMatch(/^Error: rg: regex parse error: .*\nNote: patterns run on the RE2 engine/s);
    expect("error" in (buildSearchRegex("(?x) a b", {}) as object)).toBe(true);
  });

  it("head_limit: files in files mode, matches per file in content mode", async () => {
    expect(text(await runRipgrep(ws.fs, { pattern: "alpha", head_limit: 1, "-i": true }))).toBe("./a.txt");
    expect(text(await runRipgrep(ws.fs, { pattern: "alpha", output_mode: "content", head_limit: 1 }))).toBe(
      "./a.txt:alpha-42\n./sub/c.txt:alpha one",
    );
  });
});

describe("glob", () => {
  it("matches like the built-in, newest first, with its no-match text", async () => {
    const { fs } = await workspace({ "/workspace/a.txt": "1" });
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile("/workspace/sub/b.md", "2");
    expect(text(await runGlob(fs, { pattern: "**/*" }))).toBe("./sub/b.md\n./a.txt");
    expect(text(await runGlob(fs, { pattern: "*.md" }))).toBe("./sub/b.md");
    expect(text(await runGlob(fs, { pattern: "**/*.md", paths: "/workspace/sub" }))).toBe("/workspace/sub/b.md");
    expect(text(await runGlob(fs, { pattern: "*.pdf" }))).toBe("No files matched the pattern.");
  });
});

describe("Blob efficiency", () => {
  it("one flat listing per call, narrowed to the literal prefix of path + glob; no per-file stat", async () => {
    const { fs, store } = await workspace({
      "/workspace/notes/a.txt": "alpha",
      "/workspace/notes/deep/b.txt": "alpha",
      "/workspace/other/c.txt": "alpha",
    });
    await runRipgrep(fs, { pattern: "alpha", glob: "notes/**/*.txt" });
    const ops = store.requests.map((r) => r.split(" ")[0]);
    expect(store.requests[0]).toBe(`listDetailed ${NS}/f/workspace/notes/`);
    expect(ops.filter((o) => o === "listDetailed")).toHaveLength(1);
    expect(ops.filter((o) => o === "getProperties")).toHaveLength(0);
    expect(ops.filter((o) => o === "download")).toHaveLength(2); // other/c.txt never read

    store.requests = [];
    await runGlob(fs, { pattern: "**/*.txt", paths: "/workspace/other" });
    expect(store.requests).toEqual([`listDetailed ${NS}/f/workspace/other/`]);
  });

  it("literalGlobPrefix stops at the first wildcard and ignores name-only patterns", () => {
    expect(literalGlobPrefix("notes/**/*.md")).toBe("notes/");
    expect(literalGlobPrefix("notes/rep*.md")).toBe("notes/rep");
    expect(literalGlobPrefix("*.md")).toBe("");
    expect(literalGlobPrefix("**/*")).toBe("");
    expect(literalGlobPrefix("../x/*")).toBe("");
  });

  it("keeps no content between calls: every search streams the files again", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`/workspace/f${i}.txt`] = `line ${i}\nneedle ${i}\n`;
    const { fs, store } = await workspace(files);
    const first = await runRipgrep(fs, { pattern: "needle", output_mode: "count" });
    expect(downloads(store)).toHaveLength(40);
    store.requests = [];
    const second = await runRipgrep(fs, { pattern: "needle", output_mode: "count" });
    expect(store.requests[0]).toBe(`listDetailed ${NS}/f/workspace/`);
    expect(downloads(store)).toHaveLength(40);
    expect(text(second)).toBe(text(first));
    expect(text(second).split("\n")).toHaveLength(40);
  });

  it("a rewritten file is a new data blob, so the cache never serves old content", async () => {
    const { fs } = await workspace({ "/workspace/a.txt": "old value" });
    expect(text(await runRipgrep(fs, { pattern: "old", output_mode: "content" }))).toBe("./a.txt:old value");
    await fs.writeFile("/workspace/a.txt", "new value");
    expect(text(await runRipgrep(fs, { pattern: "value", output_mode: "content" }))).toBe("./a.txt:new value");
    await fs.appendFile("/workspace/a.txt", "\nappended");
    expect(text(await runRipgrep(fs, { pattern: "appended", output_mode: "content" }))).toBe("./a.txt:appended");
  });

  it("stops early at head_limit, skips binary files and streams large ones", async () => {
    const files: Record<string, string | Buffer> = {};
    for (let i = 0; i < 100; i++) files[`/workspace/f${String(i).padStart(3, "0")}.txt`] = "hit\n";
    files["/workspace/aaa-binary.bin"] = Buffer.from([0x68, 0x69, 0x74, 0x00, 0x01]);
    files["/workspace/aab-large.txt"] = "hit\n" + "x".repeat(2 * 1024 * 1024 + 10);
    const { fs, store } = await workspace(files);
    const res = await runRipgrep(fs, { pattern: "hit", head_limit: 3 });
    // No file-size limit any more: the large file is searched, and only its first chunk is read.
    expect(text(res)).toBe("./aab-large.txt\n./f000.txt\n./f001.txt");
    expect(downloads(store).length).toBeLessThanOrEqual(4 + DOWNLOAD_PARALLELISM);
    expect(store.chunksServed.get(await dataKeyOf(store, "/workspace/aab-large.txt"))).toBeLessThanOrEqual(2);
    expect(store.aborted).toContain(await dataKeyOf(store, "/workspace/aab-large.txt"));
  });
});

describe("streaming search: early stop, bounded reads", () => {
  /** n lines "line <i>" with "needle" on the lines in `needles`. */
  const lines = (n: number, needles: number[] = []) =>
    Array.from({ length: n }, (_, i) => (needles.includes(i) ? `needle ${i}` : `line ${i}`)).join("\n") + "\n";

  it("files_with_matches stops a download at the first match", async () => {
    const { fs, store } = await workspace({ "/workspace/big.txt": lines(200_000, [5, 150_000]) });
    store.chunkSize = 4096;
    const key = await dataKeyOf(store, "/workspace/big.txt");
    expect(text(await runRipgrep(fs, { pattern: "needle" }))).toBe("./big.txt");
    const total = Math.ceil(store.blobs.get(key)!.data.length / 4096);
    expect(total).toBeGreaterThan(500);
    // The binary check holds 8 KB (2 chunks), plus at most one chunk of read-ahead.
    expect(store.chunksServed.get(key)).toBeLessThanOrEqual(4);
    expect(store.aborted).toEqual([key]);
  });

  it("count and content read the whole file; content head_limit stops after the last allowed match", async () => {
    const { fs, store } = await workspace({ "/workspace/big.txt": lines(50_000, [10, 20, 40_000]) });
    store.chunkSize = 4096;
    const key = await dataKeyOf(store, "/workspace/big.txt");
    const total = Math.ceil(store.blobs.get(key)!.data.length / 4096);
    expect(text(await runRipgrep(fs, { pattern: "needle", output_mode: "count" }))).toBe("./big.txt:3");
    expect(store.chunksServed.get(key)).toBe(total);
    store.chunksServed.clear();
    expect(text(await runRipgrep(fs, { pattern: "needle", output_mode: "content", head_limit: 2, "-A": 1, "-n": true }))).toBe(
      "./big.txt:11:needle 10\n./big.txt-12-line 11\n--\n./big.txt:21:needle 20\n./big.txt-22-line 21",
    );
    expect(store.chunksServed.get(key)).toBeLessThanOrEqual(4);
  });

  it("context lines across chunk borders, CRLF files and -B larger than the file start", async () => {
    const crlf = "a1\r\nb2\r\nneedle\r\nc3\r\nd4\r\ne5\r\nneedle two\r\n";
    const { fs, store } = await workspace({ "/workspace/w.txt": crlf });
    store.chunkSize = 3;
    expect(text(await runRipgrep(fs, { pattern: "needle", output_mode: "content", "-B": 5, "-n": true }))).toBe(
      ["./w.txt-1-a1", "./w.txt-2-b2", "./w.txt:3:needle", "./w.txt-4-c3", "./w.txt-5-d4", "./w.txt-6-e5", "./w.txt:7:needle two"].join("\n"),
    );
    expect(text(await runRipgrep(fs, { pattern: "needle", output_mode: "content", "-C": 1 }))).toBe(
      ["./w.txt-b2", "./w.txt:needle", "./w.txt-c3", "--", "./w.txt-e5", "./w.txt:needle two"].join("\n"),
    );
  });

  it("head_limit in files mode stops opening files; the listing stops at the page that had enough", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i++) files[`/workspace/f${String(i).padStart(2, "0")}.txt`] = "hit\n";
    const { fs, store } = await workspace(files);
    store.pageSize = 10;
    expect(text(await runRipgrep(fs, { pattern: "hit", head_limit: 2 }))).toBe("./f00.txt\n./f01.txt");
    expect(downloads(store).length).toBeLessThanOrEqual(2 + DOWNLOAD_PARALLELISM);
    expect(store.requests.filter((r) => r.startsWith("listDetailed")).length).toBeLessThanOrEqual(2);
  });

  it("glob and type filters decide before any download", async () => {
    const { fs, store } = await workspace({ "/workspace/a.ts": "x\n", "/workspace/b.md": "x\n", "/workspace/c.txt": "x\n" });
    expect(text(await runRipgrep(fs, { pattern: "x", glob: "*.md" }))).toBe("./b.md");
    expect(downloads(store)).toEqual([`download ${await dataKeyOf(store, "/workspace/b.md")}`]);
    store.requests = [];
    expect(text(await runRipgrep(fs, { pattern: "x", type: "ts" }))).toBe("./a.ts");
    expect(downloads(store)).toHaveLength(1);
  });

  it("multiline reads whole files up to the cap and skips larger ones with a note", async () => {
    const big = "start\n" + "y".repeat(MAX_MULTILINE_FILE_BYTES) + "\nend\n";
    const { fs, store } = await workspace({ "/workspace/a.txt": "start\nend\n", "/workspace/b.txt": big });
    const res = text(await runRipgrep(fs, { pattern: "start\\nend", multiline: true }));
    expect(res).toBe("./a.txt\n[multiline: 1 file(s) over 1 MB were not searched. Search them without multiline.]");
    expect(downloads(store)).toEqual([`download ${await dataKeyOf(store, "/workspace/a.txt")}`]);
    // Without multiline the large file is searched line by line.
    expect(text(await runRipgrep(fs, { pattern: "^end$", output_mode: "count" }))).toBe("./a.txt:1\n./b.txt:1");
  });

  it("a call stops at its byte budget with a note", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`/workspace/f${i}.txt`] = "x".repeat(10_000) + "\nhit\n";
    const { fs } = await workspace(files);
    const res = text(await runRipgrep(fs, { pattern: "hit" }, { maxScanBytes: 25_000 }));
    expect(res).toBe("./f0.txt\n./f1.txt\n[The search stopped after reading 0 MB; the results above are incomplete. Narrow paths or glob.]");
  });

  it("a very long line is truncated for matching and output, the next line is still found", async () => {
    const long = "head " + "z".repeat(200_000) + " tail";
    const { fs, store } = await workspace({ "/workspace/l.txt": `${long}\nnext needle\n` });
    store.chunkSize = 8192;
    expect(text(await runRipgrep(fs, { pattern: "tail", output_mode: "count" }))).toBe("No matches found.");
    const out = text(await runRipgrep(fs, { pattern: "head|needle", output_mode: "content", "-n": true })).split("\n");
    expect(out).toHaveLength(2);
    expect(out[0].length).toBe("./l.txt:1:".length + 64 * 1024);
    expect(out[1]).toBe("./l.txt:2:next needle");
  });

  it("a file deleted after the listing is skipped", async () => {
    const { fs, store } = await workspace({ "/workspace/a.txt": "hit\n", "/workspace/b.txt": "hit\n" });
    const realOpen = store.openRead.bind(store);
    store.openRead = async (name, options) => {
      if (name === store.blobs.get(`${NS}/f/workspace/a.txt`)!.metadata.target) {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }
      return realOpen(name, options);
    };
    expect(text(await runRipgrep(fs, { pattern: "hit" }))).toBe("./b.txt");
  });
});

describe("namespace jail", () => {
  it("paths outside the workspace fail and never reach the store", async () => {
    const { fs, store } = await workspace({ "/workspace/a.txt": "x" });
    for (const paths of ["/etc", "C:\\Windows", "/workspace/../session-state", "\\\\server\\share"]) {
      expect((await runRipgrep(fs, { pattern: "x", paths })).resultType).toBe("failure");
      expect((await runGlob(fs, { pattern: "**/*", paths })).resultType).toBe("failure");
    }
    expect(store.requests).toEqual([]);
  });

  it("another namespace's blobs are never listed or read, even under a crafted glob", async () => {
    const { fs, store } = await workspace({ "/workspace/mine.txt": "secret-a" });
    const other = new BlobSessionFs(store, "userB/thread2");
    await other.writeFile("/workspace/theirs.txt", "secret-b");
    expect(text(await runRipgrep(fs, { pattern: "secret" }))).toBe("./mine.txt");
    expect(text(await runRipgrep(other, { pattern: "secret" }))).toBe("./theirs.txt");
    expect(text(await runGlob(fs, { pattern: "../../userB/thread2/f/workspace/*" }))).toBe("No files matched the pattern.");
    // A pointer that names another namespace's data blob is ignored.
    await store.upload(`${NS}/f/workspace/evil.txt`, Buffer.alloc(0), { target: "userB/thread2/d/x", size: "8" });
    expect(text(await runGlob(fs, { pattern: "evil.txt" }))).toBe("No files matched the pattern.");
  });

  it("globToRegExp basics", () => {
    expect(globToRegExp("**/*.{md,txt}").test("x/y/z.md")).toBe(true);
    expect(globToRegExp("file[12].csv").test("file3.csv")).toBe(false);
    expect(globToRegExp("file[!12].csv").test("file3.csv")).toBe(true);
    expect(globToRegExp("a}b(c).txt").test("a}b(c).txt")).toBe(true);
  });
});

describe("model-controlled patterns cannot block the server (ReDoS)", () => {
  const EVIL = "(a+)+$";
  const evilLine = `${"a".repeat(40)}!`;

  it("the catastrophic-backtracking pattern returns at once, and the event loop keeps running", async () => {
    // 40 files of 2,000 evil lines: a backtracking engine needs about 2^40
    // steps for ONE line; RE2 is linear in the input.
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`/workspace/evil/f${i}.txt`] = `${evilLine}\n`.repeat(2000);
    files["/workspace/evil/hit.txt"] = "aaaa\n";
    const { fs } = await workspace(files);

    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const started = Date.now();
    const res = await runRipgrep(fs, { pattern: EVIL, paths: "/workspace/evil" });
    const ms = Date.now() - started;
    clearInterval(timer);

    expect(res.resultType).toBe("success");
    expect(text(res)).toBe("/workspace/evil/hit.txt");
    expect(ms).toBeLessThan(3000);
    // Timers fired while the search ran: it yields between file batches.
    expect(ticks).toBeGreaterThan(0);

    // Same in multiline mode (one global pass over the whole file).
    const multi = await runRipgrep(fs, { pattern: EVIL, paths: "/workspace/evil/f0.txt", multiline: true });
    expect(text(multi)).toBe("No matches found.");
    expect(buildSearchRegex("(x+x+)+y", {})).not.toHaveProperty("error");
  });

  it("look-around and backreferences fail with the engine note", async () => {
    const { fs } = await workspace({ "/workspace/a.txt": "aa\n" });
    for (const pattern of ["(?<=a)a", "a(?=a)", "(a)\\1", "(?<n>a)\\k<n>"]) {
      const res = await runRipgrep(fs, { pattern });
      expect(res.resultType, pattern).toBe("failure");
      expect(text(res), pattern).toMatch(/regex parse error: .*\nNote: patterns run on the RE2 engine.*look-around, backreferences/s);
    }
    // An escaped backslash before a digit is a literal, not a backreference.
    expect(buildSearchRegex("\\\\1", {})).not.toHaveProperty("error");
  });

  it("inline flags work anywhere (as in ripgrep), (?x) does not", async () => {
    const { fs } = await workspace({ "/workspace/a.txt": "alpha ALPHA\n" });
    expect(text(await runRipgrep(fs, { pattern: "alpha (?i)alpha", output_mode: "content" }))).toBe("./a.txt:alpha ALPHA");
    expect(text(await runRipgrep(fs, { pattern: "(?i:ALPHA) ALPHA", output_mode: "count" }))).toBe("./a.txt:1");
    expect(buildSearchRegex("(?x)a b", {})).toHaveProperty("error");
  });

  it("rejects patterns over the length cap", async () => {
    const { fs } = await workspace({ "/workspace/a.txt": "a\n" });
    expect(buildSearchRegex("a".repeat(MAX_PATTERN_CHARS), {})).not.toHaveProperty("error");
    const res = await runRipgrep(fs, { pattern: "a".repeat(MAX_PATTERN_CHARS + 1) });
    expect(res.resultType).toBe("failure");
    expect(text(res)).toContain(`longer than ${MAX_PATTERN_CHARS} characters`);
    expect(text(await runRipgrep(fs, { pattern: "a{1001}" }))).toMatch(/^Error: rg: regex parse error/);
  });

  it("limits glob size: groups, nesting, alternatives, classes, length", async () => {
    const { fs } = await workspace({ "/workspace/a.txt": "a\n" });
    const tooMany = [
      "{a,b}".repeat(GLOB_LIMITS.maxBraceGroups + 1),
      `${"{a,".repeat(GLOB_LIMITS.maxBraceDepth + 1)}b${"}".repeat(GLOB_LIMITS.maxBraceDepth + 1)}`,
      `{${Array.from({ length: GLOB_LIMITS.maxAlternatives + 2 }, (_, i) => `x${i}`).join(",")}}`,
      "[ab]".repeat(GLOB_LIMITS.maxClasses + 1),
      "a".repeat(GLOB_LIMITS.maxChars + 1),
    ];
    for (const glob of tooMany) {
      expect(() => globToRegExp(glob), glob.slice(0, 40)).toThrow(GlobPatternError);
      const g = await runGlob(fs, { pattern: glob });
      expect(g.resultType).toBe("failure");
      expect(text(g)).toMatch(/^Error: glob: /);
      const r = await runRipgrep(fs, { pattern: "a", glob });
      expect(r.resultType).toBe("failure");
      expect(text(r)).toMatch(/^Error: rg: glob /);
    }
    // Within the limits it still works.
    expect(text(await runGlob(fs, { pattern: "{{a,b},c}.txt" }))).toBe("./a.txt");
  });

  it("stops at the time budget with the results so far and a note", async () => {
    const { fs } = await workspace({ "/workspace/a.txt": "alpha\n", "/workspace/b.txt": "alpha\n" });
    const res = await runRipgrep(fs, { pattern: "alpha" }, { timeBudgetMs: 0 });
    expect(res.resultType).toBe("success");
    expect(text(res)).toMatch(/^No matches found\.\n\[The search stopped after 0 s; the results above are incomplete/);
    expect(text(await runRipgrep(fs, { pattern: "alpha" }))).toBe("./a.txt\n./b.txt");
  });
});
