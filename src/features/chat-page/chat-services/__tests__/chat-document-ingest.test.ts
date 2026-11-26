// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// Chat document upload through the content store: counts of blob writes,
// Document Intelligence calls and indexing runs, with fakes for Cosmos,
// AI Search and Document Intelligence and the in-memory blob backend.

type Row = Record<string, any>;
let rows: Row[] = [];

const matches = (query: string, params: Array<{ name: string; value: unknown }>, row: Row) => {
  const p = Object.fromEntries(params.map((x) => [x.name, x.value]));
  const field = /r\.(sha256|name) = @value/.exec(query)?.[1];
  return (
    row.type === p["@type"] &&
    row.userId === p["@userId"] &&
    row.chatThreadId === p["@threadId"] &&
    row.isDeleted === false &&
    (!field || row[field] === p["@value"])
  );
};

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: {
      upsert: async (doc: Row) => {
        rows = rows.filter((r) => r.id !== doc.id);
        rows.push({ ...doc });
        return { resource: doc };
      },
      query: (spec: { query: string; parameters: any[] }) => ({
        fetchAll: async () => ({
          resources: rows.filter((r) => matches(spec.query, spec.parameters, r)),
        }),
      }),
    },
  }),
}));

const extract = vi.fn(async (_bytes: Uint8Array) => "first paragraph\nsecond paragraph");
vi.mock("@/features/common/services/document-extraction", () => ({
  extractTextWithDocumentIntelligence: (bytes: Uint8Array) => extract(bytes),
}));

const indexed: Array<{ chunks: string[]; fileName?: string; threadId?: string; user?: string }> = [];
const deletedChunkIds: string[][] = [];
vi.mock("@/features/chat-page/chat-services/azure-ai-search/azure-ai-search", () => ({
  EnsureIndexIsCreated: async () => ({ status: "OK", response: {} }),
  IndexDocuments: async (
    chunks: string[],
    fileName?: string,
    threadId?: string,
    _persona?: string,
    user?: string
  ) => {
    indexed.push({ chunks, fileName, threadId, user });
    return chunks.map(() => ({ status: "OK", response: true }));
  },
  FindChatDocumentChunkIds: async () => ["old-chunk-1"],
  DeleteChunksByIds: async (ids: string[]) => {
    deletedChunkIds.push(ids);
  },
}));

vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { ingestChatDocument } from "../chat-document-ingest";
import { resolve, SERVICE_KEYS } from "@/features/common/services/service-container";
import type { MemoryContentBlobBackend } from "@/features/common/services/content-store/memory-backend";
import { createMemoryContentBlobBackend } from "@/features/common/services/content-store/memory-backend";
import { register } from "@/features/common/services/service-container";

const userA = "a".repeat(64);
const userB = "b".repeat(64);
const pdf = Buffer.from("%PDF-1.7 fake pdf bytes");

const upload = (userId: string, threadId: string, bytes = pdf, fileName = "report.pdf") =>
  ingestChatDocument({
    userId,
    threadId,
    fileName,
    file: new Blob([new Uint8Array(bytes)]),
    contentType: "application/pdf",
  });

const blobs = () => resolve<MemoryContentBlobBackend>(SERVICE_KEYS.contentBlobs);

beforeEach(() => {
  rows = [];
  indexed.length = 0;
  deletedChunkIds.length = 0;
  extract.mockClear();
  register(SERVICE_KEYS.contentBlobs, createMemoryContentBlobBackend);
});

describe("chat-page.unit.document-ingest — content store", () => {
  it("same bytes twice in the same thread: one blob write, one extraction, one indexing", async () => {
    const first = await upload(userA, "thread1");
    const second = await upload(userA, "thread1");

    expect(first.status).toBe("OK");
    expect(second.status).toBe("OK");
    if (first.status !== "OK" || second.status !== "OK") return;
    expect(first.response).toMatchObject({ extracted: true, indexing: "indexed" });
    expect(second.response).toMatchObject({ extracted: false, indexing: "already-indexed", chunks: 0 });

    // content blob + Markdown blob, each written once
    expect(blobs().stats.writes).toBe(2);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(indexed).toHaveLength(1);
    expect(rows.filter((r) => r.type === "CHAT_DOCUMENT")).toHaveLength(1);
    expect(rows[0].sha256).toBe(first.response.sha256);
  });

  it("same bytes in another thread of the same user: cached Markdown, indexing for that thread only", async () => {
    await upload(userA, "thread1");
    const other = await upload(userA, "thread2");

    expect(other.status).toBe("OK");
    if (other.status !== "OK") return;
    expect(other.response).toMatchObject({ extracted: false, indexing: "indexed" });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(indexed.map((i) => i.threadId)).toEqual(["thread1", "thread2"]);
    expect(blobs().stats.writes).toBe(2);
  });

  it("same bytes of another user: nothing is reused", async () => {
    await upload(userA, "thread1");
    const other = await upload(userB, "thread9");

    expect(other.status).toBe("OK");
    if (other.status !== "OK") return;
    expect(other.response).toMatchObject({ extracted: true, indexing: "indexed" });
    expect(extract).toHaveBeenCalledTimes(2);
    expect(blobs().stats.writes).toBe(4);
    expect(indexed.map((i) => i.user)).toEqual([userA, userB]);
  });

  it("new content under the same name replaces the old chunks and row", async () => {
    await upload(userA, "thread1", Buffer.from("version one"), "notes.txt");
    const second = await upload(userA, "thread1", Buffer.from("version two"), "notes.txt");

    expect(second.status).toBe("OK");
    const live = rows.filter((r) => r.type === "CHAT_DOCUMENT" && !r.isDeleted);
    expect(live).toHaveLength(1);
    expect(live[0].sha256).toBe(second.status === "OK" ? second.response.sha256 : "");
    expect(deletedChunkIds).toEqual([["old-chunk-1"]]);
    // Text files need no Document Intelligence.
    expect(extract).not.toHaveBeenCalled();
  });

  it("a document without text is an error and writes no row", async () => {
    extract.mockResolvedValueOnce("   ");
    const res = await upload(userA, "thread1");
    expect(res.status).toBe("ERROR");
    expect(rows).toHaveLength(0);
    expect(indexed).toHaveLength(0);
  });

  it("refuses an unsupported file type", async () => {
    const res = await upload(userA, "thread1", pdf, "tool.exe");
    expect(res.status).toBe("ERROR");
    expect(blobs().stats.writes).toBe(0);
  });
});
