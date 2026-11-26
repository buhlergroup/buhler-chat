import { describe, it, expect, beforeEach } from "vitest";

import builtin from "./builtin-search-tools.json";
import { BlobSessionFs, DataBlobCache } from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import {
  buildSearchRegex,
  globToRegExp,
  literalGlobPrefix,
  runGlob,
  runRipgrep,
  workspaceTools,
} from "./workspace-tools";

const NS = "userA/thread1";

async function workspace(files: Record<string, string | Buffer>, cacheBytes = 64 * 1024 * 1024) {
  const store = new FakeBlobStore();
  const cache = new DataBlobCache(cacheBytes);
  const fs = new BlobSessionFs(store, NS, undefined, cache);
  for (const [path, content] of Object.entries(files)) {
    if (typeof content === "string") await fs.writeFile(path, content);
    else await fs.writeFileBytes(path, content);
  }
  store.requests = [];
  return { store, fs, cache };
}

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

  it("a regex JavaScript cannot run fails with an explanation, not silently", async () => {
    const res = await runRipgrep(ws.fs, { pattern: "(" });
    expect(res.resultType).toBe("failure");
    expect(text(res)).toMatch(/^Error: rg: regex parse error: .*\nNote: patterns run as JavaScript regular expressions, not Rust regex/s);
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

  it("caches immutable data blobs: a warm search downloads nothing", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`/workspace/f${i}.txt`] = `line ${i}\nneedle ${i}\n`;
    const { fs, store, cache } = await workspace(files);
    await runRipgrep(fs, { pattern: "needle", output_mode: "count" });
    const cold = store.requests.filter((r) => r.startsWith("download")).length;
    store.requests = [];
    const warm = await runRipgrep(fs, { pattern: "needle", output_mode: "count" });
    expect(cold).toBe(40);
    expect(store.requests).toEqual([`listDetailed ${NS}/f/workspace/`]);
    expect(text(warm).split("\n")).toHaveLength(40);
    expect(cache.hits).toBe(40);
  });

  it("a rewritten file is a new data blob, so the cache never serves old content", async () => {
    const { fs } = await workspace({ "/workspace/a.txt": "old value" });
    expect(text(await runRipgrep(fs, { pattern: "old", output_mode: "content" }))).toBe("./a.txt:old value");
    await fs.writeFile("/workspace/a.txt", "new value");
    expect(text(await runRipgrep(fs, { pattern: "value", output_mode: "content" }))).toBe("./a.txt:new value");
    await fs.appendFile("/workspace/a.txt", "\nappended");
    expect(text(await runRipgrep(fs, { pattern: "appended", output_mode: "content" }))).toBe("./a.txt:appended");
  });

  it("stops early at head_limit and skips large and binary files", async () => {
    const files: Record<string, string | Buffer> = {};
    for (let i = 0; i < 100; i++) files[`/workspace/f${String(i).padStart(3, "0")}.txt`] = "hit\n";
    files["/workspace/aaa-binary.bin"] = Buffer.from([0x68, 0x69, 0x74, 0x00, 0x01]);
    files["/workspace/aab-large.txt"] = "hit\n" + "x".repeat(2 * 1024 * 1024 + 10);
    const { fs, store } = await workspace(files);
    const res = await runRipgrep(fs, { pattern: "hit", head_limit: 3 });
    expect(text(res)).toBe("./f000.txt\n./f001.txt\n./f002.txt");
    const downloads = store.requests.filter((r) => r.startsWith("download")).length;
    expect(downloads).toBeLessThanOrEqual(16); // one parallel batch, the large file is not downloaded
    expect(store.requests.some((r) => r.startsWith("download") && r.includes("aab-large"))).toBe(false);
  });

  it("LRU cache evicts by bytes", () => {
    const cache = new DataBlobCache(10);
    cache.set("a", Buffer.alloc(6));
    cache.set("b", Buffer.alloc(6));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")?.length).toBe(6);
    cache.set("huge", Buffer.alloc(11));
    expect(cache.get("huge")).toBeUndefined();
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
    const other = new BlobSessionFs(store, "userB/thread2", undefined, new DataBlobCache(1024));
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
  });
});
