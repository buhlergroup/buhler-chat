import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

const readSkillFile = vi.fn();
vi.mock("@/features/persona-page/persona-services/skills/persona-skill-store", () => ({
  readSkillFile: (...args: unknown[]) => readSkillFile(...args),
}));

// buildToolset pulls in the other tools; keep their heavy deps out.
vi.mock("@/features/persona-page/persona-services/persona-service", () => ({
  FindPersonaByID: vi.fn(),
  FindAllPersonaForCurrentUser: vi.fn(),
}));

import { loadSkillTool, MAX_SKILL_FILE_CHARS } from "../load-skill";
import { buildToolset } from "../registry";
import type { ToolContext } from "../tool-context";
import type { PersonaSkillModel } from "@/features/persona-page/persona-services/skills/skill-models";

const skill: PersonaSkillModel = {
  id: "s1",
  type: "PERSONA_SKILL",
  userId: "owner",
  personaId: "p1",
  name: "demo-skill",
  description: "Builds demos.",
  skillMd: "---\nname: demo-skill\ndescription: Builds demos.\n---\n# Demo\nRun scripts/run.py",
  rootPrefix: "demo-skill/",
  files: [
    { path: "SKILL.md", size: 70 },
    { path: "references/guide.md", size: 8 },
    { path: "assets/logo.png", size: 4 },
  ],
  zipFileName: "demo-skill.zip",
  zipBytes: 1000,
  uncompressedBytes: 82,
  blobName: "agent-skills/p1/s1-1.zip",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
  user: "u@example.com",
  threadId: "t1",
  threadDocumentIds: [],
  personaDocumentIds: [],
  defaultTools: {},
  extensions: [],
  depth: 0,
  skills: [skill],
  skillsInCodeInterpreter: ["demo-skill"],
  ...over,
});

const run = async (ctx: ToolContext, input: { name: string; path?: string }) => {
  const t = loadSkillTool(ctx) as unknown as {
    execute: (i: typeof input, o: object) => Promise<Record<string, unknown>>;
  };
  return t.execute(input, { toolCallId: "c1", messages: [] });
};

beforeEach(() => readSkillFile.mockReset());

describe("load_skill", () => {
  it("returns SKILL.md, the file list and the code interpreter steps", async () => {
    const out = await run(baseCtx(), { name: "demo-skill" });
    expect(out.instructions).toBe(skill.skillMd);
    expect(out.files).toEqual([
      "SKILL.md (70 bytes)",
      "references/guide.md (8 bytes)",
      "assets/logo.png (4 bytes)",
    ]);
    expect(out.codeInterpreter).toContain("skill-demo-skill.zip");
    expect(out.codeInterpreter).toContain("/mnt/data/skills/demo-skill/demo-skill");
    expect(readSkillFile).not.toHaveBeenCalled();
  });

  it("says the scripts cannot run when the archive is not in the code interpreter", async () => {
    const out = await run(baseCtx({ skillsInCodeInterpreter: [] }), { name: "demo-skill" });
    expect(out.codeInterpreter).toMatch(/code interpreter is off/);
  });

  it("returns a text file by path", async () => {
    readSkillFile.mockResolvedValue(Buffer.from("# Guide\n"));
    const out = await run(baseCtx(), { name: "demo-skill", path: "references/guide.md" });
    expect(out.content).toBe("# Guide\n");
    expect(readSkillFile).toHaveBeenCalledWith(skill, "references/guide.md");
  });

  it("truncates long files", async () => {
    readSkillFile.mockResolvedValue(Buffer.from("a".repeat(MAX_SKILL_FILE_CHARS + 10)));
    const out = await run(baseCtx(), { name: "demo-skill", path: "references/guide.md" });
    expect((out.content as string).length).toBe(MAX_SKILL_FILE_CHARS);
    expect(out.note).toMatch(/Truncated/);
  });

  it("points binary files to the code interpreter", async () => {
    readSkillFile.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
    const out = await run(baseCtx(), { name: "demo-skill", path: "assets/logo.png" });
    expect(out.error).toMatch(/binary/);
    expect(out.content).toBeUndefined();
  });

  it("rejects a path that is not in the manifest without reading the zip", async () => {
    const out = await run(baseCtx(), { name: "demo-skill", path: "../../etc/passwd" });
    expect(out.error).toMatch(/has no file/);
    expect(readSkillFile).not.toHaveBeenCalled();
  });

  it("rejects an unknown skill and lists the known ones", async () => {
    const out = await run(baseCtx(), { name: "nope" });
    expect(out.error).toMatch(/Unknown skill "nope". Available: demo-skill/);
  });
});

describe("buildToolset registers load_skill only with skills", () => {
  it("adds load_skill when the agent has usable skills", async () => {
    const tools = await buildToolset(baseCtx());
    expect(Object.keys(tools)).toContain("load_skill");
  });

  it("leaves it out without skills", async () => {
    const tools = await buildToolset(baseCtx({ skills: [] }));
    expect(Object.keys(tools)).not.toContain("load_skill");
  });
});
