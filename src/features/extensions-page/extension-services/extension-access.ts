import "server-only";

// No "use server": this module decides who may use which extension, and its
// helpers read documents without an access filter. It is imported by server
// code only and must never become a browser-callable action.

import { SqlQuerySpec } from "@azure/cosmos";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { PERSONA_ATTRIBUTE } from "@/features/persona-page/persona-services/models";
import { EXTENSION_ATTRIBUTE, type ExtensionModel } from "./models";

/** Why a user may use an extension. */
export type ExtensionGrant = "owner" | "published" | "agent";

/** The agent (persona) fields the rule reads. */
export interface AgentForAccess {
  id: string;
  userId: string;
  isPublished?: boolean;
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
 * Can `userId` open this agent? Same gate as the agent list and
 * FindPersonaByID: the owner always; a group-shared agent only for members
 * of that group (also when it is published, as in the agent list); any other
 * agent only when it is published to the whole organization.
 */
export async function canOpenAgent(
  agent: AgentForAccess,
  userId: string,
  isGroupMember: (groupId: string) => Promise<boolean>
): Promise<boolean> {
  if (agent.userId === userId) return true;
  const groupId = agent.accessGroup?.id;
  if (groupId) return isGroupMember(groupId);
  return agent.isPublished === true;
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
 *                 A lists E in its CURRENT extensionIds, and A's owner owns E.
 *
 * Rule 3 is "access to an agent implies access to its extensions". It runs
 * with the agent's authority, so it only covers extensions the agent's owner
 * owns: an agent cannot grant an extension its owner could not use. It reads
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
  const agentGrants = async (extension: E): Promise<boolean> => {
    const agent = input.agent;
    if (!agent) return false;
    if (!(agent.extensionIds ?? []).includes(extension.id)) return false;
    if (extension.userId !== agent.userId) return false;
    agentOpen ??= await canOpenAgent(agent, input.userId, input.isGroupMember);
    return agentOpen;
  };

  for (const id of new Set(input.extensionIds)) {
    const extension = byId.get(id);
    if (!extension) {
      decision.denied.push({ id, reason: "not-found" });
    } else if (extension.userId === input.userId) {
      decision.granted.push({ extension, grant: "owner" });
    } else if (extension.isPublished) {
      decision.granted.push({ extension, grant: "published" });
    } else if (await agentGrants(extension)) {
      decision.granted.push({ extension, grant: "agent" });
    } else {
      decision.denied.push({ id, reason: "no-access" });
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
      "SELECT r.id, r.userId, r.isPublished, r.accessGroup, r.extensionIds FROM root r WHERE r.type=@type AND r.id=@id",
    parameters: [
      { name: "@type", value: PERSONA_ATTRIBUTE },
      { name: "@id", value: id },
    ],
  };
  const { resources } = await HistoryContainer().items.query<AgentForAccess>(querySpec).fetchAll();
  return resources[0] ?? null;
}
