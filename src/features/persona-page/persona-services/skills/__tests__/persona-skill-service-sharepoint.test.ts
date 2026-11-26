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
const replace = vi.fn(async (doc: unknown) => ({ resource: doc }));
const itemDelete = vi.fn(async (_id: string) => ({}));
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: { upsert },
    item: vi.fn((id: string) => ({
      replace: (doc: unknown) => replace(doc),
      read: async () => ({ resource: undefined }),
      delete: () => itemDelete(id),
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
let graph: { status?: number; cTag: string; name: string; content: Buffer; networkError?: boolean };
const fetchMock = vi.fn(async (input: string, _init?: RequestInit): Promise<Response> => {
  if (graph.networkError) throw new TypeError("fetch failed");
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
  DeletePersonaSkill,
  UploadPersonaSkill,
} from "../persona-skill-service";
import { querySkillsByPersonaId } from "../persona-skill-store";
import { SKILL_LIMITS } from "../skill-models";
import { linkSharePointSkill } from "../link-sharepoint-skill";
import { clearDriveItemChecks } from "@/features/common/services/sharepoint/drive-item-check-cache";

const goodZip = () =>
  buildZip([
    { name: "demo-skill/SKILL.md", data: SKILL_MD },
    { name: "demo-skill/scripts/run.py", data: "print(1)" },
  ]);

const link = (over: { driveId?: string; itemId?: string } = {}) =>
  linkSharePointSkill({
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

describe("linkSharePointSkill", () => {
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

  it.each([
    ["500", { status: 500 }],
    ["503", { status: 503 }],
    ["a network error", { networkError: true }],
  ])("shows the owner an error when SharePoint gives no answer (%s)", async (_label, over) => {
    existing = [linkedRow()];
    Object.assign(graph, over);
    const res = await CheckPersonaSkillNow("p1", "s1");
    expect(res.status).toBe("ERROR");
    expect(res.status === "ERROR" && res.errors[0].message).toMatch(/SharePoint did not answer/);
  });
});

describe("skill limit with adds of several requests at the same time", () => {
  it("never keeps more than the limit when two links run at the same time", async () => {
    // The agent has one skill less than the limit. Both requests count
    // before either inserts (the barrier), so both see room.
    const max = SKILL_LIMITS.maxSkillsPerAgent;
    DeleteBlob.mockClear();
    let rows: Array<Record<string, unknown>> = Array.from({ length: max - 1 }, (_, i) => ({
      ...linkedRow(),
      id: `old-${i}`,
      name: `old-${i}`,
      source: undefined,
    }));
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    let counts = 0;
    vi.mocked(querySkillsByPersonaId).mockImplementation(async () => {
      counts++;
      if (counts === 2) release();
      if (counts <= 2) await barrier;
      return [...rows] as never;
    });
    upsert.mockImplementation(async (doc: any) => {
      rows.push(doc);
      return { resource: doc };
    });
    itemDelete.mockImplementation(async (id: string) => {
      rows = rows.filter((r) => r.id !== id);
      return {};
    });

    const results = await Promise.all([
      link({ itemId: "01ITEMAAA" }),
      link({ itemId: "01ITEMBBB" }),
    ]);

    expect(rows.length).toBeLessThanOrEqual(max);
    const ok = results.filter((r) => r.status === "OK");
    expect(ok.length).toBe(rows.length - (max - 1));
    for (const r of results.filter((r) => r.status !== "OK")) {
      expect(r.status === "ERROR" && r.errors[0].message).toMatch(/up to \d+ skills/);
    }
    // The undone add leaves no blob behind.
    expect(DeleteBlob.mock.calls.length).toBe(results.length - ok.length);

    vi.mocked(querySkillsByPersonaId).mockImplementation(async () => existing as never);
    upsert.mockImplementation(async (doc: unknown) => ({ resource: doc }));
    itemDelete.mockImplementation(async () => ({}));
  });
});

describe("skill actions: NOT_FOUND for a user who cannot open the agent", () => {
  it("Upload, Check now and Delete answer like an unknown agent, before the edit check", async () => {
    access = { canUse: false, canEdit: false };
    fetchMock.mockClear();
    const file = new NodeFile([new Uint8Array(goodZip())], "demo-skill.zip", { type: "application/zip" });
    const form = { get: (k: string) => (k === "personaId" ? "p1" : k === "file" ? file : null) } as unknown as FormData;
    expect((await UploadPersonaSkill(form)).status).toBe("NOT_FOUND");
    expect((await CheckPersonaSkillNow("p1", "s1")).status).toBe("NOT_FOUND");
    expect((await DeletePersonaSkill("p1", "s1")).status).toBe("NOT_FOUND");
    expect((await link()).status).toBe("NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
