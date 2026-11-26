import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { setSession, defaultSession, adminSession, type TestSession } from "@/__tests__/helpers/session-mock";
import { FakeGraph } from "../../sharepoint-files/__tests__/fake-graph";

/**
 * Search and Code rows written by an admin (an editor who is not the owner)
 * go to the agent OWNER's partition, so the owner and every user of the
 * agent can use them; removal deletes a row in its own partition.
 *
 * Real code: the agent files store, the Search / Code row stores and the
 * chat-time access rule (FindAccessiblePersonaDocument). Faked: Cosmos (one
 * in-memory container with partitions), the AI Search index, Graph.
 */

const hash = (email: string) => createHash("sha256").update(email).digest("hex");
const ownerSession: TestSession = {
  user: { name: "Owner", email: "owner@example.com", isAdmin: false, accessToken: "owner-token" },
  expires: new Date(Date.now() + 86_400_000).toISOString(),
};
const OWNER = hash(ownerSession!.user.email);
const ADMIN = hash(adminSession!.user.email);
const VIEWER = hash(defaultSession!.user.email);

let me = OWNER;
const as = async (session: TestSession) => {
  await setSession(session);
  me = hash(session!.user.email);
};

vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));
vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("@/features/common/navigation-helpers", () => ({ RevalidateCache: vi.fn(async () => {}) }));

// ── Cosmos: one container, partition key /userId ────────────────────────────
type Doc = Record<string, any>;
let store: Doc[] = [];
let etag = 0;

const evaluate = (spec: { query: string; parameters?: { name: string; value: any }[] }, options?: { partitionKey?: string }) => {
  const q = spec.query;
  const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
  const rows = store.filter((d) => {
    if (options?.partitionKey !== undefined && d.userId !== options.partitionKey) return false;
    if (q.includes("(r.type=@doc OR r.type=@ci)") && d.type !== p["@doc"] && d.type !== p["@ci"]) return false;
    if (q.includes("r.type=@type") && d.type !== p["@type"]) return false;
    if (/r\.id=@id\b/.test(q) && d.id !== p["@id"]) return false;
    if (q.includes("r.id!=@personaId") && d.id === p["@personaId"]) return false;
    if (q.includes("r.userId=@userId") && d.userId !== p["@userId"]) return false;
    if (q.includes("ARRAY_CONTAINS(@ids, r.id)") && !p["@ids"].includes(d.id)) return false;
    if (q.includes("ARRAY_CONTAINS(@owners, r.userId)") && !p["@owners"].includes(d.userId)) return false;
    const listed = q.match(/ARRAY_CONTAINS\(r\.(\w+), (@\w+)\)/);
    if (listed && !(d[listed[1]] ?? []).includes(p[listed[2]])) return false;
    return true;
  });
  return q.includes("SELECT VALUE COUNT(1)") ? [rows.length] : rows.map((r) => ({ ...r }));
};

const notFound = () => Object.assign(new Error("Not found"), { code: 404 });
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: {
      query: (spec: any, options?: any) => ({ fetchAll: async () => ({ resources: evaluate(spec, options) }) }),
      upsert: async (doc: Doc) => {
        store = store.filter((d) => !(d.id === doc.id && d.userId === doc.userId));
        store.push({ ...doc });
        return { resource: doc, item: { id: doc.id } };
      },
    },
    item: (id: string, pk: string) => ({
      replace: async (doc: Doc, opts?: { accessCondition?: { condition: string } }) => {
        const i = store.findIndex((d) => d.id === id && d.userId === pk);
        if (i < 0) throw notFound();
        if (opts?.accessCondition && opts.accessCondition.condition !== store[i]._etag) {
          throw Object.assign(new Error("precondition failed"), { code: 412 });
        }
        store[i] = { ...doc, _etag: `e${++etag}` };
        return { resource: store[i] };
      },
      delete: vi.fn(async () => {
        const i = store.findIndex((d) => d.id === id && d.userId === pk);
        if (i < 0) throw notFound();
        store.splice(i, 1);
        return {};
      }),
    }),
  }),
  ConfigContainer: () => ({}),
}));

