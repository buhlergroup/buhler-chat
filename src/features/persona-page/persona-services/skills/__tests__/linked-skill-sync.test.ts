import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildZip, SKILL_MD } from "./zip-fixture";

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

// ── Cosmos: rows by id, with etags and IfMatch like the real service ────────
let rows: Map<string, Record<string, unknown>>;
let etagCounter = 0;
const replace = vi.fn(
  async (doc: Record<string, unknown>, opts?: { accessCondition?: { condition: string } }) => {
    const current = rows.get(doc.id as string);
    if (opts?.accessCondition && current?._etag !== opts.accessCondition.condition) {
      throw Object.assign(new Error("Precondition failed"), { code: 412 });
    }
    const next = { ...doc, _etag: `e${++etagCounter}` };
    rows.set(doc.id as string, next);
    return { resource: next };
  },
);
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    item: (id: string) => ({
      replace: (doc: Record<string, unknown>, opts?: { accessCondition?: { condition: string } }) =>
        replace(doc, opts),
      read: async () => ({ resource: rows.get(id) }),
    }),
  }),
}));

const UploadBlob = vi.fn(async (..._a: unknown[]) => ({ status: "OK", response: "url" }));
const DeleteBlob = vi.fn(async (..._a: unknown[]) => ({ status: "OK", response: true }));
vi.mock("@/features/common/services/azure-storage", () => ({
  UploadBlob: (...a: unknown[]) => UploadBlob(...a),
  DeleteBlob: (...a: unknown[]) => DeleteBlob(...a),
}));

