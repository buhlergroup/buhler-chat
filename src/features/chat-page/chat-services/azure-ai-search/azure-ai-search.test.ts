import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

const hashedEmail = createHash("sha256").update("test@example.com").digest("hex");

// Mock Azure AI Search
const mockSearch = vi.fn();
const mockUpload = vi.fn(async (_docs: any[]): Promise<any> => ({ results: [] }));
const mockDelete = vi.fn(async () => ({ results: [] }));
const mockGetIndex = vi.fn();
const mockCreateIndex = vi.fn();

vi.mock("@/features/auth-page/auth-api", () => ({
  authOptions: {},
  options: {},
}));

vi.mock("@/features/common/services/ai-search", () => ({
  AzureAISearchInstance: vi.fn(() => ({
    search: mockSearch,
    uploadDocuments: mockUpload,
    deleteDocuments: mockDelete,
  })),
  AzureAISearchIndexClientInstance: vi.fn(() => ({
    getIndex: mockGetIndex,
    createIndex: mockCreateIndex,
  })),
}));

const mockEmbeddingsCreate = vi.fn(async (_args: any): Promise<any> => ({
  data: [{ embedding: new Array(1536).fill(0.1) }],
}));

vi.mock("@/features/common/services/openai", () => ({
  OpenAIEmbeddingInstance: vi.fn(() => ({
    embeddings: { create: mockEmbeddingsCreate },
  })),
  OpenAIV1Instance: vi.fn(() => ({})),
  OpenAIV1ReasoningInstance: vi.fn(() => ({})),
}));

vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/features/common/services/azure-default-credential", () => ({
  getAzureDefaultCredential: vi.fn(() => ({})),
}));

import {
  SimilaritySearch,
  IndexDocuments,
  DeleteDocumentsOfChatThread,
  DeleteSearchDocumentByPersonaDocumentId,
  EnsureIndexIsCreated,
  ExtensionSimilaritySearch,
  PersonaDocumentExistsInIndex,
} from "./azure-ai-search";
import * as azureSearchModule from "./azure-ai-search";

beforeEach(() => {
  vi.clearAllMocks();
  mockSearch.mockResolvedValue({
    results: (async function* () {})(),
  });
  mockUpload.mockResolvedValue({ results: [] });
  mockDelete.mockResolvedValue({ results: [] });
  mockGetIndex.mockResolvedValue({ name: "test-index" });
  mockCreateIndex.mockResolvedValue({ name: "new-index" });
  mockEmbeddingsCreate.mockResolvedValue({
    data: [{ embedding: new Array(1536).fill(0.1) }],
  });
});

async function* makeSearchResultsGen(items: any[]) {
  for (const item of items) {
    yield item;
  }
}

describe("chat-page.unit.search.001 — internal search iterates async results", () => {
  it("PersonaDocumentExistsInIndex returns the first matched document", async () => {
    const docs = [
      { score: 0.9, document: { id: "d1", pageContent: "content1", user: hashedEmail, chatThreadId: "t1", metadata: null, personaDocumentId: "p1" } },
    ];
    mockSearch.mockResolvedValueOnce({ results: makeSearchResultsGen(docs) });
    const result = await PersonaDocumentExistsInIndex("p1");
    expect(result.status).toBe("OK");
    expect((result as any).response.id).toBe("d1");
  });
});

describe("chat-page.unit.search.002 — SimilaritySearch adds vectorSearchOptions when shouldCreateEmbedding=true", () => {
  it("passes vectorSearchOptions with vector and kNN count", async () => {
    let capturedOptions: any;
    mockSearch.mockImplementationOnce(async (_text: string, options: any) => {
      capturedOptions = options;
      return { results: makeSearchResultsGen([]) };
    });
    await SimilaritySearch("test query", 5, undefined, 0, true);
    expect(mockEmbeddingsCreate).toHaveBeenCalled();
    expect(capturedOptions.vectorSearchOptions).toBeDefined();
    expect(capturedOptions.vectorSearchOptions.queries[0].kNearestNeighborsCount).toBe(5);
    expect(capturedOptions.vectorSearchOptions.queries[0].vector).toHaveLength(1536);
  });
});

