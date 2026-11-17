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
 * and placed as configured, plus the OAuth provider when the server uses
 * OAuth. A secret that cannot be read is left out (logged by id only).
 */
export async function buildMcpConnection(
  extension: ExtensionModel,
  store: SecretStore
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
 * owner, published, or granted through the agent the chat runs.
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

  const store = deps.store();
  const resolved: ResolvedExtension[] = [];
  for (const { extension } of decision.granted) {
    if (extensionKind(extension) === "mcp") {
      resolved.push({ extension, headerSecrets: {}, mcp: await buildMcpConnection(extension, store) });
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
