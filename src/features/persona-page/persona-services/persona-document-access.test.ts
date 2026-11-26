import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { setSession, defaultSession } from "@/__tests__/helpers/session-mock";

const hashEmail = (e: string) => createHash("sha256").update(e).digest("hex");
const ME = hashEmail(defaultSession!.user.email);
const OTHER = hashEmail("other@example.com");

// ── Cosmos mock that applies the query conditions ────────────────────────────
let store: any[] = [];

const evaluate = (spec: any, options?: { partitionKey?: string }) => {
  const query: string = spec.query;
  const params: Record<string, any> = Object.fromEntries(
    (spec.parameters ?? []).map((p: any) => [p.name, p.value])
  );
  return store.filter((d) => {
    if (options?.partitionKey !== undefined && d.userId !== options.partitionKey)
      return false;
    if (query.includes("r.type=@type") && d.type !== params["@type"]) return false;
    if (query.includes("r.id=@id") && d.id !== params["@id"]) return false;
    if (query.includes("r.userId=@userId") && d.userId !== params["@userId"])
      return false;
    const listed = query.match(/ARRAY_CONTAINS\(r\.(\w+), @documentId\)/);
    if (listed && !(d[listed[1]] ?? []).includes(params["@documentId"]))
      return false;
    if (
      query.includes("ARRAY_CONTAINS(@ids, r.id)") &&
      !params["@ids"].includes(d.id)
    )
      return false;
    return true;
  });
};

const upsert = vi.fn(async (doc: any) => ({ resource: { ...doc }, item: { id: doc.id } }));

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: {
      upsert,
      query: vi.fn((spec: any, options?: any) => ({
        fetchAll: async () => ({ resources: evaluate(spec, options) }),
      })),
    },
    item: vi.fn(() => ({ read: vi.fn(), delete: vi.fn(async () => ({})) })),
  }),
  ConfigContainer: () => ({}),
}));

vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/features/common/services/microsoft-graph-client", () => ({
  getGraphClient: vi.fn(() => ({
    api: vi.fn(() => ({
      post: vi.fn(async () => ({ responses: [] })),
      select: vi.fn().mockReturnThis(),
      get: vi.fn(),
      responseType: vi.fn().mockReturnThis(),
    })),
  })),
}));

vi.mock("@/features/chat-page/chat-services/azure-ai-search/azure-ai-search", () => ({
  DeleteSearchDocumentByPersonaDocumentId: vi.fn(),
  IndexDocuments: vi.fn(),
  // Every document counts as indexed, so no SharePoint download is needed.
  PersonaDocumentExistsInIndex: vi.fn(async () => ({ status: "OK", response: {} })),
}));

vi.mock("@/features/common/services/document-intelligence", () => ({
  DocumentIntelligenceInstance: vi.fn(),
}));


// The access rule opens the agent with the server-only lookup (whole row).
vi.mock("./persona-lookup", () => ({
  findPersonaForCurrentUser: vi.fn(),
}));

import {
  FindAccessiblePersonaDocument,
  personaCodeDocumentsByIds as PersonaCIDocumentsByIds,
} from "./persona-document-access";
import { findPersonaForCurrentUser as FindPersonaByID } from "./persona-lookup";

// The Search file row reader is server code only (no Server Action returns
// whole rows); the same access rule as before.
const PersonaDocumentById = async (id: string) => {
  const row = await FindAccessiblePersonaDocument<{ id: string; userId: string }>(id, "PERSONA_DOCUMENT");
  return row
    ? ({ status: "OK", response: row } as const)
    : ({ status: "NOT_FOUND", errors: [{ message: "Persona Document not found" }] } as const);
};

const personaDoc = (id: string, userId: string) => ({
  id,
  userId,
  type: "PERSONA_DOCUMENT",
  source: "SHAREPOINT",
  externalFile: { documentId: `sp-${id}`, parentReference: { driveId: "drive-1" } },
});

const ciDoc = (id: string, userId: string) => ({
  ...personaDoc(id, userId),
  type: "PERSONA_CI_DOCUMENT",
  fileName: `${id}.csv`,
});

