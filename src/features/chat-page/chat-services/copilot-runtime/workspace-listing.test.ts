// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { BlobSessionFs } from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import {
  derivedExtractPaths,
  extractSourceOf,
  listWorkspaceFiles,
  removeWorkspaceFile,
  summarizeWorkspace,
  workspacePathFromClient,
  WorkspaceFileNotFoundError,
} from "./workspace-listing";

const NS = "user1/thread1";
const OTHER_NS = "user1/thread2";

let store: FakeBlobStore;
let fs: BlobSessionFs;
let clock = Date.parse("2026-01-01T00:00:00Z");

/** Writes a file and stamps its pointer with a later time than the one before. */
async function put(target: BlobSessionFs, path: string, content = "x"): Promise<void> {
  await target.writeFileBytes(path, Buffer.from(content));
  const ns = target === fs ? NS : OTHER_NS;
  const pointer = store.blobs.get(`${ns}/f${path}`)!;
  clock += 1000;
  pointer.at = new Date(clock);
}

const paths = (files: { path: string }[]) => files.map((f) => f.path);

describe("workspace listing (Files panel and upload chips)", () => {
  beforeEach(() => {
    store = new FakeBlobStore();
    fs = new BlobSessionFs(store, NS, undefined, undefined);
  });

  it("lists every file under /workspace recursively, newest first, never /session-state", async () => {
    await put(fs, "/workspace/uploads/report.pdf", "%PDF");
    await put(fs, "/workspace/out/chart.png");
    await put(fs, "/workspace/uploads/report.pdf.md", "# text");
    await put(fs, "/workspace/tool-results/run-1.txt");
    await fs.writeFile("/session-state/events.jsonl", "{}\n");
    await fs.mkdir("/workspace/empty", true);

    const listing = await listWorkspaceFiles({ fs });

    expect(paths(listing.files)).toEqual([
      "tool-results/run-1.txt",
      "uploads/report.pdf.md",
      "out/chart.png",
      "uploads/report.pdf",
    ]);
    expect(listing.total).toBe(4);
    expect(listing.truncated).toBe(false);
    expect(JSON.stringify(listing)).not.toContain("session-state");
    expect(listing.files[0]).toMatchObject({ name: "run-1.txt", size: 1, group: "created" });
    expect(listing.files[0].modified).toMatch(/^2026-01-01T/);
  });

  it("groups the user's uploads apart from created files; a text extract counts as created", async () => {
    await put(fs, "/workspace/uploads/report.pdf");
    await put(fs, "/workspace/uploads/report.pdf.md");
    await put(fs, "/workspace/uploads/report.pdf.p1-3.md");
    await put(fs, "/workspace/uploads/notes.md");
    await put(fs, "/workspace/uploads/sub/inner.txt");
    await put(fs, "/workspace/result.xlsx");

    const { files } = await listWorkspaceFiles({ fs });
    const group = Object.fromEntries(files.map((f) => [f.path, f.group]));

    expect(group).toEqual({
      "uploads/report.pdf": "uploaded",
      "uploads/notes.md": "uploaded",
      "uploads/report.pdf.md": "created",
      "uploads/report.pdf.p1-3.md": "created",
      "uploads/sub/inner.txt": "created",
      "result.xlsx": "created",
    });
  });

  it("is bounded: the newest files up to the limit, with the total", async () => {
    for (let i = 0; i < 7; i++) await put(fs, `/workspace/out/f${i}.txt`);

    const listing = await listWorkspaceFiles({ fs }, 3);

    expect(paths(listing.files)).toEqual(["out/f6.txt", "out/f5.txt", "out/f4.txt"]);
    expect(listing.total).toBe(7);
    expect(listing.truncated).toBe(true);
  });

  it("summary: only this thread's uploads, newest first, bounded, and the count of all files", async () => {
    const other = new BlobSessionFs(store, OTHER_NS, undefined, undefined);
    await put(other, "/workspace/uploads/foreign.pdf");
    await put(fs, "/workspace/uploads/a.csv");
    await put(fs, "/workspace/uploads/b.docx");
    await put(fs, "/workspace/uploads/b.docx.md");
    await put(fs, "/workspace/uploads/c.txt");
    await put(fs, "/workspace/out/made.png");

    const summary = await summarizeWorkspace({ fs }, 2);

    expect(paths(summary.uploads)).toEqual(["uploads/c.txt", "uploads/b.docx"]);
    expect(summary.uploads.every((u) => u.group === "uploaded")).toBe(true);
    expect(summary.fileCount).toBe(5);
    expect(JSON.stringify(summary)).not.toContain("foreign");
  });

  it("knows the text extract names extract_text writes", () => {
    const existing = new Set(["/workspace/uploads/a.pdf", "/workspace/uploads/n.txt"]);
    expect(extractSourceOf("/workspace/uploads/a.pdf.md", existing)).toBe("/workspace/uploads/a.pdf");
    expect(extractSourceOf("/workspace/uploads/a.pdf.p1,3,5-7.md", existing)).toBe("/workspace/uploads/a.pdf");
    expect(extractSourceOf("/workspace/uploads/a.pdf.notes.md", existing)).toBeUndefined();
    expect(extractSourceOf("/workspace/uploads/n.txt.md", existing)).toBeUndefined();
    expect(extractSourceOf("/workspace/uploads/gone.pdf.md", existing)).toBeUndefined();
    expect(
      derivedExtractPaths("/workspace/u/a.pdf", ["/workspace/u/a.pdf.md", "/workspace/u/a.pdf.p2-4.md", "/workspace/u/a.pdf.px.md", "/workspace/u/a.pdf"]),
    ).toEqual(["/workspace/u/a.pdf.md", "/workspace/u/a.pdf.p2-4.md"]);
  });
});

