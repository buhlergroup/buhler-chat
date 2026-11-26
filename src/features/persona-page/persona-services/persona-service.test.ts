import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { defaultSession, adminSession, setSession } from "@/__tests__/helpers/session-mock";

const hashEmail = (e: string) => createHash("sha256").update(e).digest("hex");
const USER_HASH = hashEmail(defaultSession!.user.email);

// ── Cosmos mock (direct module mock, bypasses singleton) ─────────────────────
let historyItems: any[] = [];

const itemReplace = vi.fn(async (doc: any, _options?: any) => ({ resource: { ...doc } }));

const historyContainer = {
  items: {
    create: vi.fn(async (doc: any) => ({ resource: { ...doc } })),
    upsert: vi.fn(async (doc: any) => ({ resource: { ...doc } })),
    query: vi.fn((_q: any) => ({
      fetchAll: async () => ({ resources: historyItems }),
    })),
  },
  item: vi.fn((id: string, _pk?: string) => ({
    replace: itemReplace,
    read: vi.fn(async () => ({ resource: historyItems.find((i: any) => i.id === id) })),
    delete: vi.fn(async () => {
      const idx = historyItems.findIndex((i: any) => i.id === id);
      if (idx >= 0) historyItems.splice(idx, 1);
      return { resource: undefined };
    }),
  })),
};

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => historyContainer,
  ConfigContainer: () => historyContainer,
}));

// ── auth-api mock (must export 'options') ────────────────────────────────────
vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));

// ── persona-documents-service mock ──────────────────────────────────────────
vi.mock("@/features/persona-page/persona-services/persona-documents-service", () => ({}));
// The files of a deleted agent (their own tests: agent-delete-files.test.ts).
vi.mock("@/features/persona-page/persona-services/persona-file-rows", () => ({
  deleteAgentFileRows: vi.fn(async () => 0),
}));
vi.mock("@/features/persona-page/persona-services/skills/persona-skill-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./skills/persona-skill-store")>()),
  deleteSkillsForPersona: vi.fn(async () => {}),
}));
vi.mock("@/features/persona-page/persona-services/sharepoint-files/sharepoint-file-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sharepoint-files/sharepoint-file-store")>()),
  deleteFileSourcesForPersona: vi.fn(async () => {}),
}));
vi.mock("@/features/persona-page/persona-services/persona-documents-store", () => ({
  addSearchDocument: vi.fn(async () => ({ status: "OK", response: "doc" })),
}));

// ── persona-ci-documents-service / -store mocks ─────────────────────────────
vi.mock("@/features/persona-page/persona-services/persona-document-access", () => ({
  personaCodeDocumentsByIds: vi.fn(async () => ({ status: "OK", response: [] })),
}));
vi.mock("@/features/persona-page/persona-services/persona-ci-documents-store", () => ({
  CODE_FILE_NOT_VISIBLE: "CODE_FILE_NOT_VISIBLE",
  recordCodeDocumentHash: vi.fn(async () => undefined),
  downloadCodeInterpreterFile: vi.fn(async () => ({
    status: "OK",
    response: { buffer: Buffer.from("data"), name: "file.csv", contentType: "text/csv" },
  })),
}));

// ── code-interpreter-service mock ────────────────────────────────────────────
vi.mock("@/features/chat-page/chat-services/code-interpreter-service", () => ({
  UploadFileForCodeInterpreter: vi.fn(async () => ({
    status: "OK",
    response: { id: "openai-file-1", name: "file.csv" },
  })),
  UploadFileForCodeInterpreterOnce: vi.fn(async () => ({
    status: "OK",
    response: { id: "openai-file-1", name: "file.csv", sha256: "a".repeat(64), uploaded: true },
  })),
}));

// ── chat-thread-service mock ─────────────────────────────────────────────────
vi.mock("@/features/chat-page/chat-services/code-interpreter-file-access", () => ({
  createChatThreadWithServerFiles: vi.fn(async (payload: any) => ({ ...payload })),
}));

// ── agent files: does the agent need the code interpreter ────────────────────
vi.mock("@/features/persona-page/persona-services/agent-files/agent-file-requirements", () => ({
  agentFilesNeedCodeInterpreter: vi.fn(async () => false),
}));

// ── access-group-service mock ────────────────────────────────────────────────
vi.mock("@/features/persona-page/persona-services/access-group-service", () => ({
  AccessGroupById: vi.fn(async () => ({ status: "OK", response: { id: "g1", name: "G", description: "" } })),
  UserAccessGroups: vi.fn(async () => ({ status: "OK", response: [] })),
}));

// ── logger mock ──────────────────────────────────────────────────────────────
vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

// ── imports after mocks ──────────────────────────────────────────────────────
import {
  CreatePersona,
  FindPersonaByID,
  EnsurePersonaOperation,
  DeletePersona,
  UpsertPersona,
  FindAllPersonaForCurrentUser,
  CreatePersonaChat,
} from "./persona-service";

import { deleteAgentFileRows } from "./persona-file-rows";
import { deleteSkillsForPersona } from "./skills/persona-skill-store";
import { deleteFileSourcesForPersona } from "./sharepoint-files/sharepoint-file-store";
import { etagRetryClock } from "./persona-row";
import { addSearchDocument } from "./persona-documents-store";

import { personaCodeDocumentsByIds as PersonaCIDocumentsByIds } from "./persona-document-access";
import { downloadCodeInterpreterFile } from "./persona-ci-documents-store";

import { UploadFileForCodeInterpreterOnce } from "@/features/chat-page/chat-services/code-interpreter-service";
import { createChatThreadWithServerFiles } from "@/features/chat-page/chat-services/code-interpreter-file-access";
import { AccessGroupById, UserAccessGroups } from "./access-group-service";
import { agentFilesNeedCodeInterpreter } from "./agent-files/agent-file-requirements";