const persona = (id: string, userId: string, extra: Record<string, any> = {}) => ({
  id,
  userId,
  type: "PERSONA",
  personaDocumentIds: [],
  codeInterpreterDocumentIds: [],
  ...extra,
});

const canOpen = (...personas: any[]) => {
  vi.mocked(FindPersonaByID).mockImplementation(async (id: string) => {
    const found = personas.find((p) => p.id === id);
    return found
      ? ({ status: "OK", response: found } as any)
      : ({ status: "UNAUTHORIZED", errors: [{ message: "no access" }] } as any);
  });
};

beforeEach(() => {
  store = [];
  vi.clearAllMocks();
  setSession(defaultSession);
  canOpen();
  process.env.MAX_PERSONA_DOCUMENT_LIMIT = "10";
  process.env.MAX_PERSONA_CI_DOCUMENT_LIMIT = "20";
});

describe("PersonaDocumentById checks type and access", () => {
  it("returns NOT_FOUND for a document of another type with that id", async () => {
    store.push({ id: "thread1", userId: OTHER, type: "CHAT_THREAD", name: "private" });
    const result = await PersonaDocumentById("thread1");
    expect(result.status).toBe("NOT_FOUND");
  });

  it("returns a document in the caller's own partition", async () => {
    store.push(personaDoc("doc1", ME));
    const result = await PersonaDocumentById("doc1");
    expect(result.status).toBe("OK");
    expect(FindPersonaByID).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for a document of an agent the caller cannot open", async () => {
    store.push(personaDoc("doc1", OTHER));
    store.push(persona("p1", OTHER, { personaDocumentIds: ["doc1"] }));
    const result = await PersonaDocumentById("doc1");
    expect(result.status).toBe("NOT_FOUND");
  });

  it("returns NOT_FOUND for a document of another user that no agent lists", async () => {
    store.push(personaDoc("doc1", OTHER));
    canOpen(persona("p1", OTHER));
    const result = await PersonaDocumentById("doc1");
    expect(result.status).toBe("NOT_FOUND");
  });

  it("returns the document to a user who can open the agent", async () => {
    const shared = persona("p1", OTHER, { personaDocumentIds: ["doc1"] });
    store.push(personaDoc("doc1", OTHER), shared);
    canOpen(shared);
    const result = await PersonaDocumentById("doc1");
    expect(result.status).toBe("OK");
    if (result.status === "OK") expect(result.response.userId).toBe(OTHER);
  });

  it("an agent of the caller that lists another user's document id gives no access", async () => {
    const mine = persona("mine", ME, { personaDocumentIds: ["doc1"] });
    store.push(personaDoc("doc1", OTHER), mine);
    canOpen(mine);
    const result = await PersonaDocumentById("doc1");
    expect(result.status).toBe("NOT_FOUND");
  });
});

describe("PersonaCIDocumentsByIds checks type and access", () => {
  it("returns NOT_FOUND for a document of another type with that id", async () => {
    store.push({ id: "ext1", userId: OTHER, type: "EXTENSION" });
    expect(await PersonaCIDocumentsByIds(["ext1"])).toEqual({ status: "OK", response: [] });
  });

  it("returns NOT_FOUND for a document of an agent the caller cannot open", async () => {
    store.push(ciDoc("ci1", OTHER));
    store.push(persona("p1", OTHER, { codeInterpreterDocumentIds: ["ci1"] }));
    expect(await PersonaCIDocumentsByIds(["ci1"])).toEqual({ status: "OK", response: [] });
  });

  it("PersonaCIDocumentsByIds returns only documents of agents the caller can open", async () => {
    const shared = persona("p1", OTHER, { codeInterpreterDocumentIds: ["ci1"] });
    store.push(ciDoc("ci1", OTHER), ciDoc("ci2", OTHER), shared);
    store.push(persona("p2", OTHER, { codeInterpreterDocumentIds: ["ci2"] }));
    canOpen(shared);
    const result = await PersonaCIDocumentsByIds(["ci1", "ci2"]);
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.map((d) => d.id)).toEqual(["ci1"]);
    }
  });
});
