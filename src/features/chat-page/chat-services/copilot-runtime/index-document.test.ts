import { describe, it, expect, vi, beforeEach } from "vitest";

import { BlobSessionFs, DataBlobCache } from "./blob-session-fs";
import { FakeBlobStore } from "./fake-blob-store.test-helper";
import { indexDocumentTool, indexWorkspaceDocument, INDEX_DOCUMENT_DESCRIPTION, type IndexDocumentDeps } from "./index-document";

function setup() {
  const fs = new BlobSessionFs(new FakeBlobStore(), "userA/thread1", undefined, new DataBlobCache(1 << 20));
  const rows = new Map<string, { id: string; name: string; workspacePath: string; chunkCount: number }>();
  let n = 0;
  const deps: IndexDocumentDeps & { indexCalls: Array<[string, string]> } = {
    fs,
    indexCalls: [],
    async findRow(name) {
      const row = rows.get(name);
      return row ? { id: row.id } : undefined;
    },
    async saveRow(row) {
      rows.set(row.name, { ...row, id: row.id ?? `row-${++n}` });
    },
    async index(name, text) {
      deps.indexCalls.push([name, text]);
      return Math.ceil(text.length / 10);
    },
  };
  return { fs, rows, deps };
}

describe("index_document", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("indexes an uploaded document from its .md text and writes the CHAT_DOCUMENT row", async () => {
    await ctx.fs.writeFileBytes("/workspace/uploads/report.pdf", Buffer.from("%PDF\u0000binary"));
    await ctx.fs.writeFile("/workspace/uploads/report.pdf.md", "Extracted text of the report.");
    const res = await indexWorkspaceDocument(ctx.deps, "/workspace/uploads/report.pdf");
    expect(res).toEqual({ path: "/workspace/uploads/report.pdf", name: "uploads/report.pdf", chunks: 3, status: "indexed" });
    expect(ctx.deps.indexCalls).toEqual([["uploads/report.pdf", "Extracted text of the report."]]);
    expect(ctx.rows.get("uploads/report.pdf")).toMatchObject({
      id: "row-1",
      workspacePath: "/workspace/uploads/report.pdf",
      chunkCount: 3,
    });
  });

  it("the .md path indexes as its document (one row, not two)", async () => {
    await ctx.fs.writeFileBytes("/workspace/uploads/a.docx", Buffer.from("PK\u0000"));
    await ctx.fs.writeFile("/workspace/uploads/a.docx.md", "text");
    const res = await indexWorkspaceDocument(ctx.deps, "/workspace/uploads/a.docx.md");
    expect(res.name).toBe("uploads/a.docx");
    expect([...ctx.rows.keys()]).toEqual(["uploads/a.docx"]);
  });

  it("indexing again replaces the chunks and keeps the same row", async () => {
    await ctx.fs.writeFile("/workspace/notes.txt", "version one");
    await indexWorkspaceDocument(ctx.deps, "/workspace/notes.txt");
    await ctx.fs.writeFile("/workspace/notes.txt", "version two, longer text");
    const again = await indexWorkspaceDocument(ctx.deps, "/workspace/notes.txt");
    expect(again).toMatchObject({ status: "replaced", chunks: 3 });
    expect(ctx.rows.size).toBe(1);
    expect(ctx.rows.get("notes.txt")).toMatchObject({ id: "row-1", chunkCount: 3 });
    expect(ctx.deps.indexCalls.map(([, t]) => t)).toEqual(["version one", "version two, longer text"]);
  });

  it("files the agent created elsewhere in the workspace can be indexed", async () => {
    await ctx.fs.writeFile("/workspace/tool-results/board-1.svg", "<svg>labels</svg>");
    expect((await indexWorkspaceDocument(ctx.deps, "/workspace/tool-results/board-1.svg")).status).toBe("indexed");
  });

  it("stays in the jail and refuses binary or missing files", async () => {
    for (const p of ["/etc/passwd", "C:\\Windows\\win.ini", "/workspace/../session-state/events.jsonl", "/session-state/events.jsonl"]) {
      expect((await indexWorkspaceDocument(ctx.deps, p)).status).toBe("error");
    }
    await ctx.fs.writeFileBytes("/workspace/uploads/img.png", Buffer.from([0x89, 0x50, 0x00, 0x01]));
    expect((await indexWorkspaceDocument(ctx.deps, "/workspace/uploads/img.png")).error).toMatch(/no text/);
    expect((await indexWorkspaceDocument(ctx.deps, "/workspace/nope.txt")).error).toBe("File not found.");
    expect(ctx.deps.indexCalls).toEqual([]);
    expect(ctx.rows.size).toBe(0);
  });

  it("tool: several paths, a short result, a description that limits when to index", async () => {
    await ctx.fs.writeFile("/workspace/a.txt", "aaaa");
    await ctx.fs.writeFile("/workspace/b.txt", "bbbb");
    const t = indexDocumentTool(ctx.deps);
    const out = await (t.execute as (i: unknown, o: unknown) => Promise<unknown>)(
      { paths: ["/workspace/a.txt", "/workspace/b.txt"] },
      { toolCallId: "x", messages: [] },
    );
    expect(out).toEqual({
      results: [
        { path: "/workspace/a.txt", name: "a.txt", chunks: 1, status: "indexed" },
        { path: "/workspace/b.txt", name: "b.txt", chunks: 1, status: "indexed" },
      ],
    });
    expect(INDEX_DOCUMENT_DESCRIPTION).toMatch(/only when a file is too large to read with view or rg, or when you need semantic/);
  });
});