// ── helpers ──────────────────────────────────────────────────────────────────
const validPersonaInput = () => ({
  name: "Test Persona",
  description: "A description",
  personaMessage: "System message",
  isPublished: false,
  extensionIds: [],
});

const seedPersona = (overrides: Record<string, any> = {}) => {
  const doc = {
    id: "p1",
    name: "Seed Persona",
    description: "desc",
    personaMessage: "msg",
    isPublished: false,
    // Private unless a test says otherwise (undefined means link access on).
    linkAccess: false,
    userId: USER_HASH,
    createdAt: new Date(),
    extensionIds: [],
    type: "PERSONA" as const,
    personaDocumentIds: [],
    codeInterpreterDocumentIds: [],
    subAgentIds: [],
    ...overrides,
  };
  historyItems.push(doc);
  return doc;
};

beforeEach(() => {
  historyItems.length = 0;
  vi.clearAllMocks();
  setSession(defaultSession);

  // restore default mock implementations after clearAllMocks
  vi.mocked(deleteAgentFileRows).mockResolvedValue(0);
  vi.spyOn(etagRetryClock, "sleep").mockResolvedValue(undefined);
  vi.mocked(AccessGroupById).mockResolvedValue({ status: "OK", response: { id: "g1", name: "G", description: "" } });
  vi.mocked(UserAccessGroups).mockResolvedValue({ status: "OK", response: [] });
  vi.mocked(PersonaCIDocumentsByIds).mockResolvedValue({ status: "OK", response: [] });
  vi.mocked(downloadCodeInterpreterFile).mockResolvedValue({
    status: "OK",
    response: { buffer: Buffer.from("data"), name: "file.csv", contentType: "text/csv" },
  });
  vi.mocked(UploadFileForCodeInterpreterOnce).mockResolvedValue({
    status: "OK",
    response: { id: "openai-file-1", name: "file.csv" },
  });
  vi.mocked(createChatThreadWithServerFiles).mockImplementation(async (payload: any) => ({
    ...payload,
  }));
  historyContainer.items.create.mockImplementation(async (doc: any) => ({ resource: { ...doc } }));
  historyContainer.items.upsert.mockImplementation(async (doc: any) => ({ resource: { ...doc } }));
  itemReplace.mockImplementation(async (doc: any) => ({ resource: { ...doc } }));
  vi.mocked(agentFilesNeedCodeInterpreter).mockResolvedValue(false);
  historyContainer.items.query.mockImplementation((_q: any) => ({
    fetchAll: async () => ({ resources: historyItems }),
  }));
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("persona-service.ts", () => {
  // 001 – CreatePersona lets any user publish; fresh publish starts as community
  it("001 CreatePersona lets any user publish as community", async () => {
    await setSession(defaultSession);
    const result = await CreatePersona({ ...validPersonaInput(), isPublished: true });
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.isPublished).toBe(true);
      expect(result.response.trustLevel).toBe("community");
      expect(result.response.publishedAt).toBeInstanceOf(Date);
      expect(result.response.userId).toBe(USER_HASH);
      expect(result.response.creatorName).toBe("Test User");
      expect(result.response.id).toBeTruthy();
      expect(result.response.type).toBe("PERSONA");
    }
  });

  // 002 – CreatePersona without publish stores no trust metadata
  it("002 CreatePersona unpublished has no trustLevel/publishedAt", async () => {
    await setSession(defaultSession);
    const result = await CreatePersona(validPersonaInput());
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.isPublished).toBe(false);
      expect(result.response.trustLevel).toBeUndefined();
      expect(result.response.publishedAt).toBeUndefined();
    }
  });

  // 003 – CreatePersona returns ERROR on invalid input
  it("003 CreatePersona returns ERROR with Zod messages on invalid input", async () => {
    await setSession(defaultSession);
    const result = await CreatePersona(
      { name: "", description: "", personaMessage: "", isPublished: false, extensionIds: [] });
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  // 004 – CreatePersona starts without files, whatever the client sends
  it("004 CreatePersona starts with empty file lists", async () => {
    const result = await CreatePersona({
      ...validPersonaInput(),
      personaDocumentIds: ["client-doc"],
      codeInterpreterDocumentIds: ["client-ci"],
    } as any);
    expect(result.status).toBe("OK");
    const saved = historyContainer.items.create.mock.calls[0][0];
    expect(saved.personaDocumentIds).toEqual([]);
    expect(saved.codeInterpreterDocumentIds).toEqual([]);
    expect(addSearchDocument).not.toHaveBeenCalled();
  });

  // 005 – FindPersonaByID returns NOT_FOUND when no rows
  it("005 FindPersonaByID returns NOT_FOUND when no rows", async () => {
    const result = await FindPersonaByID("nonexistent");
    expect(result.status).toBe("NOT_FOUND");
  });

  // 006 – FindPersonaByID hides a group agent from a non-member (NOT_FOUND, not forbidden)
  it("006 FindPersonaByID returns NOT_FOUND when accessGroup denies", async () => {
    seedPersona({ id: "p-ag", userId: "other-hash", accessGroup: { id: "g1", source: "SHAREPOINT" } });
    vi.mocked(AccessGroupById).mockResolvedValueOnce({
      status: "ERROR",
      errors: [{ message: "no access" }],
    });
    const result = await FindPersonaByID("p-ag");
    expect(result.status).toBe("NOT_FOUND");
  });

  // 006a – the reported issue: another user's private agent with no group
  it("006a FindPersonaByID returns NOT_FOUND for another user's private agent with no group", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-private", userId: "other-hash", isPublished: false });
    const result = await FindPersonaByID("p-private");
    expect(result.status).toBe("NOT_FOUND");
    if (result.status === "NOT_FOUND") {
      // Same text as a missing id, so the answer does not reveal the agent.
      expect(result.errors[0].message).toBe("Persona not found");
    }
    expect(AccessGroupById).not.toHaveBeenCalled();
  });

  // 006b – owner, published, group member and admin can open by id
  it("006b FindPersonaByID returns OK for owner, published, group member and admin", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-own" });
    expect((await FindPersonaByID("p-own")).status).toBe("OK");

    historyItems.length = 0;
    seedPersona({ id: "p-pub", userId: "other-hash", isPublished: true });
    expect((await FindPersonaByID("p-pub")).status).toBe("OK");

    historyItems.length = 0;
    seedPersona({ id: "p-grp", userId: "other-hash", accessGroup: { id: "g1", source: "SHAREPOINT" } });
    expect((await FindPersonaByID("p-grp")).status).toBe("OK");
    expect(AccessGroupById).toHaveBeenCalledWith("g1");

    historyItems.length = 0;
    await setSession(adminSession);
    seedPersona({ id: "p-adm", userId: "other-hash", isPublished: false });
    expect((await FindPersonaByID("p-adm")).status).toBe("OK");
    await setSession(defaultSession);
  });

  // 006c – call_sub_agent resolves its target through FindPersonaByID, so a
  // model asked to call another user's private agent gets NOT_FOUND
  it("006c sub-agent lookup of another user's private agent is NOT_FOUND", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-sub", userId: "other-hash", isPublished: false, personaMessage: "secret" });
    const result = await FindPersonaByID("p-sub");
    expect(result.status).toBe("NOT_FOUND");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  // 006d – link access (on unless false): a non-owner opens a link agent by id
  it("006d FindPersonaByID: link agent OK for a non-owner, linkAccess false NOT_FOUND", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-link-legacy", userId: "other-hash", linkAccess: undefined });
    expect((await FindPersonaByID("p-link-legacy")).status).toBe("OK");

    historyItems.length = 0;
    seedPersona({ id: "p-link", userId: "other-hash", linkAccess: true });
    expect((await FindPersonaByID("p-link")).status).toBe("OK");

    historyItems.length = 0;
    seedPersona({ id: "p-nolink", userId: "other-hash", linkAccess: false });
    expect((await FindPersonaByID("p-nolink")).status).toBe("NOT_FOUND");
  });

  // 006e – a share group wins over link access
  it("006e FindPersonaByID: group agent with link access stays member-only", async () => {
    await setSession(defaultSession);
    seedPersona({
      id: "p-grp-link",
      userId: "other-hash",
      linkAccess: undefined,
      accessGroup: { id: "g1", source: "SHAREPOINT" },
    });
    vi.mocked(AccessGroupById).mockResolvedValueOnce({
      status: "ERROR",
      errors: [{ message: "no access" }],
    });
    expect((await FindPersonaByID("p-grp-link")).status).toBe("NOT_FOUND");
  });

  // 006f – link access opens an agent by link but never lists it for others
  it("006f FindAllPersonaForCurrentUser does not list other users' link agents", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-other-link", userId: "other-hash", linkAccess: true });
    seedPersona({ id: "p-other-legacy", userId: "other-hash", linkAccess: undefined });
    seedPersona({ id: "p-own-link", linkAccess: true });
    const result = await FindAllPersonaForCurrentUser();
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.map((p: any) => p.id)).toEqual(["p-own-link"]);
    }
  });

  // 006g – CreatePersona stores link access on unless the form turns it off;
  // UpsertPersona stores the form value
  it("006g CreatePersona/UpsertPersona store linkAccess", async () => {
    await setSession(defaultSession);
    const created = await CreatePersona(validPersonaInput(), []);
    expect(created.status === "OK" && created.response.linkAccess).toBe(true);
    const off = await CreatePersona({ ...validPersonaInput(), linkAccess: false }, []);
    expect(off.status === "OK" && off.response.linkAccess).toBe(false);

    seedPersona({ id: "p-up", linkAccess: undefined });
    const updated = await UpsertPersona(
      { ...(historyItems[0] as any), ...validPersonaInput(), linkAccess: false },
      []
    );
    expect(updated.status).toBe("OK");
    if (updated.status === "OK") expect(updated.response.linkAccess).toBe(false);
  });

  // 007 – FindAllPersonaForCurrentUser SQL includes published OR ownerId OR group membership
  it("007 FindAllPersonaForCurrentUser SQL scoping", async () => {
    vi.mocked(UserAccessGroups).mockResolvedValueOnce({
      status: "OK",
      response: [{ id: "g1", name: "G1", description: "" }],
    });

    let capturedQuerySpec: any;
    historyContainer.items.query.mockImplementationOnce((q: any) => {
      capturedQuerySpec = q;
      return { fetchAll: async () => ({ resources: [] }) };
    });

    await FindAllPersonaForCurrentUser();

    expect(capturedQuerySpec).toBeDefined();
    expect(capturedQuerySpec.query).toContain("isPublished=@isPublished");
    expect(capturedQuerySpec.query).toContain("r.userId=@userId");
    expect(capturedQuerySpec.query).toContain("ARRAY_CONTAINS(@groupIds, r.accessGroup.id)");

    const userParam = capturedQuerySpec.parameters.find((p: any) => p.name === "@userId");
    expect(userParam?.value).toBe(USER_HASH);

    const groupIdsParam = capturedQuerySpec.parameters.find((p: any) => p.name === "@groupIds");
    expect(groupIdsParam?.value).toEqual(["g1"]);
  });

  // 008 – FindAllPersonaForCurrentUser filters out personas with denied access group
  it("008 FindAllPersonaForCurrentUser filters out inaccessible personas", async () => {
    const deniedPersona = {
      id: "p-denied",
      name: "Denied",
      description: "d",
      personaMessage: "m",
      isPublished: true,
      userId: "other-hash",
      createdAt: new Date(),
      extensionIds: [],
      type: "PERSONA",
      accessGroup: { id: "g-denied", source: "SHAREPOINT" },
      personaDocumentIds: [],
    };
    historyItems.push(deniedPersona);

    vi.mocked(AccessGroupById).mockResolvedValueOnce({
      status: "ERROR",
      errors: [{ message: "no access" }],
    });

    const result = await FindAllPersonaForCurrentUser();
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.find((p: any) => p.id === "p-denied")).toBeUndefined();
    }
  });

  // 008a – the list applies the same rule: a private agent of another user
  // that the pre-filter query returns is dropped; the owner's own agent with a
  // group the owner is not in is kept.
  it("008a FindAllPersonaForCurrentUser applies canOpenPersona to every row", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-other-private", userId: "other-hash", isPublished: false });
    seedPersona({ id: "p-own-group", accessGroup: { id: "g-x", source: "SHAREPOINT" } });
    vi.mocked(AccessGroupById).mockResolvedValue({
      status: "ERROR",
      errors: [{ message: "no access" }],
    });

    const result = await FindAllPersonaForCurrentUser();
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.map((p: any) => p.id)).toEqual(["p-own-group"]);
    }
  });

  // 009 – EnsurePersonaOperation returns UNAUTHORIZED for non-owner non-admin
  it("009 EnsurePersonaOperation returns UNAUTHORIZED for non-owner non-admin", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-other", userId: "other-hash" });
    const result = await EnsurePersonaOperation("p-other");
    expect(result.status).toBe("UNAUTHORIZED");
  });

  // 009b – a user who can only OPEN (use) a published agent may not edit it
  it("009b EnsurePersonaOperation: published agent of another user is not editable", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-published", userId: "other-hash", isPublished: true });
    const result = await EnsurePersonaOperation("p-published");
    expect(result.status).toBe("UNAUTHORIZED");
    if (result.status === "UNAUTHORIZED") {
      expect(result.errors[0].message).toMatch(/not allowed/);
    }
  });

  // 009c – the form save keeps the stored file lists (decision: only the
  // file actions change them)
  it("009c UpsertPersona keeps the stored file ids and ignores the client's", async () => {
    await setSession(defaultSession);
    const p = seedPersona({
      id: "p-docs",
      personaDocumentIds: ["own-doc"],
      codeInterpreterDocumentIds: ["own-ci"],
    });
    const result = await UpsertPersona({
      ...p,
      personaDocumentIds: [],
      codeInterpreterDocumentIds: ["foreign-ci"],
    });
    expect(result.status).toBe("OK");
    const saved = itemReplace.mock.calls[0][0];
    expect(saved.personaDocumentIds).toEqual(["own-doc"]);
    expect(saved.codeInterpreterDocumentIds).toEqual(["own-ci"]);
    expect(addSearchDocument).not.toHaveBeenCalled();
  });

  it("009d UpsertPersona writes with the etag and, on a conflict, re-reads so a file added meanwhile stays", async () => {
    await setSession(defaultSession);
    const p = seedPersona({ id: "p-race", personaDocumentIds: ["doc-1"], _etag: "v1" });
    // A file action adds doc-2 between the read and the write of the save.
    itemReplace.mockImplementationOnce(async () => {
      const row = historyItems.find((i: any) => i.id === "p-race");
      row.personaDocumentIds = ["doc-1", "doc-2"];
      row._etag = "v2";
      throw Object.assign(new Error("precondition failed"), { code: 412 });
    });
    const result = await UpsertPersona({ ...p, name: "Renamed", personaDocumentIds: ["doc-1"] });
    expect(result.status).toBe("OK");
    expect(itemReplace).toHaveBeenCalledTimes(2);
    expect(itemReplace.mock.calls[0][1]).toEqual({
      accessCondition: { type: "IfMatch", condition: "v1" },
    });
    expect(itemReplace.mock.calls[1][1]).toEqual({
      accessCondition: { type: "IfMatch", condition: "v2" },
    });
    const saved = itemReplace.mock.calls[1][0];
    expect(saved.name).toBe("Renamed");
    expect(saved.personaDocumentIds).toEqual(["doc-1", "doc-2"]);
  });

  it("009d2 UpsertPersona retries up to 10 times with a short random wait (the shared rule)", async () => {
    await setSession(defaultSession);
    const p = seedPersona({ id: "p-busy", _etag: "v1" });
    const conflict = () => Object.assign(new Error("precondition failed"), { code: 412 });
    for (let i = 0; i < 9; i++) itemReplace.mockRejectedValueOnce(conflict());
    const result = await UpsertPersona({ ...p, name: "Renamed" });
    expect(result.status).toBe("OK");
    expect(itemReplace).toHaveBeenCalledTimes(10);
    const waits = vi.mocked(etagRetryClock.sleep).mock.calls.map((c) => c[0]);
    expect(waits).toHaveLength(9);
    expect(waits.every((ms) => ms >= 20 && ms <= 200)).toBe(true);
  });

  it("009d3 UpsertPersona gives up after 10 conflicts", async () => {
    await setSession(defaultSession);
    const p = seedPersona({ id: "p-busy2", _etag: "v1" });
    itemReplace.mockRejectedValue(Object.assign(new Error("precondition failed"), { code: 412 }));
    const result = await UpsertPersona({ ...p, name: "Renamed" });
    itemReplace.mockReset();
    itemReplace.mockImplementation(async (doc: any) => ({ resource: { ...doc } }));
    expect(result.status).toBe("ERROR");
    expect(result.status === "ERROR" && result.errors[0].message).toMatch(/changed while saving/);
  });

  it("009e UpsertPersona keeps the code interpreter on while the agent has files that need it", async () => {
    await setSession(defaultSession);
    const p = seedPersona({ id: "p-ci", codeInterpreterDocumentIds: ["ci-1"] });
    vi.mocked(agentFilesNeedCodeInterpreter).mockResolvedValueOnce(true);
    const result = await UpsertPersona({
      ...p,
      defaultTools: { webSearch: true, codeInterpreter: false },
    });
    expect(result.status).toBe("OK");
    expect(itemReplace.mock.calls[0][0].defaultTools).toEqual({
      webSearch: true,
      codeInterpreter: true,
    });
  });

  it("009f UpsertPersona keeps the client's choice when no file needs the code interpreter", async () => {
    await setSession(defaultSession);
    const p = seedPersona({ id: "p-noci" });
    const result = await UpsertPersona({ ...p, defaultTools: { codeInterpreter: false } });
    expect(result.status).toBe("OK");
    expect(itemReplace.mock.calls[0][0].defaultTools).toEqual({ codeInterpreter: false });
  });

  // 010 – EnsurePersonaOperation returns OK for admin
  it("010 EnsurePersonaOperation returns OK for admin", async () => {
    await setSession(adminSession);
    seedPersona({ id: "p-admin-test", userId: "some-other-hash" });
    const result = await EnsurePersonaOperation("p-admin-test");
    expect(result.status).toBe("OK");
  });

  // 011 – DeletePersona deletes documents then the persona
  it("011 DeletePersona deletes associated documents then the persona", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-del" });

    const result = await DeletePersona("p-del");
    expect(result.status).toBe("OK");
    expect(deleteAgentFileRows).toHaveBeenCalledWith(expect.objectContaining({ id: "p-del" }), USER_HASH);
    expect(deleteSkillsForPersona).toHaveBeenCalledWith("p-del");
    expect(deleteFileSourcesForPersona).toHaveBeenCalledWith("p-del");
    expect(historyItems.find((i: any) => i.id === "p-del")).toBeUndefined();
  });

  it("011b an admin deletes another user's agent: the cleanup gets that agent with all its file ids", async () => {
    await setSession(adminSession);
    seedPersona({
      id: "p-del-u",
      userId: "user-u",
      personaDocumentIds: ["doc-u"],
      codeInterpreterDocumentIds: ["ci-u"],
    });
    const result = await DeletePersona("p-del-u");
    expect(result.status).toBe("OK");
    expect(deleteAgentFileRows).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "p-del-u",
        userId: "user-u",
        personaDocumentIds: ["doc-u"],
        codeInterpreterDocumentIds: ["ci-u"],
      }),
      // The deleting admin's own partition may hold an old row of the agent.
      hashEmail(adminSession!.user.email),
    );
    expect(historyItems.find((i: any) => i.id === "p-del-u")).toBeUndefined();
  });

  it("011c a file cleanup that fails does not stop the agent delete", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-del-f", personaDocumentIds: ["doc-1"] });
    vi.mocked(deleteAgentFileRows).mockResolvedValueOnce(1);
    const result = await DeletePersona("p-del-f");
    expect(result.status).toBe("OK");
    expect(historyItems.find((i: any) => i.id === "p-del-f")).toBeUndefined();
  });

  // 012 – UpsertPersona lets the owner publish/unpublish
  it("012a UpsertPersona fresh publish stamps community + publishedAt", async () => {
    await setSession(defaultSession);
    const p = seedPersona({ id: "p-upsert", isPublished: false });

    const result = await UpsertPersona({ ...p, isPublished: true });
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.isPublished).toBe(true);
      expect(result.response.trustLevel).toBe("community");
      expect(result.response.publishedAt).toBeInstanceOf(Date);
    }
  });

  it("012b UpsertPersona owner can unpublish; trustLevel is retained", async () => {
    await setSession(defaultSession);
    const p = seedPersona({
      id: "p-unpub",
      isPublished: true,
      trustLevel: "community",
      publishedAt: new Date("2026-01-01"),
    });

    const result = await UpsertPersona({ ...p, isPublished: false });
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.isPublished).toBe(false);
      // Stored classification survives an unpublish/republish cycle.
      expect(result.response.trustLevel).toBe("community");
      expect(result.response.publishedAt).toEqual(new Date("2026-01-01"));
    }
  });

  it("012c UpsertPersona materializes legacy published agents as verified", async () => {
    await setSession(defaultSession);
    // Legacy: published via the old admin-only gate, before trustLevel existed.
    const p = seedPersona({ id: "p-legacy", isPublished: true });

    const result = await UpsertPersona({ ...p, isPublished: true });
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.trustLevel).toBe("verified");
    }
  });

  it("012d UpsertPersona keeps a stored verified level on edit", async () => {
    await setSession(defaultSession);
    const p = seedPersona({
      id: "p-verified",
      isPublished: true,
      trustLevel: "verified",
    });

    const result = await UpsertPersona({ ...p, name: "Renamed" });
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.trustLevel).toBe("verified");
    }
  });

  it("012e UpsertPersona preserves createdAt and stamps updatedAt", async () => {
    await setSession(defaultSession);
    const created = new Date("2025-03-03T12:00:00Z");
    const p = seedPersona({ id: "p-times", createdAt: created.toISOString() });

    const result = await UpsertPersona({ ...p, createdAt: created });
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.createdAt).toEqual(created);
      expect(result.response.updatedAt).toBeInstanceOf(Date);
      expect(result.response.updatedAt!.getTime()).toBeGreaterThan(
        created.getTime()
      );
    }
  });

  // 013 – CreatePersonaChat returns NOT_FOUND when user lacks access group
  it("013 CreatePersonaChat returns NOT_FOUND when user lacks access group", async () => {
    seedPersona({ id: "p-chat-ag", userId: "other-hash", accessGroup: { id: "g1", source: "SHAREPOINT" } });
    vi.mocked(AccessGroupById).mockResolvedValue({
      status: "ERROR",
      errors: [{ message: "no access" }],
    });
    const result = await CreatePersonaChat("p-chat-ag");
    expect(result.status).toBe("NOT_FOUND");
    expect(createChatThreadWithServerFiles).not.toHaveBeenCalled();
  });

  // 013a – CreatePersonaChat refuses another user's private agent with no group
  it("013a CreatePersonaChat refuses another user's private agent with no group", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-chat-private", userId: "other-hash", isPublished: false });
    const result = await CreatePersonaChat("p-chat-private");
    expect(result.status).toBe("NOT_FOUND");
    expect(createChatThreadWithServerFiles).not.toHaveBeenCalled();
  });

  // 014 – CreatePersonaChat uploads SharePoint CI docs and attaches files
  it("014 CreatePersonaChat uploads CI docs and attaches files", async () => {
    seedPersona({ id: "p-chat-ci", codeInterpreterDocumentIds: ["d1"] });

    vi.mocked(PersonaCIDocumentsByIds).mockResolvedValueOnce({
      status: "OK",
      response: [
        {
          id: "d1",
          fileName: "file.csv",
          userId: USER_HASH,
          source: "SHAREPOINT",
          type: "PERSONA_CI_DOCUMENT",
          externalFile: {
            documentId: "sp-doc-1",
            parentReference: { driveId: "drive-1" },
          },
        },
      ],
    });

    await CreatePersonaChat("p-chat-ci");

    expect(createChatThreadWithServerFiles).toHaveBeenCalled();
    const callArg = vi.mocked(createChatThreadWithServerFiles).mock.calls[0][0] as any;
    expect(callArg.attachedFiles).toBeDefined();
    expect(callArg.attachedFiles!.length).toBe(1);
    expect(callArg.attachedFiles![0].id).toBe("openai-file-1");
    expect(callArg.attachedFiles![0].type).toBe("code-interpreter");
    expect(callArg.attachedFiles![0].uploadedAt).toBeInstanceOf(Date);
    // Recorded as the agent's document: users may not delete it.
    expect(callArg.attachedFiles![0].source).toBe("agent-document");
  });

  // 014b – CreatePersonaChat stores only the agent extensions the chatting
  // user may use (decideExtensionAccess, integration wiring #203 + #205/#206)
  it("014b CreatePersonaChat checks the agent's extensions against the chatting user", async () => {
    seedPersona({
      id: "p-chat-ext",
      userId: "agent-owner-hash",
      isPublished: true,
      extensionIds: ["e-agent-owner", "e-third-private", "e-third-published"],
    });
    historyItems.push(
      { id: "e-agent-owner", type: "EXTENSION", userId: "agent-owner-hash", isPublished: false },
      { id: "e-third-private", type: "EXTENSION", userId: "third-hash", isPublished: false },
      { id: "e-third-published", type: "EXTENSION", userId: "third-hash", isPublished: true },
    );

    const result = await CreatePersonaChat("p-chat-ext");

    expect(result.status).toBe("OK");
    const callArg = vi.mocked(createChatThreadWithServerFiles).mock.calls[0][0] as any;
    // "e-third-private" is already on the stored agent: temporary rule 4
    // "legacy" (decideExtensionAccess) keeps it for viewers of the agent.
    expect(callArg.extension).toEqual(["e-agent-owner", "e-third-private", "e-third-published"]);
  });

  // 014c - agent save: a foreign extension already on the agent stays, a NEW
  // foreign unpublished one is refused (extensionIdsForAgentSave).
  it("014c UpsertPersona keeps a stored foreign extension and refuses a new one", async () => {
    await setSession(defaultSession);
    const p = seedPersona({ id: "p-ext-save", extensionIds: ["e-foreign-old"] });
    historyItems.push(
      { id: "e-foreign-old", type: "EXTENSION", userId: "third-hash", isPublished: false },
      { id: "e-foreign-new", type: "EXTENSION", userId: "third-hash", isPublished: false },
      { id: "e-own", type: "EXTENSION", userId: USER_HASH, isPublished: false },
      { id: "e-published", type: "EXTENSION", userId: "third-hash", isPublished: true },
    );

    const result = await UpsertPersona(
      { ...p, extensionIds: ["e-foreign-old", "e-foreign-new", "e-own", "e-published"] });

    expect(result.status).toBe("OK");
    const saved = itemReplace.mock.calls[0][0];
    expect(saved.extensionIds).toEqual(["e-foreign-old", "e-own", "e-published"]);
  });

  // 014d - a new agent has no stored ids: nothing is legacy.
  it("014d CreatePersona refuses a foreign unpublished extension", async () => {
    await setSession(defaultSession);
    historyItems.push(
      { id: "e-foreign", type: "EXTENSION", userId: "third-hash", isPublished: false },
      { id: "e-own", type: "EXTENSION", userId: USER_HASH, isPublished: false },
    );

    const result = await CreatePersona(
      { ...validPersonaInput(), extensionIds: ["e-foreign", "e-own"] });

    expect(result.status).toBe("OK");
    const saved = historyContainer.items.create.mock.calls[0][0];
    expect(saved.extensionIds).toEqual(["e-own"]);
  });

  // 014c – the new thread row stores the agent id, not the agent's id lists:
  // the thread goes to the browser, and the lists are editor-only fields.
  it("014c CreatePersonaChat stores the agent id and no agent id lists on the thread", async () => {
    seedPersona({
      id: "p-chat-lists",
      userId: "agent-owner-hash",
      isPublished: true,
      personaDocumentIds: ["doc-1", "doc-2"],
      subAgentIds: ["sub-1"],
    });

    const result = await CreatePersonaChat("p-chat-lists");

    expect(result.status).toBe("OK");
    const row = vi.mocked(createChatThreadWithServerFiles).mock.calls[0][0] as any;
    expect(row.personaId).toBe("p-chat-lists");
    expect(row).not.toHaveProperty("personaDocumentIds");
    expect(row).not.toHaveProperty("subAgentIds");
    expect(row).not.toHaveProperty("codeInterpreterDocumentIds");
    if (result.status === "OK") {
      expect(result.response).not.toHaveProperty("personaDocumentIds");
      expect(result.response).not.toHaveProperty("subAgentIds");
    }
  });

  // 015 – CreatePersonaChat continues after a single CI doc fails to download
  it("015 CreatePersonaChat continues after a single CI doc fails to download", async () => {
    seedPersona({ id: "p-chat-ci-partial", codeInterpreterDocumentIds: ["d1", "d2"] });

    vi.mocked(PersonaCIDocumentsByIds).mockResolvedValueOnce({
      status: "OK",
      response: [
        {
          id: "d1",
          fileName: "fail.csv",
          userId: USER_HASH,
          source: "SHAREPOINT",
          type: "PERSONA_CI_DOCUMENT",
          externalFile: { documentId: "sp-fail", parentReference: { driveId: "drive-1" } },
        },
        {
          id: "d2",
          fileName: "ok.csv",
          userId: USER_HASH,
          source: "SHAREPOINT",
          type: "PERSONA_CI_DOCUMENT",
          externalFile: { documentId: "sp-ok", parentReference: { driveId: "drive-1" } },
        },
      ],
    });

    vi.mocked(downloadCodeInterpreterFile)
      .mockResolvedValueOnce({ status: "ERROR", errors: [{ message: "download failed" }] })
      .mockResolvedValueOnce({
        status: "OK",
        response: { buffer: Buffer.from("data"), name: "ok.csv", contentType: "text/csv" },
      });

    const result = await CreatePersonaChat("p-chat-ci-partial");
    expect(result.status).toBe("OK");

    const callArg = vi.mocked(createChatThreadWithServerFiles).mock.calls[0][0] as any;
    // Only one file should be attached (the one that downloaded successfully)
    expect(callArg.attachedFiles?.length).toBe(1);
    // The name comes from UploadFileForCodeInterpreter which returns the file.name from the upload
    // The second doc's download succeeds with name "ok.csv"; that becomes the File name passed to UploadFileForCodeInterpreter
    // Our UploadFileForCodeInterpreter mock always returns {name:"file.csv"}, so check id instead
    expect(callArg.attachedFiles![0].id).toBe("openai-file-1");
  });

  // 015b – CreatePersonaChat names only the files SharePoint showed to the
  // user; files SharePoint denies (or no answer) are counted, never named.
  it("015b CreatePersonaChat stores names only of CI docs the user could see, a count for the others", async () => {
    seedPersona({ id: "p-chat-ci-names", codeInterpreterDocumentIds: ["d1", "d2", "d3", "d4"] });
    const ciDoc = (id: string, fileName: string) => ({
      id,
      fileName,
      userId: USER_HASH,
      source: "SHAREPOINT" as const,
      type: "PERSONA_CI_DOCUMENT" as const,
      externalFile: { documentId: `sp-${id}`, parentReference: { driveId: "drive-1" } },
    });
    vi.mocked(PersonaCIDocumentsByIds).mockResolvedValueOnce({
      status: "OK",
      response: [
        ciDoc("d1", "no-access.xlsx"),
        ciDoc("d2", "ok.csv"),
        ciDoc("d3", "upload-fails.csv"),
        ciDoc("d4", "throws.csv"),
      ],
    });
    vi.mocked(downloadCodeInterpreterFile)
      .mockResolvedValueOnce({
        status: "ERROR",
        errors: [{ message: "The file is not available.", code: "CODE_FILE_NOT_VISIBLE" }],
      })
      .mockResolvedValueOnce({
        status: "OK",
        response: { buffer: Buffer.from("data"), name: "ok.csv", contentType: "text/csv" },
      })
      .mockResolvedValueOnce({
        status: "OK",
        response: { buffer: Buffer.from("data"), name: "upload-fails.csv", contentType: "text/csv" },
      })
      .mockRejectedValueOnce(new Error("boom"));
    vi.mocked(UploadFileForCodeInterpreterOnce)
      .mockResolvedValueOnce({ status: "OK", response: { id: "openai-file-1", name: "ok.csv" } })
      .mockResolvedValueOnce({ status: "ERROR", errors: [{ message: "upload failed" }] });

    const result = await CreatePersonaChat("p-chat-ci-names");
    expect(result.status).toBe("OK");

    const callArg = vi.mocked(createChatThreadWithServerFiles).mock.calls[0][0] as any;
    expect(callArg.attachedFiles).toHaveLength(1);
    expect(callArg.unavailableAgentFiles).toEqual(["upload-fails.csv"]);
    expect(callArg.notAvailableAgentFileCount).toBe(2);
    expect(JSON.stringify(callArg)).not.toMatch(/no-access|throws/);
    expect(JSON.stringify(callArg.unavailableAgentFiles)).not.toMatch(/sp-d|drive-1|d1|http/);
  });

  it("015c CreatePersonaChat sets no note when every CI doc loads", async () => {
    seedPersona({ id: "p-chat-ci-all", codeInterpreterDocumentIds: ["d1"] });
    vi.mocked(PersonaCIDocumentsByIds).mockResolvedValueOnce({
      status: "OK",
      response: [
        {
          id: "d1",
          fileName: "ok.csv",
          userId: USER_HASH,
          source: "SHAREPOINT",
          type: "PERSONA_CI_DOCUMENT",
          externalFile: { documentId: "sp-ok", parentReference: { driveId: "drive-1" } },
        },
      ],
    });

    await CreatePersonaChat("p-chat-ci-all");
    const callArg = vi.mocked(createChatThreadWithServerFiles).mock.calls[0][0] as any;
    expect(callArg.unavailableAgentFiles).toBeUndefined();
    expect(callArg.notFoundAgentFileCount).toBeUndefined();
  });

  it("015d CreatePersonaChat counts listed CI ids whose row it cannot get (no ids stored)", async () => {
    seedPersona({ id: "p-chat-ci-gone", codeInterpreterDocumentIds: ["d1", "gone-1", "gone-2", "gone-1"] });
    vi.mocked(PersonaCIDocumentsByIds).mockResolvedValueOnce({
      status: "OK",
      response: [
        {
          id: "d1",
          fileName: "ok.csv",
          userId: USER_HASH,
          source: "SHAREPOINT",
          type: "PERSONA_CI_DOCUMENT",
          externalFile: { documentId: "sp-ok", parentReference: { driveId: "drive-1" } },
        },
      ],
    });

    await CreatePersonaChat("p-chat-ci-gone");
    const callArg = vi.mocked(createChatThreadWithServerFiles).mock.calls[0][0] as any;
    expect(callArg.notFoundAgentFileCount).toBe(2);
    expect(callArg.unavailableAgentFiles).toBeUndefined();
    expect(JSON.stringify(callArg)).not.toMatch(/gone-/);
  });

  it("015e CreatePersonaChat counts every CI id as not found when the lookup fails", async () => {
    seedPersona({ id: "p-chat-ci-err", codeInterpreterDocumentIds: ["d1", "d2"] });
    vi.mocked(PersonaCIDocumentsByIds).mockResolvedValueOnce({ status: "ERROR", errors: [{ message: "x" }] });

    await CreatePersonaChat("p-chat-ci-err");
    const callArg = vi.mocked(createChatThreadWithServerFiles).mock.calls[0][0] as any;
    expect(callArg.notFoundAgentFileCount).toBe(2);
  });

  // 016 – DeletePersona UNAUTHORIZED when not owner
  it("016 DeletePersona UNAUTHORIZED when not owner/non-admin", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-del-unauth", userId: "another-user" });

    const result = await DeletePersona("p-del-unauth");
    expect(result.status).toBe("UNAUTHORIZED");
    // persona should NOT be deleted
    expect(historyItems.find((i: any) => i.id === "p-del-unauth")).toBeDefined();
  });

  // 017 – UpsertPersona ERROR when Cosmos throws
  it("017 UpsertPersona ERROR when Cosmos throws", async () => {
    await setSession(defaultSession);
    const p = seedPersona({ id: "p-upsert-err" });
    itemReplace.mockRejectedValueOnce(new Error("cosmos boom"));

    const result = await UpsertPersona(p);
    expect(result.status).toBe("ERROR");
  });

  // 018 – UpsertPersona validation ERROR on empty fields
  it("018 UpsertPersona validation ERROR on empty fields", async () => {
    await setSession(defaultSession);
    const p = seedPersona({ id: "p-upsert-val" });

    const result = await UpsertPersona({ ...p, name: "", description: "" });
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  // 019 – FindAllPersonaForCurrentUser returns ERROR on Cosmos throw
  it("019 FindAllPersonaForCurrentUser returns ERROR on Cosmos throw", async () => {
    historyContainer.items.query.mockImplementationOnce(() => ({
      fetchAll: async () => { throw new Error("cosmos error"); },
    }));

    const result = await FindAllPersonaForCurrentUser();
    expect(result.status).toBe("ERROR");
  });

  // 020 – CreatePersonaChat returns ERROR when the thread cannot be created
  it("020 CreatePersonaChat returns ERROR when the thread cannot be created", async () => {
    seedPersona({ id: "p-chat-err" });
    vi.mocked(createChatThreadWithServerFiles).mockRejectedValueOnce(new Error("thread fail"));

    const result = await CreatePersonaChat("p-chat-err");
    expect(result.status).toBe("ERROR");
  });
});

