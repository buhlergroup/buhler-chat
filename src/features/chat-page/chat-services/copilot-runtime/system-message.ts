import type { SystemMessageConfig } from "@microsoft/copilot-sdk";
import { WORKSPACE_ROOT } from "./session-path";

/**
 * System message for a Copilot session: the app's own system message
 * (buildSystemMessage), not the runtime's coding-assistant prompt.
 *
 *   replace    (default) the app's message is the whole prompt. The SDK
 *              documents this as removing all runtime sections, including its
 *              guardrails; the app's own prompt carries ours.
 *   customize  keeps the runtime's safety and tool-instruction sections,
 *              replaces the identity with the app's message and removes the
 *              coding sections.
 *
 * COPILOT_SYSTEM_MESSAGE_MODE selects the mode, so both can be measured.
 */
export type CopilotSystemMessageMode = "replace" | "customize";

/** Short note on the file workspace; the tool schemas carry the details. */
export const WORKSPACE_NOTE =
  `\n\n## Files\nThis chat has a private file workspace at ${WORKSPACE_ROOT}. ` +
  "Use the file tools (view, create, edit, glob, grep) to keep notes or work files there. " +
  "Only paths inside the workspace exist; the files stay with this chat.";

export function copilotSystemMessageMode(): CopilotSystemMessageMode {
  return process.env.COPILOT_SYSTEM_MESSAGE_MODE === "customize" ? "customize" : "replace";
}

export function buildCopilotSystemMessage(
  appSystemMessage: string,
  mode: CopilotSystemMessageMode = copilotSystemMessageMode(),
): SystemMessageConfig {
  if (mode === "replace") {
    return { mode: "replace", content: appSystemMessage + WORKSPACE_NOTE };
  }
  return {
    mode: "customize",
    sections: {
      identity: { action: "replace", content: appSystemMessage },
      tone: { action: "remove" },
      tool_efficiency: { action: "remove" },
      environment_context: { action: "remove" },
      code_change_rules: { action: "remove" },
      guidelines: { action: "remove" },
      custom_instructions: { action: "remove" },
      runtime_instructions: { action: "remove" },
      last_instructions: { action: "remove" },
    },
    content: WORKSPACE_NOTE,
  };
}
