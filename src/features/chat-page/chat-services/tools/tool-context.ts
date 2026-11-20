import "server-only";

import type { DefaultTools } from "@/features/chat-page/chat-services/models";
import type { ExtensionModel } from "@/features/extensions-page/extension-services/models";
import type { McpConnectionOptions } from "@/features/extensions-page/extension-services/mcp/mcp-client";

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
  /**
   * Extension records resolved at the callsite (headers already in secrets).
   * Only extensions that passed the access rule in extension-access.ts.
   * `mcp` holds the connection (URL, secret headers, OAuth) of a Remote MCP
   * extension; it carries secret values and must never be logged.
   */
  extensions: Array<{
    extension: ExtensionModel;
    headerSecrets: Record<string, string>;
    mcp?: McpConnectionOptions;
    /** Agent that granted access; carried into the per-user "Connect" action. */
    personaId?: string;
  }>;
  /**
   * IDs of the sub-agents (child personas) configured on this thread or
   * agent. `call_sub_agent` can reach any agent the user can open, but only
   * these run with their own extensions.
   */
  subAgentIds?: string[];
  /**
   * Recursion guard for buildToolset.
   * 0 = top-level call; sub-agent contexts use depth + 1.
   * Max depth before tools are omitted: 2.
   */
  depth?: number;
}

/**
 * The configured sub-agents of a context: those on the thread (or, one level
 * down, on the calling agent). The model picks `agent_id`, and tool output
 * can steer the model, so an agent outside this set runs without extensions
 * even when the user can open it.
 */
export function allowedSubAgentIds(ctx: Pick<ToolContext, "subAgentIds">): ReadonlySet<string> {
  return new Set((ctx.subAgentIds ?? []).filter((id) => typeof id === "string" && id.length > 0));
}
