import { describe, it, expect, vi, beforeEach } from "vitest";
import { File as NodeFile } from "node:buffer";
import { buildZip, SKILL_MD } from "./zip-fixture";

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

const upsert = vi.fn(async (doc: unknown) => ({ resource: doc }));
const itemDelete = vi.fn(async () => ({}));
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: { upsert },
    item: vi.fn(() => ({ delete: itemDelete })),
  }),
}));

const UploadBlob = vi.fn(async () => ({ status: "OK", response: "url" }));
const DeleteBlob = vi.fn(async () => ({ status: "OK", response: true }));
vi.mock("@/features/common/services/azure-storage", () => ({
  UploadBlob: (...a: unknown[]) => UploadBlob(...(a as [])),
  DeleteBlob: (...a: unknown[]) => DeleteBlob(...(a as [])),
}));

const deleteSkillOpenAiFile = vi.fn(async () => {});
let access: { canUse: boolean; canEdit: boolean } | undefined;
let existing: Array<Record<string, unknown>> = [];
vi.mock("../persona-skill-store", () => ({
  resolveSkillAccess: vi.fn(async () =>
    access
      ? { ...access, persona: { userId: "owner-hash" }, currentUserId: "x" }
      : undefined,
  ),
  querySkillsByPersonaId: vi.fn(async () => existing),
  skillBlobContainer: () => "agent-skills",
  deleteSkillOpenAiFile: (...a: unknown[]) => deleteSkillOpenAiFile(...(a as [])),
  skillBlobName: (p: string, s: string) => `agent-skills/${p}/${s}-1.zip`,
}));

// The persona row: the real etag-checked helpers run against this row.
let personaRow: Record<string, any> | undefined;
const updatePersonaRow = vi.fn(async (_id: string, mutate: (p: any) => any) => {
  if (!personaRow) return undefined;
  const next = mutate({ ...personaRow });
  if (next) personaRow = next;
  return personaRow;
});
vi.mock("../../persona-row", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../persona-row")>();
  return {
    withCodeInterpreterOn: actual.withCodeInterpreterOn,
    updatePersonaRow: (id: string, mutate: (p: any) => any) => updatePersonaRow(id, mutate),
  };
});

import {
  DeletePersonaSkill,
  UploadPersonaSkill,
} from "../persona-skill-service";

const goodZip = () =>
  buildZip([
    { name: "demo-skill/SKILL.md", data: SKILL_MD },
    { name: "demo-skill/scripts/run.py", data: "print(1)" },
  ]);

// jsdom's File has no arrayBuffer(); use Node's File, as the Next server does.
const form = (zip: Buffer, extra: Record<string, string> = {}) => {
  const values: Record<string, unknown> = {
    personaId: "p1",
    file: new NodeFile([new Uint8Array(zip)], "demo-skill.zip", { type: "application/zip" }),
    ...extra,
  };
  return { get: (k: string) => values[k] ?? null } as unknown as FormData;
};

beforeEach(() => {
  personaRow = { id: "p1", userId: "owner-hash", defaultTools: { webSearch: true } };
  access = { canUse: true, canEdit: true };
  existing = [];
  upsert.mockClear();
  itemDelete.mockClear();
  UploadBlob.mockClear();
  DeleteBlob.mockClear();
  deleteSkillOpenAiFile.mockClear();
});

