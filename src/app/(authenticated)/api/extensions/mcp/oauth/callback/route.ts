/**
 * OAuth redirect target for Remote MCP extensions.
 *
 * The owner starts the sign-in with StartMcpOAuth; the authorization server
 * sends the browser back here with `code` and `state`. The sign-in is
 * accepted only when the state matches the pending record (constant-time),
 * the same signed-in user started it, it is younger than ten minutes, and
 * that user still owns the extension. Tokens go to Key Vault; the browser
 * only gets a redirect to /extensions.
 */

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { userHashedId } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { logInfo, logWarn } from "@/features/common/services/logger";
import { findExtensionsByIdsUnchecked } from "@/features/extensions-page/extension-services/extension-access";
import { mcpOAuthRedirectUrl } from "@/features/extensions-page/extension-services/extension-runtime";
import {
  keyVaultSecretStore,
  mcpOAuthSecretNames,
} from "@/features/extensions-page/extension-services/extension-secrets";
import { MCP_LIMITS } from "@/features/extensions-page/extension-services/mcp/mcp-client";
import { discoverMcpTools } from "@/features/extensions-page/extension-services/mcp/mcp-discovery";
import { createGuardedFetch } from "@/features/extensions-page/extension-services/mcp/mcp-fetch";
import {
  extensionIdFromMcpOAuthState,
  isPendingMcpOAuthValid,
  KeyVaultMcpOAuthProvider,
  readPendingMcpOAuth,
} from "@/features/extensions-page/extension-services/mcp/mcp-oauth";
import type { ExtensionModel } from "@/features/extensions-page/extension-services/models";

const backToExtensions = (req: Request, result: "connected" | "failed") => {
  const url = new URL("/extensions", process.env.NEXTAUTH_URL ?? req.url);
  url.searchParams.set("mcp", result);
  return Response.redirect(url.toString(), 303);
};

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const code = params.get("code");
  const state = params.get("state") ?? "";
  const extensionId = extensionIdFromMcpOAuthState(state);

  if (!code || !extensionId || params.get("error")) {
    logWarn("MCP OAuth callback: missing code or state, or provider error", {
      providerError: params.get("error") ?? undefined,
    });
    return backToExtensions(req, "failed");
  }

  try {
    const userId = await userHashedId();
    const [extension] = await findExtensionsByIdsUnchecked([extensionId]);
    if (!extension || extension.userId !== userId || extension.mcp?.auth !== "oauth") {
      return backToExtensions(req, "failed");
    }

    const store = keyVaultSecretStore();
    const names = mcpOAuthSecretNames(extension.id);
    const pending = await readPendingMcpOAuth(store, extension.id);
    if (!isPendingMcpOAuthValid(pending, { state, userId })) {
      logWarn("MCP OAuth callback: state does not match a pending sign-in", { extensionId });
      return backToExtensions(req, "failed");
    }
    // One use only.
    await store.set(names.pending, "null");

    const clientSecret = extension.mcp.oauth?.clientSecret
      ? await store.get(names.clientSecret)
      : undefined;
    const provider = new KeyVaultMcpOAuthProvider({
      extensionId: extension.id,
      clientId: extension.mcp.oauth?.clientId || undefined,
      clientSecret,
      scopes: extension.mcp.oauth?.scopes || undefined,
      redirectUrl: mcpOAuthRedirectUrl(),
      store,
    });
    // codeVerifier() reads the pending record we just cleared: hand it over.
    provider.codeVerifier = async () => pending!.codeVerifier!;

    const result = await auth(provider, {
      serverUrl: extension.mcp.url,
      authorizationCode: code,
      scope: extension.mcp.oauth?.scopes || undefined,
      fetchFn: createGuardedFetch({
        timeoutMs: MCP_LIMITS.connectTimeoutMs,
        maxResponseBytes: MCP_LIMITS.maxResponseBytes,
      }),
    });
    if (result !== "AUTHORIZED") return backToExtensions(req, "failed");

    let updated: ExtensionModel = {
      ...extension,
      mcp: {
        ...extension.mcp,
        oauth: { ...extension.mcp.oauth, connected: true, connectedAt: new Date() },
      },
    };
    const discovery = await discoverMcpTools(updated, store);
    if (discovery.ok) {
      updated = {
        ...updated,
        mcp: { ...updated.mcp!, tools: discovery.tools, toolsDiscoveredAt: new Date() },
      };
    }
    await HistoryContainer().items.upsert<ExtensionModel>(updated);
    logInfo("MCP OAuth callback: connected", { extensionId, toolsDiscovered: discovery.ok });
    return backToExtensions(req, "connected");
  } catch (error) {
    logWarn("MCP OAuth callback failed", {
      extensionId,
      errorName: (error as { name?: string })?.name,
    });
    return backToExtensions(req, "failed");
  }
}
