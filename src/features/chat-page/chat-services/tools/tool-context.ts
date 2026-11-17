import "server-only";

import type { DefaultTools } from "@/features/chat-page/chat-services/models";
import type { ExtensionModel } from "@/features/extensions-page/extension-services/models";
import type { PersonaSkillModel } from "@/features/persona-page/persona-services/skills/skill-models";

/**
 * Context threaded through buildToolset and every tool execute closure.
 * Constructed once per request at the callsite that owns the chat thread.
 */
export interface ToolContext {
  /** The authenticated user's hashed ID. */
  user: string;
  /** ID of the current chat thread. */
  threadId: string;
  /** Document IDs attached to this thread (for RAG search filter). */
  threadDocumentIds: string[];
  /** Persona-level document IDs (may overlap with thread docs). */
  personaDocumentIds: string[];
  /** Feature toggles derived from the persona / thread settings. */
  defaultTools: DefaultTools;
  /**
   * The user's local datetime as an ISO 8601 string with UTC offset
   * (e.g. "2026-05-29T19:40:00.123+02:00"), forwarded by the browser via the
   * `x-client-datetime` header. The `get_current_time` tool returns it so the
   * model answers in the user's local time; falls back to server UTC.
   */
  clientDateTime?: string;
  /** Extension records resolved at the callsite (headers already in secrets). */
  extensions: Array<{ extension: ExtensionModel; headerSecrets: Record<string, string> }>;
  /**
   * IDs of sub-agents (child personas) this thread can invoke. When empty
   * or undefined the sub-agent tools (`call_sub_agent`, `search_sub_agent`)
   * are NOT registered — without this the AI SDK would register a real
   * `execute()` that throws "agent not found" for any caller, racing the
   * provider-executed inline result a fake provider may emit (#37).
   */
  subAgentIds?: string[];
  /**
   * Recursion guard for buildToolset.
   * 0 = top-level call; sub-agent contexts use depth + 1.
   * Max depth before tools are omitted: 2.
   */
  depth?: number;
  /**
   * Skills of the agent that runs this turn, already filtered by the access
   * rule (loadUsableSkills). Registers `load_skill` when non-empty.
   */
  skills?: PersonaSkillModel[];
  /**
   * Names of the skills whose zip is attached to this turn's code
   * interpreter container. load_skill tells the model how to unpack them.
   */
  skillsInCodeInterpreter?: string[];
}
