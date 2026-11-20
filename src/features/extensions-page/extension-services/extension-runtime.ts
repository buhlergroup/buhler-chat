import "server-only";

// No "use server": returns secret values for the tool layer.

import { userHashedId } from "@/features/auth-page/helpers";
import { logInfo, logWarn } from "@/features/common/services/logger";
import { AccessGroupById } from "@/features/persona-page/persona-services/access-group-service";
import {
  decideExtensionAccess,
  findAgentUnchecked,
  findExtensionsByIdsUnchecked,
  type AgentForAccess,
} from "./extension-access";
import { keyVaultSecretStore, mcpOAuthSecretNames, type SecretStore } from "./extension-secrets";
import type { McpConnectionOptions } from "./mcp/mcp-client";
import { KeyVaultMcpOAuthProvider, MCP_OAUTH_CALLBACK_PATH } from "./mcp/mcp-oauth";
import { applyMcpSecrets, type ResolvedMcpSecret } from "./mcp/mcp-secrets";
import { extensionKind, type ExtensionModel } from "./models";

export interface ResolvedExtension {
  extension: ExtensionModel;
  headerSecrets: Record<string, string>;
  mcp?: McpConnectionOptions;
  /** The agent that granted access, for the per-user "Connect" action. */
  personaId?: string;
}

export interface ResolveExtensionsDeps {
  userId: () => Promise<string>;
  findExtensions: (ids: readonly string[]) => Promise<ExtensionModel[]>;
  findAgent: (id: string) => Promise<AgentForAccess | null>;
  isGroupMember: (groupId: string) => Promise<boolean>;
  store: () => SecretStore;
}

const defaultDeps: ResolveExtensionsDeps = {
  userId: userHashedId,
  findExtensions: findExtensionsByIdsUnchecked,
  findAgent: findAgentUnchecked,
  isGroupMember: async (groupId) => (await AccessGroupById(groupId)).status === "OK",
  store: keyVaultSecretStore,
};

/** The OAuth redirect URL registered with MCP authorization servers. */
export function mcpOAuthRedirectUrl(): string {
  const base = process.env.NEXTAUTH_URL;
  if (!base) throw new Error("NEXTAUTH_URL is not set; MCP sign-in needs it for the redirect URL");
  return new URL(MCP_OAUTH_CALLBACK_PATH, base).toString();
}

/**
 * Connection options for a Remote MCP extension: secrets read from Key Vault
 * and placed as configured (owner-level, shared), plus the OAuth provider
 * for `oauthUserId` when the server uses OAuth (per user: the chatting user,
 * or the owner for the save-time tool list). A secret that cannot be read is
 * left out (logged by id only).
 */
export async function buildMcpConnection(
  extension: ExtensionModel,
  store: SecretStore,
  oauthUserId: string
): Promise<McpConnectionOptions | undefined> {
  const config = extension.mcp;
  if (!config) return undefined;

  const secrets: ResolvedMcpSecret[] = [];
  for (const secret of config.secrets) {
    const value = await store.get(secret.id).catch(() => undefined);
    if (value) {
      secrets.push({ name: secret.name, placement: secret.placement, target: secret.target, value });
    } else {
      logWarn("buildMcpConnection: secret not readable", { extensionId: extension.id, secretId: secret.id });
    }
  }
  const { url, headers } = applyMcpSecrets(config.url, secrets);

  let authProvider: KeyVaultMcpOAuthProvider | undefined;
  if (config.auth === "oauth") {
    const clientSecret = config.oauth?.clientSecret
      ? await store.get(mcpOAuthSecretNames(extension.id).clientSecret).catch(() => undefined)
      : undefined;
    authProvider = new KeyVaultMcpOAuthProvider({
      extensionId: extension.id,
      serverUrl: config.url,
      userId: oauthUserId,
      clientId: config.oauth?.clientId || undefined,
      clientSecret,
      scopes: config.oauth?.scopes || undefined,
      redirectUrl: mcpOAuthRedirectUrl(),
      store,
    });
  }

  return { url, transport: config.transport, headers, authProvider };
}

/**
 * Resolves the extensions a chat turn (or a sub-agent call) may use, with
 * their secrets. Access is decided ONLY by decideExtensionAccess:
 * owner, published, or granted through the agent the chat runs (rules 3 and
 * 4, "legacy"). Each legacy use is logged with the agent and extension id.
 */
