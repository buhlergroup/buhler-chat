import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeGraph } from "./fake-graph";

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

const upsert = vi.fn(async (doc: unknown) => ({ resource: doc }));
const remove = vi.fn(async () => ({}));
const item = vi.fn((..._a: unknown[]) => ({ delete: remove }));
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({ items: { upsert }, item }),
}));

vi.mock("@/features/auth-page/helpers", () => ({
  getCurrentUser: async () => ({ token: "user-token", isAdmin: false }),
}));

let access: { canUse: boolean; canEdit: boolean } | undefined;
vi.mock("../../skills/persona-skill-store", () => ({
  resolveSkillAccess: vi.fn(async () =>
    access ? { ...access, persona: { userId: "owner-hash" }, currentUserId: "me" } : undefined,
  ),
}));

let existing: Array<Record<string, unknown>> = [];
vi.mock("../sharepoint-file-store", () => ({
  queryFileSourcesByPersonaId: vi.fn(async () => existing),
}));

import { DeletePersonaFileSource } from "../sharepoint-file-service";
import { queryFileSourcesByPersonaId } from "../sharepoint-file-store";
import { addPersonaFileSource as AddPersonaFileSource } from "../add-file-source";

const DRIVE = "b!driveA_123";
let graph: FakeGraph;

const row = (over: Record<string, unknown> = {}) => ({
  id: "src1",
  type: "PERSONA_SHAREPOINT_FILE_SOURCE",
  userId: "owner-hash",
  personaId: "p1",
  driveId: DRIVE,
  itemId: "FOLDER1",
  name: "Images",
  webUrl: "https://contoso.sharepoint.com/sites/demo/Images",
  kind: "folder",
  createdAt: new Date("2026-11-01T00:00:00Z"),
  ...over,
});

beforeEach(() => {
  graph = new FakeGraph()
    .add(DRIVE, { id: "ROOT", name: "root", folder: true })
    .add(DRIVE, { id: "FOLDER1", name: "Images", parent: "ROOT", folder: true })
    .add(DRIVE, { id: "FILE1", name: "photo-01.jpg", parent: "FOLDER1", content: Buffer.from("x") })
    .add(DRIVE, { id: "EXE1", name: "setup.exe", parent: "FOLDER1", content: Buffer.from("x") })
    .add(DRIVE, { id: "LOCKED", name: "Locked", parent: "ROOT", folder: true, status: 403 });
  vi.stubGlobal("fetch", vi.fn(graph.fetch));
  access = { canUse: true, canEdit: true };
  existing = [];
  delete process.env.SHAREPOINT_FILES_MAX_SOURCES;
});

