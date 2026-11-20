import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeGraph } from "../../sharepoint-files/__tests__/fake-graph";

/**
 * The Files actions of the agent editor, with the four existing mechanisms
 * mocked (they have their own tests) and a fake Graph for the metadata.
 */

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("@/features/common/navigation-helpers", () => ({
  RevalidateCache: vi.fn(async () => {}),
}));

vi.mock("@/features/auth-page/helpers", () => ({
  getCurrentUser: async () => ({ token: "user-token", isAdmin: false }),
  userHashedId: async () => "owner-hash",
}));

// ── state ────────────────────────────────────────────────────────────────────
const DRIVE = "b!driveA_123";

type Row = Record<string, any>;
let persona: Row;
let docRows: Row[];
let skills: Row[];
let sources: Row[];
let access: { canUse: boolean; canEdit: boolean } | undefined;
let nextId = 0;
const newId = (p: string) => `${p}-${++nextId}`;

// ── Cosmos: the persona row (etag-checked replace) + the document rows ───────
const replace = vi.fn(async (doc: Row, options?: { accessCondition?: { condition: string } }) => {
  const etag = options?.accessCondition?.condition;
  if (etag && etag !== persona._etag) {
    throw Object.assign(new Error("precondition failed"), { code: 412 });
  }
  persona = { ...doc, _etag: `v${++nextId}` };
  return { resource: persona };
});
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: {
      query: (spec: { parameters: { name: string; value: any }[] }) => ({
        fetchAll: async () => {
          const p = Object.fromEntries(spec.parameters.map((x) => [x.name, x.value]));
          return {
            resources: docRows.filter(
              (r) =>
                (r.type === p["@doc"] || r.type === p["@ci"]) &&
                p["@ids"].includes(r.id) &&
                p["@owners"].includes(r.userId),
            ),
          };
        },
      }),
    },
    item: () => ({ replace }),
  }),
}));

vi.mock("../../skills/persona-skill-store", () => ({
  resolveSkillAccess: vi.fn(async () =>
    access ? { ...access, persona: { ...persona }, currentUserId: "owner-hash" } : undefined,
  ),
  readPersonaRow: vi.fn(async () => ({ ...persona })),
  querySkillsByPersonaId: vi.fn(async () => skills),
}));
vi.mock("../../sharepoint-files/sharepoint-file-store", () => ({
  queryFileSourcesByPersonaId: vi.fn(async () => sources),
}));

// ── the four mechanisms ──────────────────────────────────────────────────────
const docRow = (type: string, f: { documentId: string; parentReference: { driveId: string }; name: string }) => ({
  id: newId(type === "PERSONA_DOCUMENT" ? "doc" : "ci"),
  type,
  userId: "owner-hash",
  source: "SHAREPOINT",
  externalFile: { documentId: f.documentId, parentReference: f.parentReference },
  ...(type === "PERSONA_CI_DOCUMENT" ? { fileName: f.name } : {}),
});

const UpdateOrAddPersonaDocuments = vi.fn(async (files: any[], current: string[]) => {
  docRows = docRows.filter((r) => !current.includes(r.id));
  const ids = files.map((f) => {
    const row = docRow("PERSONA_DOCUMENT", f);
    docRows.push(row);
    return row.id;
  });
  return { status: "OK", response: ids };
});
vi.mock("../../persona-documents-service", () => ({
  UpdateOrAddPersonaDocuments: (...a: [any[], string[]]) => UpdateOrAddPersonaDocuments(...a),
}));

const UpdateOrAddPersonaCIDocuments = vi.fn(async (files: any[], _current: string[]) => ({
  status: "OK",
  response: files.map((f) => {
    const row = docRow("PERSONA_CI_DOCUMENT", f);
    docRows.push(row);
    return row.id;
  }),
}));
const DeletePersonaCIDocumentById = vi.fn(async (id: string) => {
  docRows = docRows.filter((r) => r.id !== id);
  return { status: "OK", response: true };
});
vi.mock("../../persona-ci-documents-service", () => ({
  UpdateOrAddPersonaCIDocuments: (...a: [any[], string[]]) => UpdateOrAddPersonaCIDocuments(...a),
  DeletePersonaCIDocumentById: (id: string) => DeletePersonaCIDocumentById(id),
}));

