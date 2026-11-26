// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
const logWarn = vi.fn();
vi.mock("@/features/common/services/logger", () => ({ logWarn: (...a: unknown[]) => logWarn(...a), logInfo: vi.fn(), logError: vi.fn() }));

// Document Intelligence: a fake client that records each call.
const analyze = vi.fn();
vi.mock("@/features/common/services/document-intelligence", () => ({
  DocumentIntelligenceInstance: () => ({
    beginAnalyzeDocument: (...args: unknown[]) => analyze(...args),
  }),
}));

// The content store on the in-memory backend (one per test, see beforeEach).
let store: ContentStore;
vi.mock("@/features/common/services/content-store", async () => {
  const { sha256Hex } = await import("@/features/common/services/content-store/content-store");
  return { contentStore: () => store, contentStoreTakesBuffer: () => true, sha256Hex };
});
vi.mock("@/features/common/services/ai-search", () => ({ AzureAISearchInstance: vi.fn() }));
vi.mock("../azure-ai-search/azure-ai-search", () => ({ IndexDocuments: vi.fn() }));

import { createContentStore, type ContentStore } from "@/features/common/services/content-store/content-store";
import { createMemoryContentBlobBackend } from "@/features/common/services/content-store/memory-backend";
import { BlobSessionFs, DataBlobCache, WorkspaceQuota } from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import { extractDocumentText } from "./document-pipeline";
import {
  EXTRACT_TEXT_DESCRIPTION,
  extractTextTool,
  extractWorkspaceText,
  parsePageRange,
  type ExtractTextDeps,
} from "./extract-text";
import { indexWorkspaceDocument, type IndexDocumentDeps } from "./index-document";
import { storeUpload } from "./workspace-uploads";

const USER = "a".repeat(64);
const PDF = Buffer.from("%PDF-1.4\u0000fake pdf bytes");

function diResult(paragraphs: string[], pages: number) {
  return {
    pollUntilDone: async () => ({
      paragraphs: paragraphs.map((content) => ({ content })),
      pages: Array.from({ length: pages }, (_, i) => ({ pageNumber: i + 1 })),
    }),
  };
}

function setup(options: { quota?: WorkspaceQuota; maxBytes?: number } = {}) {
  const fs = new BlobSessionFs(new FakeBlobStore(), `${USER}/thread1`, undefined, new DataBlobCache(1 << 20), options.quota);
  const deps: ExtractTextDeps = {
    fs,
    extract: (data, pages) => extractDocumentText(USER, data, pages),
    maxBytes: options.maxBytes ?? 10 * 1024 * 1024,
  };
  return { fs, deps };
}

beforeEach(() => {
  analyze.mockReset();
  analyze.mockImplementation(async () => diResult(["Title of the report", "First paragraph."], 3));
  store = createContentStore({
    blobs: createMemoryContentBlobBackend(),
    openAiFiles: () => ({ exists: async () => true, upload: async () => "file-1" }),
  });
});

describe("parsePageRange", () => {
  it("accepts Document Intelligence page ranges and removes spaces", () => {
    expect(parsePageRange("1")).toBe("1");
    expect(parsePageRange("1-20")).toBe("1-20");
    expect(parsePageRange("1,3,5-7")).toBe("1,3,5-7");
    expect(parsePageRange(" 2 - 4 , 9 ")).toBe("2-4,9");
    expect(parsePageRange("01-03")).toBe("1-3");
  });

  it("refuses anything else", () => {
    for (const bad of ["", "0", "0-3", "5-3", "a", "1--2", "-1", "1,", ",1", "1;2", "1-2-3", "1.5", "200000", "../1"]) {
      expect(() => parsePageRange(bad), bad).toThrow();
    }
    expect(() => parsePageRange(Array.from({ length: 60 }, (_, i) => String(i + 1)).join(","))).toThrow();
  });
});

