import "server-only";

// No "use server": called only by the OAuth callback route.

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { logInfo, logWarn } from "@/features/common/services/logger";
import { findUsableExtension, mcpOAuthRedirectUrl } from "../extension-runtime";
import {
  keyVaultSecretStore,
  MCP_EXTENSION_TAG,
  mcpOAuthSecretNames,
  mcpOAuthUserSecretNames,
  type SecretStore,
} from "../extension-secrets";
import type { ExtensionModel } from "../models";
import { MCP_LIMITS } from "./mcp-client";
import { discoverMcpTools } from "./mcp-discovery";
import { createGuardedFetch, type McpFetch } from "./mcp-fetch";
import {
  extensionIdFromMcpOAuthState,
  isPendingMcpOAuthValid,
  KeyVaultMcpOAuthProvider,
  readPendingMcpOAuth,
} from "./mcp-oauth";

export interface McpOAuthCallbackDeps {
  store: SecretStore;
  findUsableExtension: typeof findUsableExtension;
  redirectUrl: () => string;
  fetchFn: McpFetch;
  /** Stores the owner's refreshed tool list. */
  refreshOwnerTools: (extension: ExtensionModel, store: SecretStore) => Promise<void>;
  now?: () => number;
}

const defaultDeps = (): McpOAuthCallbackDeps => ({
  store: keyVaultSecretStore(),
  findUsableExtension,
  redirectUrl: mcpOAuthRedirectUrl,
  fetchFn: createGuardedFetch({
    timeoutMs: MCP_LIMITS.connectTimeoutMs,
    maxResponseBytes: MCP_LIMITS.maxResponseBytes,
  }),
  refreshOwnerTools: async (extension, store) => {
    const discovery = await discoverMcpTools(extension, store);
    if (!discovery.ok || !extension.mcp) return;
    await HistoryContainer().items.upsert<ExtensionModel>({
      ...extension,
      mcp: { ...extension.mcp, tools: discovery.tools, toolsDiscoveredAt: new Date() },
    });
  },
});

export type McpOAuthCallbackResult =
  | { ok: true; returnTo?: string }
  | { ok: false; reason: "invalid-request" | "invalid-state" | "no-access" | "not-authorized"; returnTo?: string };

/**
 * Finishes a per-user MCP sign-in. Accepted only when:
 *   - the state matches the pending record of THIS user (constant-time; the
 *     record is stored per extension + user),
 *   - the sign-in is younger than ten minutes,
 *   - the user may still use the extension under the access rule (owner,
 *     published, or through the agent recorded at the start). Ownership is
 *     not required.
 * The tokens are stored for this user only.
 */
export async function completeMcpOAuthCallback(
  input: { code: string | null; state: string; userId: string },
  deps: McpOAuthCallbackDeps = defaultDeps()
): Promise<McpOAuthCallbackResult> {
  const extensionId = extensionIdFromMcpOAuthState(input.state);
  if (!input.code || !extensionId) return { ok: false, reason: "invalid-request" };

  const { store, userId } = { store: deps.store, userId: input.userId };
  const pending = await readPendingMcpOAuth(store, extensionId, userId);
  if (!isPendingMcpOAuthValid(pending, { state: input.state, userId, now: deps.now?.() })) {
    logWarn("MCP OAuth callback: state does not match a pending sign-in of this user", { extensionId });
    return { ok: false, reason: "invalid-state" };
  }
  // One use only.
  await store.set(mcpOAuthUserSecretNames(extensionId, userId).pending, "null", {
    [MCP_EXTENSION_TAG]: extensionId,
  });
  const returnTo = pending!.returnTo;

  const extension = await deps.findUsableExtension({ extensionId, personaId: pending!.personaId, userId });
  if (!extension || extension.kind !== "mcp" || extension.mcp?.auth !== "oauth") {
    logWarn("MCP OAuth callback: user may not use this extension", { extensionId });
    return { ok: false, reason: "no-access", returnTo };
  }

  const clientSecret = extension.mcp.oauth?.clientSecret
    ? await store.get(mcpOAuthSecretNames(extension.id).clientSecret)
    : undefined;
  const provider = new KeyVaultMcpOAuthProvider({
    extensionId: extension.id,
    serverUrl: extension.mcp.url,
    userId,
    clientId: extension.mcp.oauth?.clientId || undefined,
    clientSecret,
    scopes: extension.mcp.oauth?.scopes || undefined,
    redirectUrl: deps.redirectUrl(),
    store,
  });
  // codeVerifier() reads the pending record we just cleared: hand it over.
  provider.codeVerifier = async () => pending!.codeVerifier!;

  const result = await auth(provider, {
    serverUrl: extension.mcp.url,
    authorizationCode: input.code,
    scope: extension.mcp.oauth?.scopes || undefined,
    fetchFn: deps.fetchFn,
  });
  if (result !== "AUTHORIZED") return { ok: false, reason: "not-authorized", returnTo };

  // The stored tool list is the owner's: refresh it when the OWNER connects.
  const isOwner = extension.userId === userId;
  if (isOwner) await deps.refreshOwnerTools(extension, store).catch(() => undefined);
  logInfo("MCP OAuth callback: user connected", { extensionId, owner: isOwner });
  return { ok: true, returnTo };
}