const fetchLinkedSkillZip = vi.fn(async (_t: string, _d: string, itemId: string) =>
  itemId.startsWith("SKILL")
    ? { ok: true, meta: { name: "brand.zip" }, buf: Buffer.from("zip"), pkg: { name: "brand" } }
    : { ok: false, reason: "invalid", message: "SKILL.md is missing." },
);
vi.mock("../../skills/linked-skill-sync", () => ({
  fetchLinkedSkillZip: (...a: [string, string, string]) => fetchLinkedSkillZip(...a),
}));

const linkSharePointSkill = vi.fn(async (input: { driveId: string; itemId: string }) => {
  if (skills.length >= 10) {
    return { status: "ERROR", errors: [{ message: "An agent can have up to 10 skills." }] };
  }
  const row = {
    id: newId("skill"),
    name: "brand",
    zipFileName: "brand.zip",
    zipBytes: 3,
    source: { driveId: input.driveId, itemId: input.itemId, name: "brand.zip", webUrl: "https://contoso.sharepoint.com/brand.zip", size: 3 },
  };
  skills.push(row);
  return { status: "OK", response: { id: row.id, name: row.name } };
});
vi.mock("../../skills/link-sharepoint-skill", () => ({
  linkSharePointSkill: (input: any, prefetched: any) => linkSharePointSkill(input, prefetched),
}));
const DeletePersonaSkill = vi.fn(async (_p: string, id: string) => {
  skills = skills.filter((s) => s.id !== id);
  return { status: "OK", response: true };
});
vi.mock("../../skills/persona-skill-service", () => ({
  DeletePersonaSkill: (p: string, id: string) => DeletePersonaSkill(p, id),
}));

const addPersonaFileSource = vi.fn(async (input: { driveId: string; itemId: string }, info: any) => {
  const row = {
    id: newId("src"),
    driveId: input.driveId,
    itemId: input.itemId,
    name: info.name,
    webUrl: info.webUrl,
    kind: info.isFolder ? "folder" : "file",
  };
  sources.push(row);
  return { status: "OK", response: { id: row.id } };
});
vi.mock("../../sharepoint-files/add-file-source", () => ({
  addPersonaFileSource: (input: any, info: any) => addPersonaFileSource(input, info),
}));
const DeletePersonaFileSource = vi.fn(async (_p: string, id: string) => {
  sources = sources.filter((s) => s.id !== id);
  return { status: "OK", response: true };
});
vi.mock("../../sharepoint-files/sharepoint-file-service", () => ({
  DeletePersonaFileSource: (p: string, id: string) => DeletePersonaFileSource(p, id),
}));

import {
  AddAgentFiles,
  ChangeAgentFileUse,
  ListAgentFiles,
  RemoveAgentFile,
} from "../agent-file-service";

let graph: FakeGraph;

beforeEach(() => {
  nextId = 0;
  persona = {
    id: "p1",
    type: "PERSONA",
    userId: "owner-hash",
    name: "Agent",
    personaDocumentIds: [],
    codeInterpreterDocumentIds: [],
    defaultTools: { webSearch: true },
    _etag: "v0",
  };
  docRows = [];
  skills = [];
  sources = [];
  access = { canUse: true, canEdit: true };
  delete process.env.MAX_PERSONA_DOCUMENT_LIMIT;
  delete process.env.MAX_PERSONA_CI_DOCUMENT_LIMIT;
  graph = new FakeGraph()
    .add(DRIVE, { id: "ROOT", name: "root", folder: true })
    .add(DRIVE, { id: "FOLDER1", name: "Reports", parent: "ROOT", folder: true })
    .add(DRIVE, { id: "PDF1", name: "Handbook.pdf", parent: "ROOT", size: 2000 })
    .add(DRIVE, { id: "PDF2", name: "Policy.pdf", parent: "ROOT", size: 2000 })
    .add(DRIVE, { id: "CSV1", name: "sales.csv", parent: "ROOT", size: 2000 })
    .add(DRIVE, { id: "SKILL1", name: "brand.zip", parent: "ROOT", size: 3000 })
    .add(DRIVE, { id: "ZIP1", name: "data.zip", parent: "ROOT", size: 3000 })
    .add(DRIVE, { id: "TIF1", name: "scan.tiff", parent: "ROOT", size: 3000 })
    .add(DRIVE, { id: "EXE1", name: "setup.exe", parent: "ROOT", size: 3000 })
    .add(DRIVE, { id: "LOCKED", name: "Secret.pdf", parent: "ROOT", status: 403 });
  vi.stubGlobal("fetch", vi.fn(graph.fetch));
});

