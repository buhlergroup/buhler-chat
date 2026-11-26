import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The cleanup of an agent's files when the agent is deleted (the three
 * calls DeletePersona makes): Search and Code rows in their own partition
 * with the Search chunks, skills (row + blob) and SharePoint sources, also
 * when an admin deletes another user's agent. Real code: persona-file-rows,
 * the Search / Code row stores, the skill and source cleanups. Faked:
 * Cosmos (one container with partitions), the AI Search index, blobs.
 */

vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));
vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

// ── Cosmos ───────────────────────────────────────────────────────────────────
type Doc = Record<string, any>;
let store: Doc[] = [];
let failDeleteOf: string | undefined;

const evaluate = (spec: { query: string; parameters?: { name: string; value: any }[] }) => {
  const q = spec.query;
  const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
  const rows = store.filter((d) => {
    if (q.includes("r.type=@type") && d.type !== p["@type"]) return false;
    if (/r\.id=@id\b/.test(q) && d.id !== p["@id"]) return false;
    if (q.includes("r.id!=@personaId") && d.id === p["@personaId"]) return false;
    if (q.includes("r.personaId=@personaId") && d.personaId !== p["@personaId"]) return false;
    const listed = q.match(/ARRAY_CONTAINS\(r\.(\w+), (@\w+)\)/);
    if (listed && !(d[listed[1]] ?? []).includes(p[listed[2]])) return false;
    return true;
  });
  return q.includes("SELECT VALUE COUNT(1)") ? [rows.length] : rows.map((r) => ({ ...r }));
};

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: {
      query: (spec: any) => ({ fetchAll: async () => ({ resources: evaluate(spec) }) }),
    },
    item: (id: string, pk: string) => ({
      delete: async () => {
        if (id === failDeleteOf) throw new Error("cosmos down");
        const i = store.findIndex((d) => d.id === id && d.userId === pk);
        if (i < 0) throw Object.assign(new Error("Not found"), { code: 404 });
        store.splice(i, 1);
        return {};
      },
    }),
  }),
}));

// ── AI Search chunks, blobs ─────────────────────────────────────────────────
let chunks: Array<{ personaDocumentId: string; user: string }> = [];
vi.mock("@/features/chat-page/chat-services/azure-ai-search/azure-ai-search", () => ({
  IndexDocuments: vi.fn(),
  DeleteSearchDocumentByPersonaDocumentId: vi.fn(async (id: string, user: string) => {
    chunks = chunks.filter((c) => !(c.personaDocumentId === id && c.user === user));
    return { status: "OK", response: true };
  }),
}));
vi.mock("@/features/chat-page/chat-services/chat-document-service", () => ({ ChunkDocumentWithOverlap: vi.fn() }));
vi.mock("@/features/common/services/document-intelligence", () => ({ DocumentIntelligenceInstance: vi.fn() }));
vi.mock("@/features/common/services/microsoft-graph-client", () => ({ getGraphClient: vi.fn() }));
const deletedBlobs: string[] = [];
vi.mock("@/features/common/services/azure-storage", () => ({
  UploadBlob: vi.fn(),
  GetBlob: vi.fn(),
  DeleteBlob: vi.fn(async (_c: string, name: string) => {
    deletedBlobs.push(name);
    return { status: "OK", response: true };
  }),
}));
vi.mock("@/features/common/services/openai", () => ({ OpenAIV1Instance: vi.fn() }));
vi.mock("@/features/chat-page/chat-services/code-interpreter-service", () => ({
  UploadFileForCodeInterpreter: vi.fn(),
}));

import { deleteAgentFileRows } from "./persona-file-rows";
import { deleteSkillsForPersona } from "./skills/persona-skill-store";
import { deleteFileSourcesForPersona } from "./sharepoint-files/sharepoint-file-store";
import { logError } from "@/features/common/services/logger";

const OWNER = "owner-hash";
const ADMIN = "admin-hash";
const DRIVE = "b!driveA_123";

const searchRow = (id: string, userId: string) => {
  chunks.push({ personaDocumentId: id, user: userId }, { personaDocumentId: id, user: userId });
  return { id, type: "PERSONA_DOCUMENT", userId, source: "SHAREPOINT", externalFile: { documentId: "X", parentReference: { driveId: DRIVE } } };
};
const codeRow = (id: string, userId: string) => ({
  id,
  type: "PERSONA_CI_DOCUMENT",
  userId,
  fileName: `${id}.csv`,
  source: "SHAREPOINT",
  externalFile: { documentId: "Y", parentReference: { driveId: DRIVE } },
});