describe("chat-page.unit.search.003 — SimilaritySearch skips embedding when flag is false", () => {
  it("does not call OpenAI embeddings", async () => {
    mockSearch.mockResolvedValueOnce({ results: makeSearchResultsGen([]) });
    await SimilaritySearch("query", 3, undefined, 0, false);
    expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
  });
});

describe("chat-page.unit.search.004 — IndexDocuments tags each document with hashed userId", () => {
  it("each uploaded doc has user = hashedEmail", async () => {
    let uploadedDocs: any[] = [];
    mockUpload.mockImplementationOnce(async (docs: any[]) => {
      uploadedDocs = docs;
      return { results: docs.map(() => ({ succeeded: true })) };
    });
    await IndexDocuments(["doc content 1", "doc content 2"], "test.txt", "t1");
    uploadedDocs.forEach((doc: any) => {
      expect(doc.user).toBe(hashedEmail);
    });
  });
});

describe("chat-page.unit.search.005 — IndexDocuments returns per-doc ERROR when upload fails", () => {
  it("returns ERROR for failed upload", async () => {
    mockUpload.mockResolvedValueOnce({
      results: [{ succeeded: false, errorMessage: "upload failed" }],
    });
    const results = await IndexDocuments(["content"]);
    expect(results[0].status).toBe("ERROR");
    expect((results[0] as any).errors[0].message).toContain("upload failed");
  });
});

describe("chat-page.unit.search.005b — IndexDocuments sends chunks in batches of 100", () => {
  it("splits 250 chunks into 3 embedding and 3 upload calls", async () => {
    mockEmbeddingsCreate.mockImplementation(async ({ input }: any) => ({
      data: input.map(() => ({ embedding: [0.1] })),
    }));
    mockUpload.mockImplementation(async (docs: any[]) => ({
      results: docs.map(() => ({ succeeded: true })),
    }));
    const chunks = Array.from({ length: 250 }, (_, i) => `chunk ${i}`);

    const results = await IndexDocuments(chunks, "big.pdf", undefined, "p1");

    expect(mockEmbeddingsCreate.mock.calls.map((c: any) => c[0].input.length)).toEqual([100, 100, 50]);
    expect(mockUpload.mock.calls.map((c: any) => c[0].length)).toEqual([100, 100, 50]);
    expect(results).toHaveLength(250);
    expect(results.every((r) => r.status === "OK")).toBe(true);
  });

  it("stops after the first failing embedding batch and returns its error", async () => {
    mockEmbeddingsCreate
      .mockImplementationOnce(async ({ input }: any) => ({
        data: input.map(() => ({ embedding: [0.1] })),
      }))
      .mockRejectedValueOnce(new Error("400 Invalid 'input'"));
    mockUpload.mockImplementation(async (docs: any[]) => ({
      results: docs.map(() => ({ succeeded: true })),
    }));
    const chunks = Array.from({ length: 250 }, (_, i) => `chunk ${i}`);

    const results = await IndexDocuments(chunks);

    expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(2);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const last = results[results.length - 1];
    expect(last.status).toBe("ERROR");
    expect((last as any).errors[0].message).toContain("400 Invalid 'input'");
  });
});