const pick = (...ids: string[]) => ids.map((itemId) => ({ driveId: DRIVE, itemId }));

const add = async (...ids: string[]) => {
  const res = await AddAgentFiles("p1", pick(...ids));
  if (res.status !== "OK") throw new Error(JSON.stringify(res));
  return res.response;
};

describe("permission check first (decision 11)", () => {
  it.each([
    ["ListAgentFiles is open to users of the agent", () => ListAgentFiles("p1"), "OK"],
    ["AddAgentFiles", () => AddAgentFiles("p1", pick("PDF1")), "UNAUTHORIZED"],
    ["RemoveAgentFile", () => RemoveAgentFile("p1", { kind: "document", id: "d" }), "UNAUTHORIZED"],
    ["ChangeAgentFileUse", () => ChangeAgentFileUse("p1", { kind: "document", id: "d" }, "code"), "UNAUTHORIZED"],
  ])("%s: a user who can use but not edit the agent", async (_name, call, status) => {
    access = { canUse: true, canEdit: false };
    expect((await call()).status).toBe(status);
    expect(graph.calls).toEqual([]);
    expect(UpdateOrAddPersonaDocuments).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("an unknown or hidden agent is NOT_FOUND for every action", async () => {
    access = undefined;
    expect((await ListAgentFiles("p1")).status).toBe("NOT_FOUND");
    expect((await AddAgentFiles("p1", pick("PDF1"))).status).toBe("NOT_FOUND");
    access = { canUse: false, canEdit: false };
    expect((await ListAgentFiles("p1")).status).toBe("NOT_FOUND");
    expect((await RemoveAgentFile("p1", { kind: "skill", id: "s" })).status).toBe("NOT_FOUND");
  });

  it("refuses a use or a ref the client made up", async () => {
    expect((await ChangeAgentFileUse("p1", { kind: "document", id: "d" }, "admin" as any)).status).toBe("ERROR");
    expect((await RemoveAgentFile("p1", { kind: "PERSONA" as any, id: "p1" })).status).toBe("ERROR");
  });
});

describe("AddAgentFiles: one pick, per-item result (decisions 2, 4, 11)", () => {
  it("adds a mixed pick and rejects only the items that cannot be added", async () => {
    const results = await add("PDF1", "CSV1", "FOLDER1", "SKILL1", "ZIP1", "TIF1", "EXE1", "LOCKED");
    const byId = Object.fromEntries(results.map((r) => [r.itemId, r]));
    expect(byId.PDF1).toMatchObject({ status: "added", use: "search", name: "Handbook.pdf" });
    expect(byId.CSV1).toMatchObject({ status: "added", use: "code" });
    expect(byId.FOLDER1).toMatchObject({ status: "added", use: "on-demand" });
    expect(byId.SKILL1).toMatchObject({ status: "added", use: "skill" });
    expect(byId.ZIP1).toMatchObject({ status: "added", use: "code" });
    expect(byId.TIF1).toMatchObject({ status: "added", use: "on-demand" });
    expect(byId.EXE1).toMatchObject({ status: "rejected", reason: expect.stringMatching(/\.exe cannot be added/) });
    expect(byId.LOCKED).toMatchObject({ status: "rejected", reason: expect.stringMatching(/access/) });

    // The persona lists the new Search and Code rows.
    expect(persona.personaDocumentIds).toHaveLength(1);
    expect(persona.codeInterpreterDocumentIds).toHaveLength(2);
    // The mechanisms got the ids from Graph, not from the client.
    expect(UpdateOrAddPersonaDocuments).toHaveBeenCalledWith(
      [expect.objectContaining({ documentId: "PDF1", parentReference: { driveId: DRIVE }, name: "Handbook.pdf" })],
      [],
    );
  });

  it("switches the code interpreter on when an item needs it (decision 6)", async () => {
    await add("PDF1");
    expect(persona.defaultTools).toEqual({ webSearch: true });
    await add("FOLDER1");
    expect(persona.defaultTools).toEqual({ webSearch: true, codeInterpreter: true });
  });

  it.each([["CSV1"], ["SKILL1"], ["FOLDER1"]])("an item %s that needs the code interpreter switches it on", async (id) => {
    await add(id);
    expect(persona.defaultTools.codeInterpreter).toBe(true);
  });

  it("rejects an item the agent already uses, in any use", async () => {
    await add("PDF1");
    const [res] = await add("PDF1");
    expect(res).toMatchObject({ status: "rejected", reason: "The agent already uses this item." });
  });

  it("shows the limit reason when a use is full (decision 11)", async () => {
    process.env.MAX_PERSONA_DOCUMENT_LIMIT = "1";
    const [first, second] = await add("PDF1", "PDF2");
    expect(first.status).toBe("added");
    expect(second).toMatchObject({ status: "rejected", reason: "An agent can have up to 1 Search files." });
  });

  it("keeps the limit of 20 Code files by default", async () => {
    persona.codeInterpreterDocumentIds = Array.from({ length: 20 }, (_, i) => `ci-old-${i}`);
    const [res] = await add("CSV1");
    expect(res).toMatchObject({ status: "rejected", reason: "An agent can have up to 20 Code files." });
  });

  it("refuses an item whose drive differs from the one the client named", async () => {
    graph.add(DRIVE, { id: "MOVED", name: "x.pdf", parent: "ROOT", reportedDriveId: "b!other" });
    const [res] = await add("MOVED");
    expect(res.status).toBe("rejected");
  });

  it("refuses malformed ids without a Graph call", async () => {
    const res = await AddAgentFiles("p1", [{ driveId: "../x", itemId: "a/b" }]);
    expect(res.status === "OK" && res.response[0].status).toBe("rejected");
    expect(graph.calls).toEqual([]);
  });

  it("undoes the mechanism add when the persona row cannot be written", async () => {
    replace.mockRejectedValueOnce(new Error("cosmos down"));
    const [res] = await add("CSV1");
    expect(res).toMatchObject({ status: "rejected", reason: expect.stringMatching(/could not be saved/) });
    expect(DeletePersonaCIDocumentById).toHaveBeenCalled();
    expect(docRows).toEqual([]);
  });

  it("rejects a Search file whose indexing fails and keeps the stored ids", async () => {
    persona.personaDocumentIds = ["doc-old"];
    UpdateOrAddPersonaDocuments.mockResolvedValueOnce({ status: "ERROR", errors: [{ message: "indexing failed" }] } as any);
    const [first, second] = await add("PDF1", "PDF2");
    expect(first).toMatchObject({
      status: "rejected",
      name: "Handbook.pdf",
      reason: expect.stringMatching(/could not be indexed for Search.*indexing failed/),
    });
    // The other item of the pick is still added.
    expect(second).toMatchObject({ status: "added", use: "search" });
    expect(persona.personaDocumentIds).toEqual(["doc-old", second.status === "added" ? second.ref.id : ""]);
  });

  it("rejects a Search file whose indexing throws and does not write the persona row", async () => {
    persona.personaDocumentIds = ["doc-old"];
    UpdateOrAddPersonaDocuments.mockRejectedValueOnce(new Error("search service down"));
    const [res] = await add("PDF1");
    expect(res).toMatchObject({ status: "rejected", reason: expect.stringMatching(/could not be indexed for Search/) });
    expect(JSON.stringify(res)).not.toMatch(/search service down/);
    expect(persona.personaDocumentIds).toEqual(["doc-old"]);
    expect(replace).not.toHaveBeenCalled();
  });

  it("retries the persona write on an etag conflict, so a parallel change is kept", async () => {
    replace.mockImplementationOnce(async () => {
      persona = { ...persona, name: "Renamed by a parallel save", _etag: "v-parallel" };
      throw Object.assign(new Error("precondition failed"), { code: 412 });
    });
    await add("PDF1");
    expect(persona.name).toBe("Renamed by a parallel save");
    expect(persona.personaDocumentIds).toHaveLength(1);
  });
});

describe("ListAgentFiles: one list over all four row types (decision 10)", () => {
  const seedAll = () => {
    docRows.push(
      { id: "doc-a", type: "PERSONA_DOCUMENT", userId: "owner-hash", externalFile: { documentId: "PDF1", parentReference: { driveId: DRIVE } } },
      { id: "ci-a", type: "PERSONA_CI_DOCUMENT", userId: "owner-hash", fileName: "sales.csv", externalFile: { documentId: "CSV1", parentReference: { driveId: DRIVE } } },
      // Listed by the persona, but in a third user's partition: not shown.
      { id: "doc-foreign", type: "PERSONA_DOCUMENT", userId: "third-hash", externalFile: { documentId: "PDF2", parentReference: { driveId: DRIVE } } },
    );
    persona.personaDocumentIds = ["doc-a", "doc-foreign"];
    persona.codeInterpreterDocumentIds = ["ci-a"];
    skills.push(
      { id: "s-linked", name: "brand", zipFileName: "brand.zip", zipBytes: 3, source: { driveId: DRIVE, itemId: "SKILL1", name: "brand.zip", webUrl: "https://contoso.sharepoint.com/brand.zip", size: 3000, syncError: { message: "SKILL.md is missing.", version: "2", at: "" } } },
      { id: "s-upload", name: "notes", zipFileName: "notes.zip", zipBytes: 5 },
    );
    sources.push({ id: "src-a", driveId: DRIVE, itemId: "FOLDER1", name: "Reports", webUrl: "", kind: "folder" });
  };

  it("an editor sees every item with its use, status and allowed uses", async () => {
    seedAll();
    const res = await ListAgentFiles("p1");
    expect(res.status).toBe("OK");
    if (res.status !== "OK" || !res.response.canEdit) throw new Error("expected editor list");
    const { items, count, needsCodeInterpreter } = res.response;
    expect(count).toBe(6);
    expect(needsCodeInterpreter).toBe(true);
    const by = Object.fromEntries(items.map((i) => [i.ref.id, i]));
    expect(by["doc-a"]).toMatchObject({
      ref: { kind: "document", id: "doc-a" },
      name: "Handbook.pdf",
      webUrl: expect.stringMatching(/^https:/),
      use: "search",
      status: "ok",
      sizeBytes: 2000,
      allowedUses: ["search", "code", "on-demand"],
    });
    expect(by["ci-a"]).toMatchObject({ name: "sales.csv", use: "code", allowedUses: ["search", "code", "on-demand"] });
    expect(by["s-linked"]).toMatchObject({ use: "skill", status: "sync-error", linkedSkill: true, allowedUses: ["skill", "code"] });
    expect(by["s-upload"]).toMatchObject({ use: "skill", status: "ok", uploadedSkill: true, allowedUses: ["skill"] });
    expect(by["src-a"]).toMatchObject({ name: "Reports", isFolder: true, use: "on-demand", allowedUses: ["on-demand"] });
    expect(by["doc-foreign"]).toMatchObject({ status: "missing", name: "File not found" });
    expect(JSON.stringify(by["doc-foreign"])).not.toMatch(/PDF2|Policy/);
  });

  it("shows an item the editor cannot open with its status, not its metadata", async () => {
    docRows.push({ id: "doc-l", type: "PERSONA_DOCUMENT", userId: "owner-hash", externalFile: { documentId: "LOCKED", parentReference: { driveId: DRIVE } } });
    persona.personaDocumentIds = ["doc-l"];
    const res = await ListAgentFiles("p1");
    const item = res.status === "OK" ? res.response.items[0] : undefined;
    expect(item).toMatchObject({ status: "no-access", allowedUses: ["search"] });
  });

  it.each([
    ["503", () => graph.add(DRIVE, { id: "BUSY", name: "Busy.pdf", parent: "ROOT", status: 503 })],
    [
      "a network error",
      () => {
        graph.add(DRIVE, { id: "BUSY", name: "Busy.pdf", parent: "ROOT" });
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: string) => {
            if (String(input).includes("/items/BUSY")) throw new TypeError("fetch failed");
            return graph.fetch(input);
          }),
        );
      },
    ],
  ])("no answer from SharePoint (%s): the item is unavailable, not readable, and says so", async (_label, setup) => {
    setup();
    docRows.push({ id: "doc-b", type: "PERSONA_DOCUMENT", userId: "owner-hash", externalFile: { documentId: "BUSY", parentReference: { driveId: DRIVE } } });
    persona.personaDocumentIds = ["doc-b"];
    const res = await ListAgentFiles("p1");
    const item = res.status === "OK" ? res.response.items[0] : undefined;
    expect(item).toMatchObject({
      status: "unavailable",
      statusMessage: "SharePoint did not answer. Try again in a moment.",
      allowedUses: ["search"],
    });
    expect(item?.webUrl).toBeUndefined();
    expect(item?.sizeBytes).toBeUndefined();
    expect(JSON.stringify(item)).not.toMatch(/Busy\.pdf/);
  });

  it("an add whose metadata check gets no answer is rejected with a try-again reason, not an access reason", async () => {
    graph.add(DRIVE, { id: "BUSY", name: "Busy.pdf", parent: "ROOT", status: 503 });
    const [res] = await add("BUSY");
    expect(res).toMatchObject({ status: "rejected", reason: "SharePoint did not answer. Try again in a moment." });
    expect(UpdateOrAddPersonaDocuments).not.toHaveBeenCalled();
  });

  it("a viewer gets the count only: no names, no links, no Graph call (decision 9)", async () => {
    seedAll();
    access = { canUse: true, canEdit: false };
    const res = await ListAgentFiles("p1");
    expect(res).toEqual({
      status: "OK",
      response: { canEdit: false, count: 6, items: [], needsCodeInterpreter: true },
    });
    expect(graph.calls).toEqual([]);
  });

  it("an agent with only Search files does not need the code interpreter", async () => {
    await add("PDF1");
    const res = await ListAgentFiles("p1");
    expect(res.status === "OK" && res.response.needsCodeInterpreter).toBe(false);
  });
});

