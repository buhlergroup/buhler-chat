import { describe, it, expect, vi, beforeEach } from "vitest";
import { setSession, defaultSession } from "@/__tests__/helpers/session-mock";

// ── Microsoft Graph batch mock ────────────────────────────────────────────────
type BatchItem = { id: string; status: number; body?: any };
let nextBatchResponses: BatchItem[] = [];
const postSpy = vi.fn(async () => ({ responses: nextBatchResponses }));

vi.mock("@/features/common/services/microsoft-graph-client", () => ({
  getGraphClient: vi.fn(() => ({
    api: vi.fn(() => ({
      post: postSpy,
      select: vi.fn().mockReturnThis(),
      get: vi.fn(),
      responseType: vi.fn().mockReturnThis(),
    })),
  })),
}));

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: { upsert: vi.fn(), query: vi.fn(() => ({ fetchAll: async () => ({ resources: [] }) })) },
    item: vi.fn(() => ({ read: vi.fn(), delete: vi.fn() })),
  }),
  ConfigContainer: () => ({}),
}));

vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("@/features/chat-page/chat-services/azure-ai-search/azure-ai-search", () => ({
  DeleteSearchDocumentByPersonaDocumentId: vi.fn(),
  IndexDocuments: vi.fn(),
  PersonaDocumentExistsInIndex: vi.fn(),
}));

vi.mock("@/features/common/services/document-intelligence", () => ({
  DocumentIntelligenceInstance: vi.fn(),
}));

vi.mock("@/features/chat-page/chat-services/chat-document-service", () => ({
  ChunkDocumentWithOverlap: vi.fn(),
}));

import { AuthorizedDocuments, DocumentDetails } from "./persona-documents-service";
import {
  GRAPH_BATCH_MAX_REQUESTS,
  chunkItems,
} from "@/features/common/services/microsoft-graph-batch";

const sharepointDoc = (id: string) => ({
  id,
  documentId: id,
  parentReference: { driveId: "drive-1" },
});

const okBatch = (id: string, size: number) => ({
  id,
  status: 200,
  body: {
    id,
    name: `${id}.pdf`,
    size,
    createdBy: { user: { displayName: "Test User" } },
    createdDateTime: "2024-01-01",
    parentReference: { driveId: "drive-1" },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  postSpy.mockImplementation(async () => ({ responses: nextBatchResponses }));
  setSession(defaultSession);
  nextBatchResponses = [];
  process.env.MAX_PERSONA_DOCUMENT_LIMIT = "10";
  process.env.MAX_PERSONA_DOCUMENT_SIZE = "10485760"; // 10MB
});

describe("DocumentDetails — issue #113: CI size limit handling", () => {
  it("flags >10MB as sizeToBig under default (regular agent doc) limits", async () => {
    nextBatchResponses = [okBatch("big-pdf", 25 * 1024 * 1024)];

    const result = await DocumentDetails([sharepointDoc("big-pdf")]);

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.successful).toHaveLength(0);
      expect(result.response.sizeToBig).toHaveLength(1);
      expect(result.response.sizeToBig[0].name).toBe("big-pdf.pdf");
    }
  });

  it("accepts a 25MB file when caller raises maxSize (Code Interpreter path)", async () => {
    nextBatchResponses = [okBatch("ci-pdf", 25 * 1024 * 1024)];

    const result = await DocumentDetails([sharepointDoc("ci-pdf")], {
      maxSize: 512 * 1024 * 1024,
      maxCount: 20,
    });

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.successful).toHaveLength(1);
      expect(result.response.sizeToBig).toHaveLength(0);
    }
  });

  it("still flags files above the CI maxSize (e.g. 600MB > 512MB)", async () => {
    nextBatchResponses = [okBatch("huge", 600 * 1024 * 1024)];

    const result = await DocumentDetails([sharepointDoc("huge")], {
      maxSize: 512 * 1024 * 1024,
      maxCount: 20,
    });

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.sizeToBig).toHaveLength(1);
    }
  });

  it("enforces caller-supplied maxCount", async () => {
    const docs = Array.from({ length: 21 }, (_, i) => sharepointDoc(`d${i}`));

    const result = await DocumentDetails(docs, {
      maxSize: 512 * 1024 * 1024,
      maxCount: 20,
    });

    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors[0].message).toContain("Maximum is 20");
    }
  });
});