// ── Fake Microsoft Graph behind global fetch ────────────────────────────────
interface FakeFile {
  metaStatus?: number;
  contentStatus?: number;
  cTag: string;
  name?: string;
  size?: number;
  content?: Buffer;
  /** Metadata request hangs until the abort signal fires. */
  hang?: boolean;
}
let file: FakeFile;
const fetchMock = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (file.hang && !url.includes("/content")) {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
      );
    });
  }
  if (url.includes("/content")) {
    if (file.contentStatus) return new Response("denied", { status: file.contentStatus });
    return new Response(new Uint8Array(file.content ?? Buffer.alloc(0)), { status: 200 });
  }
  if (file.metaStatus) return new Response("{}", { status: file.metaStatus });
  return new Response(
    JSON.stringify({
      name: file.name ?? "demo-skill.zip",
      webUrl: "https://example.sharepoint.com/sites/x/demo-skill.zip",
      cTag: file.cTag,
      eTag: `"{E}-${file.cTag}"`,
      lastModifiedDateTime: "2026-11-18T09:00:00Z",
      size: file.size ?? file.content?.length ?? 100,
      file: { mimeType: "application/zip" },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});
vi.stubGlobal("fetch", fetchMock);

import {
  fetchLinkedSkillZip,
  syncLinkedSkill,
  syncLinkedSkills,
  type LinkedSkillDeps,
} from "../linked-skill-sync";
import {
  GRAPH_BASE_URL,
  getDriveItemVersion,
} from "../sharepoint-skill-graph";
import {
  ITEM_CHECK_MAX_ENTRIES,
  checkDriveItem,
  clearDriveItemChecks,
} from "../drive-item-check-cache";
import type { PersonaSkillModel } from "../skill-models";

const goodZip = (description = "Builds demo things v2.") =>
  buildZip([
    {
      name: "demo-skill/SKILL.md",
      data: SKILL_MD.replace(/description: .*/, `description: ${description}`),
    },
    { name: "demo-skill/scripts/run.py", data: "print(2)" },
  ]);

let blobCounter = 0;
const deleteOpenAiFile = vi.fn(async (_id: string | undefined) => {});
const deps: LinkedSkillDeps = {
  blobContainer: "agent-skills",
  newBlobName: (p, s) => `agent-skills/${p}/${s}-new${++blobCounter}.zip`,
  deleteOpenAiFile: (id) => deleteOpenAiFile(id),
};

type Row = PersonaSkillModel & { _etag?: string };
const linkedSkill = (over: Partial<Row> = {}): Row => ({
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
  _etag: "e0",
  ...over,
});

const uploadedSkill = (): Row => {
  const { source: _s, ...rest } = linkedSkill({ id: "s2", name: "other-skill", blobName: "b2" });
  return rest;
};

const contentCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/content"));

beforeEach(() => {
  clearDriveItemChecks();
  rows = new Map();
  etagCounter = 0;
  blobCounter = 0;
  file = { cTag: "c1", content: goodZip() };
  const row = linkedSkill();
  rows.set(row.id, row);
});

describe("Graph calls", () => {
  it("only calls graph.microsoft.com, with the user's token and the metadata select", async () => {
    await getDriveItemVersion("user-token", "b!drive_ABC-1", "01ITEMXYZ");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `${GRAPH_BASE_URL}/drives/b!drive_ABC-1/items/01ITEMXYZ?$select=name,webUrl,cTag,eTag,lastModifiedDateTime,size,file`,
    );
    expect(GRAPH_BASE_URL).toBe("https://graph.microsoft.com/v1.0");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer user-token");
  });

  it.each([
    ["../me/drive", "01ITEM"],
    ["b!x", "01ITEM/../../children"],
    ["b!x", "01ITEM?x=1"],
    ["https://evil.example/x", "01ITEM"],
    ["", "01ITEM"],
  ])("refuses the id pair %s / %s without any request", async (driveId, itemId) => {
    const res = await fetchLinkedSkillZip("t", driveId, itemId);
    expect(res).toMatchObject({ ok: false, reason: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("times out a hanging metadata request", async () => {
    file.hang = true;
    await expect(getDriveItemVersion("t", "b!d", "01I", 20)).rejects.toMatchObject({
      timedOut: true,
    });
  });

  it("refuses a file larger than the zip limit before the download", async () => {
    file.size = 60_000_000;
    const res = await fetchLinkedSkillZip("t", "b!d", "01I");
    expect(res).toMatchObject({ ok: false, reason: "invalid" });
    expect(contentCalls()).toHaveLength(0);
  });

  it("refuses a file that is not a .zip", async () => {
    file.name = "notes.docx";
    const res = await fetchLinkedSkillZip("t", "b!d", "01I");
    expect(res).toMatchObject({ ok: false, reason: "invalid", message: "Choose a .zip file." });
  });
});

describe("syncLinkedSkill at chat time", () => {
  it("cTag unchanged: uses the stored copy and its OpenAI file, no download", async () => {
    const res = await syncLinkedSkill(linkedSkill(), "user-token", [], deps);
    expect(res.status).toBe("current");
    expect(res.skill.blobName).toBe("agent-skills/p1/s1-0.zip");
    expect(res.skill.openAiFileId).toBe("file-v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(contentCalls()).toHaveLength(0);
    expect(UploadBlob).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("cTag changed: downloads, validates and stores a new version; old blob and OpenAI file go", async () => {
    file.cTag = "c2";
    const res = await syncLinkedSkill(linkedSkill(), "user-token", [], deps);
    expect(res.status).toBe("updated");
    expect(contentCalls()).toHaveLength(1);
    expect(UploadBlob).toHaveBeenCalledWith(
      "agent-skills",
      "agent-skills/p1/s1-new1.zip",
      expect.any(Buffer),
      expect.anything(),
    );
    // Written only if the row is unchanged since it was read.
    expect(replace.mock.calls[0][1]).toEqual({
      accessCondition: { type: "IfMatch", condition: "e0" },
    });
    const stored = rows.get("s1")!;
    expect(stored).toMatchObject({
      blobName: "agent-skills/p1/s1-new1.zip",
      description: "Builds demo things v2.",
      source: { version: "c2", lastModifiedDateTime: "2026-11-18T09:00:00Z" },
    });
    expect(stored.openAiFileId).toBeUndefined();
    expect(res.skill.openAiFileId).toBeUndefined();
    expect(DeleteBlob).toHaveBeenCalledWith("agent-skills", "agent-skills/p1/s1-0.zip");
    expect(deleteOpenAiFile).toHaveBeenCalledWith("file-v1");
  });

  it.each([401, 403, 404])("Graph %i on metadata: the skill is not used, no fallback", async (status) => {
    file.metaStatus = status;
    const res = await syncLinkedSkill(linkedSkill(), "user-token", [], deps);
    expect(res.status).toBe("denied");
    expect(contentCalls()).toHaveLength(0);
  });

  it("Graph 403 on the download of a new version: the skill is not used", async () => {
    file.cTag = "c2";
    file.contentStatus = 403;
    expect((await syncLinkedSkill(linkedSkill(), "t", [], deps)).status).toBe("denied");
    expect(UploadBlob).not.toHaveBeenCalled();
  });

  it("no token: the skill is not used (permission cannot be checked)", async () => {
    const res = await syncLinkedSkill(linkedSkill(), "", [], deps);
    expect(res.status).toBe("denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([500, 503, 429])("Graph %i: uses the stored version", async (status) => {
    file.metaStatus = status;
    const res = await syncLinkedSkill(linkedSkill(), "t", [], deps);
    expect(res).toMatchObject({ status: "kept", invalid: false });
    expect(res.skill.blobName).toBe("agent-skills/p1/s1-0.zip");
    expect(res.skill.openAiFileId).toBe("file-v1");
  });

  it("timeout: uses the stored version", async () => {
    file.hang = true;
    const res = await syncLinkedSkill(linkedSkill(), "t", [], deps, { metadataTimeoutMs: 20 });
    expect(res).toMatchObject({ status: "kept", invalid: false });
    expect(res.skill.openAiFileId).toBe("file-v1");
  });

  it("invalid new zip: keeps the last good version and records the error once", async () => {
    file.cTag = "c2";
    file.content = buildZip([{ name: "x/README.md", data: "no skill" }]);
    const res = await syncLinkedSkill(linkedSkill(), "t", [], deps);
    expect(res).toMatchObject({ status: "kept", invalid: true });
    expect(res.skill.blobName).toBe("agent-skills/p1/s1-0.zip");
    expect(UploadBlob).not.toHaveBeenCalled();
    const stored = rows.get("s1")!;
    expect(stored.blobName).toBe("agent-skills/p1/s1-0.zip");
    expect(stored.openAiFileId).toBe("file-v1");
    expect((stored.source as { syncError: { version: string; message: string } }).syncError).toMatchObject({
      version: "c2",
      message: expect.stringMatching(/SKILL.md is missing/),
    });

    // The next chat does not download the same bad version again...
    fetchMock.mockClear();
    const again = await syncLinkedSkill(stored as Row, "t", [], deps);
    expect(again).toMatchObject({ status: "kept", invalid: true });
    expect(contentCalls()).toHaveLength(0);

    // ...but "Check now" (force) does.
    await syncLinkedSkill(stored as Row, "t", [], deps, { force: true });
    expect(contentCalls()).toHaveLength(1);
  });

  it("a new version whose skill name another skill uses is refused", async () => {
    file.cTag = "c2";
    const sibling = { ...uploadedSkill(), name: "demo-skill", id: "s9" };
    const res = await syncLinkedSkill(linkedSkill(), "t", [sibling], deps);
    expect(res).toMatchObject({ status: "kept", invalid: true });
    expect(UploadBlob).not.toHaveBeenCalled();
  });

  it("clears a stale error when the file is back at the stored version", async () => {
    const skill = linkedSkill();
    skill.source = { ...skill.source!, syncError: { version: "c9", message: "bad", at: "x" } };
    rows.set("s1", skill);
    const res = await syncLinkedSkill(skill, "t", [], deps);
    expect(res.status).toBe("current");
    expect(res.skill.source?.syncError).toBeUndefined();
    expect((rows.get("s1")!.source as Record<string, unknown>).syncError).toBeUndefined();
  });

  it("a parallel request stored the same version first: uses theirs, drops its own blob", async () => {
    file.cTag = "c2";
    rows.set("s1", {
      ...linkedSkill(),
      blobName: "agent-skills/p1/s1-theirs.zip",
      openAiFileId: undefined,
      source: { ...linkedSkill().source!, version: "c2" },
      _etag: "e-other",
    });
    const res = await syncLinkedSkill(linkedSkill(), "t", [], deps);
    expect(res.status).toBe("updated");
    expect(res.skill.blobName).toBe("agent-skills/p1/s1-theirs.zip");
    expect(DeleteBlob).toHaveBeenCalledWith("agent-skills", "agent-skills/p1/s1-new1.zip");
    expect(DeleteBlob).not.toHaveBeenCalledWith("agent-skills", "agent-skills/p1/s1-theirs.zip");
  });

  it("retries when only the cached OpenAI file id changed meanwhile", async () => {
    file.cTag = "c2";
    rows.set("s1", { ...linkedSkill(), openAiFileId: "file-v1b", _etag: "e-cache" });
    const res = await syncLinkedSkill(linkedSkill(), "t", [], deps);
    expect(res.status).toBe("updated");
    expect(rows.get("s1")!.blobName).toBe("agent-skills/p1/s1-new1.zip");
    expect(deleteOpenAiFile).toHaveBeenCalledWith("file-v1b");
  });
});

describe("syncLinkedSkills for one chat request", () => {
  it("checks linked skills once each, in parallel; uploaded skills pass without Graph", async () => {
    const res = await syncLinkedSkills([linkedSkill(), uploadedSkill()], "t", deps);
    expect(res.skills.map((s) => s.name)).toEqual(["demo-skill", "other-skill"]);
    expect(res.unavailable).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url).startsWith("https://graph.microsoft.com/v1.0/")).toBe(true);
    }
  });

  it("403: leaves the linked skill out and names it as unavailable", async () => {
    file.metaStatus = 403;
    const res = await syncLinkedSkills([linkedSkill(), uploadedSkill()], "t", deps);
    expect(res.skills.map((s) => s.name)).toEqual(["other-skill"]);
    expect(res.unavailable).toEqual(["demo-skill"]);
  });

  it("503: keeps the cached linked skill", async () => {
    file.metaStatus = 503;
    const res = await syncLinkedSkills([linkedSkill()], "t", deps);
    expect(res.skills).toHaveLength(1);
    expect(res.skills[0].openAiFileId).toBe("file-v1");
    expect(res.unavailable).toEqual([]);
  });
});

describe("per-user check cache (60 s)", () => {
  const metaCalls = () => fetchMock.mock.calls.filter((c) => !String(c[0]).includes("/content"));
  const sync = (opts: { userId?: string; force?: boolean } = {}) =>
    syncLinkedSkill(rows.get("s1") as Row, "user-token", [], deps, { userId: "user-a", ...opts });

  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("second check within 60 s makes no Graph call", async () => {
    expect((await sync()).status).toBe("current");
    now += 59_000;
    expect((await sync()).status).toBe("current");
    expect(metaCalls()).toHaveLength(1);
  });

  it("after 60 s the file is checked again", async () => {
    await sync();
    now += 60_001;
    await sync();
    expect(metaCalls()).toHaveLength(2);
  });

  it("is per user: another user is checked with their own call", async () => {
    await sync();
    await sync({ userId: "user-b" });
    expect(metaCalls()).toHaveLength(2);
  });

  it("caches a denial: still not used, no second call", async () => {
    file.metaStatus = 403;
    expect((await sync()).status).toBe("denied");
    file.metaStatus = undefined;
    expect((await sync()).status).toBe("denied");
    expect(metaCalls()).toHaveLength(1);
  });

  it("does not cache transient errors", async () => {
    file.metaStatus = 503;
    expect((await sync()).status).toBe("kept");
    file.metaStatus = undefined;
    expect((await sync()).status).toBe("current");
    expect(metaCalls()).toHaveLength(2);
  });

  it("Check now (force) bypasses the cache and refreshes it", async () => {
    await sync();
    file.metaStatus = 403;
    expect((await sync({ force: true })).status).toBe("denied");
    expect(metaCalls()).toHaveLength(2);
    // The refreshed entry (denied) now answers the next chat.
    file.metaStatus = undefined;
    expect((await sync()).status).toBe("denied");
    expect(metaCalls()).toHaveLength(2);
  });

  it("a stored new version updates the cached entry: the next chat needs no call", async () => {
    file.cTag = "c2";
    expect((await sync()).status).toBe("updated");
    const callsAfterUpdate = metaCalls().length;
    expect((await sync()).status).toBe("current");
    expect(metaCalls()).toHaveLength(callsAfterUpdate);
  });

  it("a new version stored by one user updates the cached entries of other users", async () => {
    await sync({ userId: "user-b" }); // user-b caches c1
    file.cTag = "c2";
    await sync({ force: true }); // user-a stores c2
    expect(rows.get("s1")!.source).toMatchObject({ version: "c2" });
    fetchMock.mockClear();
    expect((await sync({ userId: "user-b" })).status).toBe("current");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a cached version that differs from the row is checked again, never downloaded from the cache", async () => {
    await sync({ userId: "user-b" }); // user-b caches c1
    // Another replica stored c2 (this process's cache did not see it).
    rows.set("s1", { ...rows.get("s1")!, source: { ...linkedSkill().source!, version: "c2" } });
    file.cTag = "c2";
    fetchMock.mockClear();
    expect((await sync({ userId: "user-b" })).status).toBe("current");
    expect(metaCalls()).toHaveLength(1);
    expect(contentCalls()).toHaveLength(0);
  });

  it("drops the least recently used entry above 500 entries", async () => {
    for (let i = 0; i <= ITEM_CHECK_MAX_ENTRIES; i++) {
      await checkDriveItem("t", "user-a", "b!d", `01ITEM${i}`);
    }
    fetchMock.mockClear();
    await checkDriveItem("t", "user-a", "b!d", `01ITEM${ITEM_CHECK_MAX_ENTRIES}`);
    expect(fetchMock).not.toHaveBeenCalled();
    await checkDriveItem("t", "user-a", "b!d", "01ITEM0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches nothing without a user id", async () => {
    await sync({ userId: "" });
    await sync({ userId: "" });
    expect(metaCalls()).toHaveLength(2);
  });
});
