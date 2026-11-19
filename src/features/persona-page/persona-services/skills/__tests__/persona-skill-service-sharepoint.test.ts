import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildZip, SKILL_MD } from "./zip-fixture";

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

const upsert = vi.fn(async (doc: unknown) => ({ resource: doc }));
const replace = vi.fn(async (doc: unknown) => ({ resource: doc }));
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: { upsert },
    item: vi.fn(() => ({
      replace: (doc: unknown) => replace(doc),
      read: async () => ({ resource: undefined }),
      delete: vi.fn(),
    })),
  }),
}));

const UploadBlob = vi.fn(async (..._a: unknown[]) => ({ status: "OK", response: "url" }));
const DeleteBlob = vi.fn(async (..._a: unknown[]) => ({ status: "OK", response: true }));
vi.mock("@/features/common/services/azure-storage", () => ({
  UploadBlob: (...a: unknown[]) => UploadBlob(...a),
  DeleteBlob: (...a: unknown[]) => DeleteBlob(...a),
}));

vi.mock("@/features/auth-page/helpers", () => ({
  getCurrentUser: async () => ({ token: "user-token", isAdmin: false }),
}));

let access: { canUse: boolean; canEdit: boolean } | undefined;
let existing: Array<Record<string, unknown>> = [];
vi.mock("../persona-skill-store", () => ({
  resolveSkillAccess: vi.fn(async () =>
    access ? { ...access, persona: { userId: "owner-hash" }, currentUserId: "x" } : undefined,
  ),
  querySkillsByPersonaId: vi.fn(async () => existing),
  skillBlobContainer: () => "agent-skills",
  deleteSkillOpenAiFile: vi.fn(async () => {}),
  skillBlobName: (p: string, s: string) => `agent-skills/${p}/${s}-1.zip`,
  linkedSkillDeps: () => ({
    blobContainer: "agent-skills",
    newBlobName: (p: string, s: string) => `agent-skills/${p}/${s}-2.zip`,
    deleteOpenAiFile: async () => {},
  }),
}));

// ── Fake Graph ──────────────────────────────────────────────────────────────
let graph: { status?: number; cTag: string; name: string; content: Buffer };
const fetchMock = vi.fn(async (input: string, _init?: RequestInit): Promise<Response> => {
  if (graph.status) return new Response("{}", { status: graph.status });
  if (String(input).includes("/content")) {
    return new Response(new Uint8Array(graph.content), { status: 200 });
  }
  return new Response(
    JSON.stringify({
      name: graph.name,
      webUrl: "https://example.sharepoint.com/sites/x/demo-skill.zip",
      cTag: graph.cTag,
      lastModifiedDateTime: "2026-11-18T09:00:00Z",
      size: graph.content.length,
      file: {},
    }),
    { status: 200 },
  );
});
vi.stubGlobal("fetch", fetchMock);

import {
  CheckPersonaSkillNow,
  FindPersonaSkills,
  LinkPersonaSkillFromSharePoint,
} from "../persona-skill-service";
import { clearDriveItemChecks } from "@/features/common/services/sharepoint/drive-item-check-cache";

const goodZip = () =>
  buildZip([
    { name: "demo-skill/SKILL.md", data: SKILL_MD },
    { name: "demo-skill/scripts/run.py", data: "print(1)" },
  ]);

const link = (over: { driveId?: string; itemId?: string } = {}) =>
  LinkPersonaSkillFromSharePoint({
    personaId: "p1",
    driveId: over.driveId ?? "b!drive_ABC-1",
    itemId: over.itemId ?? "01ITEMXYZ",
  });

