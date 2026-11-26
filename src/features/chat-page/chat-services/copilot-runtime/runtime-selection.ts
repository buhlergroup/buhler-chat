import "server-only";

import { getCurrentUser, hashValue } from "@/features/auth-page/helpers";
import { getGraphClient } from "@/features/common/services/microsoft-graph-client";
import { logError } from "@/features/common/services/logger";
import { getAgentRuntime, type AgentRuntime } from "./runtime-flag";
import { isInUserList } from "./runtime-users";

/**
 * Which agent runtime serves the current user.
 *
 *   AGENT_RUNTIME=copilot        everybody (global default)
 *   COPILOT_RUNTIME_USERS        comma list of user e-mail addresses or hashed
 *                                user ids that get the Copilot path
 *   COPILOT_RUNTIME_GROUP_ID     Entra group whose members get the Copilot path,
 *                                checked with Graph /me/checkMemberGroups like
 *                                AGENT_VERIFIER_GROUP_ID (security groups and
 *                                transitive membership included)
 *
 * Fails closed: an unset list, a missing token or a Graph error keeps the
 * user on the AI SDK path. The group answer is cached per user for a few
 * minutes so a chat turn does not pay a Graph call each time.
 */
const GROUP_CACHE_MS = 5 * 60 * 1000;
const groupCache = new Map<string, { member: boolean; until: number }>();

async function isGroupMember(groupId: string, cacheKey: string, token: string): Promise<boolean> {
  const cached = groupCache.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached.member;
  try {
    const result = await getGraphClient(token).api("/me/checkMemberGroups").post({ groupIds: [groupId] });
    const member = Array.isArray(result?.value) && result.value.includes(groupId);
    groupCache.set(cacheKey, { member, until: Date.now() + GROUP_CACHE_MS });
    return member;
  } catch (error) {
    logError("copilot-runtime: checkMemberGroups failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function resolveAgentRuntimeForCurrentUser(
  env: Record<string, string | undefined> = process.env,
): Promise<AgentRuntime> {
  if (getAgentRuntime(env) === "copilot") return "copilot";
  const list = env.COPILOT_RUNTIME_USERS?.trim();
  const groupId = env.COPILOT_RUNTIME_GROUP_ID?.trim();
  if (!list && !groupId) return "ai-sdk";

  const user = await getCurrentUser();
  const hashedId = hashValue(user.email);
  if (list && isInUserList(list, { email: user.email, hashedId })) return "copilot";
  if (groupId && user.token && !user.isLocalDevUser) {
    if (await isGroupMember(groupId, hashedId, user.token)) return "copilot";
  }
  return "ai-sdk";
}
