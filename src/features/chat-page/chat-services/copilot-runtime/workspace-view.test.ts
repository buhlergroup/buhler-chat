import { describe, it, expect } from "vitest";

import builtinView from "./builtin-view-tool.json";
import { BlobSessionFs } from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import { runView, VIEW_OUTPUT_BYTES, workspaceViewTool } from "./workspace-view";

const NS = "userA/thread1";
const rows = (n: number, w = 10) => Array.from({ length: n }, (_, i) => `row ${i + 1} ${"y".repeat(w)}`).join("\n");

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
const dataKeyOf = async (store: FakeBlobStore, path: string) =>
  (await store.getProperties(`${NS}/f${path}`))!.metadata.target;
const text = (r: { textResultForLlm: string }) => r.textResultForLlm;

// Expected outputs below were measured on the runtime's built-in view (runtime
// 1.0.116) with the same files: same text, byte for byte.
describe("view: output of the built-in", () => {
  const files = {
    "/workspace/small.txt": `${rows(5)}\n`,
    "/workspace/nonl.txt": "a\nb",
    "/workspace/crlf.txt": "one\r\ntwo\r\nthree\r\n",
    "/workspace/crend.txt": "a\r\nb\r",
    "/workspace/empty.txt": "",
    "/workspace/mid.txt": `${rows(3000, 20)}\n`,
    "/workspace/longline.txt": `${"z".repeat(50_000)}\nshort\n`,
    "/workspace/sub/a.md": "# a\n",
    "/workspace/sub/deeper/b.md": "# b\n",
    "/workspace/twenty.txt": "q".repeat(20481),
    "/workspace/nineteen.txt": "q".repeat(20480),
  };

  it("whole files, ranges and the range errors", async () => {
    const { fs } = await workspace(files);
    const v = async (args: Record<string, unknown>) => text(await runView(fs, args));
    expect(await v({ path: "/workspace/small.txt" })).toBe(`${rows(5)}\n`);
    expect(await v({ path: "small.txt" })).toBe(`${rows(5)}\n`);
    expect(await v({ path: "/workspace/small.txt", view_range: [2, 3] })).toBe("row 2 yyyyyyyyyy\nrow 3 yyyyyyyyyy");
    expect(await v({ path: "/workspace/small.txt", view_range: [4, -1] })).toBe("row 4 yyyyyyyyyy\nrow 5 yyyyyyyyyy\n");
    expect(await v({ path: "/workspace/small.txt", view_range: [5, 8] })).toBe("row 5 yyyyyyyyyy\n");
    expect(await v({ path: "/workspace/small.txt", view_range: [6, 6] })).toBe("");
    expect(await v({ path: "/workspace/small.txt", view_range: [7, 9] })).toBe(
      "Invalid view_range: start line (7) is beyond the end of the file. The file has 6 lines.",
    );
    expect(await v({ path: "/workspace/small.txt", view_range: [3, 2] })).toBe(
      "Invalid view_range: end line (2) must be greater than or equal to start line (3).",
    );
    expect(await v({ path: "/workspace/small.txt", view_range: [0, 2] })).toBe(
      "Invalid view_range: start line (0) must be greater than or equal to 1.",
    );
    expect(await v({ path: "/workspace/nonl.txt" })).toBe("a\nb");
    expect(await v({ path: "/workspace/crlf.txt" })).toBe("one\r\ntwo\r\nthree\r\n");
    expect(await v({ path: "/workspace/crlf.txt", view_range: [2, 3] })).toBe("two\r\nthree");
    expect(await v({ path: "/workspace/crend.txt" })).toBe("a\r\nb");
    expect(await v({ path: "/workspace/empty.txt" })).toBe("");
    expect(await v({ path: "/workspace/empty.txt", view_range: [1, 1] })).toBe(
      "Invalid view_range: start line (1) is beyond the end of the file. The file has 0 lines.",
    );
  });

  it("size limits: whole files over 20 KB, the 20,480-byte output cap, a first line over it", async () => {
    const { fs } = await workspace(files);
    const v = async (args: Record<string, unknown>) => text(await runView(fs, args));
    expect(await v({ path: "/workspace/nineteen.txt" })).toBe("q".repeat(20480));
    expect(await v({ path: "/workspace/twenty.txt" })).toBe(
      "File too large to read at once (20.0 KB). Consider using the grep tool to search within the file, or view with view_range to read specific sections.",
    );
    expect(await v({ path: "/workspace/mid.txt" })).toBe(
      "File too large to read at once (86.8 KB). Consider using the grep tool to search within the file, or view with view_range to read specific sections.",
    );
    expect(text(await runView(fs, { path: "/workspace/mid.txt" }, { searchToolName: "rg" }))).toContain("using the rg tool");
    expect(await v({ path: "/workspace/mid.txt", forceReadLargeFiles: true })).toBe(files["/workspace/mid.txt"]);
    expect(await v({ path: "/workspace/mid.txt", view_range: [1000, 1002] })).toBe(
      "row 1000 yyyyyyyyyyyyyyyyyyyy\nrow 1001 yyyyyyyyyyyyyyyyyyyy\nrow 1002 yyyyyyyyyyyyyyyyyyyy",
    );
    const capped = await v({ path: "/workspace/mid.txt", view_range: [1, 2500] });
    expect(capped).toBe(
      `${rows(709, 20)}\n\n[Output truncated. Use view_range=[710, ...] to continue reading. In your next response, you may batch this with other view calls. File has at least 710 lines.]`,
    );
    expect(Buffer.byteLength(rows(709, 20))).toBeLessThanOrEqual(VIEW_OUTPUT_BYTES);
    expect(Buffer.byteLength(rows(710, 20))).toBeGreaterThan(VIEW_OUTPUT_BYTES);
    expect(await v({ path: "/workspace/longline.txt", view_range: [1, 1] })).toBe(
      `${"z".repeat(20480)}\n\n[Output truncated. Line 1 truncated after 20480 bytes. Use other tools to examine the rest of this line.]`,
    );
    expect(await v({ path: "/workspace/longline.txt", view_range: [2, 3] })).toBe("short\n");
  });

  it("directories, missing paths, the jail and denied paths", async () => {
    const { fs, store } = await workspace(files);
    expect(text(await runView(fs, { path: "/workspace/sub" }))).toBe("a.md\ndeeper");
    expect(text(await runView(fs, { path: "/workspace/sub", view_range: [1, 2] }))).toBe("a.md\ndeeper");
    expect(text(await runView(fs, { path: "/workspace/missing.txt" }))).toBe(
      "Path /workspace/missing.txt does not exist. Please provide a valid path.",
    );
    store.requests = [];
    for (const path of ["/etc/passwd", "/workspace/../session-state/x", "C:\\Windows\\win.ini"]) {
      const r = await runView(fs, { path });
      expect(r.resultType, path).toBe("failure");
      expect(text(r), path).toBe(`Path ${path} does not exist. Please provide a valid path.`);
    }
    expect(store.requests).toEqual([]);
    const denied = await runView(fs, { path: "/workspace/small.txt" }, { readDenied: (p) => p === "/workspace/small.txt" });
    expect([denied.resultType, text(denied)]).toEqual(["failure", "This path cannot be read."]);
    expect(store.requests).toEqual([]);
  });

  it("an image returns its bytes for the model, like the built-in", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const { fs } = await workspace({ "/workspace/images/cat.png": png });
    const r = await runView(fs, { path: "/workspace/images/cat.png" });
    expect(text(r)).toBe("Viewed image file successfully.");
    expect(r.binaryResultsForLlm).toEqual([
      { data: png.toString("base64"), mimeType: "image/png", type: "image", description: "Image file at path /workspace/images/cat.png" },
    ]);
  });
});

