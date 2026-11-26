import { describe, it, expect, vi, beforeEach } from "vitest";
import { setSession, adminSession } from "@/__tests__/helpers/session-mock";

// Search files through the real IndexDocuments: only the index, the
// embedding client, Cosmos and SharePoint are fakes. Covers the chunk limit
// and the clean-up of a failed upload on the agent path.

let rows: Array<Record<string, any>> = [];
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: {
      upsert: async (doc: any) => {
        rows.push({ ...doc });
        return { resource: doc };
      },
    },
    item: (id: string, pk: string) => ({
      delete: async () => {
        const i = rows.findIndex((r) => r.id === id && r.userId === pk);
        if (i < 0) throw Object.assign(new Error("Not found"), { code: 404 });
        rows.splice(i, 1);
        return {};
      },
    }),
  }),
}));

vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));

// The index: documents by id.
const index = new Map<string, any>();
const failUploadNumber = { value: 0 };
let uploadCalls = 0;
const deleteRequests: string[][] = [];
vi.mock("@/features/common/services/ai-search", () => ({
  AzureAISearchInstance: () => ({
    uploadDocuments: async (docs: any[]) => {
      uploadCalls++;
      if (uploadCalls === failUploadNumber.value) {
        return { results: docs.map((d) => ({ key: d.id, succeeded: false, errorMessage: "quota" })) };
      }
      for (const d of docs) index.set(d.id, { ...d });
      return { results: docs.map((d) => ({ key: d.id, succeeded: true })) };
    },
    deleteDocuments: async (_key: string, ids: string[]) => {
      deleteRequests.push(ids);
      for (const id of ids) index.delete(id);
      return { results: ids.map(() => ({ succeeded: true })) };
    },
    search: async (_text: unknown, opts: { filter: string }) => {
      const pd = /personaDocumentId eq '([^']+)'/.exec(opts.filter)?.[1];
      const docs = [...index.values()].filter((d) => d.personaDocumentId === pd);
      return {
        results: (async function* () {
          for (const document of docs) yield { score: 1, document };
        })(),
      };
    },
  }),
  AzureAISearchIndexClientInstance: () => ({}),
}));

const embeddingsCreate = vi.fn(async ({ input }: { input: string[] }) => ({
  data: input.map(() => ({ embedding: [0.1, 0.2] })),
}));
vi.mock("@/features/common/services/openai", () => ({
  OpenAIEmbeddingInstance: () => ({ embeddings: { create: embeddingsCreate } }),
}));

let sharePointText = "Some text.";
vi.mock("@/features/common/services/microsoft-graph-client", () => ({
  getGraphClient: vi.fn(() => ({
    api: vi.fn(() => ({
      responseType: vi.fn().mockReturnThis(),
      get: vi.fn(async () => new TextEncoder().encode(sharePointText).buffer),
    })),
  })),
}));
vi.mock("@/features/common/services/document-intelligence", () => ({
  DocumentIntelligenceInstance: vi.fn(),
}));
vi.mock("@/features/common/services/document-extraction", () => ({
  extractTextWithDocumentIntelligence: vi.fn(async () => "Extracted text."),
}));
vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { addSearchDocument } from "./persona-documents-store";
import { register, SERVICE_KEYS } from "@/features/common/services/service-container";
import { createMemoryContentBlobBackend } from "@/features/common/services/content-store/memory-backend";

const file = {
  documentId: "ITEM1",
  parentReference: { driveId: "b!drive" },
  name: "notes.txt",
  createdBy: "",
  createdDateTime: "",
};

// Text of `n` chunks: chunks are 2300 characters and add 1725 new ones each.
const textOfChunks = (n: number) => "y".repeat(1725 * (n - 1) + 100);

beforeEach(async () => {
  rows = [];
  index.clear();
  deleteRequests.length = 0;
  uploadCalls = 0;
  failUploadNumber.value = 0;
  sharePointText = "Some text.";
  embeddingsCreate.mockClear();
  vi.unstubAllEnvs();
  register(SERVICE_KEYS.contentBlobs, createMemoryContentBlobBackend);
  await setSession(adminSession);
});

describe("persona-page.unit.search-file-indexing — agent Search files through IndexDocuments", () => {
  it("indexes a Search file: chunks carry the row id and the owner's id", async () => {
    sharePointText = textOfChunks(150);
    const res = await addSearchDocument(file, "owner-hash");

    expect(res.status).toBe("OK");
    const id = res.status === "OK" ? res.response : "";
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(index.size).toBe(150);
    expect([...index.values()].every((d) => d.personaDocumentId === id && d.user === "owner-hash")).toBe(true);
    expect(embeddingsCreate).toHaveBeenCalledTimes(2);
  });

  it("a Search file over MAX_DOCUMENT_CHUNKS: clear error, no embedding call, no row, no chunk", async () => {
    vi.stubEnv("MAX_DOCUMENT_CHUNKS", "3");
    sharePointText = textOfChunks(4);
    const res = await addSearchDocument(file, "owner-hash");

    expect(res.status).toBe("ERROR");
    if (res.status === "OK") return;
    expect(res.errors[0].message).toMatch(/^notes\.txt: The document is too long to index/);
    expect(res.errors[0].message).toContain("Split the document");
    expect(embeddingsCreate).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
    expect(index.size).toBe(0);
  });

  it("a failed second batch: the chunks of the first batch are deleted and the row is gone", async () => {
    sharePointText = textOfChunks(250);
    failUploadNumber.value = 2;
    const res = await addSearchDocument(file, "owner-hash");

    expect(res.status).toBe("ERROR");
    if (res.status === "OK") return;
    expect(res.errors).toEqual([{ message: "notes.txt: quota" }]);
    // IndexDocuments deleted its 100 chunks by id.
    expect(deleteRequests[0]).toHaveLength(100);
    expect(index.size).toBe(0);
    expect(rows).toEqual([]);
  });
});