export async function resolveExtensionsForChat(
  input: { extensionIds: readonly string[]; personaId?: string },
  deps: ResolveExtensionsDeps = defaultDeps
): Promise<ResolvedExtension[]> {
  if (input.extensionIds.length === 0) return [];

  const [userId, extensions, agent] = await Promise.all([
    deps.userId(),
    deps.findExtensions(input.extensionIds),
    input.personaId ? deps.findAgent(input.personaId) : Promise.resolve(null),
  ]);

  const decision = await decideExtensionAccess({
    extensionIds: input.extensionIds,
    extensions,
    agent,
    userId,
    isGroupMember: deps.isGroupMember,
  });

  if (decision.denied.length > 0) {
    logInfo("resolveExtensionsForChat: extensions left out", {
      personaId: input.personaId,
      denied: decision.denied,
    });
  }

  for (const { extension, grant } of decision.granted) {
    if (grant === "legacy") {
      // TODO: remove with rule 4 in decideExtensionAccess.
      logInfo("resolveExtensionsForChat: legacy foreign extension on agent", {
        personaId: input.personaId,
        extensionId: extension.id,
      });
    }
  }

  const store = deps.store();
  const resolved: ResolvedExtension[] = [];
  for (const { extension } of decision.granted) {
    if (extensionKind(extension) === "mcp") {
      resolved.push({
        extension,
        headerSecrets: {},
        mcp: await buildMcpConnection(extension, store, userId),
        personaId: input.personaId,
      });
      continue;
    }
    const headerSecrets: Record<string, string> = {};
    for (const h of extension.headers) {
      const value = await store.get(h.id).catch(() => undefined);
      if (value) headerSecrets[h.key] = value;
      else logWarn("resolveExtensionsForChat: failed to resolve extension header", { headerId: h.id });
    }
    resolved.push({ extension, headerSecrets });
  }
  return resolved;
}

/**
 * The extension if the current user may USE it under the access rule (owner,
 * published, or through the given agent). Used before a per-user OAuth
 * sign-in starts and again when its callback arrives.
 */
export async function findUsableExtension(
  input: { extensionId: string; personaId?: string; userId: string },
  deps: Pick<ResolveExtensionsDeps, "findExtensions" | "findAgent" | "isGroupMember"> = defaultDeps
): Promise<ExtensionModel | undefined> {
  const [extensions, agent] = await Promise.all([
    deps.findExtensions([input.extensionId]),
    input.personaId ? deps.findAgent(input.personaId) : Promise.resolve(null),
  ]);
  const decision = await decideExtensionAccess({
    extensionIds: [input.extensionId],
    extensions,
    agent,
    userId: input.userId,
    isGroupMember: deps.isGroupMember,
  });
  return decision.granted[0]?.extension;
}

/**
 * The extension ids of an agent that `userId` may use in a chat with that
 * agent, in the agent's order: decideExtensionAccess with the agent as the
 * granting agent (owner, published, rule 3 "the agent's owner owns it", or
 * rule 4 "legacy": already on the stored agent).
 * CreatePersonaChat stores only these ids on the new thread, so a thread
 * never carries an extension id the chatting user may not use.
 */
export async function usableExtensionIdsForAgent(
  agent: AgentForAccess,
  userId: string,
  deps: Pick<ResolveExtensionsDeps, "findExtensions" | "isGroupMember"> = defaultDeps
): Promise<string[]> {
  const extensionIds = agent.extensionIds ?? [];
  if (extensionIds.length === 0) return [];
  const decision = await decideExtensionAccess({
    extensionIds,
    extensions: await deps.findExtensions(extensionIds),
    agent,
    userId,
    isGroupMember: deps.isGroupMember,
  });
  if (decision.denied.length > 0) {
    logInfo("usableExtensionIdsForAgent: agent extensions left out", {
      personaId: agent.id,
      denied: decision.denied,
    });
  }
  return decision.granted.map(({ extension }) => extension.id);
}

/**
 * The extension ids an agent save stores (CreatePersona, UpsertPersona), in
 * the requested order.
 *
 * - An id that is already on the stored agent is kept as it is, also an
 *   extension of another user (rule 4 "legacy" in decideExtensionAccess), so
 *   editing an existing agent does not drop it.
 * - A NEW id is kept only when the extension exists and passes the strict
 *   rule for this agent: it is published, or the agent's owner owns it. Any
 *   other new id is refused (left out and logged by id), so a save cannot
 *   create a new legacy attachment. A new agent has no stored ids.
 *
 * `agentOwnerId` is the agent's owner, not the user who saves: an admin who
 * edits another user's agent cannot attach the admin's own private extension
 * (its secrets would then serve everyone who can open the agent).
 */
export async function extensionIdsForAgentSave(
  input: {
    requestedIds: readonly unknown[] | undefined;
    storedIds: readonly string[] | undefined;
    agentOwnerId: string;
    agentId?: string;
  },
  deps: Pick<ResolveExtensionsDeps, "findExtensions"> = defaultDeps
): Promise<{ kept: string[]; refused: string[] }> {
  const requested = [
    ...new Set((Array.isArray(input.requestedIds) ? input.requestedIds : []).filter(
      (id): id is string => typeof id === "string" && id.length > 0
    )),
  ];
  const stored = new Set(input.storedIds ?? []);
  const newIds = requested.filter((id) => !stored.has(id));

  const allowedNew = new Set<string>();
  if (newIds.length > 0) {
    const extensions = await deps.findExtensions(newIds);
    for (const extension of extensions) {
      if (!newIds.includes(extension.id)) continue;
      if (extension.isPublished || extension.userId === input.agentOwnerId) {
        allowedNew.add(extension.id);
      }
    }
  }

  const kept = requested.filter((id) => stored.has(id) || allowedNew.has(id));
  const refused = newIds.filter((id) => !allowedNew.has(id));
  if (refused.length > 0) {
    logInfo("extensionIdsForAgentSave: new extension ids refused", {
      personaId: input.agentId,
      refused,
    });
  }
  return { kept, refused };
}
