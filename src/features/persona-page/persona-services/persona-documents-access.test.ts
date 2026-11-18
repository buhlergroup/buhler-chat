import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import {
  setSession,
  defaultSession,
  adminSession,
} from "@/__tests__/helpers/session-mock";

// Edit rights on persona (agent) documents: only the owner or an admin may
// delete them. Being able to open (use) a shared or published agent is not
// enough.

const hashEmail = (e: string) => createHash("sha256").update(e).digest("hex");
const USER_HASH = hashEmail(defaultSession!.user.email);

let historyItems: any[] = [];
const deleteCalls: Array<[string, string]> = [];

const historyContainer = {
  items: {
    upsert: vi.fn(async (doc: any) => ({ resource: doc, item: { id: doc.id } })),
    query: vi.fn((_q: any) => ({
      fetchAll: async () => ({ resources: historyItems }),
    })),
  },
  item: vi.fn((id: string, pk: string) => ({
    read: vi.fn(),
    delete: vi.fn(async () => {
      deleteCalls.push([id, pk]);
      // Cosmos semantics: the item must exist in THIS partition.
      const doc = historyItems.find((i) => i.id === id && i.userId === pk);
      if (!doc) throw Object.assign(new Error("Not found"), { code: 404 });
      return { resource: undefined };
    }),
  })),
};

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => historyContainer,
  ConfigContainer: () => historyContainer,
}));

vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/features/common/services/microsoft-graph-client", () => ({
  getGraphClient: vi.fn(() => ({ api: vi.fn() })),
}));

vi.mock("@/features/persona-page/persona-services/access-group-service", () => ({
  AccessGroupById: vi.fn(async () => ({ status: "OK", response: { id: "g1" } })),
  UserAccessGroups: vi.fn(async () => ({ status: "OK", response: [] })),
}));

vi.mock("@/features/chat-page/chat-services/azure-ai-search/azure-ai-search", () => ({
  DeleteSearchDocumentByPersonaDocumentId: vi.fn(async () => undefined),
  IndexDocuments: vi.fn(async () => []),
  PersonaDocumentExistsInIndex: vi.fn(async () => ({ status: "OK", response: true })),
}));

vi.mock("@/features/common/services/document-intelligence", () => ({
  DocumentIntelligenceInstance: vi.fn(),
}));

vi.mock("@/features/chat-page/chat-services/chat-document-service", () => ({
  ChunkDocumentWithOverlap: vi.fn(),
}));

import {
  DeletePersonaDocumentsByPersonaId,
  UpdateOrAddPersonaDocuments,
} from "./persona-documents-service";
import { DeleteSearchDocumentByPersonaDocumentId } from "@/features/chat-page/chat-services/azure-ai-search/azure-ai-search";

const seedPersona = (overrides: Record<string, any> = {}) => {
  historyItems.push({
    id: "p1",
    type: "PERSONA",
    userId: "owner-hash",
    isPublished: false,
    personaDocumentIds: ["doc-1", "doc-2"],
    ...overrides,
  });
};

beforeEach(async () => {
  historyItems = [];
  deleteCalls.length = 0;
  vi.clearAllMocks();
  process.env.MAX_PERSONA_DOCUMENT_LIMIT = "10";
  await setSession(defaultSession);
});

describe("persona documents: DeletePersonaDocumentsByPersonaId needs edit rights", () => {
  it("denied: a user who can only use a published agent gets 'not allowed', nothing is deleted", async () => {
    seedPersona({ isPublished: true });
    const result = await DeletePersonaDocumentsByPersonaId("p1");
    expect(result.status).toBe("UNAUTHORIZED");
    if (result.status === "UNAUTHORIZED") {
      expect(result.errors[0].message).toMatch(/not allowed/);
    }
    expect(DeleteSearchDocumentByPersonaDocumentId).not.toHaveBeenCalled();
    expect(deleteCalls).toEqual([]);
  });

  it("denied: a member of the share group (can open, cannot edit) gets 'not allowed'", async () => {
    seedPersona({ accessGroup: { id: "g1", source: "SHAREPOINT" } });
    const result = await DeletePersonaDocumentsByPersonaId("p1");
    expect(result.status).toBe("UNAUTHORIZED");
    expect(DeleteSearchDocumentByPersonaDocumentId).not.toHaveBeenCalled();
  });

  it("denied: a private agent of another user is NOT_FOUND (existence not revealed)", async () => {
    seedPersona();
    const result = await DeletePersonaDocumentsByPersonaId("p1");
    expect(result.status).toBe("NOT_FOUND");
    expect(DeleteSearchDocumentByPersonaDocumentId).not.toHaveBeenCalled();
  });

  it("allowed: the owner deletes the agent's documents", async () => {
    seedPersona({ userId: USER_HASH });
    const result = await DeletePersonaDocumentsByPersonaId("p1");
    expect(result.status).toBe("OK");
    expect(DeleteSearchDocumentByPersonaDocumentId).toHaveBeenCalledTimes(2);
  });

  it("allowed: an admin deletes the documents of another user's agent", async () => {
    await setSession(adminSession);
    seedPersona();
    const result = await DeletePersonaDocumentsByPersonaId("p1");
    expect(result.status).toBe("OK");
    expect(DeleteSearchDocumentByPersonaDocumentId).toHaveBeenCalledTimes(2);
  });
});

describe("persona documents: UpdateOrAddPersonaDocuments removes only own documents", () => {
  it("allowed: an own document is removed from Cosmos and from the search index", async () => {
    historyItems.push({ id: "own-doc", type: "PERSONA_DOCUMENT", userId: USER_HASH });
    const result = await UpdateOrAddPersonaDocuments([], ["own-doc"]);
    expect(result.status).toBe("OK");
    expect(DeleteSearchDocumentByPersonaDocumentId).toHaveBeenCalledWith("own-doc");
  });

  it("denied: a document id of another user's agent is skipped, its search entries stay", async () => {
    historyItems.push({ id: "foreign-doc", type: "PERSONA_DOCUMENT", userId: "owner-hash" });
    const result = await UpdateOrAddPersonaDocuments([], ["foreign-doc"]);
    expect(result.status).toBe("OK");
    expect(deleteCalls).toEqual([["foreign-doc", USER_HASH]]);
    expect(DeleteSearchDocumentByPersonaDocumentId).not.toHaveBeenCalled();
  });
});