describe("RemoveAgentFile", () => {
  it("removes a Search file: persona list first, then the row and index entry", async () => {
    const [added] = await add("PDF1");
    if (added.status !== "added") throw new Error("not added");
    const res = await RemoveAgentFile("p1", added.ref);
    expect(res.status).toBe("OK");
    expect(persona.personaDocumentIds).toEqual([]);
    expect(UpdateOrAddPersonaDocuments).toHaveBeenLastCalledWith([], [added.ref.id]);
  });

  it("refuses an id the agent does not list", async () => {
    expect((await RemoveAgentFile("p1", { kind: "document", id: "other" })).status).toBe("NOT_FOUND");
    expect(UpdateOrAddPersonaDocuments).not.toHaveBeenCalled();
  });

  it("removes skills and On-demand sources through their services", async () => {
    const [skill, folder] = await add("SKILL1", "FOLDER1");
    if (skill.status !== "added" || folder.status !== "added") throw new Error("not added");
    expect((await RemoveAgentFile("p1", skill.ref)).status).toBe("OK");
    expect((await RemoveAgentFile("p1", folder.ref)).status).toBe("OK");
    expect(DeletePersonaSkill).toHaveBeenCalledWith("p1", skill.ref.id);
    expect(DeletePersonaFileSource).toHaveBeenCalledWith("p1", folder.ref.id);
  });
});