describe("view: streamed and bounded", () => {
  it("a range stops the download after its last line", async () => {
    const big = `${rows(200_000, 40)}\n`; // ~10 MB
    const { fs, store } = await workspace({ "/workspace/big.txt": big });
    store.chunkSize = 64 * 1024;
    const key = await dataKeyOf(store, "/workspace/big.txt");
    const total = Math.ceil(Buffer.byteLength(big) / store.chunkSize);
    expect(text(await runView(fs, { path: "/workspace/big.txt", view_range: [100, 102] }))).toBe(
      big.split("\n").slice(99, 102).join("\n"),
    );
    expect(store.chunksServed.get(key)).toBeLessThanOrEqual(2);
    expect(store.aborted).toContain(key);
    // A capped range in the middle also stops at the cap, not at the end of the file.
    store.chunksServed.clear();
    const mid = text(await runView(fs, { path: "/workspace/big.txt", view_range: [100_000, -1] }));
    expect(mid).toMatch(/\[Output truncated\. Use view_range=\[100\d{3}, \.\.\.\]/);
    expect(store.chunksServed.get(key)).toBeLessThan(total);
    // Beyond the end: the whole file is read (only newlines counted) to say how many lines it has.
    expect(text(await runView(fs, { path: "/workspace/big.txt", view_range: [300_000, 300_001] }))).toBe(
      "Invalid view_range: start line (300000) is beyond the end of the file. The file has 200001 lines.",
    );
    // Whole file over 10 MB: refused from the size alone, no download.
    store.requests = [];
    const huge = await workspace({ "/workspace/huge.txt": "x".repeat(10 * 1024 * 1024 + 1) });
    huge.store.requests = [];
    expect(text(await runView(huge.fs, { path: "/workspace/huge.txt", forceReadLargeFiles: true }))).toMatch(
      /^File is too large to view \(10\.0MB\)\. Maximum file size is 10MB\./,
    );
    expect(huge.store.requests.filter((r) => r.startsWith("download"))).toEqual([]);
  });

  it("the tool has the built-in's name, description and schema and never lets the runtime spill it", async () => {
    const { fs } = await workspace({ "/workspace/a.txt": `${rows(3000, 20)}\n` });
    const tool = workspaceViewTool(fs, "gpt");
    expect([tool.name, tool.description, tool.parameters]).toEqual([builtinView.name, builtinView.description, builtinView.parameters]);
    expect(tool.overridesBuiltInTool).toBe(true);
    const result = (await tool.handler!({ path: "/workspace/a.txt", view_range: [1, 2000] }, {} as never)) as {
      textResultForLlm: string;
      skipLargeOutputProcessing?: boolean;
    };
    expect(result.skipLargeOutputProcessing).toBe(true);
    expect(result.textResultForLlm.length).toBeGreaterThan(16 * 1024);
    const whole = (await tool.handler!({ path: "/workspace/a.txt" }, {} as never)) as { textResultForLlm: string };
    expect(whole.textResultForLlm).toContain("using the rg tool");
  });
});
