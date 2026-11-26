import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

// ── Cosmos: one PERSONA_SKILL row (plus the persona for access checks) ──────
let row: Record<string, unknown> | undefined;
let personaRow: Record<string, unknown> | undefined;
let skillRows: Record<string, unknown>[] = [];
/** Next row write fails with 412 after the row became this (a parallel writer). */
let conflictWith: Record<string, unknown> | undefined;
// Every row write (upsert, or replace with IfMatch) lands here.
const upsert = vi.fn(async (doc: Record<string, unknown>) => {
  row = { ...doc };
  return { resource: doc };
});
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: {
      upsert: (doc: Record<string, unknown>) => upsert(doc),
      query: (spec: { parameters: { value: string }[] }) => ({
        fetchAll: async () => ({
          resources:
            spec.parameters[0].value === "PERSONA_SKILL"
              ? skillRows
              : personaRow
                ? [personaRow]
                : [],
        }),
      }),
    },
    item: () => ({
      read: async () => ({ resource: row }),
      delete: async () => ({}),
      replace: async (doc: Record<string, unknown>) => {
        if (conflictWith) {
          row = conflictWith;
          conflictWith = undefined;
          throw Object.assign(new Error("Precondition failed"), { code: 412 });
        }
        return upsert(doc);
      },
    }),
  }),
}));

vi.mock("@/features/common/services/azure-storage", () => ({
  UploadBlob: vi.fn(async () => ({ status: "OK", response: "url" })),
  GetBlob: vi.fn(async () => ({
    status: "OK",
    response: { stream: Readable.from([Buffer.from("zip-bytes")]) },
  })),
  DeleteBlob: vi.fn(async () => ({ status: "OK", response: true })),
}));

const retrieve = vi.fn();
const del = vi.fn();
vi.mock("@/features/common/services/openai", () => ({
  OpenAIV1Instance: () => ({ files: { retrieve, delete: del } }),
}));

let nextUploadId = 0;
const UploadFileForCodeInterpreter = vi.fn(async (file: File) => ({
  status: "OK",
  response: { id: `file-new-${++nextUploadId}`, name: file.name },
}));
vi.mock("@/features/chat-page/chat-services/code-interpreter-service", () => ({
  UploadFileForCodeInterpreter: (f: File) => UploadFileForCodeInterpreter(f),
}));

let currentUser = { isAdmin: false, token: "user-token" };
vi.mock("@/features/auth-page/helpers", () => ({
  userHashedId: async () => "viewer-hash",
  getCurrentUser: async () => currentUser,
}));
vi.mock("../../access-group-service", () => ({
  AccessGroupById: vi.fn(async () => ({ status: "NOT_FOUND", errors: [] })),
}));

import {
  canEditPersonaSkills,
  canUsePersonaSkills,
  deleteSkillOpenAiFile,
  ensureSkillOpenAiFile,
  loadUsableSkillsWithStatus,
  refreshSkillOpenAiFiles,
  resolveSkillAccess,
  skillBlobContainer,
  uploadSkillArchivesForCodeInterpreter,
} from "../persona-skill-store";
import type { PersonaSkillModel } from "../skill-models";
import { clearDriveItemChecks } from "@/features/common/services/sharepoint/drive-item-check-cache";

