import "server-only";

import { z } from "zod";
import { tool } from "ai";
import { logInfo, logWarn } from "@/features/common/services/logger";
import {
  skillArchiveFileName,
  type PersonaSkillModel,
} from "@/features/persona-page/persona-services/skills/skill-models";
import { readSkillFile } from "@/features/persona-page/persona-services/skills/persona-skill-store";
import type { ToolContext } from "./tool-context";

/** Max characters of one file returned to the model. */
export const MAX_SKILL_FILE_CHARS = 100_000;

const looksBinary = (buf: Buffer): boolean => {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) return true;
  // Invalid UTF-8 round-trips with U+FFFD replacements.
  const text = sample.toString("utf8");
  const bad = (text.match(/�/g) ?? []).length;
  return bad > 4;
};

/** Code interpreter instructions for one skill (level 3: files on demand). */
export function codeInterpreterInstructions(
  skill: Pick<PersonaSkillModel, "name" | "rootPrefix">,
  available: boolean,
): string {
  if (!available) {
    return (
      "The code interpreter is off for this chat, so you cannot run the skill's scripts. " +
      "Read text files with load_skill and `path`. If the task needs the scripts, tell the user to turn on the code interpreter and start a new chat with the agent."
    );
  }
  const archive = skillArchiveFileName(skill.name);
  const root = `/mnt/data/skills/${skill.name}${skill.rootPrefix ? `/${skill.rootPrefix.replace(/\/$/, "")}` : ""}`;
  return (
    `The skill package is attached to the code interpreter as ${archive}. ` +
    "Unpack it once per chat before you use its scripts or assets:\n" +
    "```python\n" +
    "import glob, os, zipfile\n" +
    `dest = "/mnt/data/skills/${skill.name}"\n` +
    "if not os.path.isdir(dest):\n" +
    `    src = sorted(glob.glob("/mnt/data/**/*${archive}", recursive=True))[0]\n` +
    "    zipfile.ZipFile(src).extractall(dest)\n" +
    "```\n" +
    `Skill root (the folder of SKILL.md): ${root}\n` +
    "Paths in SKILL.md are relative to the skill root: use it as working directory or prefix the paths. " +
    "Write outputs to /mnt/data, never into the skill folder."
  );
}

/**
 * `load_skill` — progressive disclosure for agent skills.
 *   - without `path`: returns SKILL.md (level 2) plus the file list and how
 *     to use the files in the code interpreter;
 *   - with `path`: returns one text file of the skill (level 3).
 *
 * The skill list (names + descriptions, level 1) is in the system prompt
 * (buildSkillCatalogPrompt), so the tool description stays short and static.
 */
export function loadSkillTool(ctx: ToolContext) {
  const skills = ctx.skills ?? [];
  const ciSkills = new Set(ctx.skillsInCodeInterpreter ?? []);

  return tool({
    description:
      "Load an agent skill. Without path: returns the skill's instructions (SKILL.md) and its file list. " +
      "With path: returns that text file of the skill (path relative to the skill root).",
    inputSchema: z.object({
      name: z.string().describe("The skill name from the Skills list."),
      path: z
        .string()
        .optional()
        .describe("Optional file path relative to the skill root, e.g. references/guide.md."),
    }),
    execute: async ({ name, path }: { name: string; path?: string }) => {
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        return {
          error: `Unknown skill "${name}". Available: ${skills.map((s) => s.name).join(", ") || "none"}.`,
        };
      }

      const wantsSkillMd = !path || path.replace(/^\.\//, "") === "SKILL.md";
      if (wantsSkillMd) {
        logInfo("load_skill: SKILL.md", {
          threadId: ctx.threadId,
          skill: skill.name,
          depth: ctx.depth ?? 0,
        });
        return {
          name: skill.name,
          instructions: skill.skillMd,
          files: skill.files.map((f) => `${f.path} (${f.size} bytes)`),
          codeInterpreter: codeInterpreterInstructions(skill, ciSkills.has(skill.name)),
        };
      }

      const normalised = path!.replace(/\\/g, "/").replace(/^\.\//, "");
      if (!skill.files.some((f) => f.path === normalised)) {
        return { error: `The skill "${skill.name}" has no file "${path}". Call load_skill without path for the file list.` };
      }
      try {
        const buf = await readSkillFile(skill, normalised);
        if (!buf) return { error: `Could not read "${path}".` };
        if (looksBinary(buf)) {
          return {
            name: skill.name,
            path: normalised,
            error: "This is a binary file. Use it in the code interpreter.",
            codeInterpreter: codeInterpreterInstructions(skill, ciSkills.has(skill.name)),
          };
        }
        const text = buf.toString("utf8");
        const truncated = text.length > MAX_SKILL_FILE_CHARS;
        logInfo("load_skill: file", {
          threadId: ctx.threadId,
          skill: skill.name,
          path: normalised,
          bytes: buf.length,
        });
        return {
          name: skill.name,
          path: normalised,
          content: truncated ? text.slice(0, MAX_SKILL_FILE_CHARS) : text,
          ...(truncated ? { note: `Truncated at ${MAX_SKILL_FILE_CHARS} characters. Read the full file in the code interpreter.` } : {}),
        };
      } catch (error) {
        logWarn("load_skill: read failed", {
          skill: skill.name,
          path: normalised,
          error: error instanceof Error ? error.message : String(error),
        });
        return { error: `Could not read "${path}" from the skill package.` };
      }
    },
  });
}