const linkedRow = () => ({
  id: "s1",
  type: "PERSONA_SKILL",
  userId: "owner-hash",
  personaId: "p1",
  name: "demo-skill",
  description: "Builds demo things.",
  skillMd: SKILL_MD,
  rootPrefix: "demo-skill/",
  files: [{ path: "SKILL.md", size: 10 }],
  zipFileName: "demo-skill.zip",
  zipBytes: 100,
  uncompressedBytes: 100,
  blobName: "agent-skills/p1/s1-0.zip",
  openAiFileId: "file-v1",
  source: {
    kind: "sharepoint",
    driveId: "b!drive_ABC-1",
    itemId: "01ITEMXYZ",
    webUrl: "https://example.sharepoint.com/sites/x/demo-skill.zip",
    name: "demo-skill.zip",
    version: "c1",
    lastModifiedDateTime: "2026-11-01T09:00:00Z",
    size: 100,
  },
  createdAt: new Date("2026-11-01"),
  updatedAt: new Date("2026-11-01"),
});

beforeEach(() => {
  clearDriveItemChecks();
  access = { canUse: true, canEdit: true };
  existing = [];
  graph = { cTag: "c1", name: "demo-skill.zip", content: goodZip() };
});

describe("LinkPersonaSkillFromSharePoint", () => {
  it("stores a linked skill: blob copy, row with source and version, data from Graph", async () => {
    const res = await link();
    expect(res.status).toBe("OK");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: "Bearer user-token" },
    });
    expect(UploadBlob).toHaveBeenCalledWith(
      "agent-skills",
      expect.stringMatching(/^agent-skills\/p1\/.+-1\.zip$/),
      expect.any(Buffer),
      expect.anything(),
    );
    const doc = upsert.mock.calls[0][0] as Record<string, unknown>;
    expect(doc).toMatchObject({
      type: "PERSONA_SKILL",
      personaId: "p1",
      userId: "owner-hash",
      name: "demo-skill",
      zipFileName: "demo-skill.zip",
      source: {
        kind: "sharepoint",
        driveId: "b!drive_ABC-1",
        itemId: "01ITEMXYZ",
        webUrl: "https://example.sharepoint.com/sites/x/demo-skill.zip",
        version: "c1",
        lastModifiedDateTime: "2026-11-18T09:00:00Z",
      },
    });
    expect(res.status === "OK" && res.response.source).toMatchObject({
      kind: "sharepoint",
      fileName: "demo-skill.zip",
    });
  });

  it("refuses a user who can use but not edit the agent, before any Graph call", async () => {
    access = { canUse: true, canEdit: false };
    expect((await link()).status).toBe("UNAUTHORIZED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for an unknown agent", async () => {
    access = undefined;
    expect((await link()).status).toBe("NOT_FOUND");
  });

  it.each([
    { driveId: "../me" },
    { itemId: "01ITEM/children" },
    { driveId: "https://evil.example" },
  ])("refuses malformed ids %o without a Graph call", async (over) => {
    const res = await link(over);
    expect(res.status).toBe("ERROR");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates with the upload rules and stores nothing for a bad zip", async () => {
    graph.content = buildZip([{ name: "x/README.md", data: "hi" }]);
    const res = await link();
    expect(res.status === "ERROR" && res.errors[0].message).toMatch(/SKILL.md is missing/);
    expect(UploadBlob).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("returns the access message when SharePoint says 403", async () => {
    graph.status = 403;
    const res = await link();
    expect(res.status === "ERROR" && res.errors[0].message).toMatch(/cannot open this file/);
  });

  it("refuses a file the agent already uses and a skill name it already has", async () => {
    existing = [linkedRow()];
    expect((await link()).status).toBe("ERROR");
    expect(fetchMock).not.toHaveBeenCalled();

    existing = [{ ...linkedRow(), source: undefined }];
    const res = await link();
    expect(res.status === "ERROR" && res.errors[0].message).toMatch(/already has the skill/);
    expect(UploadBlob).not.toHaveBeenCalled();
  });
});

describe("CheckPersonaSkillNow", () => {
  it("refuses a non-editor", async () => {
    access = { canUse: true, canEdit: false };
    existing = [linkedRow()];
    expect((await CheckPersonaSkillNow("p1", "s1")).status).toBe("UNAUTHORIZED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports current when the file did not change", async () => {
    existing = [linkedRow()];
    const res = await CheckPersonaSkillNow("p1", "s1");
    expect(res.status === "OK" && res.response.result).toBe("current");
    expect(UploadBlob).not.toHaveBeenCalled();
  });

  it("stores the new version when the file changed", async () => {
    existing = [linkedRow()];
    graph.cTag = "c2";
    const res = await CheckPersonaSkillNow("p1", "s1");
    expect(res.status === "OK" && res.response.result).toBe("updated");
    expect(UploadBlob).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(
      expect.objectContaining({ source: expect.objectContaining({ version: "c2" }) }),
    );
  });

  it("shows the owner why a new version is not used", async () => {
    existing = [linkedRow()];
    graph.cTag = "c2";
    graph.content = buildZip([{ name: "x/README.md", data: "hi" }]);
    const res = await CheckPersonaSkillNow("p1", "s1");
    expect(res.status === "OK" && res.response.result).toBe("invalid");
    expect(res.status === "OK" && res.response.skill.source?.syncError).toMatch(/SKILL.md is missing/);
  });

  it("refuses an uploaded skill", async () => {
    existing = [{ ...linkedRow(), source: undefined }];
    expect((await CheckPersonaSkillNow("p1", "s1")).status).toBe("ERROR");
  });
});

describe("FindPersonaSkills — linked skills and SharePoint access of the viewer", () => {
  const uploaded = () => ({ ...linkedRow(), id: "s2", name: "other-skill", source: undefined });

  it("a viewer without access to the file sees the name and a note only", async () => {
    access = { canUse: true, canEdit: false };
    existing = [linkedRow(), uploaded()];
    graph.status = 403;
    const res = await FindPersonaSkills("p1");
    expect(res.status).toBe("OK");
    if (res.status !== "OK") return;
    const [linked, other] = res.response.skills;
    expect(linked).toEqual({
      id: "s1",
      name: "demo-skill",
      description: "",
      zipFileName: "",
      zipBytes: 0,
      fileCount: 0,
      updatedAt: "",
      noAccess: true,
    });
    expect(JSON.stringify(linked)).not.toMatch(/Builds demo|sharepoint\.com|demo-skill\.zip/);
    // Uploaded skills are not affected.
    expect(other).toMatchObject({ name: "other-skill", description: "Builds demo things." });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: "Bearer user-token" },
    });
  });

  it("a viewer with access sees the full entry", async () => {
    access = { canUse: true, canEdit: false };
    existing = [linkedRow()];
    const res = await FindPersonaSkills("p1");
    expect(res.status === "OK" && res.response.skills[0]).toMatchObject({
      name: "demo-skill",
      description: "Builds demo things.",
      source: { kind: "sharepoint", fileName: "demo-skill.zip" },
    });
    expect(res.status === "OK" && res.response.skills[0].noAccess).toBeUndefined();
  });

  it("a timeout or 5xx does not hide the entry (chats use the stored copy then too)", async () => {
    access = { canUse: true, canEdit: false };
    existing = [linkedRow()];
    graph.status = 503;
    const res = await FindPersonaSkills("p1");
    expect(res.status === "OK" && res.response.skills[0].description).toBe("Builds demo things.");
  });

  it("owners and admins see the full entry without a Graph call", async () => {
    access = { canUse: true, canEdit: true };
    existing = [linkedRow()];
    graph.status = 403;
    const res = await FindPersonaSkills("p1");
    expect(res.status === "OK" && res.response.skills[0].description).toBe("Builds demo things.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a second list load within 60 s makes no Graph call", async () => {
    access = { canUse: true, canEdit: false };
    existing = [linkedRow()];
    graph.status = 403;
    await FindPersonaSkills("p1");
    await FindPersonaSkills("p1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