describe("UploadPersonaSkill — server-side owner/admin check", () => {
  it("stores the zip in blob and the metadata in Cosmos for the owner", async () => {
    const res = await UploadPersonaSkill(form(goodZip()));
    expect(res.status).toBe("OK");
    expect(UploadBlob).toHaveBeenCalledTimes(1);
    const doc = upsert.mock.calls[0][0] as Record<string, unknown>;
    expect(doc).toMatchObject({
      type: "PERSONA_SKILL",
      personaId: "p1",
      userId: "owner-hash",
      name: "demo-skill",
      rootPrefix: "demo-skill/",
      zipFileName: "demo-skill.zip",
    });
  });

  it("refuses a user who can use but not edit the agent, before any storage write", async () => {
    access = { canUse: true, canEdit: false };
    const res = await UploadPersonaSkill(form(goodZip()));
    expect(res.status).toBe("UNAUTHORIZED");
    expect(UploadBlob).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for an unknown agent", async () => {
    access = undefined;
    expect((await UploadPersonaSkill(form(goodZip()))).status).toBe("NOT_FOUND");
  });

  it("returns the validation message for a bad zip and stores nothing", async () => {
    const res = await UploadPersonaSkill(form(buildZip([{ name: "x/README.md", data: "hi" }])));
    expect(res.status).toBe("ERROR");
    expect(res.status === "ERROR" && res.errors[0].message).toMatch(/SKILL.md is missing/);
    expect(UploadBlob).not.toHaveBeenCalled();
  });

  it("rejects a second skill with the same name", async () => {
    existing = [{ id: "s1", name: "demo-skill", blobName: "old" }];
    const res = await UploadPersonaSkill(form(goodZip()));
    expect(res.status === "ERROR" && res.errors[0].message).toMatch(/Replace/);
  });

  it("replaces a skill: same id, old blob deleted", async () => {
    existing = [{ id: "s1", name: "demo-skill", blobName: "agent-skills/p1/s1-0.zip", openAiFileId: "file-old", createdAt: new Date() }];
    const res = await UploadPersonaSkill(form(goodZip(), { replaceSkillId: "s1" }));
    expect(res.status).toBe("OK");
    expect((upsert.mock.calls[0][0] as { id: string }).id).toBe("s1");
    expect(DeleteBlob).toHaveBeenCalledWith("agent-skills", "agent-skills/p1/s1-0.zip");
    expect(deleteSkillOpenAiFile).toHaveBeenCalledWith("file-old");
    // The new version starts without a cached OpenAI file.
    expect((upsert.mock.calls[0][0] as { openAiFileId?: string }).openAiFileId).toBeUndefined();
  });
});

describe("UploadPersonaSkill switches the code interpreter on", () => {
  it("sets defaultTools.codeInterpreter on the persona row, before the skill is stored", async () => {
    const order: string[] = [];
    updatePersonaRow.mockImplementationOnce(async (_id, mutate) => {
      order.push("persona");
      personaRow = mutate({ ...personaRow }) ?? personaRow;
      return personaRow;
    });
    UploadBlob.mockImplementationOnce(async () => {
      order.push("blob");
      return { status: "OK", response: "url" };
    });
    const res = await UploadPersonaSkill(form(goodZip()));
    expect(res.status).toBe("OK");
    expect(updatePersonaRow).toHaveBeenCalledWith("p1", expect.any(Function));
    expect(personaRow!.defaultTools).toEqual({ webSearch: true, codeInterpreter: true });
    expect(order).toEqual(["persona", "blob"]);
  });

  it("leaves a persona row alone when the code interpreter is on already", async () => {
    personaRow = { id: "p1", userId: "owner-hash", defaultTools: { codeInterpreter: true } };
    const before = personaRow;
    expect((await UploadPersonaSkill(form(goodZip()))).status).toBe("OK");
    expect(personaRow).toBe(before);
  });

  it("stores nothing when the persona row cannot be written", async () => {
    updatePersonaRow.mockRejectedValueOnce(new Error("The agent changed while saving. Try again."));
    const res = await UploadPersonaSkill(form(goodZip()));
    expect(res.status).toBe("ERROR");
    expect(UploadBlob).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does not touch the persona row for a user who may not edit", async () => {
    access = { canUse: true, canEdit: false };
    await UploadPersonaSkill(form(goodZip()));
    expect(updatePersonaRow).not.toHaveBeenCalled();
  });
});

describe("DeletePersonaSkill", () => {
  it("refuses delete for a non-owner", async () => {
    access = { canUse: true, canEdit: false };
    existing = [{ id: "s1", name: "demo-skill", blobName: "b", userId: "owner-hash" }];
    expect((await DeletePersonaSkill("p1", "s1")).status).toBe("UNAUTHORIZED");
    expect(itemDelete).not.toHaveBeenCalled();
  });

  it("deletes row and blob for the owner", async () => {
    existing = [{ id: "s1", name: "demo-skill", blobName: "b", userId: "owner-hash", openAiFileId: "file-1" }];
    expect((await DeletePersonaSkill("p1", "s1")).status).toBe("OK");
    expect(itemDelete).toHaveBeenCalled();
    expect(DeleteBlob).toHaveBeenCalledWith("agent-skills", "b");
    expect(deleteSkillOpenAiFile).toHaveBeenCalledWith("file-1");
  });
});
