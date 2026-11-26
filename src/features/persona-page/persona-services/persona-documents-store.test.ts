import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { setSession, adminSession } from "@/__tests__/helpers/session-mock";

// Search files: the row and the index chunks are written with the agent
// owner's id, and deleted by the row's own partition.

const ADMIN = createHash("sha256").update(adminSession!.user.email).digest("hex");

let rows: Array<Record<string, any>> = [];
const upsert = vi.fn(async (doc: any) => {
  rows.push({ ...doc });
  return { resource: doc, item: { id: doc.id } };
});
const deleteCalls: Array<[string, string]> = [];
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: { upsert },
    item: (id: string, pk: string) => ({
      delete: async () => {
        deleteCalls.push([id, pk]);
        const i = rows.findIndex((r) => r.id === id && r.userId === pk);
        if (i < 0) throw Object.assign(new Error("Not found"), { code: 404 });
        rows.splice(i, 1);
        return {};
      },
    }),
  }),
}));

vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));

const IndexDocuments = vi.fn(async (docs: string[], ..._rest: unknown[]): Promise<any[]> =>
  docs.map(() => ({ status: "OK", response: true }))
);
const DeleteSearchDocumentByPersonaDocumentId = vi.fn(
  async (_id: string, _owner?: string): Promise<any> => ({ status: "OK", response: true })
);
vi.mock("@/features/chat-page/chat-services/azure-ai-search/azure-ai-search", () => ({
  IndexDocuments: (...a: [string[], ...unknown[]]) => IndexDocuments(...a),
  DeleteSearchDocumentByPersonaDocumentId: (id: string, owner?: string) =>
    DeleteSearchDocumentByPersonaDocumentId(id, owner),
}));
vi.mock("@/features/chat-page/chat-services/chat-document-service", () => ({
  ChunkDocumentWithOverlap: vi.fn(async (text: string) => [text]),
}));
vi.mock("@/features/common/services/document-intelligence", () => ({
  DocumentIntelligenceInstance: vi.fn(),
}));
const extract = vi.fn(async (_bytes: Uint8Array) => "Extracted text.");
vi.mock("@/features/common/services/document-extraction", () => ({
  extractTextWithDocumentIntelligence: (bytes: Uint8Array) => extract(bytes),
}));
vi.mock("@/features/common/services/microsoft-graph-client", () => ({
  getGraphClient: vi.fn(() => ({
    api: vi.fn(() => ({
      responseType: vi.fn().mockReturnThis(),
      get: vi.fn(async () => new TextEncoder().encode("Some text.").buffer),
    })),
  })),
}));

import { addSearchDocument, deleteSearchDocument } from "./persona-documents-store";
import { register, SERVICE_KEYS } from "@/features/common/services/service-container";
import { createMemoryContentBlobBackend } from "@/features/common/services/content-store/memory-backend";

const file = {
  documentId: "ITEM1",
  parentReference: { driveId: "b!drive" },
  name: "notes.txt",
  createdBy: "",
  createdDateTime: "",
};

beforeEach(async () => {
  rows = [];
  deleteCalls.length = 0;
  vi.clearAllMocks();
  // The caller is an admin, not the owner of the agent.
  await setSession(adminSession);
});

describe("addSearchDocument", () => {
  it("writes the row and the chunks with the owner's id, not the caller's", async () => {
    const res = await addSearchDocument(file, "owner-hash");
    expect(res.status).toBe("OK");
    const id = res.status === "OK" ? res.response : "";
    expect(rows).toEqual([
      expect.objectContaining({
        id,
        userId: "owner-hash",
        type: "PERSONA_DOCUMENT",
        externalFile: { documentId: "ITEM1", parentReference: { driveId: "b!drive" } },
      }),
    ]);
    expect(IndexDocuments).toHaveBeenCalledWith(["Some text."], "notes.txt", undefined, id, "owner-hash");
    expect(JSON.stringify(rows)).not.toContain(ADMIN);
  });

  it("indexing fails: the row and the chunks written so far are deleted under the owner", async () => {
    IndexDocuments.mockResolvedValueOnce([
      { status: "OK", response: true },
      { status: "ERROR", errors: [{ message: "quota" }] },
    ]);
    const res = await addSearchDocument(file, "owner-hash");
    expect(res).toEqual({ status: "ERROR", errors: [{ message: "notes.txt: quota" }] });
    expect(rows).toEqual([]);
    expect(DeleteSearchDocumentByPersonaDocumentId).toHaveBeenCalledWith(expect.any(String), "owner-hash");
    expect(deleteCalls.map(([, pk]) => pk)).toEqual(["owner-hash"]);
  });
});

describe("deleteSearchDocument", () => {
  it("deletes the row in its own partition and its chunks by the same id", async () => {
    rows.push({ id: "d1", userId: "someone-hash", type: "PERSONA_DOCUMENT" });
    const res = await deleteSearchDocument({ id: "d1", userId: "someone-hash" });
    expect(res).toEqual({ status: "OK", response: true });
    expect(deleteCalls).toEqual([["d1", "someone-hash"]]);
    expect(DeleteSearchDocumentByPersonaDocumentId).toHaveBeenCalledWith("d1", "someone-hash");
  });

  it("a row that is already gone is no error", async () => {
    expect((await deleteSearchDocument({ id: "gone", userId: "owner-hash" })).status).toBe("OK");
  });

  it("reports a failed chunk delete and still deletes the row", async () => {
    rows.push({ id: "d1", userId: "owner-hash", type: "PERSONA_DOCUMENT" });
    DeleteSearchDocumentByPersonaDocumentId.mockResolvedValueOnce({
      status: "ERROR",
      errors: [{ message: "search down" }],
    });
    const res = await deleteSearchDocument({ id: "d1", userId: "owner-hash" });
    expect(res.status).toBe("ERROR");
    expect(res.status === "ERROR" && res.errors[0].message).toMatch(/index entries.*search down/);
    expect(rows).toEqual([]);
  });
});

describe("addSearchDocument with the content store", () => {
  beforeEach(() => {
    // A fresh in-memory content store for each test.
    register(SERVICE_KEYS.contentBlobs, createMemoryContentBlobBackend);
  });

  it("the same file added again is not extracted again; each row is indexed and stores the hash", async () => {
    const pdf = { ...file, name: "slides.pdf" };
    const first = await addSearchDocument(pdf, "owner-hash");
    const second = await addSearchDocument(pdf, "owner-hash");
    expect(first.status).toBe("OK");
    expect(second.status).toBe("OK");
    expect(extract).toHaveBeenCalledTimes(1);
    expect(IndexDocuments).toHaveBeenCalledTimes(2);
    expect(IndexDocuments.mock.calls[1][0]).toEqual(["Extracted text."]);
    const hashes = rows.map((r) => r.sha256);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[1]).toBe(hashes[0]);
  });

  it("another owner extracts again (no reuse across scopes)", async () => {
    const pdf = { ...file, name: "slides.pdf" };
    await addSearchDocument(pdf, "owner-hash");
    await addSearchDocument(pdf, "other-owner-hash");
    expect(extract).toHaveBeenCalledTimes(2);
  });
});
