import { describe, it, expect, vi } from "vitest";

vi.mock("@/features/common/services/cosmos", () => ({ HistoryContainer: vi.fn() }));
vi.mock("./document-pipeline", () => ({ extractMarkdown: vi.fn(), indexDocument: vi.fn() }));
vi.mock("./azure-blob-store", () => ({ getAgentWorkspaceStore: vi.fn(), getExistingAgentWorkspaceStore: vi.fn() }));

import { BlobSessionFs, DataBlobCache } from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import {
  sanitizeUploadName,
  storeUpload,
  uniqueUploadName,
  uploadKind,
  uploadsNote,
  UPLOADS_DIR,
} from "./workspace-uploads";
import { removeThreadWorkspaceFiles } from "./workspace-files";

const USER_A = "a".repeat(64);
const USER_B = "b".repeat(64);

function setup(store = new FakeBlobStore()) {
  const extract = vi.fn(async (data: Buffer) => `# text of ${data.length} bytes\n`);
  const workspace = (user: string, thread: string) => ({
    fs: new BlobSessionFs(store, `${user}/${thread}`, undefined, new DataBlobCache(1 << 20)),
    extractMarkdown: extract,
  });
  return { store, extract, workspace };
}

describe("upload names", () => {
  it("keeps only a safe last path segment", () => {
    expect(sanitizeUploadName("report.pdf")).toBe("report.pdf");
    expect(sanitizeUploadName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeUploadName("C:\\Users\\x\\Q3 plan?.docx")).toBe("Q3 plan_.docx");
    expect(sanitizeUploadName("..")).toBe("file");
    expect(sanitizeUploadName("  .hidden  ")).toBe("hidden");
    expect(sanitizeUploadName("a\u0000b.txt")).toBe("a_b.txt");
    expect(sanitizeUploadName(".~dir")).toBe("~dir"); // never the directory marker name
    const long = sanitizeUploadName(`${"x".repeat(300)}.pdf`);
    expect(long.length).toBe(120);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("makes names unique, keeping the .md companion free for documents", () => {
    expect(uniqueUploadName("a.pdf", new Set(), true)).toBe("a.pdf");
    expect(uniqueUploadName("a.pdf", new Set(["a.pdf", "a.pdf.md"]), true)).toBe("a (2).pdf");
    expect(uniqueUploadName("a.pdf", new Set(["a.pdf.md"]), true)).toBe("a (2).pdf");
    expect(uniqueUploadName("a.png", new Set(["a.png", "a (2).png"]), false)).toBe("a (3).png");
    expect(uniqueUploadName("notes", new Set(["notes"]), false)).toBe("notes (2)");
  });

  it("classifies uploads", () => {
    expect(uploadKind("x.PDF")).toBe("document");
    expect(uploadKind("x.docx")).toBe("document");
    expect(uploadKind("x.png")).toBe("image");
    expect(uploadKind("x.csv")).toBe("text");
    expect(uploadKind("x.zip")).toBe("binary");
  });
});

describe("storeUpload", () => {
  it("stores the original and, for documents, the extracted Markdown next to it", async () => {
    const { workspace, extract } = setup();
    const ws = workspace(USER_A, "t1");
    const res = await storeUpload(ws, "Report.pdf", Buffer.from("%PDF-1.4 fake"));
    expect(res).toMatchObject({
      path: `${UPLOADS_DIR}/Report.pdf`,
      markdownPath: `${UPLOADS_DIR}/Report.pdf.md`,
      kind: "document",
    });
    expect(await ws.fs.readFile(`${UPLOADS_DIR}/Report.pdf.md`)).toBe("# text of 13 bytes\n");
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("stores an image as exact bytes, without extraction", async () => {
    const { workspace, extract } = setup();
    const ws = workspace(USER_A, "t1");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    const res = await storeUpload(ws, "photo.png", png);
    expect(res).toMatchObject({ path: `${UPLOADS_DIR}/photo.png`, kind: "image" });
    expect(res.markdownPath).toBeUndefined();
    expect(Buffer.from(await ws.fs.readFileBytes(`${UPLOADS_DIR}/photo.png`))).toEqual(png);
    expect(extract).not.toHaveBeenCalled();
  });

  it("different bytes under the same name get a unique name", async () => {
    const { workspace } = setup();
    const ws = workspace(USER_A, "t1");
    await storeUpload(ws, "a.pdf", Buffer.from("one"));
    const second = await storeUpload(ws, "a.pdf", Buffer.from("two"));
    expect(second.path).toBe(`${UPLOADS_DIR}/a (2).pdf`);
    expect(second.markdownPath).toBe(`${UPLOADS_DIR}/a (2).pdf.md`);
  });

  it("names the uploads for the model", async () => {
    const { workspace } = setup();
    const ws = workspace(USER_A, "t1");
    await storeUpload(ws, "a.pdf", Buffer.from("x"));
    expect(uploadsNote(await ws.fs.listEntries(UPLOADS_DIR))).toContain("/workspace/uploads/a.pdf, /workspace/uploads/a.pdf.md");
    expect(uploadsNote([])).toBeUndefined();
  });
});

describe("removeThreadWorkspaceFiles", () => {
  it("deleting the chat documents removes only that thread's uploads", async () => {
    const { workspace, store } = setup();
    const t1 = workspace(USER_A, "t1");
    await storeUpload(t1, "a.pdf", Buffer.from("x"));
    await t1.fs.writeFile("/workspace/notes.txt", "keep");
    await t1.fs.writeFile("/session-state/events.jsonl", "{}");
    const t2 = workspace(USER_A, "t2");
    await storeUpload(t2, "a.pdf", Buffer.from("x"));

    const removed = await removeThreadWorkspaceFiles(USER_A, "t1", "uploads", store);
    expect(removed).toBe(4); // a.pdf + a.pdf.md: 2 pointers + 2 data blobs
    expect(await t1.fs.exists(`${UPLOADS_DIR}/a.pdf`)).toBe(false);
    expect(await t1.fs.readFile("/workspace/notes.txt")).toBe("keep");
    expect(await t2.fs.exists(`${UPLOADS_DIR}/a.pdf`)).toBe(true);
  });

  it("deleting the thread removes its whole namespace, nothing else", async () => {
    const { workspace, store } = setup();
    const t1 = workspace(USER_A, "t1");
    await storeUpload(t1, "a.pdf", Buffer.from("x"));
    await t1.fs.writeFile("/session-state/events.jsonl", "{}");
    const t2 = workspace(USER_A, "t2");
    await t2.fs.writeFile("/workspace/b.txt", "b");
    await removeThreadWorkspaceFiles(USER_A, "t1", "all", store);
    expect([...store.blobs.keys()].some((k) => k.startsWith(`${USER_A}/t1/`))).toBe(false);
    expect(await t2.fs.readFile("/workspace/b.txt")).toBe("b");
  });

  it("rejects a crafted thread id", async () => {
    const { store } = setup();
    await expect(removeThreadWorkspaceFiles(USER_A, "../x", "all", store)).rejects.toThrow();
  });
});
