import "server-only";

// No "use server": this module decides who may use which extension, and its
// helpers read documents without an access filter. It is imported by server
// code only and must never become a browser-callable action.

import { SqlQuerySpec } from "@azure/cosmos";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { PERSONA_ATTRIBUTE } from "@/features/persona-page/persona-services/models";
import { EXTENSION_ATTRIBUTE, type ExtensionModel } from "./models";

/**
 * Why a user may use an extension. "legacy" is rule 4 in
 * decideExtensionAccess: an extension of another user that an agent already
 * listed before the access rule (temporary, see there).
 */
export type ExtensionGrant = "owner" | "published" | "agent" | "legacy";

/** The agent (persona) fields the rule reads. */
export interface AgentForAccess {
  id: string;
  userId: string;
  isPublished?: boolean;
  linkAccess?: boolean;
  accessGroup?: { id?: string } | null;
  extensionIds?: string[];
}

export interface ExtensionAccessDecision<E extends { id: string }> {
  granted: Array<{ extension: E; grant: ExtensionGrant }>;
  denied: Array<{ id: string; reason: "not-found" | "no-access" }>;
}

export interface ExtensionAccessInput<E> {
  /** Extension ids requested for this chat (thread or sub-agent persona). */
  extensionIds: readonly string[];
  /** The documents that exist for those ids (missing ids = deleted extensions). */
  extensions: readonly E[];
  /** The agent the chat runs, if any (thread.personaId or the sub-agent). */
  agent?: AgentForAccess | null;
  /** Hashed id of the user who chats. */
  userId: string;
  /** Entra group membership of that user. */
  isGroupMember: (groupId: string) => Promise<boolean>;
}

/**
 * Can `userId` open this agent, for rule 3 below? canOpenPersona
 * (persona-access.ts) without its admin clause: the owner always; a
 * group-shared agent only for members of that group (also when it is
 * published, as in the agent list); any other agent only when it is
 * published to the whole organization or open to everyone with the link
 * (linkAccess, on unless false). An admin may open any agent, but that
 * does not give the admin the agent owner's private extensions (and their
 * secrets) in a chat.
 */
export async function canOpenAgent(
  agent: AgentForAccess,
  userId: string,
  isGroupMember: (groupId: string) => Promise<boolean>
): Promise<boolean> {
  if (agent.userId === userId) return true;
  const groupId = agent.accessGroup?.id;
  if (groupId) return isGroupMember(groupId);
  return agent.isPublished === true || agent.linkAccess !== false;
}

/**
 * THE extension access rule. Used for every chat turn and every sub-agent
 * call; nothing else decides which extensions' tools (and secrets) a chat
 * gets.
 *
 * A user may use extension E when one of these holds:
 *   1. owner:     the user owns E;
 *   2. published: E is published (admin-published, visible to everyone);
 *   3. agent:     the chat runs agent A, the user can open A (canOpenAgent),
 *                 A lists E in its CURRENT extensionIds, and A's owner owns E;
 *   4. legacy:    as 3, but E belongs to another user (not A's owner) and is
 *                 not published. Agents saved before this rule can list such
 *                 an extension; they keep it for now. A save cannot add a new
 *                 one (extensionIdsForAgentSave in extension-runtime.ts), so
 *                 only attachments that already exist are granted this way.
 *
 * Rule 3 is "access to an agent implies access to its extensions". It runs
 * with the agent's authority, so it only covers extensions the agent's owner
 * owns: an agent cannot grant an extension its owner could not use (except
 * the temporary rule 4 for attachments that already exist). It reads
 * the agent's current list, so an extension removed from the agent stops
 * working in old threads too.
 *
 * Granting use never grants management: edit, delete and secrets stay with
 * the extension owner (EnsureExtensionOperation).
 *
 * Every other id is denied: deleted extensions ("not-found") and extensions
 * a user put on their own thread by id ("no-access").
 */
export async function decideExtensionAccess<
  E extends { id: string; userId: string; isPublished: boolean },
>(input: ExtensionAccessInput<E>): Promise<ExtensionAccessDecision<E>> {
  const byId = new Map(input.extensions.map((e) => [e.id, e]));
  const decision: ExtensionAccessDecision<E> = { granted: [], denied: [] };

  let agentOpen: boolean | undefined;
  const agentGrant = async (extension: E): Promise<"agent" | "legacy" | undefined> => {
    const agent = input.agent;
    if (!agent) return undefined;
    if (!(agent.extensionIds ?? []).includes(extension.id)) return undefined;
    agentOpen ??= await canOpenAgent(agent, input.userId, input.isGroupMember);
    if (!agentOpen) return undefined;
    if (extension.userId === agent.userId) return "agent";
    // TODO: remove rule 4 ("legacy") after the existing agents are migrated
    // (the owners re-attach their own extension, or an admin publishes it).
    // Until then an extension of another user that an agent already lists
    // stays usable for everyone who can open the agent, as before the rule.
    return "legacy";
  };

  for (const id of new Set(input.extensionIds)) {
    const extension = byId.get(id);
    if (!extension) {
      decision.denied.push({ id, reason: "not-found" });
    } else if (extension.userId === input.userId) {
      decision.granted.push({ extension, grant: "owner" });
    } else if (extension.isPublished) {
      decision.granted.push({ extension, grant: "published" });
    } else {
      const grant = await agentGrant(extension);
      if (grant) decision.granted.push({ extension, grant });
      else decision.denied.push({ id, reason: "no-access" });
    }
  }
  return decision;
}

/** Extensions by id, WITHOUT an access filter. Callers must apply decideExtensionAccess. */
export async function findExtensionsByIdsUnchecked(ids: readonly string[]): Promise<ExtensionModel[]> {
  if (ids.length === 0) return [];
  const querySpec: SqlQuerySpec = {
    query: "SELECT * FROM root r WHERE r.type=@type AND ARRAY_CONTAINS(@ids, r.id)",
    parameters: [
      { name: "@type", value: EXTENSION_ATTRIBUTE },
      { name: "@ids", value: [...ids] },
    ],
  };
  const { resources } = await HistoryContainer().items.query<ExtensionModel>(querySpec).fetchAll();
  return resources;
}

/** One agent by id, WITHOUT an access filter. Callers must apply canOpenAgent. */
export async function findAgentUnchecked(id: string): Promise<AgentForAccess | null> {
  const querySpec: SqlQuerySpec = {
    query:
      "SELECT r.id, r.userId, r.isPublished, r.linkAccess, r.accessGroup, r.extensionIds FROM root r WHERE r.type=@type AND r.id=@id",
    parameters: [
      { name: "@type", value: PERSONA_ATTRIBUTE },
      { name: "@id", value: id },
    ],
  };
  const { resources } = await HistoryContainer().items.query<AgentForAccess>(querySpec).fetchAll();
  return resources[0] ?? null;
}