// ── Graph $batch limit: at most 20 requests per batch ───────────────────────
describe("Graph $batch in chunks of at most 20 requests", () => {
  type BatchBody = { requests: Array<{ id: string; url: string }> };
  const docs = (n: number) => Array.from({ length: n }, (_, i) => sharepointDoc(`d${i}`));
  const batchSizes = () =>
    (postSpy.mock.calls as unknown as Array<[BatchBody]>).map((c) => c[0].requests.length);

  // Answers every request of a batch with 200; a batch that contains
  // `failId` fails as a whole.
  const answerAll = (failId?: string) =>
    postSpy.mockImplementation((async (body: BatchBody) => {
      if (body.requests.length > 20) throw new Error("Too many requests in the batch");
      if (failId && body.requests.some((r) => r.id === failId)) throw new Error("batch failed");
      return { responses: body.requests.map((r) => okBatch(r.id, 100)) };
    }) as any);

  describe("AuthorizedDocuments", () => {
    it.each([
      [0, []],
      [1, [1]],
      [20, [20]],
      [21, [20, 1]],
      [25, [20, 5]],
    ])("%i documents: batches of %j, all allowed", async (n, sizes) => {
      answerAll();
      const allowed = await AuthorizedDocuments(docs(n));
      expect(batchSizes()).toEqual(sizes);
      expect(allowed).toEqual(docs(n).map((d) => d.id));
    });

    it("a failed chunk allows none of its documents; the other chunk still counts", async () => {
      answerAll("d22");
      const allowed = await AuthorizedDocuments(docs(25));
      expect(batchSizes()).toEqual([20, 5]);
      expect(allowed).toEqual(docs(20).map((d) => d.id));
    });

    it("only a 200 answer allows a document", async () => {
      postSpy.mockImplementation((async (body: BatchBody) => ({
        responses: body.requests.map((r) =>
          r.id === "d3" ? { id: r.id, status: 403 } : okBatch(r.id, 100)
        ),
      })) as any);
      const allowed = await AuthorizedDocuments(docs(21));
      expect(allowed).toHaveLength(20);
      expect(allowed).not.toContain("d3");
    });
  });

  describe("DocumentDetails", () => {
    it.each([
      [1, [1]],
      [20, [20]],
      [21, [20, 1]],
      [25, [20, 5]],
    ])("%i documents: batches of %j, all details returned", async (n, sizes) => {
      answerAll();
      const result = await DocumentDetails(docs(n), { maxCount: 25 });
      expect(batchSizes()).toEqual(sizes);
      expect(result.status).toBe("OK");
      if (result.status === "OK") {
        expect(result.response.successful.map((d) => d.documentId)).toEqual(
          docs(n).map((d) => d.documentId)
        );
        expect(result.response.unsuccessful).toEqual([]);
      }
    });

    it("a failed chunk marks its documents unsuccessful; the other chunk still counts", async () => {
      answerAll("d0");
      const result = await DocumentDetails(docs(25), { maxCount: 25 });
      expect(result.status).toBe("OK");
      if (result.status === "OK") {
        expect(result.response.successful.map((d) => d.documentId)).toEqual(
          docs(25).slice(20).map((d) => d.documentId)
        );
        expect(result.response.unsuccessful).toHaveLength(20);
      }
    });

    it("every chunk failed: returns an error", async () => {
      postSpy.mockImplementation((async () => {
        throw new Error("Graph down");
      }) as any);
      const result = await DocumentDetails(docs(21), { maxCount: 25 });
      expect(result.status).toBe("ERROR");
    });
  });
});

describe("chunkItems", () => {
  it("splits into chunks of at most the size, order kept", () => {
    expect(chunkItems([], 20)).toEqual([]);
    expect(chunkItems([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunkItems(Array.from({ length: 40 }, (_, i) => i)).map((c) => c.length)).toEqual([
      20, 20,
    ]);
    expect(GRAPH_BATCH_MAX_REQUESTS).toBe(20);
  });
});
