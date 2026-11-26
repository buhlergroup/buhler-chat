import { describe, it, expect, vi } from "vitest";

vi.mock("@/features/common/services/logger", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }));
vi.mock("@/features/persona-page/persona-services/skills/persona-skill-store", () => ({ readSkillFile: vi.fn() }));

import { copilotCodeInterpreterPlan } from "./agent-code-interpreter";
import { loadSkillTool } from "../tools/load-skill";
import { buildCopilotSystemMessage } from "./system-message";
import type { PersonaSkillModel } from "@/features/persona-page/persona-services/skills/skill-models";

const skill = {
  id: "s1",
  type: "PERSONA_SKILL",
  userId: "owner",
  personaId: "p1",
  name: "deck",
  description: "Builds slide decks with python.",
  skillMd: "---\nname: deck\n---\nRun scripts/build.py",
  rootPrefix: "",
  files: [{ path: "SKILL.md", size: 40 }, { path: "scripts/build.py", size: 10 }],
  zipFileName: "deck.zip",
  zipBytes: 1,
  uncompressedBytes: 1,
  blobName: "b",
  openAiFileId: "assistant-skill-current",
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as PersonaSkillModel;

const attachedFiles = [
  { id: "assistant-skill-old", name: "skill-deck.zip", source: "skill" },
  { id: "assistant-code1", name: "Line Overview.xlsx", source: "agent-document" },
  { id: "assistant-up1", name: "notes.csv", source: "upload" },
];

describe("copilotCodeInterpreterPlan", () => {
  it("an agent with a skill and a Code file, toggle off: run_code on, files attached, no 'code interpreter is off'", async () => {
    const plan = copilotCodeInterpreterPlan({
      toggle: false,
      isAgentChat: true,
      skills: [skill],
      attachedFiles,
      requestedFileIds: [],
      agentFileSourceCount: 0,
    });
    expect(plan.enabled).toBe(true);
    // The current file of the skill version, the Code file and the upload, at their container paths.
    expect(plan.files).toEqual([
      {
        id: "assistant-skill-current",
        name: "skill-deck.zip",
        containerPath: "/mnt/data/assistant-skill-current-skill-deck.zip",
        // The files in the archive: run_code does not return copies of them.
        entries: [{ name: "SKILL.md", size: 40 }, { name: "build.py", size: 10 }],
      },
      { id: "assistant-code1", name: "Line Overview.xlsx", containerPath: "/mnt/data/assistant-code1-Line Overview.xlsx" },
      { id: "assistant-up1", name: "notes.csv", containerPath: "/mnt/data/assistant-up1-notes.csv" },
    ]);
    expect(plan.skillsInCodeInterpreter).toEqual(["deck"]);
    // The system message does not say the code interpreter is off and names no per-thread file.
    const system = buildCopilotSystemMessage("You are the agent.", "replace");
    const content = "content" in system ? String(system.content) : "";
    expect(content).not.toMatch(/code interpreter is off/i);
    expect(content).not.toContain("assistant-code1");

    // load_skill (what the route builds with this plan) points at the unpacked skill.
    const tool = loadSkillTool({
      user: "u",
      threadId: "t",
      skills: [skill],
      skillsInCodeInterpreter: plan.skillsInCodeInterpreter,
      codeInterpreterAvailable: plan.enabled,
    } as never);
    const out = (await tool.execute!({ name: "deck" }, { toolCallId: "c", messages: [] } as never)) as { codeInterpreter: string };
    expect(out.codeInterpreter).toContain("/mnt/data/skills/deck");
    expect(out.codeInterpreter).toContain("skill-deck.zip");
    expect(out.codeInterpreter).not.toMatch(/is off/);
  });

  it("an agent with On-demand SharePoint files only: run_code on, nothing attached", () => {
    const plan = copilotCodeInterpreterPlan({ toggle: false, isAgentChat: true, skills: [], attachedFiles: [], requestedFileIds: [], agentFileSourceCount: 1 });
    expect(plan).toEqual({ enabled: true, files: [], skillsInCodeInterpreter: [] });
  });

  it("a chat without agent files and toggle off: no run_code", () => {
    expect(
      copilotCodeInterpreterPlan({ toggle: false, isAgentChat: true, skills: [], attachedFiles: [], requestedFileIds: [], agentFileSourceCount: 0 }).enabled,
    ).toBe(false);
    expect(
      copilotCodeInterpreterPlan({ toggle: true, isAgentChat: false, skills: [], attachedFiles: [], requestedFileIds: ["browser-only"], agentFileSourceCount: 0 }),
    ).toEqual({ enabled: true, files: [], skillsInCodeInterpreter: [] });
  });

  it("drops the archive of a skill that is no longer usable", () => {
    const plan = copilotCodeInterpreterPlan({ toggle: true, isAgentChat: true, skills: [], attachedFiles, requestedFileIds: [], agentFileSourceCount: 0 });
    expect(plan.files.map((f) => f.id)).toEqual(["assistant-code1", "assistant-up1"]);
    expect(plan.skillsInCodeInterpreter).toEqual([]);
  });
});