describe("ChangeAgentFileUse (decision 5)", () => {
  it("moves a Search file to Code: new mechanism added, old one removed", async () => {
    const [added] = await add("PDF1");
    if (added.status !== "added") throw new Error("not added");
    const res = await ChangeAgentFileUse("p1", added.ref, "code");
    expect(res.status).toBe("OK");
    expect(persona.personaDocumentIds).toEqual([]);
    expect(persona.codeInterpreterDocumentIds).toHaveLength(1);
    expect(persona.defaultTools.codeInterpreter).toBe(true);
    expect(res.status === "OK" && res.response).toMatchObject({ use: "code", ref: { kind: "ci-document" } });
  });

  it("moves a Code zip to Skill when it passes the validation", async () => {
    graph.add(DRIVE, { id: "SKILL2", name: "brand.zip", parent: "ROOT", size: 3000 });
    persona.codeInterpreterDocumentIds = ["ci-z"];
    docRows.push({ id: "ci-z", type: "PERSONA_CI_DOCUMENT", userId: "owner-hash", fileName: "brand.zip", externalFile: { documentId: "SKILL2", parentReference: { driveId: DRIVE } } });
    const res = await ChangeAgentFileUse("p1", { kind: "ci-document", id: "ci-z" }, "skill");
    expect(res.status).toBe("OK");
    expect(skills).toHaveLength(1);
    expect(persona.codeInterpreterDocumentIds).toEqual([]);
  });

  it("keeps the old use when the zip is no skill", async () => {
    const [added] = await add("ZIP1");
    if (added.status !== "added") throw new Error("not added");
    const res = await ChangeAgentFileUse("p1", added.ref, "skill");
    expect(res.status === "ERROR" && res.errors[0].message).toMatch(/not a skill/);
    expect(persona.codeInterpreterDocumentIds).toEqual([added.ref.id]);
    expect(skills).toEqual([]);
  });

  it("refuses a use outside the item's allowed set", async () => {
    const [folder] = await add("FOLDER1");
    if (folder.status !== "added") throw new Error("not added");
    const res = await ChangeAgentFileUse("p1", folder.ref, "search");
    expect(res.status === "ERROR" && res.errors[0].message).toMatch(/cannot be used as Search/);
    expect(UpdateOrAddPersonaDocuments).not.toHaveBeenCalled();
  });

  it("refuses to move an uploaded skill", async () => {
    skills.push({ id: "s-upload", name: "notes", zipFileName: "notes.zip", zipBytes: 5 });
    const res = await ChangeAgentFileUse("p1", { kind: "skill", id: "s-upload" }, "code");
    expect(res.status).toBe("ERROR");
  });

  it("leaves the item in its old use when adding to the new one fails", async () => {
    const [added] = await add("PDF1");
    if (added.status !== "added") throw new Error("not added");
    UpdateOrAddPersonaCIDocuments.mockResolvedValueOnce({ status: "ERROR", errors: [{ message: "store down" }] } as any);
    const res = await ChangeAgentFileUse("p1", added.ref, "code");
    expect(res.status).toBe("ERROR");
    expect(persona.personaDocumentIds).toEqual([added.ref.id]);
    expect(persona.codeInterpreterDocumentIds).toEqual([]);
  });

  it("keeps a Code file in Code when its indexing for Search fails", async () => {
    const [added] = await add("CSV1");
    if (added.status !== "added") throw new Error("not added");
    UpdateOrAddPersonaDocuments.mockResolvedValueOnce({ status: "ERROR", errors: [{ message: "indexing failed" }] } as any);
    const res = await ChangeAgentFileUse("p1", added.ref, "search");
    expect(res.status === "ERROR" && res.errors[0].message).toMatch(/could not be indexed for Search.*indexing failed/);
    expect(persona.codeInterpreterDocumentIds).toEqual([added.ref.id]);
    expect(persona.personaDocumentIds).toEqual([]);
  });

  it("undoes the new entry when removing the old one fails", async () => {
    const [folder] = await add("TIF1");
    if (folder.status !== "added") throw new Error("not added");
    DeletePersonaFileSource.mockResolvedValueOnce({ status: "ERROR", errors: [{ message: "down" }] } as any);
    const res = await ChangeAgentFileUse("p1", folder.ref, "search");
    expect(res.status).toBe("ERROR");
    expect(persona.personaDocumentIds).toEqual([]);
    expect(sources.map((s) => s.id)).toEqual([folder.ref.id]);
  });
});