describe("extract_text", () => {
  it("extracts a PDF with Document Intelligence, writes <file>.md and returns stats", async () => {
    const { fs, deps } = setup();
    await storeUpload({ fs }, "report.pdf", PDF);
    const res = await extractWorkspaceText(deps, "/workspace/uploads/report.pdf");
    expect(res).toEqual({
      status: "extracted",
      path: "/workspace/uploads/report.pdf.md",
      source: "/workspace/uploads/report.pdf",
      pageCount: 3,
      characters: "Title of the report\nFirst paragraph.".length,
      cached: false,
    });
    expect(await fs.readFile("/workspace/uploads/report.pdf.md")).toBe("Title of the report\nFirst paragraph.");
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0][0]).toBe("prebuilt-read");
    expect(analyze.mock.calls[0]).toHaveLength(2); // no page range option
  });

  it("validates the page range, passes it to Document Intelligence and writes <file>.p<range>.md", async () => {
    const { fs, deps } = setup();
    await storeUpload({ fs }, "big.pdf", PDF);
    analyze.mockImplementation(async () => diResult(["Page one.", "Page two."], 2));
    const res = await extractWorkspaceText(deps, "/workspace/uploads/big.pdf", " 1-2 ");
    expect(res).toMatchObject({ status: "extracted", path: "/workspace/uploads/big.pdf.p1-2.md", pages: "1-2", pageCount: 2 });
    expect(analyze.mock.calls[0][2]).toEqual({ pages: "1-2" });
    expect(await fs.readFile("/workspace/uploads/big.pdf.p1-2.md")).toBe("Page one.\nPage two.");

    const bad = await extractWorkspaceText(deps, "/workspace/uploads/big.pdf", "3-1");
    expect(bad).toMatchObject({ status: "error" });
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("a second call (also from another thread) comes from the cache, per page range", async () => {
    const { fs, deps } = setup();
    await storeUpload({ fs }, "report.pdf", PDF);
    await extractWorkspaceText(deps, "/workspace/uploads/report.pdf");
    const again = await extractWorkspaceText(deps, "/workspace/uploads/report.pdf");
    expect(again).toMatchObject({ status: "extracted", cached: true, characters: 36 });
    expect(again).not.toHaveProperty("pageCount");

    const other = setup();
    await storeUpload({ fs: other.fs }, "copy.pdf", PDF);
    expect(await extractWorkspaceText(other.deps, "/workspace/uploads/copy.pdf")).toMatchObject({ cached: true });
    expect(analyze).toHaveBeenCalledTimes(1);

    // Another page range is its own cache entry.
    expect(await extractWorkspaceText(deps, "/workspace/uploads/report.pdf", "2")).toMatchObject({ cached: false });
    expect(await extractWorkspaceText(deps, "/workspace/uploads/report.pdf", "2")).toMatchObject({ cached: true });
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it("text files need no extraction", async () => {
    const { fs, deps } = setup();
    for (const name of ["notes.txt", "README.md", "data.csv", "cfg.json", "main.py", "notes.unknownext"]) {
      await fs.writeFile(`/workspace/${name}`, "plain text");
      const res = await extractWorkspaceText(deps, `/workspace/${name}`);
      expect(res, name).toMatchObject({ status: "not-needed" });
      expect((res as { message: string }).message).toMatch(/no extraction needed.*view or rg/);
    }
    expect(analyze).not.toHaveBeenCalled();
    expect(await fs.exists("/workspace/notes.txt.md")).toBe(false);
  });

  it("refuses images, unknown binary files and missing files", async () => {
    const { fs, deps } = setup();
    await fs.writeFileBytes("/workspace/a.png", Buffer.from([0x89, 0x50, 0, 1]));
    await fs.writeFileBytes("/workspace/a.bin", Buffer.from([1, 0, 2]));
    expect(await extractWorkspaceText(deps, "/workspace/a.png")).toMatchObject({ status: "error" });
    expect(await extractWorkspaceText(deps, "/workspace/a.bin")).toMatchObject({ status: "error" });
    expect(await extractWorkspaceText(deps, "/workspace/missing.pdf")).toEqual({
      path: "/workspace/missing.pdf",
      status: "error",
      error: "File not found.",
    });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("stays in the workspace jail", async () => {
    const { fs, deps } = setup();
    await fs.writeFile("/session-state/events.pdf", "x");
    for (const p of [
      "../etc/passwd.pdf",
      "/workspace/../session-state/events.pdf",
      "/session-state/events.pdf",
      "/etc/passwd.pdf",
      "C:\\Windows\\a.pdf",
      "\\\\host\\share\\a.pdf",
    ]) {
      expect((await extractWorkspaceText(deps, p)).status, p).toBe("error");
    }
    expect(analyze).not.toHaveBeenCalled();
  });

  it("respects the workspace quota: no .md over the limit, a message for the model", async () => {
    const { fs, deps } = setup({ quota: new WorkspaceQuota(PDF.length + 10, 10) });
    await fs.writeFileBytes("/workspace/uploads/report.pdf", PDF);
    const res = await extractWorkspaceText(deps, "/workspace/uploads/report.pdf");
    expect(res).toMatchObject({ status: "error" });
    expect((res as { error: string }).error).toMatch(/quota/i);
    expect(await fs.exists("/workspace/uploads/report.pdf.md")).toBe(false);
  });

  it("refuses a file at or over the upload limit before Document Intelligence runs", async () => {
    const { fs, deps } = setup({ maxBytes: PDF.length });
    await fs.writeFileBytes("/workspace/uploads/report.pdf", PDF);
    const res = await extractWorkspaceText(deps, "/workspace/uploads/report.pdf");
    expect(res).toMatchObject({ status: "error" });
    expect((res as { error: string }).error).toMatch(/too large/);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("reports a failed extraction to the model", async () => {
    const { fs, deps } = setup();
    await fs.writeFileBytes("/workspace/uploads/report.pdf", PDF);
    analyze.mockRejectedValue(new Error("service unavailable"));
    expect(await extractWorkspaceText(deps, "/workspace/uploads/report.pdf")).toMatchObject({
      status: "error",
      error: "Text extraction failed: Document Intelligence could not read the file.",
    });
    // The service's own text goes to the log, not to the model.
    expect(logWarn).toHaveBeenCalledWith(
      "copilot-runtime: Document Intelligence failed",
      expect.objectContaining({ error: "service unavailable" }),
    );
  });

  it("tool: path + optional pages, a short description", async () => {
    const { fs, deps } = setup();
    await fs.writeFileBytes("/workspace/uploads/report.pdf", PDF);
    const t = extractTextTool(deps);
    const out = await (t.execute as (i: unknown, o: unknown) => Promise<unknown>)(
      { path: "uploads/report.pdf", pages: "1" },
      { toolCallId: "x", messages: [] },
    );
    expect(out).toMatchObject({ status: "extracted", path: "/workspace/uploads/report.pdf.p1.md", pages: "1" });
    expect(EXTRACT_TEXT_DESCRIPTION).toMatch(/pages/);
    expect(EXTRACT_TEXT_DESCRIPTION.length).toBeLessThan(500);
  });
});

describe("index_document with extract_text", () => {
  function indexSetup() {
    const { fs, deps: extractDeps } = setup();
    const indexed: Array<[string, string]> = [];
    const deps: IndexDocumentDeps = {
      fs,
      findRow: async () => undefined,
      saveRow: async () => undefined,
      index: async (name, text) => {
        indexed.push([name, text]);
        return 1;
      },
      extractText: (path) => extractWorkspaceText(extractDeps, path),
    };
    return { fs, deps, indexed };
  }

  it("extracts first when the .md is missing, then indexes its text", async () => {
    const { fs, deps, indexed } = indexSetup();
    await storeUpload({ fs }, "report.pdf", PDF);
    const res = await indexWorkspaceDocument(deps, "/workspace/uploads/report.pdf");
    expect(res).toMatchObject({ status: "indexed", name: "uploads/report.pdf", chunks: 1 });
    expect(indexed).toEqual([["uploads/report.pdf", "Title of the report\nFirst paragraph."]]);
    expect(await fs.exists("/workspace/uploads/report.pdf.md")).toBe(true);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("uses an existing .md without extracting", async () => {
    const { fs, deps, indexed } = indexSetup();
    await fs.writeFileBytes("/workspace/uploads/report.pdf", PDF);
    await fs.writeFile("/workspace/uploads/report.pdf.md", "already extracted");
    await indexWorkspaceDocument(deps, "/workspace/uploads/report.pdf");
    expect(indexed).toEqual([["uploads/report.pdf", "already extracted"]]);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("returns the extraction error and indexes nothing", async () => {
    const { fs, deps, indexed } = indexSetup();
    await fs.writeFileBytes("/workspace/uploads/report.pdf", PDF);
    analyze.mockRejectedValue(new Error("boom"));
    expect(await indexWorkspaceDocument(deps, "/workspace/uploads/report.pdf")).toMatchObject({
      status: "error",
      error: "Text extraction failed: Document Intelligence could not read the file.",
    });
    expect(indexed).toEqual([]);
  });
});
