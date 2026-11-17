"use server";
import "server-only";

// Server actions for Remote MCP extensions. Every export is an async
// function; nothing is re-exported. Only the extension owner (and, for
// tool discovery, an admin) passes; access through a shared agent does not.

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { userHashedId } from "@/features/auth-page/helpers";
import type { ServerActionResponse } from "@/features/common/server-action-response";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { logWarn } from "@/features/common/services/logger";
import { EnsureExtensionOperation } from "../extension-service";
import { mcpOAuthRedirectUrl } from "../extension-runtime";
import { keyVaultSecretStore, mcpOAuthSecretNames } from "../extension-secrets";
import type { ExtensionModel } from "../models";
import { MCP_LIMITS } from "./mcp-client";
import { discoverMcpTools } from "./mcp-discovery";
import { createGuardedFetch } from "./mcp-fetch";
import { createMcpOAuthState, KeyVaultMcpOAuthProvider } from "./mcp-oauth";

const unauthorized = (): ServerActionResponse<never> => ({
  status: "UNAUTHORIZED",
  errors: [{ message: "Only the extension owner can do this." }],
});

const loadOwnMcpExtension = async (
  extensionId: string,
  { allowAdmin }: { allowAdmin: boolean }
): Promise<ServerActionResponse<ExtensionModel>> => {
  const response = await EnsureExtensionOperation(extensionId);
  if (response.status !== "OK") return response;
  if (response.response.kind !== "mcp" || !response.response.mcp) {
    return { status: "ERROR", errors: [{ message: "This extension is not a Remote MCP server." }] };
  }
  if (!allowAdmin && response.response.userId !== (await userHashedId())) {
    return unauthorized();
  }
  return response;
};

/** Reads the tool list from the server now and stores it on the extension. */
export async function DiscoverMcpTools(
  extensionId: string
): Promise<ServerActionResponse<ExtensionModel>> {
  try {
    const loaded = await loadOwnMcpExtension(extensionId, { allowAdmin: true });
    if (loaded.status !== "OK") return loaded;
    const extension = loaded.response;

    const result = await discoverMcpTools(extension, keyVaultSecretStore());
    if (!result.ok) return { status: "ERROR", errors: [{ message: result.error }] };

    const updated: ExtensionModel = {
      ...extension,
      mcp: { ...extension.mcp!, tools: result.tools, toolsDiscoveredAt: new Date() },
    };
    const { resource } = await HistoryContainer().items.upsert<ExtensionModel>(updated);
    return { status: "OK", response: resource ?? updated };
  } catch (error) {
    logWarn("DiscoverMcpTools failed", { extensionId, error: String(error) });
    return { status: "ERROR", errors: [{ message: "Could not read the tools of the MCP server." }] };
  }
}

/**
 * Starts the OAuth sign-in for an MCP server (authorization code + PKCE,
 * dynamic client registration when no client id is set). Returns the URL
 * the browser opens; the callback route finishes the sign-in. Owner only:
 * the tokens are the owner's, and every user of the extension (also through
 * shared agents) calls the server with them.
 */
export async function StartMcpOAuth(
  extensionId: string
): Promise<ServerActionResponse<{ authorizationUrl?: string; connected: boolean }>> {
  try {
    const loaded = await loadOwnMcpExtension(extensionId, { allowAdmin: false });
    if (loaded.status !== "OK") return loaded;
    const extension = loaded.response;
    if (extension.mcp?.auth !== "oauth") {
      return { status: "ERROR", errors: [{ message: "Turn on OAuth sign-in for this extension first." }] };
    }

    const store = keyVaultSecretStore();
    const clientSecret = extension.mcp.oauth?.clientSecret
      ? await store.get(mcpOAuthSecretNames(extension.id).clientSecret)
      : undefined;
    const provider = new KeyVaultMcpOAuthProvider({
      extensionId: extension.id,
      clientId: extension.mcp.oauth?.clientId || undefined,
      clientSecret,
      scopes: extension.mcp.oauth?.scopes || undefined,
      redirectUrl: mcpOAuthRedirectUrl(),
      store,
      interactive: { userId: await userHashedId(), state: createMcpOAuthState(extension.id) },
    });

    const result = await auth(provider, {
      serverUrl: extension.mcp.url,
      scope: extension.mcp.oauth?.scopes || undefined,
      fetchFn: createGuardedFetch({
        timeoutMs: MCP_LIMITS.connectTimeoutMs,
        maxResponseBytes: MCP_LIMITS.maxResponseBytes,
      }),
    });

    if (result === "AUTHORIZED") {
      return { status: "OK", response: { connected: true } };
    }
    const url = provider.capturedAuthorizationUrl;
    if (!url) {
      return { status: "ERROR", errors: [{ message: "The MCP server did not return a sign-in page." }] };
    }
    return { status: "OK", response: { authorizationUrl: url.toString(), connected: false } };
  } catch (error) {
    logWarn("StartMcpOAuth failed", {
      extensionId,
      errorName: (error as { name?: string })?.name,
    });
    return {
      status: "ERROR",
      errors: [{ message: "Could not start the sign-in. Check the server URL and the OAuth settings." }],
    };
  }
}

/** Forgets the stored tokens; the extension stops working until the owner connects again. */
export async function DisconnectMcpOAuth(
  extensionId: string
): Promise<ServerActionResponse<ExtensionModel>> {
  try {
    const loaded = await loadOwnMcpExtension(extensionId, { allowAdmin: false });
    if (loaded.status !== "OK") return loaded;
    const extension = loaded.response;
    const store = keyVaultSecretStore();
    const names = mcpOAuthSecretNames(extension.id);
    await store.set(names.tokens, "null");

    const updated: ExtensionModel = {
      ...extension,
      mcp: {
        ...extension.mcp!,
        oauth: { ...extension.mcp!.oauth, connected: false, connectedAt: undefined },
      },
    };
    const { resource } = await HistoryContainer().items.upsert<ExtensionModel>(updated);
    return { status: "OK", response: resource ?? updated };
  } catch (error) {
    logWarn("DisconnectMcpOAuth failed", { extensionId, error: String(error) });
    return { status: "ERROR", errors: [{ message: "Could not disconnect." }] };
  }
}
