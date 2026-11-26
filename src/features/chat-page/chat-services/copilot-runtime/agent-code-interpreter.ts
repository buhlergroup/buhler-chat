/**
 * The code interpreter of a Copilot turn (run_code, provider-tools.ts).
 *
 * On the AI SDK path the thread's code interpreter files (attachedFiles:
 * the agent's Code files and skill archives, which the chat start uploaded
 * and attached, and the user's code interpreter uploads) go into the
 * container by OpenAI file id, and the agent save keeps the code interpreter
 * on for an agent whose files need it (agentFilesNeedCodeInterpreter). The
 * Copilot path has no provider-hosted code interpreter, and the route used
 * to decide everything code-interpreter related from "provider-hosted
 * tools: off": load_skill said that the code interpreter is off, the system
 * message had no file paths, and run_code got an empty container.
 *
 * Here: run_code is on when the chat toggle is on, the thread has code
 * interpreter files, or the chat's agent has files that need it (skills,
 * On-demand SharePoint files). Its container is created with the thread's
 * code interpreter files (skill archives mapped onto the current file of
 * each skill version), the same files at the same paths
 * (/mnt/data/<file id>-<name>) as on the AI SDK path, so load_skill's unpack
 * snippet works. The paths reach the model in run_code's result (`inputs`),
 * never in the system message: it stays the same on every turn (prompt cache).
 *
 * Pure: the route passes what it has loaded.
 */
import {
  resolveSkillCodeInterpreterFiles,
  skillArchiveFileName,
  type PersonaSkillModel,
} from "@/features/persona-page/persona-services/skills/skill-models";
import { codeInterpreterPathOf } from "../chat-api/code-interpreter-files-prompt";

export interface CopilotCodeInterpreterInput {
  /** The composer toggle (payload, else the thread's default tools). */
  toggle: boolean;
  /** The chat runs an agent (thread.personaId). */
  isAgentChat: boolean;
  /** The agent's skills the user may use. */
  skills: ReadonlyArray<Pick<PersonaSkillModel, "name" | "openAiFileId">>;
  /** The thread's code interpreter files (attachedFiles without the search-indexed ones). */
  attachedFiles: ReadonlyArray<{ id: string; name: string; source?: string }>;
  /** The request's code interpreter file ids the server can attribute. */
  requestedFileIds: ReadonlyArray<string>;
  /** The agent's On-demand SharePoint files and folders. */
  agentFileSourceCount: number;
}

/** One file the run_code container is created with. */
export interface ContainerInputFile {
  /** OpenAI file id. */
  id: string;
  name: string;
  /** Where the code finds it: /mnt/data/<file id>-<name>. */
  containerPath: string;
}

export interface CopilotCodeInterpreterPlan {
  /** run_code is registered. */
  enabled: boolean;
  /** The files the run_code container is created with (by OpenAI file id). */
  files: ContainerInputFile[];
  /** Skills whose archive is in the container (load_skill tells how to unpack it). */
  skillsInCodeInterpreter: string[];
}

export function copilotCodeInterpreterPlan(input: CopilotCodeInterpreterInput): CopilotCodeInterpreterPlan {
  const agentNeedsIt = input.isAgentChat && (input.skills.length > 0 || input.agentFileSourceCount > 0);
  const enabled = input.toggle || input.attachedFiles.length > 0 || agentNeedsIt;
  if (!enabled) return { enabled: false, files: [], skillsInCodeInterpreter: [] };

  // Every code interpreter file of the thread, whether or not the request
  // names it: the browser sends no file ids while its toggle is off. The ids
  // are the thread's own (attachedFiles) and the current skill files.
  const requested = [
    ...new Set([
      ...input.requestedFileIds,
      ...input.attachedFiles.map((f) => f.id),
      ...(input.isAgentChat ? input.skills.flatMap((s) => (s.openAiFileId ? [s.openAiFileId] : [])) : []),
    ]),
  ];
  const resolved = input.isAgentChat
    ? resolveSkillCodeInterpreterFiles({ skills: input.skills, attachedFiles: input.attachedFiles, requestedFileIds: requested })
    : { fileIds: requested.filter((id) => input.attachedFiles.some((f) => f.id === id)), skillsInCodeInterpreter: [] as string[] };

  const nameById = new Map(input.attachedFiles.map((f) => [f.id, f.name]));
  const skillNameByFileId = new Map(input.skills.flatMap((s) => (s.openAiFileId ? [[s.openAiFileId, skillArchiveFileName(s.name)]] : [])));
  const files = resolved.fileIds.flatMap((id) => {
    const name = skillNameByFileId.get(id) ?? nameById.get(id);
    return name ? [{ id, name, containerPath: codeInterpreterPathOf({ id, name }) }] : [];
  });
  return { enabled, files, skillsInCodeInterpreter: resolved.skillsInCodeInterpreter };
}