describe("addPersonaFileSource", () => {
  it("stores a folder with name, link and kind from Graph", async () => {
    const res = await AddPersonaFileSource({ personaId: "p1", driveId: DRIVE, itemId: "FOLDER1" });
    expect(res.status).toBe("OK");
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0][0]).toMatchObject({
      type: "PERSONA_SHAREPOINT_FILE_SOURCE",
      userId: "owner-hash", // partition of the agent's owner
      personaId: "p1",
      driveId: DRIVE,
      itemId: "FOLDER1",
      name: "Images",
      kind: "folder",
      webUrl: "https://contoso.sharepoint.com/sites/demo/Images",
    });
  });

  it("stores a file as kind file", async () => {
    const res = await AddPersonaFileSource({ personaId: "p1", driveId: DRIVE, itemId: "FILE1" });
    expect(res.status === "OK" && res.response.kind).toBe("file");
  });

  it("refuses a non-owner before any Graph call", async () => {
    access = { canUse: true, canEdit: false };
    const res = await AddPersonaFileSource({ personaId: "p1", driveId: DRIVE, itemId: "FOLDER1" });
    expect(res.status).toBe("UNAUTHORIZED");
    expect(fetch).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses invalid ids before the access check and Graph", async () => {
    const res = await AddPersonaFileSource({ personaId: "p1", driveId: "../x", itemId: "FOLDER1" });
    expect(res.status).toBe("ERROR");
    const res2 = await AddPersonaFileSource({ personaId: "p1", driveId: DRIVE, itemId: "a/b?c" });
    expect(res2.status).toBe("ERROR");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses more sources than the limit (configurable)", async () => {
    process.env.SHAREPOINT_FILES_MAX_SOURCES = "2";
    existing = [row({ id: "a", itemId: "A1" }), row({ id: "b", itemId: "B1" })];
    const res = await AddPersonaFileSource({ personaId: "p1", driveId: DRIVE, itemId: "FOLDER1" });
    expect(res.status).toBe("ERROR");
    expect(res.status === "ERROR" && res.errors[0].message).toMatch(/up to 2/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses the same folder twice", async () => {
    existing = [row()];
    const res = await AddPersonaFileSource({ personaId: "p1", driveId: DRIVE, itemId: "FOLDER1" });
    expect(res.status === "ERROR" && res.errors[0].message).toMatch(/already uses/);
  });

  it("says 'not available for you' when SharePoint refuses", async () => {
    const res = await AddPersonaFileSource({ personaId: "p1", driveId: DRIVE, itemId: "LOCKED" });
    expect(res.status === "ERROR" && res.errors[0].message).toMatch(/not available for you/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses a file type the model cannot use", async () => {
    const res = await AddPersonaFileSource({ personaId: "p1", driveId: DRIVE, itemId: "EXE1" });
    expect(res.status === "ERROR" && res.errors[0].message).toMatch(/\.exe are not supported/);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("DeletePersonaFileSource", () => {
  it("deletes for the owner only", async () => {
    existing = [row()];
    access = { canUse: true, canEdit: false };
    expect((await DeletePersonaFileSource("p1", "src1")).status).toBe("UNAUTHORIZED");
    expect(remove).not.toHaveBeenCalled();
    access = { canUse: true, canEdit: true };
    expect((await DeletePersonaFileSource("p1", "src1")).status).toBe("OK");
    expect(item).toHaveBeenCalledWith("src1", "owner-hash");
    expect(remove).toHaveBeenCalledOnce();
  });
});

describe("source limit with adds of several requests at the same time", () => {
  it("never keeps more than the limit when two adds run at the same time", async () => {
    process.env.SHAREPOINT_FILES_MAX_SOURCES = "2";
    let rows: Array<Record<string, unknown>> = [row({ id: "a", itemId: "A1" })];
    // Both requests count before either inserts (the barrier): both see room.
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    let counts = 0;
    vi.mocked(queryFileSourcesByPersonaId).mockImplementation(async () => {
      counts++;
      if (counts === 2) release();
      if (counts <= 2) await barrier;
      return [...rows] as never;
    });
    upsert.mockImplementation(async (doc: any) => {
      rows.push(doc);
      return { resource: doc };
    });
    item.mockImplementation((...a: unknown[]) => ({
      delete: async () => {
        rows = rows.filter((r) => r.id !== a[0]);
        return {};
      },
    }));

    const results = await Promise.all([
      AddPersonaFileSource({ personaId: "p1", driveId: DRIVE, itemId: "FOLDER1" }),
      AddPersonaFileSource({ personaId: "p1", driveId: DRIVE, itemId: "FILE1" }),
    ]);

    expect(rows.length).toBeLessThanOrEqual(2);
    const ok = results.filter((r) => r.status === "OK");
    expect(ok.length).toBe(rows.length - 1);
    for (const r of results.filter((r) => r.status !== "OK")) {
      expect(r.status === "ERROR" && r.errors[0].message).toMatch(/up to 2/);
    }

    vi.mocked(queryFileSourcesByPersonaId).mockImplementation(async () => existing as never);
    upsert.mockImplementation(async (doc: unknown) => ({ resource: doc }));
    item.mockImplementation((..._a: unknown[]) => ({ delete: remove }));
  });
});

describe("source actions: NOT_FOUND for a user who cannot open the agent", () => {
  it("DeletePersonaFileSource and addPersonaFileSource answer like an unknown agent", async () => {
    existing = [row()];
    access = { canUse: false, canEdit: false };
    remove.mockClear();
    expect((await DeletePersonaFileSource("p1", "src1")).status).toBe("NOT_FOUND");
    expect((await AddPersonaFileSource({ personaId: "p1", driveId: DRIVE, itemId: "FOLDER1" })).status).toBe(
      "NOT_FOUND",
    );
    expect(remove).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
