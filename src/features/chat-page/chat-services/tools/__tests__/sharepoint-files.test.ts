import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

// buildToolset pulls in the other tools; keep their heavy deps out.
vi.mock("@/features/persona-page/persona-services/persona-service", () => ({
  FindPersonaByID: vi.fn(),
  FindAllPersonaForCurrentUser: vi.fn(),
}));
vi.mock("@/features/persona-page/persona-services/skills/persona-skill-store", () => ({
  readSkillFile: vi.fn(),
}));

const uploadToContainer = vi.fn(async (_c: string, name: string, _d: Buffer, _scope?: string) => ({
  path: `/mnt/data/${name}`,
}));
vi.mock("@/features/chat-page/chat-services/code-interpreter-container", () => ({
  putFileIntoCodeInterpreterContainer: (c: string, n: string, d: Buffer, scope?: string) =>
    uploadToContainer(c, n, d, scope),
}));

import { buildToolset } from "../registry";
import type { ToolContext } from "../tool-context";
import type { PersonaFileSourceModel } from "@/features/persona-page/persona-services/sharepoint-files/sharepoint-file-models";
import { readSharePointFileLimits } from "@/features/persona-page/persona-services/sharepoint-files/sharepoint-file-limits";

const DRIVE = "b!driveA_123";
const source: PersonaFileSourceModel = {
  id: "src1",
  type: "PERSONA_SHAREPOINT_FILE_SOURCE",
  userId: "owner-hash",
  personaId: "p1",
  driveId: DRIVE,
  itemId: "FOLDER1",
  name: "Images",
  webUrl: "",
  kind: "folder",
  createdAt: new Date("2026-11-01T00:00:00Z"),
};

const baseCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
  user: "u@example.com",
  threadId: "t1",
  threadDocumentIds: [],
  personaDocumentIds: [],
  defaultTools: {},
  extensions: [],
  depth: 0,
  codeInterpreterAvailable: true,
  sharePointFiles: {
    sources: [source],
    accessToken: "user-token",
    getContainerId: () => "cntr_1",
  },
  ...over,
});

type Exec = { execute: (i: object, o: object) => Promise<Record<string, unknown>> };
const exec = (t: unknown, input: object) =>
  (t as Exec).execute(input, { toolCallId: "c1", messages: [] });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/content")) {
        return new Response("hello", { status: 200, headers: { "content-length": "5" } });
      }
      if (url.includes("/children")) {
        return Response.json({
          value: [
            {
              id: "TXT1",
              name: "notes.txt",
              size: 5,
              file: {},
              parentReference: { driveId: DRIVE, id: "FOLDER1" },
            },
          ],
        });
      }
      return new Response("{}", { status: 404 });
    }),
  );
});

