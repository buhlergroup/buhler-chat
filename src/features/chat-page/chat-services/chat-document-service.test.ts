import { describe, it, expect, vi, beforeEach } from "vitest";

// jsdom Blob/File polyfill for arrayBuffer and text
if (typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function(): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = reject;
      reader.readAsArrayBuffer(this);
    });
  };
}
if (typeof Blob.prototype.text !== "function") {
  Blob.prototype.text = function(): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsText(this);
    });
  };
}
import { createHash } from "crypto";

const hashedEmail = createHash("sha256").update("test@example.com").digest("hex");

let historyItems: any[] = [];
let queryCapture: any = null;

const historyContainer = {
  items: {
    upsert: vi.fn(async (doc: any) => ({ resource: doc })),
    query: vi.fn((q: any) => {
      queryCapture = q;
      return { fetchAll: async () => ({ resources: historyItems }) };
    }),
  },
};

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => historyContainer,
}));

vi.mock("@/features/auth-page/auth-api", () => ({
  authOptions: {},
  options: {},
}));

vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/features/common/services/document-intelligence", () => ({
  DocumentIntelligenceInstance: vi.fn(() => ({
    beginAnalyzeDocument: vi.fn(async () => ({
      pollUntilDone: async () => ({
        paragraphs: [
          { content: "paragraph 1" },
          { content: "paragraph 2" },
        ],
      }),
    })),
  })),
}));

vi.mock("@/features/common/navigation-helpers", () => ({
  RevalidateCache: vi.fn(),
}));

vi.mock("@/features/chat-page/chat-services/azure-ai-search/azure-ai-search", () => ({
  EnsureIndexIsCreated: vi.fn(async () => ({ status: "OK", response: {} })),
  IndexDocuments: vi.fn(async () => [{ status: "OK", response: true }]),
  DeleteDocumentsOfChatThread: vi.fn(async () => [{ status: "OK", response: true }]),
}));

import { CrackDocument, FindAllChatDocuments } from "./chat-document-service";
import { EnsureIndexIsCreated } from "@/features/chat-page/chat-services/azure-ai-search/azure-ai-search";
import { CHAT_DOCUMENT_ATTRIBUTE } from "./models";

beforeEach(() => {
  historyItems = [];
  queryCapture = null;
  vi.clearAllMocks();
  historyContainer.items.query.mockImplementation((q: any) => {
    queryCapture = q;
    return { fetchAll: async () => ({ resources: historyItems }) };
  });
  (EnsureIndexIsCreated as any).mockResolvedValue({ status: "OK", response: {} });
});

describe("chat-page.unit.document-service.001 — CrackDocument short-circuits for plain text extensions", () => {
  it("returns OK with chunked array for .txt file", async () => {
    const text = "A".repeat(5000);
    const file = new File([text], "doc.txt", { type: "text/plain" });
    const formData = new FormData();
    formData.set("file", file);
    const result = await CrackDocument(formData);
    expect(result.status).toBe("OK");
    expect(Array.isArray((result as any).response)).toBe(true);
    expect((result as any).response.length).toBeGreaterThan(0);
  });
});

describe("chat-page.unit.document-service.002 — CrackDocument falls back to Document Intelligence for PDF", () => {
  it("LoadFile invoked for .pdf file", async () => {
    const { DocumentIntelligenceInstance } = await import("@/features/common/services/document-intelligence");
    const pdfContent = new Uint8Array(100);
    const file = new File([pdfContent], "doc.pdf", { type: "application/pdf" });
    const formData = new FormData();
    formData.set("file", file);
    const result = await CrackDocument(formData);
    if (result.status !== "OK") console.error("PDF error:", (result as any).errors);
    expect(result.status).toBe("OK");
    expect(DocumentIntelligenceInstance).toHaveBeenCalled();
  });
});

describe("chat-page.unit.document-service.003 — CrackDocument returns ERROR if index ensure fails", () => {
  it("returns same ERROR from EnsureIndexIsCreated", async () => {
    const { EnsureIndexIsCreated } = await import("@/features/chat-page/chat-services/azure-ai-search/azure-ai-search");
    (EnsureIndexIsCreated as any).mockResolvedValueOnce({ status: "ERROR", errors: [{ message: "index failed" }] });
    const file = new File(["content"], "doc.txt", { type: "text/plain" });
    const formData = new FormData();
    formData.append("file", file);
    const result = await CrackDocument(formData);
    expect(result.status).toBe("ERROR");
    expect((result as any).errors[0].message).toBe("index failed");
  });
});

describe("chat-page.unit.document-service.004 — FindAllChatDocuments filters by type, threadId and isDeleted only", () => {
  it("scopes documents by thread (intentionally not by userId — documents can be assigned to an agent and shared)", async () => {
    await FindAllChatDocuments("t1");
    expect(queryCapture.parameters).toEqual(
      expect.arrayContaining([
        { name: "@type", value: CHAT_DOCUMENT_ATTRIBUTE },
        { name: "@threadId", value: "t1" },
        { name: "@isDeleted", value: false },
      ])
    );
    // Pin design intent: no @userId parameter — documents are agent-scoped, not user-scoped.
    expect(queryCapture.parameters?.some((p: any) => p.name === "@userId")).toBe(false);
  });

  it("orders deterministically, so the document names in the prompt cannot reshuffle", async () => {
    // The document names go into the system prompt's DOCUMENT CONTEXT line.
    // Without an ORDER BY, Cosmos may hand the same documents back in a
    // different order on a later turn, rewriting the prompt prefix and voiding
    // the prompt cache for no reason at all.
    await FindAllChatDocuments("t1");
    expect(queryCapture.query).toMatch(/ORDER BY r\.createdAt ASC/i);
  });
});

describe("chat-page.unit.document-service.005 — Upload over MAX_UPLOAD_DOCUMENT_SIZE returns ERROR", () => {
  it("returns ERROR for oversized file (PDF > 10MB)", async () => {
    // Create a file that exceeds 10MB by 1 byte
    const bigData = new Uint8Array(10485761); // 10MB + 1 byte
    const file = new File([bigData], "big.pdf", { type: "application/pdf" });
    const formData = new FormData();
    formData.append("file", file);
    const result = await CrackDocument(formData);
    // File is too large — Document Intelligence will return ERROR
    // The MAX_UPLOAD_DOCUMENT_SIZE check is inside LoadFile
    expect(result.status).toBe("ERROR");
  });
});