/** What DeletePersona does with the files before it deletes the persona row. */
const deleteAgentFiles = async (persona: Doc) => {
  await deleteAgentFileRows(persona as any);
  await deleteSkillsForPersona(persona.id);
  await deleteFileSourcesForPersona(persona.id);
};

let persona: Doc;

beforeEach(() => {
  vi.clearAllMocks();
  chunks = [];
  deletedBlobs.length = 0;
  failDeleteOf = undefined;
  persona = {
    id: "p1",
    type: "PERSONA",
    userId: OWNER,
    personaDocumentIds: ["doc-own", "doc-legacy"],
    codeInterpreterDocumentIds: ["ci-own", "ci-legacy"],
  };
  store = [
    persona,
    searchRow("doc-own", OWNER),
    // Written by an admin before the owner-partition rule.
    searchRow("doc-legacy", ADMIN),
    codeRow("ci-own", OWNER),
    codeRow("ci-legacy", ADMIN),
    { id: "s1", type: "PERSONA_SKILL", userId: OWNER, personaId: "p1", name: "a", blobName: "agent-skills/p1/s1.zip" },
    { id: "s2", type: "PERSONA_SKILL", userId: OWNER, personaId: "p1", name: "b", blobName: "agent-skills/p1/s2.zip" },
    {
      id: "src1",
      type: "PERSONA_SHAREPOINT_FILE_SOURCE",
      userId: OWNER,
      personaId: "p1",
      driveId: DRIVE,
      itemId: "FOLDER1",
      name: "Reports",
      webUrl: "",
      kind: "folder",
      createdAt: new Date().toISOString(),
    },
    // Another agent's skill: stays.
    { id: "s-other", type: "PERSONA_SKILL", userId: OWNER, personaId: "p2", name: "c", blobName: "agent-skills/p2/s.zip" },
  ];
});

const left = () => store.filter((d) => d.id !== "p1").map((d) => d.id);

describe("deleting an agent deletes its files in every partition", () => {
  it("removes Search rows with their chunks, Code rows, skills with blobs and sources", async () => {
    await deleteAgentFiles(persona);
    expect(left()).toEqual(["s-other"]);
    expect(chunks).toEqual([]);
    expect(deletedBlobs.sort()).toEqual(["agent-skills/p1/s1.zip", "agent-skills/p1/s2.zip"]);
  });

  it("needs no session: every partition comes from the row (an admin deleting a user's agent)", async () => {
    // No user is signed in here at all; the owner's and the old admin rows go.
    await deleteAgentFileRows(persona as any);
    expect(store.filter((d) => d.type === "PERSONA_DOCUMENT" || d.type === "PERSONA_CI_DOCUMENT")).toEqual([]);
  });

  it("keeps a Search or Code row that another agent still lists", async () => {
    store.push({ id: "p2", type: "PERSONA", userId: OWNER, personaDocumentIds: ["doc-own"], codeInterpreterDocumentIds: ["ci-legacy"] });
    await deleteAgentFiles(persona);
    expect(left().sort()).toEqual(["ci-legacy", "doc-own", "p2", "s-other"]);
    expect(chunks.map((c) => c.personaDocumentId)).toEqual(["doc-own", "doc-own"]);
  });

  it("a failing delete is logged and does not stop the others", async () => {
    failDeleteOf = "ci-own";
    const failed = await deleteAgentFileRows(persona as any);
    expect(failed).toBe(1);
    expect(left()).toContain("ci-own");
    expect(left()).not.toContain("ci-legacy");
    expect(left()).not.toContain("doc-own");
    expect(logError).toHaveBeenCalledWith(
      "agent delete: stored data of a file not deleted",
      expect.objectContaining({ kind: "ci-document" }),
    );
  });

  it("a skill or source that fails to delete does not stop the others", async () => {
    failDeleteOf = "s1";
    await deleteSkillsForPersona("p1");
    expect(left()).toContain("s1");
    expect(left()).not.toContain("s2");
    failDeleteOf = undefined;
  });
});