// ── AI Search: the chunks of each persona document ──────────────────────────
type Chunk = { personaDocumentId: string; user: string };
let chunks: Chunk[] = [];
const IndexDocuments = vi.fn(
  async (docs: string[], _name?: string, _thread?: string, personaDocumentId?: string, ownerUserId?: string) => {
    for (const _ of docs) chunks.push({ personaDocumentId: personaDocumentId!, user: ownerUserId ?? me });
    return docs.map(() => ({ status: "OK", response: true }));
  },
);
const DeleteSearchDocumentByPersonaDocumentId = vi.fn(async (id: string, ownerUserId?: string) => {
  const user = ownerUserId ?? me;
  chunks = chunks.filter((c) => !(c.personaDocumentId === id && c.user === user));
  return { status: "OK", response: true };
});
vi.mock("@/features/chat-page/chat-services/azure-ai-search/azure-ai-search", () => ({
  IndexDocuments: (...a: Parameters<typeof IndexDocuments>) => IndexDocuments(...a),
  DeleteSearchDocumentByPersonaDocumentId: (id: string, owner?: string) =>
    DeleteSearchDocumentByPersonaDocumentId(id, owner),
}));
vi.mock("@/features/chat-page/chat-services/chat-document-service", () => ({
  ChunkDocumentWithOverlap: vi.fn(async (text: string) => [text]),
}));
vi.mock("@/features/common/services/document-intelligence", () => ({ DocumentIntelligenceInstance: vi.fn() }));

// The text download of a Search file (Graph client).
vi.mock("@/features/common/services/microsoft-graph-client", () => ({
  getGraphClient: vi.fn(() => ({
    api: vi.fn(() => ({
      responseType: vi.fn().mockReturnThis(),
      get: vi.fn(async () => new TextEncoder().encode("Opening hours are 8 to 5.").buffer),
    })),
  })),
}));

// ── Agent: access (owner or admin edits), who may open it ───────────────────
let viewerCanOpen = true;
const personaRow = (id: string) => store.find((d) => d.type === "PERSONA" && d.id === id);
vi.mock("../../skills/persona-skill-store", () => ({
  readPersonaRow: vi.fn(async (id: string) => {
    const row = personaRow(id);
    return row ? { ...row } : undefined;
  }),
  resolveSkillAccess: vi.fn(async (id: string) => {
    const row = personaRow(id);
    if (!row) return undefined;
    const canEdit = me === row.userId || me === ADMIN;
    return { persona: { ...row }, currentUserId: me, canEdit, canUse: canEdit || viewerCanOpen };
  }),
  querySkillsByPersonaId: vi.fn(async () => []),
}));
vi.mock("../../persona-lookup", () => ({
  findPersonaForCurrentUser: vi.fn(async (id: string) => {
    const row = personaRow(id);
    const canOpen = row && (me === row.userId || me === ADMIN || viewerCanOpen);
    return canOpen ? { status: "OK", response: { ...row } } : { status: "NOT_FOUND", errors: [{ message: "x" }] };
  }),
}));
vi.mock("../../sharepoint-files/sharepoint-file-store", () => ({ queryFileSourcesByPersonaId: vi.fn(async () => []) }));
vi.mock("../../sharepoint-files/add-file-source", () => ({ addPersonaFileSource: vi.fn() }));
vi.mock("../../sharepoint-files/sharepoint-file-service", () => ({ DeletePersonaFileSource: vi.fn() }));
vi.mock("../../skills/linked-skill-sync", () => ({ fetchLinkedSkillZip: vi.fn() }));
vi.mock("../../skills/link-sharepoint-skill", () => ({ linkSharePointSkill: vi.fn() }));
vi.mock("../../skills/persona-skill-service", () => ({ DeletePersonaSkill: vi.fn() }));

import { AddAgentFiles, ChangeAgentFileUse, RemoveAgentFile } from "../agent-file-service";
import {
  FindAccessiblePersonaDocument,
  personaCodeDocumentsByIds as PersonaCIDocumentsByIds,
} from "../../persona-document-access";

// The chat-time access rule of a Search file row (server code only).
const PersonaDocumentById = async (id: string) =>
  (await FindAccessiblePersonaDocument(id, "PERSONA_DOCUMENT"))
    ? { status: "OK" as const }
    : { status: "NOT_FOUND" as const };
import { logError } from "@/features/common/services/logger";

const DRIVE = "b!driveA_123";