describe("SharePoint file tools in buildToolset", () => {
  it("are registered with sources and the code interpreter", async () => {
    const tools = await buildToolset(baseCtx());
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["find_sharepoint_files", "fetch_sharepoint_file"]),
    );
  });

  it("are absent without sources", async () => {
    const none = await buildToolset(baseCtx({ sharePointFiles: undefined }));
    const empty = await buildToolset(
      baseCtx({
        sharePointFiles: { sources: [], accessToken: "t", getContainerId: () => "c" },
      }),
    );
    for (const tools of [none, empty]) {
      expect(tools).not.toHaveProperty("find_sharepoint_files");
      expect(tools).not.toHaveProperty("fetch_sharepoint_file");
    }
  });

  it("are absent without the code interpreter", async () => {
    for (const codeInterpreterAvailable of [false, undefined]) {
      const tools = await buildToolset(baseCtx({ codeInterpreterAvailable }));
      expect(tools).not.toHaveProperty("find_sharepoint_files");
      expect(tools).not.toHaveProperty("fetch_sharepoint_file");
    }
  });

  it("tell the model to use exact names and fetch only what it needs", async () => {
    const tools = await buildToolset(baseCtx());
    const find = (tools.find_sharepoint_files as { description?: string }).description ?? "";
    const fetchDesc = (tools.fetch_sharepoint_file as { description?: string }).description ?? "";
    expect(find).toContain('"Images" (folder)');
    expect(fetchDesc).toMatch(/exact file name/);
    expect(fetchDesc).toMatch(/Fetch only the files the task really needs/);
    expect(fetchDesc).toContain("at most 10 per message");
    expect(fetchDesc).toContain("SharePoint's preview image: a JPEG that fits 2560x2560 px");
    expect(fetchDesc).toContain("images without a preview, may be up to 50 MB");
    // Same sources → byte-identical descriptions (prompt-cache stability).
    const again = await buildToolset(baseCtx());
    expect((again.fetch_sharepoint_file as { description?: string }).description).toBe(fetchDesc);
    expect((again.find_sharepoint_files as { description?: string }).description).toBe(find);
  });

  it("find + fetch share one listing and put the file into the container", async () => {
    const tools = await buildToolset(baseCtx());
    const found = await exec(tools.find_sharepoint_files, { query: "notes" });
    expect(found.files).toEqual([expect.objectContaining({ id: "TXT1", path: "notes.txt" })]);
    const fetched = await exec(tools.fetch_sharepoint_file, { name: "notes.txt" });
    expect(fetched).toMatchObject({ path: "/mnt/data/notes.txt", name: "notes.txt" });
    expect(uploadToContainer).toHaveBeenCalledWith(
      "cntr_1",
      "notes.txt",
      expect.any(Buffer),
      // the agent owner: the content store scope of agent files
      expect.any(String),
    );
    const calls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(calls.filter((u) => u.includes("/children"))).toHaveLength(1);
  });

  it("tells the model the exact path when the container prefixed the name", async () => {
    // A file attached by OpenAI file id (content store) is /mnt/data/<file id>-<name>.
    uploadToContainer.mockResolvedValueOnce({ path: "/mnt/data/assistant-abc-notes.txt" });
    const tools = await buildToolset(baseCtx());
    const fetched = await exec(tools.fetch_sharepoint_file, { name: "notes.txt" });
    expect(fetched.path).toBe("/mnt/data/assistant-abc-notes.txt");
    expect(fetched.pathNote).toContain("/mnt/data/assistant-abc-notes.txt");
    expect(fetched.pathNote).toContain("/mnt/data/notes.txt does not exist");
  });

  it("adds no path note when the path is /mnt/data/<name>", async () => {
    const tools = await buildToolset(baseCtx());
    const fetched = await exec(tools.fetch_sharepoint_file, { name: "notes.txt" });
    expect(fetched.pathNote).toBeUndefined();
  });
});

describe("readSharePointFileLimits", () => {
  it("uses the defaults", () => {
    expect(readSharePointFileLimits({})).toEqual({
      maxSources: 10,
      maxFetchesPerRequest: 10,
      maxFileBytes: 50_000_000,
      imageMaxPx: 2560,
    });
  });

  it("reads valid values and falls back on invalid ones", () => {
    expect(
      readSharePointFileLimits({
        SHAREPOINT_FILES_MAX_SOURCES: "3",
        SHAREPOINT_FILES_MAX_FETCHES_PER_REQUEST: " 4 ",
        SHAREPOINT_FILES_MAX_FILE_MB: "20",
        SHAREPOINT_FILES_IMAGE_MAX_PX: "1024",
      }),
    ).toEqual({ maxSources: 3, maxFetchesPerRequest: 4, maxFileBytes: 20_000_000, imageMaxPx: 1024 });
    for (const bad of ["0", "-1", "1.5", "abc", "1e3x", "99999999"]) {
      const l = readSharePointFileLimits({
        SHAREPOINT_FILES_MAX_SOURCES: bad,
        SHAREPOINT_FILES_MAX_FETCHES_PER_REQUEST: bad,
        SHAREPOINT_FILES_MAX_FILE_MB: bad,
        SHAREPOINT_FILES_IMAGE_MAX_PX: bad,
      });
      expect(l).toEqual(readSharePointFileLimits({}));
    }
  });
});
