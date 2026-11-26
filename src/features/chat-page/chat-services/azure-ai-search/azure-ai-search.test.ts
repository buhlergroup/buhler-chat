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

// Counts the ids handed out, i.e. the index documents built.
const idsCreated = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/features/common/util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/common/util")>();
  return {
    ...actual,
    uniqueId: () => {
      idsCreated.count++;
      return actual.uniqueId();
    },
  };
});

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
  DeleteChunksByIds,
  FindChatDocumentChunkIds,
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

  it("deletes the chunks of earlier batches and of the batch whose upload throws", async () => {
    mockEmbeddingsCreate.mockImplementation(async ({ input }: any) => ({
      data: input.map(() => ({ embedding: [0.1] })),
    }));
    const uploaded: string[][] = [];
    mockUpload
      .mockImplementationOnce(async (docs: any[]) => {
        uploaded.push(docs.map((d) => d.id));
        return { results: docs.map((d) => ({ key: d.id, succeeded: true })) };
      })
      .mockImplementationOnce(async (docs: any[]) => {
        uploaded.push(docs.map((d) => d.id));
        throw new Error("413 Request Entity Too Large");
      });
    const chunks = Array.from({ length: 150 }, (_, i) => `chunk ${i}`);

    const results = await IndexDocuments(chunks);

    // The thrown batch may be written in part: its ids are deleted too.
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith("id", [...uploaded[0], ...uploaded[1]]);
    expect(results.some((r) => r.status === "OK")).toBe(false);
    const last = results[results.length - 1];
    expect(last.status).toBe("ERROR");
    expect((last as any).errors[0].message).toContain("413");
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
    expect(results).toHaveLength(1);
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

describe("chat-page.unit.search.014 — filters quote the values they contain", () => {
  const captureFilter = () => {
    const captured: { filter?: string } = {};
    mockSearch.mockImplementationOnce(async (_text: any, opts: any) => {
      captured.filter = opts?.filter;
      return { results: makeSearchResultsGen([]) };
    });
    return captured;
  };

  it("DeleteSearchDocumentByPersonaDocumentId escapes a quote in the id", async () => {
    const captured = captureFilter();
    await DeleteSearchDocumentByPersonaDocumentId("x' or true or user eq '");
    expect(captured.filter).toBe(
      `personaDocumentId eq 'x'' or true or user eq ''' and user eq '${hashedEmail}'`
    );
  });

  it("PersonaDocumentExistsInIndex escapes a quote in the id", async () => {
    const captured = captureFilter();
    await PersonaDocumentExistsInIndex("a' or true or personaDocumentId eq 'b");
    expect(captured.filter).toBe(
      "personaDocumentId eq 'a'' or true or personaDocumentId eq ''b'"
    );
  });

  it("DeleteDocumentsOfChatThread scopes by thread and user", async () => {
    const captured = captureFilter();
    await DeleteDocumentsOfChatThread("t1");
    expect(captured.filter).toBe(
      `chatThreadId eq 't1' and user eq '${hashedEmail}'`
    );
  });
});

describe("chat-page.unit.search.015 — search and index functions are not Server Actions", () => {
  it("azure-ai-search.ts has no \"use server\" directive", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // vitest runs from src/ (vitest.config.ts).
    const source = readFileSync(
      resolve(
        process.cwd(),
        "features/chat-page/chat-services/azure-ai-search/azure-ai-search.ts"
      ),
      "utf8"
    );
    // Every export of a "use server" module is a Server Action that any
    // signed-in browser can call with its own arguments.
    expect(source).not.toMatch(/^\s*(\/\/[^\n]*\n\s*)*["']use server["']/);
    expect(source).toMatch(/import "server-only";/);
  });
});

describe("chat-page.unit.search.016 — persona document chunks carry the agent owner's id", () => {
  it("IndexDocuments sets user = ownerUserId when given", async () => {
    let uploadedDocs: any[] = [];
    mockUpload.mockImplementationOnce(async (docs: any[]) => {
      uploadedDocs = docs;
      return { results: docs.map(() => ({ succeeded: true })) };
    });
    await IndexDocuments(["a", "b"], "f.txt", undefined, "pd-1", "owner-hash");
    expect(uploadedDocs.map((d) => [d.user, d.personaDocumentId])).toEqual([
      ["owner-hash", "pd-1"],
      ["owner-hash", "pd-1"],
    ]);
  });

  it("DeleteSearchDocumentByPersonaDocumentId filters by the given owner and deletes by key", async () => {
    let capturedOptions: any;
    mockSearch.mockImplementationOnce(async (_t: any, opts: any) => {
      capturedOptions = opts;
      return { results: makeSearchResultsGen([{ score: 1, document: { id: "c1" } }, { score: 1, document: { id: "c2" } }]) };
    });
    mockDelete.mockResolvedValueOnce({ results: [{ succeeded: true }, { succeeded: true }] } as any);
    const res = await DeleteSearchDocumentByPersonaDocumentId("pd-1", "owner-hash");
    expect(res.status).toBe("OK");
    expect(capturedOptions.filter).toBe("personaDocumentId eq 'pd-1' and user eq 'owner-hash'");
    expect(mockDelete).toHaveBeenCalledWith("id", ["c1", "c2"]);
  });

  it("deletes every chunk beyond the first 1000: next round excludes the deleted ids, no skip, no sort", async () => {
    // 2005 chunks; the index serves any page of the ones the filter allows.
    const all = Array.from({ length: 2005 }, (_, i) => `c${String(i).padStart(4, "0")}`);
    const calls: any[] = [];
    mockSearch.mockImplementation(async (_t: any, opts: any) => {
      calls.push(opts);
      const excluded = new Set<string>(
        (String(opts.filter).match(/search\.in\(id, '([^']*)'/)?.[1] ?? "").split(",").filter(Boolean),
      );
      const page = all.filter((id) => !excluded.has(id)).slice(0, opts.top);
      return { results: makeSearchResultsGen(page.map((id) => ({ score: 1, document: { id } }))) };
    });
    mockDelete.mockImplementation((async (_key: string, ids: string[]) => ({
      results: ids.map(() => ({ succeeded: true })),
    })) as any);
    const res = await DeleteSearchDocumentByPersonaDocumentId("pd-big", "owner-hash");
    expect(res.status).toBe("OK");
    const deleted = (mockDelete.mock.calls as unknown as Array<[string, string[]]>).flatMap((c) => c[1]);
    expect(deleted).toHaveLength(2005);
    expect(new Set(deleted).size).toBe(2005);
    expect(calls).toHaveLength(3);
    expect(calls.every((o) => o.skip === undefined && o.orderBy === undefined && o.top === 1000)).toBe(true);
    expect(calls[0].filter).toBe("personaDocumentId eq 'pd-big' and user eq 'owner-hash'");
    expect(calls[1].filter).toMatch(/^personaDocumentId eq 'pd-big' and user eq 'owner-hash' and not search\.in\(id, 'c0000,/);
  });

  it("no chunk left is OK; a failed delete is an ERROR", async () => {
    expect((await DeleteSearchDocumentByPersonaDocumentId("pd-none", "owner-hash")).status).toBe("OK");
    mockSearch.mockImplementationOnce(async () => ({
      results: makeSearchResultsGen([{ score: 1, document: { id: "c1" } }]),
    }));
    mockDelete.mockResolvedValueOnce({ results: [{ succeeded: false, errorMessage: "busy" }] } as any);
    const res = await DeleteSearchDocumentByPersonaDocumentId("pd-1", "owner-hash");
    expect(res).toEqual({ status: "ERROR", errors: [{ message: "busy" }] });
  });
});

// Embedding and upload fakes for the big-document cases: one vector per
// input, every upload succeeds and reports the key of each document.
const embedEachInput = () =>
  mockEmbeddingsCreate.mockImplementation(async ({ input }: any) => ({
    data: input.map(() => ({ embedding: new Array(8).fill(0.5) })),
  }));
const uploadAllOk = () =>
  mockUpload.mockImplementation(async (docs: any[]) => ({
    results: docs.map((d) => ({ key: d.id, succeeded: true })),
  }));

describe("chat-page.unit.search.005d — IndexDocuments keeps at most one batch of embeddings", () => {
  it("documents of earlier batches hold no embedding while the next batch is embedded", async () => {
    const uploaded: any[] = [];
    const retainedAtEachEmbedCall: number[] = [];
    mockEmbeddingsCreate.mockImplementation(async ({ input }: any) => {
      retainedAtEachEmbedCall.push(uploaded.filter((d) => d.embedding !== undefined).length);
      return { data: input.map(() => ({ embedding: new Array(8).fill(0.5) })) };
    });
    mockUpload.mockImplementation(async (docs: any[]) => {
      // Every document of the batch carries its vector at upload time.
      expect(docs.every((d) => Array.isArray(d.embedding) && d.embedding.length === 8)).toBe(true);
      uploaded.push(...docs);
      return { results: docs.map((d) => ({ key: d.id, succeeded: true })) };
    });

    const results = await IndexDocuments(Array.from({ length: 450 }, (_, i) => `chunk ${i}`));

    expect(results).toHaveLength(450);
    expect(retainedAtEachEmbedCall).toEqual([0, 0, 0, 0, 0]);
    expect(uploaded).toHaveLength(450);
    expect(uploaded.filter((d) => d.embedding !== undefined)).toHaveLength(0);
  });

  it("builds the documents of a batch only when that batch is embedded", async () => {
    // Every index document gets its id from uniqueId when it is built.
    const builtAtEachEmbedCall: number[] = [];
    mockEmbeddingsCreate.mockImplementation(async ({ input }: any) => {
      builtAtEachEmbedCall.push(idsCreated.count);
      return { data: input.map(() => ({ embedding: [0.1] })) };
    });
    uploadAllOk();
    idsCreated.count = 0;

    await IndexDocuments(Array.from({ length: 250 }, (_, i) => `chunk ${i}`));

    expect(builtAtEachEmbedCall).toEqual([100, 200, 250]);
  });
});

describe("chat-page.unit.search.005e — IndexDocuments refuses a document over MAX_DOCUMENT_CHUNKS", () => {
  it("returns a user-facing error before any embedding call", async () => {
    vi.stubEnv("MAX_DOCUMENT_CHUNKS", "120");
    try {
      const results = await IndexDocuments(Array.from({ length: 121 }, (_, i) => `chunk ${i}`));
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("ERROR");
      const message = (results[0] as any).errors[0].message as string;
      expect(message).toContain("too long to index");
      expect(message).toContain("121");
      expect(message).toContain("Split the document");
      expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
      expect(mockUpload).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("indexes a document of exactly MAX_DOCUMENT_CHUNKS chunks", async () => {
    vi.stubEnv("MAX_DOCUMENT_CHUNKS", "120");
    embedEachInput();
    uploadAllOk();
    try {
      const results = await IndexDocuments(Array.from({ length: 120 }, (_, i) => `chunk ${i}`));
      expect(results).toHaveLength(120);
      expect(results.every((r) => r.status === "OK")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("default limit is 4000 chunks; empty chunks do not count", async () => {
    const { DEFAULT_MAX_DOCUMENT_CHUNKS, maxDocumentChunks } = await import("../chat-document-chunks");
    expect(DEFAULT_MAX_DOCUMENT_CHUNKS).toBe(4000);
    vi.stubEnv("MAX_DOCUMENT_CHUNKS", "not a number");
    expect(maxDocumentChunks()).toBe(4000);
    vi.stubEnv("MAX_DOCUMENT_CHUNKS", "2");
    try {
      embedEachInput();
      uploadAllOk();
      const results = await IndexDocuments(["a", " ", "", "b"]);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === "OK")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("chat-page.unit.search.005f — a failed batch deletes the chunks this call wrote", () => {
  it("embedding error in batch 3: deletes exactly the ids of batches 1 and 2", async () => {
    const written: string[] = [];
    mockEmbeddingsCreate
      .mockImplementationOnce(async ({ input }: any) => ({ data: input.map(() => ({ embedding: [0.1] })) }))
      .mockImplementationOnce(async ({ input }: any) => ({ data: input.map(() => ({ embedding: [0.1] })) }))
      .mockRejectedValueOnce(new Error("429 Too Many Requests"));
    mockUpload.mockImplementation(async (docs: any[]) => {
      written.push(...docs.map((d) => d.id));
      return { results: docs.map((d) => ({ key: d.id, succeeded: true })) };
    });

    const results = await IndexDocuments(Array.from({ length: 250 }, (_, i) => `chunk ${i}`));

    expect(written).toHaveLength(200);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith("id", written);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("ERROR");
    expect((results[0] as any).errors[0].message).toContain("429");
  });

  it("upload with failed results: deletes earlier batches and the succeeded ids of the failing batch only", async () => {
    embedEachInput();
    const firstBatch: string[] = [];
    let secondOk: string[] = [];
    mockUpload
      .mockImplementationOnce(async (docs: any[]) => {
        firstBatch.push(...docs.map((d) => d.id));
        return { results: docs.map((d) => ({ key: d.id, succeeded: true })) };
      })
      .mockImplementationOnce(async (docs: any[]) => {
        // The first 10 documents fail, the rest are written.
        secondOk = docs.slice(10).map((d) => d.id);
        return {
          results: docs.map((d, i) =>
            i < 10
              ? { key: d.id, succeeded: false, errorMessage: "document too large" }
              : { key: d.id, succeeded: true }
          ),
        };
      });

    const results = await IndexDocuments(Array.from({ length: 300 }, (_, i) => `chunk ${i}`));

    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith("id", [...firstBatch, ...secondOk]);
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.status === "ERROR")).toBe(true);
    expect((results[0] as any).errors[0].message).toBe("document too large");
  });

  it("a failure in the first batch before any write deletes nothing", async () => {
    mockEmbeddingsCreate.mockRejectedValueOnce(new Error("500 Internal Server Error"));
    const results = await IndexDocuments(["only chunk"]);
    expect(results[0].status).toBe("ERROR");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("reports when the written chunks cannot be deleted", async () => {
    embedEachInput();
    mockUpload
      .mockImplementationOnce(async (docs: any[]) => ({
        results: docs.map((d) => ({ key: d.id, succeeded: true })),
      }))
      .mockImplementationOnce(async (docs: any[]) => ({
        results: docs.map((d) => ({ key: d.id, succeeded: false, errorMessage: "quota" })),
      }));
    mockDelete.mockResolvedValueOnce({ results: [{ succeeded: false, errorMessage: "busy" }] } as any);

    const results = await IndexDocuments(Array.from({ length: 101 }, (_, i) => `chunk ${i}`));

    const messages = results.flatMap((r) => (r.status === "OK" ? [] : r.errors.map((e) => e.message)));
    expect(messages).toContain("quota");
    expect(
      messages.some((m) => m.includes("100 chunks written before the error could not be deleted") && m.includes("busy"))
    ).toBe(true);
  });
});

describe("chat-page.unit.search.005g — chunk ids of big documents are found and deleted whole", () => {
  it("DeleteChunksByIds deletes in requests of at most 1000 ids", async () => {
    mockDelete.mockImplementation((async (_key: string, ids: string[]) => ({
      results: ids.map(() => ({ succeeded: true })),
    })) as any);
    const ids = Array.from({ length: 2500 }, (_, i) => `id${i}`);
    await DeleteChunksByIds(ids);
    const calls = mockDelete.mock.calls as unknown as Array<[string, string[]]>;
    expect(calls.map((c) => c[1].length)).toEqual([1000, 1000, 500]);
    expect(calls.flatMap((c) => c[1])).toEqual(ids);
  });

  it("FindChatDocumentChunkIds asks for more than 1000 results (the client follows the pages)", async () => {
    let options: any;
    mockSearch.mockImplementationOnce(async (_t: any, opts: any) => {
      options = opts;
      return {
        results: makeSearchResultsGen(
          Array.from({ length: 1500 }, (_, i) => ({
            score: 1,
            document: { id: `c${i}`, metadata: i % 3 === 0 ? "other.txt" : "big.txt" },
          }))
        ),
      };
    });
    const ids = await FindChatDocumentChunkIds("t1", "u1", "big.txt");
    expect(options.top).toBeGreaterThan(1000);
    expect(ids).toHaveLength(1000);
  });
});