// ── Editor-only fields (subAgentIds, file id lists) ─────────────────────────
describe("persona payloads for users who cannot edit the agent", () => {
  const withIds = {
    personaDocumentIds: ["doc-1"],
    codeInterpreterDocumentIds: ["ci-1"],
    subAgentIds: ["sub-1"],
  };
  const hasNoIds = (p: Record<string, unknown>) => {
    expect(p).not.toHaveProperty("personaDocumentIds");
    expect(p).not.toHaveProperty("codeInterpreterDocumentIds");
    expect(p).not.toHaveProperty("subAgentIds");
  };

  it("FindPersonaByID: a viewer of a published agent gets no file or sub-agent ids", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-pub", userId: "other-hash", isPublished: true, ...withIds });
    const result = await FindPersonaByID("p-pub");
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.name).toBe("Seed Persona");
      hasNoIds(result.response as any);
    }
  });

  it("FindPersonaByID: the owner and an admin get the ids", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-own", ...withIds });
    const own = await FindPersonaByID("p-own");
    expect(own.status === "OK" && own.response.subAgentIds).toEqual(["sub-1"]);

    seedPersona({ id: "p-other", userId: "other-hash", ...withIds });
    await setSession(adminSession);
    const admin = await FindPersonaByID("p-other");
    expect(admin.status === "OK" && admin.response.personaDocumentIds).toEqual(["doc-1"]);
    expect(admin.status === "OK" && admin.response.codeInterpreterDocumentIds).toEqual(["ci-1"]);
  });

  it("FindAllPersonaForCurrentUser: ids only on the caller's own agents", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-mine", ...withIds });
    seedPersona({ id: "p-theirs", userId: "other-hash", isPublished: true, ...withIds });
    const result = await FindAllPersonaForCurrentUser();
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    const byId = Object.fromEntries(result.response.map((p) => [p.id, p as any]));
    expect(byId["p-mine"].subAgentIds).toEqual(["sub-1"]);
    hasNoIds(byId["p-theirs"]);
  });

  it("CreatePersonaChat: a viewer's thread holds the agent id, not its file or sub-agent ids", async () => {
    await setSession(defaultSession);
    seedPersona({ id: "p-pub-chat", userId: "other-hash", isPublished: true, ...withIds });
    const result = await CreatePersonaChat("p-pub-chat");
    expect(result.status).toBe("OK");
    const callArg = vi.mocked(createChatThreadWithServerFiles).mock.calls[0][0] as any;
    // The chat route reads the lists from the agent on every turn.
    expect(callArg.personaId).toBe("p-pub-chat");
    hasNoIds(callArg);
    if (result.status === "OK") hasNoIds(result.response as any);
  });
});