const makeSkill = (over: Partial<PersonaSkillModel> = {}): PersonaSkillModel => ({
  id: "s1",
  type: "PERSONA_SKILL",
  userId: "owner-hash",
  personaId: "p1",
  name: "demo",
  description: "Demo.",
  skillMd: "---\nname: demo\ndescription: Demo.\n---\n",
  rootPrefix: "",
  files: [{ path: "SKILL.md", size: 10 }],
  zipFileName: "demo.zip",
  zipBytes: 9,
  uncompressedBytes: 10,
  blobName: "agent-skills/p1/s1-1.zip",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const notFound = () => Object.assign(new Error("No such File object"), { status: 404 });

beforeEach(() => {
  vi.clearAllMocks();
  nextUploadId = 0;
  row = undefined;
  personaRow = undefined;
  skillRows = [];
  conflictWith = undefined;
  currentUser = { isAdmin: false, token: "user-token" };
  clearDriveItemChecks();
});

describe("skill container", () => {
  it("defaults to the private agent-skills container", () => {
    const saved = process.env.AZURE_STORAGE_SKILL_CONTAINER_NAME;
    delete process.env.AZURE_STORAGE_SKILL_CONTAINER_NAME;
    expect(skillBlobContainer()).toBe("agent-skills");
    process.env.AZURE_STORAGE_SKILL_CONTAINER_NAME = "custom-skills";
    expect(skillBlobContainer()).toBe("custom-skills");
    if (saved === undefined) delete process.env.AZURE_STORAGE_SKILL_CONTAINER_NAME;
    else process.env.AZURE_STORAGE_SKILL_CONTAINER_NAME = saved;
  });
});

describe("ensureSkillOpenAiFile — one OpenAI file per skill version", () => {
  it("uploads once and stores the file id on the row", async () => {
    const skill = makeSkill();
    row = { ...skill };
    const id = await ensureSkillOpenAiFile(skill);
    expect(id).toBe("file-new-1");
    expect(UploadFileForCodeInterpreter).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({ id: "s1", openAiFileId: "file-new-1" });
  });

  it("reuses a cached file that still exists", async () => {
    retrieve.mockResolvedValue({ id: "file-cached", status: "processed" });
    const id = await ensureSkillOpenAiFile(makeSkill({ openAiFileId: "file-cached" }), { verify: true });
    expect(id).toBe("file-cached");
    expect(UploadFileForCodeInterpreter).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("re-uploads when the cached file is gone (404) and stores the new id", async () => {
    retrieve.mockRejectedValue(notFound());
    const skill = makeSkill({ openAiFileId: "file-gone" });
    row = { ...skill };
    const id = await ensureSkillOpenAiFile(skill, { verify: true });
    expect(id).toBe("file-new-1");
    expect(upsert.mock.calls[0][0]).toMatchObject({ openAiFileId: "file-new-1" });
  });

  it("keeps the cached file on a transient check error", async () => {
    retrieve.mockRejectedValue(Object.assign(new Error("timeout"), { status: 503 }));
    const id = await ensureSkillOpenAiFile(makeSkill({ openAiFileId: "file-cached" }), { verify: true });
    expect(id).toBe("file-cached");
    expect(UploadFileForCodeInterpreter).not.toHaveBeenCalled();
  });

  it("uses the id another chat stored first and deletes its own upload", async () => {
    const skill = makeSkill();
    row = { ...skill, openAiFileId: "file-other" };
    const id = await ensureSkillOpenAiFile(skill);
    expect(id).toBe("file-other");
    expect(del).toHaveBeenCalledWith("file-new-1");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does not undo a new version stored meanwhile (412): drops its upload, caches the new one", async () => {
    const skill = makeSkill();
    row = { ...skill };
    conflictWith = { ...skill, blobName: "agent-skills/p1/s1-2.zip" };
    const id = await ensureSkillOpenAiFile(skill);
    expect(del).toHaveBeenCalledWith("file-new-1");
    expect(id).toBe("file-new-2");
    expect(row).toMatchObject({ blobName: "agent-skills/p1/s1-2.zip", openAiFileId: "file-new-2" });
  });

  it("412 for another field on the same version: stores its upload on the newer row, no second upload", async () => {
    const skill = makeSkill();
    row = { ...skill };
    conflictWith = { ...skill, description: "Changed meanwhile." };
    const id = await ensureSkillOpenAiFile(skill);
    expect(id).toBe("file-new-1");
    expect(UploadFileForCodeInterpreter).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
    expect(row).toMatchObject({ description: "Changed meanwhile.", openAiFileId: "file-new-1" });
  });

  it("drops its upload when the skill was deleted meanwhile", async () => {
    row = undefined;
    const id = await ensureSkillOpenAiFile(makeSkill());
    expect(id).toBeUndefined();
    expect(del).toHaveBeenCalledWith("file-new-1");
  });
});

describe("uploadSkillArchivesForCodeInterpreter / refreshSkillOpenAiFiles", () => {
  it("attaches the cached file under the skill archive name", async () => {
    retrieve.mockResolvedValue({ id: "file-cached" });
    const files = await uploadSkillArchivesForCodeInterpreter([makeSkill({ openAiFileId: "file-cached" })]);
    expect(files).toEqual([
      expect.objectContaining({ id: "file-cached", name: "skill-demo.zip", type: "code-interpreter" }),
    ]);
    expect(UploadFileForCodeInterpreter).not.toHaveBeenCalled();
  });

  it("skips a skill whose upload fails", async () => {
    UploadFileForCodeInterpreter.mockResolvedValueOnce({ status: "ERROR", errors: [{ message: "x" }] } as never);
    expect(await uploadSkillArchivesForCodeInterpreter([makeSkill()])).toEqual([]);
  });

  it("reports a change when a missing file was re-uploaded", async () => {
    retrieve.mockRejectedValue(notFound());
    const skill = makeSkill({ openAiFileId: "file-gone" });
    row = { ...skill };
    expect(await refreshSkillOpenAiFiles([skill])).toBe(true);
    expect(skill.openAiFileId).toBe("file-new-1");
  });

  it("reports no change when every file is there", async () => {
    retrieve.mockResolvedValue({ id: "file-cached" });
    expect(await refreshSkillOpenAiFiles([makeSkill({ openAiFileId: "file-cached" })])).toBe(false);
  });
});

describe("deleteSkillOpenAiFile — best effort", () => {
  it("does nothing without an id", async () => {
    await deleteSkillOpenAiFile(undefined);
    expect(del).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    del.mockRejectedValueOnce(new Error("boom"));
    await expect(deleteSkillOpenAiFile("file-1")).resolves.toBeUndefined();
    del.mockRejectedValueOnce(notFound());
    await expect(deleteSkillOpenAiFile("file-2")).resolves.toBeUndefined();
  });
});

describe("loadUsableSkillsWithStatus — SharePoint permission per user", () => {
  it("leaves out a linked skill the user cannot read (Graph 403) and names it", async () => {
    personaRow = { id: "p1", type: "PERSONA", userId: "owner-hash", isPublished: true };
    const linked = makeSkill({
      id: "s2",
      name: "linked",
      openAiFileId: "file-linked",
      source: {
        kind: "sharepoint",
        driveId: "b!drive",
        itemId: "01ITEM",
        webUrl: "https://example.sharepoint.com/x.zip",
        name: "linked.zip",
        version: "c1",
        lastModifiedDateTime: "2026-11-01T00:00:00Z",
        size: 9,
      },
    });
    skillRows = [makeSkill(), linked];
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403, body: null }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await loadUsableSkillsWithStatus("p1");
      expect(res.skills.map((s) => s.name)).toEqual(["demo"]);
      expect(res.unavailable).toEqual(["linked"]);
      const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
      expect(calls).toHaveLength(1);
      expect(calls[0][1].headers).toMatchObject({ Authorization: "Bearer user-token" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not call Graph when the agent has no linked skills", async () => {
    personaRow = { id: "p1", type: "PERSONA", userId: "owner-hash", isPublished: true };
    skillRows = [makeSkill()];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await loadUsableSkillsWithStatus("p1");
      expect(res).toEqual({ skills: [expect.objectContaining({ name: "demo" })], unavailable: [] });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("resolveSkillAccess — admins may edit", () => {
  it("an admin who does not own the agent can edit its skills", async () => {
    personaRow = { id: "p1", type: "PERSONA", userId: "owner-hash", isPublished: true };
    currentUser = { isAdmin: true, token: "user-token" };
    const access = await resolveSkillAccess("p1");
    expect(access).toMatchObject({ canUse: true, canEdit: true });
  });

  it("a non-admin viewer of a published agent can use but not edit", async () => {
    personaRow = { id: "p1", type: "PERSONA", userId: "owner-hash", isPublished: true };
    const access = await resolveSkillAccess("p1");
    expect(access).toMatchObject({ canUse: true, canEdit: false });
  });
});

describe("canUsePersonaSkills — the central canOpenPersona rule", () => {
  const OWNER = "owner-hash";
  const user = { userId: "other-hash", isAdmin: false };
  const member = async () => true;
  const notMember = async () => false;

  it("owner can always use the skills", async () => {
    const owner = { userId: OWNER, isAdmin: false };
    expect(await canUsePersonaSkills(owner, { userId: OWNER, isPublished: false }, notMember)).toBe(true);
    expect(
      await canUsePersonaSkills(owner, { userId: OWNER, isPublished: false, accessGroup: { id: "g1", source: "SHAREPOINT" as const } }, notMember),
    ).toBe(true);
  });

  it("an admin can use the skills of an agent the admin can open", async () => {
    const admin = { userId: "admin-hash", isAdmin: true };
    expect(await canUsePersonaSkills(admin, { userId: OWNER, isPublished: false }, notMember)).toBe(true);
  });

  it("published agent: everyone; private agent: nobody else", async () => {
    expect(await canUsePersonaSkills(user, { userId: OWNER, isPublished: true }, notMember)).toBe(true);
    expect(await canUsePersonaSkills(user, { userId: OWNER, isPublished: false, linkAccess: false }, member)).toBe(false);
  });

  it("link agent (linkAccess not false): everyone with the link", async () => {
    expect(await canUsePersonaSkills(user, { userId: OWNER, isPublished: false }, notMember)).toBe(true);
  });

  it("group-shared agent: members yes, non-members no (even when published)", async () => {
    const shared = { userId: OWNER, isPublished: true, accessGroup: { id: "g1", source: "SHAREPOINT" as const } };
    expect(await canUsePersonaSkills(user, shared, member)).toBe(true);
    expect(await canUsePersonaSkills(user, shared, notMember)).toBe(false);
    expect(await canUsePersonaSkills(user, { ...shared, isPublished: false }, member)).toBe(true);
  });

  it("an empty access group id counts as no group", async () => {
    expect(
      await canUsePersonaSkills(user, { userId: OWNER, isPublished: true, accessGroup: { id: "", source: "SHAREPOINT" as const } }, notMember),
    ).toBe(true);
  });
});

describe("canEditPersonaSkills — the central canEditPersona rule (owner or admin)", () => {
  const OWNER = "owner-hash";
  it("the owner may change skills", () => {
    expect(canEditPersonaSkills({ userId: OWNER, isAdmin: false }, { userId: OWNER })).toBe(true);
  });
  it("an admin may change skills of any agent", () => {
    expect(canEditPersonaSkills({ userId: "admin-hash", isAdmin: true }, { userId: OWNER })).toBe(true);
  });
  it("other users may not", () => {
    expect(canEditPersonaSkills({ userId: "other-hash", isAdmin: false }, { userId: OWNER })).toBe(false);
  });
});