beforeEach(async () => {
  vi.clearAllMocks();
  store = [
    {
      id: "p1",
      type: "PERSONA",
      userId: OWNER,
      name: "Agent",
      personaDocumentIds: [],
      codeInterpreterDocumentIds: [],
      defaultTools: {},
      _etag: "e0",
    },
  ];
  chunks = [];
  viewerCanOpen = true;
  delete process.env.MAX_PERSONA_DOCUMENT_LIMIT;
  // The admin of these tests is an admin by ADMIN_EMAIL_ADDRESS.
  vi.stubEnv("ADMIN_EMAIL_ADDRESS", adminSession!.user.email);
  const graph = new FakeGraph()
    .add(DRIVE, { id: "ROOT", name: "root", folder: true })
    .add(DRIVE, { id: "TXT1", name: "Hours.txt", parent: "ROOT", size: 25 })
    .add(DRIVE, { id: "CSV1", name: "sales.csv", parent: "ROOT", size: 2000 });
  vi.stubGlobal("fetch", vi.fn(graph.fetch));
  await as(ownerSession);
});

const addOne = async (itemId: string) => {
  const res = await AddAgentFiles("p1", [{ driveId: DRIVE, itemId }]);
  if (res.status !== "OK" || res.response[0].status !== "added") throw new Error(JSON.stringify(res));
  return res.response[0];
};

const rowsOfType = (type: string) => store.filter((d) => d.type === type);

describe("an admin adds a file to another user's agent (owner partition)", () => {
  it("Search: the row and its index chunks are under the owner; the owner and a viewer can use it", async () => {
    await as(adminSession);
    const added = await addOne("TXT1");
    expect(added).toMatchObject({ use: "search" });

    const [row] = rowsOfType("PERSONA_DOCUMENT");
    expect(row).toMatchObject({ id: added.ref.id, userId: OWNER });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.personaDocumentId === row.id && c.user === OWNER)).toBe(true);
    expect(personaRow("p1")!.personaDocumentIds).toEqual([row.id]);

    await as(ownerSession);
    expect((await PersonaDocumentById(row.id)).status).toBe("OK");
    await as(defaultSession);
    expect(me).toBe(VIEWER);
    expect((await PersonaDocumentById(row.id)).status).toBe("OK");
  });

  it("Code: the row is under the owner; the owner and a viewer get it at chat start", async () => {
    await as(adminSession);
    const added = await addOne("CSV1");
    expect(added).toMatchObject({ use: "code" });
    expect(rowsOfType("PERSONA_CI_DOCUMENT")).toEqual([expect.objectContaining({ id: added.ref.id, userId: OWNER })]);

    for (const session of [ownerSession, defaultSession]) {
      await as(session);
      const res = await PersonaCIDocumentsByIds([added.ref.id]);
      expect(res.status === "OK" && res.response.map((d) => d.id)).toEqual([added.ref.id]);
    }
  });

  it("Code -> Search by an admin: the new Search file works for the owner, the Code row is gone", async () => {
    store.push({
      id: "ci-1",
      type: "PERSONA_CI_DOCUMENT",
      userId: OWNER,
      fileName: "Hours.txt",
      source: "SHAREPOINT",
      externalFile: { documentId: "TXT1", parentReference: { driveId: DRIVE } },
    });
    personaRow("p1")!.codeInterpreterDocumentIds = ["ci-1"];

    await as(adminSession);
    const res = await ChangeAgentFileUse("p1", { kind: "ci-document", id: "ci-1" }, "search");
    expect(res.status).toBe("OK");
    if (res.status !== "OK") return;
    expect(res.response.warning).toBeUndefined();
    expect(rowsOfType("PERSONA_CI_DOCUMENT")).toEqual([]);
    expect(rowsOfType("PERSONA_DOCUMENT")).toEqual([expect.objectContaining({ id: res.response.ref.id, userId: OWNER })]);

    await as(ownerSession);
    expect((await PersonaDocumentById(res.response.ref.id)).status).toBe("OK");
  });
});