describe("chat-page.unit.search.005c — IndexDocuments drops empty and whitespace-only chunks", () => {
  it("embeds only chunks with text", async () => {
    mockEmbeddingsCreate.mockImplementation(async ({ input }: any) => ({
      data: input.map(() => ({ embedding: [0.1] })),
    }));
    mockUpload.mockImplementation(async (docs: any[]) => ({
      results: docs.map(() => ({ succeeded: true })),
    }));

    await IndexDocuments(["", "  \n\t", "real text"]);

    expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(1);
    expect((mockEmbeddingsCreate.mock.calls[0] as any)[0].input).toEqual(["real text"]);
  });

  it("returns no results and calls no service when all chunks are empty", async () => {
    const results = await IndexDocuments(["", "   "]);

    expect(results).toEqual([]);
    expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe("chat-page.unit.search.006 —DeleteDocumentsOfChatThread issues search filter scoped by chatThreadId", () => {
  it("calls SimpleSearch with chatThreadId filter", async () => {
    let capturedFilter: string | undefined;
    // SimpleSearch calls instance.search(text, { filter })
    mockSearch.mockImplementationOnce(async (_text: any, opts: any) => {
      capturedFilter = opts?.filter;
      return { results: makeSearchResultsGen([]) };
    });
    await DeleteDocumentsOfChatThread("t1");
    expect(typeof capturedFilter).toBe("string");
    expect(capturedFilter!).toContain("t1");
  });
});

describe("chat-page.unit.search.007 — DeleteSearchDocumentByPersonaDocumentId filter includes hashed user", () => {
  it("includes hashed user in filter", async () => {
    let capturedFilter: string | undefined;
    mockSearch.mockImplementationOnce(async (_text: any, opts: any) => {
      capturedFilter = opts?.filter;
      return { results: makeSearchResultsGen([]) };
    });
    await DeleteSearchDocumentByPersonaDocumentId("persona-doc-1");
    expect(typeof capturedFilter).toBe("string");
    expect(capturedFilter!).toContain(hashedEmail);
  });
});

describe("chat-page.unit.search.008 — EnsureIndexIsCreated returns existing index when getIndex resolves", () => {
  it("returns OK with existing index, createIndex not called", async () => {
    mockGetIndex.mockResolvedValueOnce({ name: "existing-index" });
    const result = await EnsureIndexIsCreated();
    expect(result.status).toBe("OK");
    expect((result as any).response.name).toBe("existing-index");
    expect(mockCreateIndex).not.toHaveBeenCalled();
  });
});

describe("chat-page.unit.search.009 — EnsureIndexIsCreated falls through to creation when getIndex throws", () => {
  it("creates index when getIndex throws", async () => {
    mockGetIndex.mockRejectedValueOnce(new Error("not found"));
    mockCreateIndex.mockResolvedValueOnce({ name: "new-index" });
    const result = await EnsureIndexIsCreated();
    expect(result.status).toBe("OK");
    expect((result as any).response.name).toBe("new-index");
  });
});

describe("chat-page.unit.search.010 — ExtensionSimilaritySearch requires an apiKey", () => {
  it("returns ERROR when apiKey is missing, so the application identity is never used", async () => {
    const result = await ExtensionSimilaritySearch({
      searchText: "q",
      vectors: ["v"],
      searchName: "valid-search",
      indexName: "valid-index",
      shouldCreateEmbedding: false,
    });
    expect(result.status).toBe("ERROR");
    expect((result as any).errors[0].message).toContain("apiKey");
  });
});

describe("chat-page.unit.search.011 — ExtensionSimilaritySearch rejects a host-relocating searchName", () => {
  it("returns ERROR for a searchName containing a path or query delimiter", async () => {
    const result = await ExtensionSimilaritySearch({
      searchText: "q",
      vectors: ["v"],
      apiKey: "any-key",
      searchName: "attacker.example.com/collector?x=",
      indexName: "valid-index",
      shouldCreateEmbedding: false,
    });
    expect(result.status).toBe("ERROR");
    expect((result as any).errors[0].message).toContain("searchName");
  });
});

describe("chat-page.unit.search.013 — internal primitives are not Server Actions", () => {
  it("does not export SimpleSearch (it must stay internal, never a Server Action)", () => {
    expect((azureSearchModule as Record<string, unknown>).SimpleSearch).toBeUndefined();
  });
});