describe("workspacePathFromClient", () => {
  it("accepts a path relative to /workspace", () => {
    expect(workspacePathFromClient("uploads/a.pdf")).toBe("/workspace/uploads/a.pdf");
    expect(workspacePathFromClient("out/sub/b c.txt")).toBe("/workspace/out/sub/b c.txt");
  });

  it.each([
    ["empty", ""],
    ["parent", "../x"],
    ["parent inside", "uploads/../x"],
    ["absolute session state", "/session-state/events.jsonl"],
    ["absolute workspace", "/workspace/uploads/a.pdf"],
    ["backslash", "uploads\\a.pdf"],
    ["backslash parent", "..\\session-state\\x"],
    ["dot", "."],
    ["empty segment", "uploads//a.pdf"],
    ["trailing slash", "uploads/"],
    ["control char", "uploads/a\u0000.pdf"],
    ["directory marker", "uploads/.~dir"],
    ["not a string", 42],
  ])("refuses %s", (_label, raw) => {
    expect(() => workspacePathFromClient(raw)).toThrow();
  });
});

describe("removeWorkspaceFile", () => {
  beforeEach(() => {
    store = new FakeBlobStore();
    fs = new BlobSessionFs(store, NS, undefined, undefined);
  });

  it("deletes the file and its text extracts, nothing else", async () => {
    await put(fs, "/workspace/uploads/report.pdf");
    await put(fs, "/workspace/uploads/report.pdf.md");
    await put(fs, "/workspace/uploads/report.pdf.p1-3.md");
    await put(fs, "/workspace/uploads/report.pdf.notes.md");
    await put(fs, "/workspace/uploads/report.pdf (2).pdf");
    await put(fs, "/workspace/uploads/other.pdf.md");
    await put(fs, "/workspace/out/report.pdf.md");
    await fs.writeFile("/session-state/events.jsonl", "{}\n");

    const removed = await removeWorkspaceFile({ fs }, "uploads/report.pdf");

    expect(removed.sort()).toEqual(["uploads/report.pdf", "uploads/report.pdf.md", "uploads/report.pdf.p1-3.md"]);
    expect((await fs.listFiles("/workspace")).sort()).toEqual([
      "/workspace/out/report.pdf.md",
      "/workspace/uploads/other.pdf.md",
      "/workspace/uploads/report.pdf (2).pdf",
      "/workspace/uploads/report.pdf.notes.md",
    ]);
    expect(await fs.exists("/session-state/events.jsonl")).toBe(true);
    // No orphaned data blobs of the removed files.
    const targets = [...store.blobs.values()].map((b) => b.metadata.target).filter(Boolean);
    const dataBlobs = [...store.blobs.keys()].filter((k) => k.includes("/d/"));
    expect(dataBlobs.sort()).toEqual(targets.sort());
  });

  it("deletes a created file under any folder of /workspace", async () => {
    await put(fs, "/workspace/out/chart.png");
    await put(fs, "/workspace/out/keep.png");
    expect(await removeWorkspaceFile({ fs }, "out/chart.png")).toEqual(["out/chart.png"]);
    expect(await fs.listFiles("/workspace")).toEqual(["/workspace/out/keep.png"]);
  });

  it("does not delete a folder", async () => {
    await put(fs, "/workspace/out/a.txt");
    await expect(removeWorkspaceFile({ fs }, "out")).rejects.toBeInstanceOf(WorkspaceFileNotFoundError);
    expect(await fs.listFiles("/workspace")).toEqual(["/workspace/out/a.txt"]);
  });

  it("does not reach another thread", async () => {
    const other = new BlobSessionFs(store, OTHER_NS, undefined, undefined);
    await put(other, "/workspace/uploads/a.pdf");
    await expect(removeWorkspaceFile({ fs }, "uploads/a.pdf")).rejects.toBeInstanceOf(WorkspaceFileNotFoundError);
    expect(await other.listFiles("/workspace")).toEqual(["/workspace/uploads/a.pdf"]);
  });

  it.each(["../x", "a\\b", "", "/session-state/events.jsonl", "uploads/../../x"])("refuses %j before any Blob call", async (raw) => {
    await fs.writeFile("/session-state/events.jsonl", "{}\n");
    store.requests.length = 0;
    await expect(removeWorkspaceFile({ fs }, raw)).rejects.toThrow();
    expect(store.requests).toEqual([]);
    expect(await fs.exists("/session-state/events.jsonl")).toBe(true);
  });

  it("handles a name with '..' inside (lists the folder for the extracts)", async () => {
    await put(fs, "/workspace/uploads/a..b.pdf");
    await put(fs, "/workspace/uploads/a..b.pdf.md");
    expect((await removeWorkspaceFile({ fs }, "uploads/a..b.pdf")).sort()).toEqual([
      "uploads/a..b.pdf",
      "uploads/a..b.pdf.md",
    ]);
  });
});