describe("removal deletes each row in its own partition", () => {
  const seedSearchRow = (id: string, userId: string) => {
    store.push({
      id,
      type: "PERSONA_DOCUMENT",
      userId,
      source: "SHAREPOINT",
      externalFile: { documentId: "TXT1", parentReference: { driveId: DRIVE } },
    });
    chunks.push({ personaDocumentId: id, user: userId }, { personaDocumentId: id, user: userId });
    personaRow("p1")!.personaDocumentIds = [...personaRow("p1")!.personaDocumentIds, id];
  };

  it("the owner removes a Search file an admin added before (row and chunks in the admin's partition)", async () => {
    seedSearchRow("doc-legacy", ADMIN);
    const res = await RemoveAgentFile("p1", { kind: "document", id: "doc-legacy" });
    expect(res).toEqual({ status: "OK", response: {} });
    expect(personaRow("p1")!.personaDocumentIds).toEqual([]);
    expect(rowsOfType("PERSONA_DOCUMENT")).toEqual([]);
    expect(chunks).toEqual([]);
    expect(DeleteSearchDocumentByPersonaDocumentId).toHaveBeenCalledWith("doc-legacy", ADMIN);
  });

  it("an admin removes the owner's Search file (row and chunks in the owner's partition)", async () => {
    seedSearchRow("doc-own", OWNER);
    await as(adminSession);
    const res = await RemoveAgentFile("p1", { kind: "document", id: "doc-own" });
    expect(res).toEqual({ status: "OK", response: {} });
    expect(rowsOfType("PERSONA_DOCUMENT")).toEqual([]);
    expect(chunks).toEqual([]);
  });

  it("the owner removes a Code file an admin added before", async () => {
    store.push({
      id: "ci-legacy",
      type: "PERSONA_CI_DOCUMENT",
      userId: ADMIN,
      fileName: "sales.csv",
      source: "SHAREPOINT",
      externalFile: { documentId: "CSV1", parentReference: { driveId: DRIVE } },
    });
    personaRow("p1")!.codeInterpreterDocumentIds = ["ci-legacy"];
    const res = await RemoveAgentFile("p1", { kind: "ci-document", id: "ci-legacy" });
    expect(res).toEqual({ status: "OK", response: {} });
    expect(rowsOfType("PERSONA_CI_DOCUMENT")).toEqual([]);
  });

  it("never deletes a row with the same id in the partition of a user who is not an admin", async () => {
    seedSearchRow("doc-own", OWNER);
    store.push({
      id: "doc-own",
      type: "PERSONA_DOCUMENT",
      userId: VIEWER,
      source: "SHAREPOINT",
      externalFile: { documentId: "TXT1", parentReference: { driveId: DRIVE } },
    });
    chunks.push({ personaDocumentId: "doc-own", user: VIEWER });
    const res = await RemoveAgentFile("p1", { kind: "document", id: "doc-own" });
    expect(res).toEqual({ status: "OK", response: {} });
    expect(rowsOfType("PERSONA_DOCUMENT")).toEqual([expect.objectContaining({ id: "doc-own", userId: VIEWER })]);
    expect(chunks).toEqual([{ personaDocumentId: "doc-own", user: VIEWER }]);
  });

  it("keeps a row that another agent still lists", async () => {
    seedSearchRow("doc-shared", OWNER);
    store.push({ id: "p2", type: "PERSONA", userId: OWNER, personaDocumentIds: ["doc-shared"] });
    const res = await RemoveAgentFile("p1", { kind: "document", id: "doc-shared" });
    expect(res).toEqual({ status: "OK", response: {} });
    expect(personaRow("p1")!.personaDocumentIds).toEqual([]);
    expect(rowsOfType("PERSONA_DOCUMENT")).toHaveLength(1);
    expect(chunks).toHaveLength(2);
  });

  it("index cleanup fails: the file is off the agent, the result says so, the error is logged", async () => {
    seedSearchRow("doc-own", OWNER);
    DeleteSearchDocumentByPersonaDocumentId.mockResolvedValueOnce({
      status: "ERROR",
      errors: [{ message: "search down" }],
    } as any);
    const res = await RemoveAgentFile("p1", { kind: "document", id: "doc-own" });
    expect(res.status).toBe("OK");
    expect(res.status === "OK" && res.response.warning).toMatch(/no longer used.*could not be deleted/);
    expect(personaRow("p1")!.personaDocumentIds).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "agent files: stored data of a removed file not deleted",
      expect.objectContaining({ kind: "document" }),
    );
  });
});
