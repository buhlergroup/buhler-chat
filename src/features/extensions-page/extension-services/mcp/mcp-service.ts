"use server";
import "server-only";

// Server actions for Remote MCP extensions. Every export is an async
// function; nothing is re-exported. Tool discovery: owner or admin; draft
// discovery (form values, not saved): any signed-in user, saved values only
// for whoever may edit the extension. Sign-in,
// disconnect and connection status: every user for THEIR OWN connection,
// as far as the access rule lets them use the extension.

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { getCurrentUser, userHashedId } from "@/features/auth-page/helpers";
import type { ServerActionResponse } from "@/features/common/server-action-response";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { logWarn } from "@/features/common/services/logger";
import { EnsureExtensionOperation } from "../extension-service";
import { findUsableExtension, mcpOAuthRedirectUrl } from "../extension-runtime";
import {
  keyVaultSecretStore,
  MCP_EXTENSION_TAG,
  mcpOAuthSecretNames,
  mcpOAuthUserSecretNames,
} from "../extension-secrets";
import type { ExtensionModel, McpToolInfo } from "../models";
import { mcpSignInNotice, type McpSignInNotice } from "../extension-credentials";
import { MCP_LIMITS } from "./mcp-client";
import { discoverMcpTools } from "./mcp-discovery";
import { discoverDraftMcpTools, type McpDraftInput } from "./mcp-draft-discovery";
import { createGuardedFetch } from "./mcp-fetch";
import {
  createMcpOAuthState,
  hasMcpUserTokens,
  KeyVaultMcpOAuthProvider,
  safeReturnPath,
} from "./mcp-oauth";

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
 * Reads the tool list for the connection as typed in the form, before (or
 * without) a save. Sign-in None only. Stores nothing. Header rows that show
 * the saved mask use the value stored for that row of the extension being
 * edited, only for a user who may edit it (owner or admin, the edit check).
 * Same URL guard, guarded fetch and header rules as save and runtime; see
 * discoverDraftMcpTools. Returns names, descriptions and input schemas only.
 */
export async function DiscoverDraftMcpTools(
  input: McpDraftInput
): Promise<ServerActionResponse<McpToolInfo[]>> {
  try {
    // Signed-in users only (getCurrentUser throws without a session).
    const user = await getCurrentUser().catch(() => undefined);
    if (!user) return { status: "UNAUTHORIZED", errors: [{ message: "Sign in to load the tools." }] };
    return await discoverDraftMcpTools(input, {
      loadEditable: async (extensionId) => {
        const response = await EnsureExtensionOperation(extensionId);
        return response.status === "OK" ? response.response : undefined;
      },
      store: keyVaultSecretStore(),
    });
  } catch (error) {
    // No input in the log: it holds header values.
    logWarn("DiscoverDraftMcpTools failed", { errorName: (error as { name?: string })?.name });
    return { status: "ERROR", errors: [{ message: "Could not read the tools of the MCP server." }] };
  }
}

/**
 * Starts the OAuth sign-in of the CURRENT user for an MCP server
 * (authorization code + PKCE; dynamic client registration when no client id
 * is set). Each user signs in with their own account. Allowed for every user
 * who may use the extension under the access rule (owner, published, or
 * through `personaId`); ownership is not required. Returns the URL the
 * browser opens; the callback route finishes the sign-in and re-checks
 * access. For an extension the user does not own, `notice` names the host of
 * the sign-in page and of the MCP server, for the browser to show first.
 */
export async function StartMcpOAuth(
  extensionId: string,
  options: { personaId?: string; returnTo?: string } = {}
): Promise<ServerActionResponse<{ authorizationUrl?: string; connected: boolean; notice?: McpSignInNotice }>> {
  try {
    const userId = await userHashedId();
    const personaId = typeof options.personaId === "string" ? options.personaId : undefined;
    const extension = await findUsableExtension({ extensionId, personaId, userId });
    if (!extension || extension.kind !== "mcp" || !extension.mcp) {
      return { status: "NOT_FOUND", errors: [{ message: "Extension not found." }] };
    }
    if (extension.mcp.auth !== "oauth") {
      return { status: "ERROR", errors: [{ message: "This extension does not use a sign-in." }] };
    }

    const store = keyVaultSecretStore();
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
      redirectUrl: mcpOAuthRedirectUrl(),
      store,
      interactive: {
        state: createMcpOAuthState(extension.id),
        personaId,
        returnTo: safeReturnPath(options.returnTo),
      },
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
    const notice = mcpSignInNotice(extension, url, userId);
    return {
      status: "OK",
      response: { authorizationUrl: url.toString(), connected: false, ...(notice ? { notice } : {}) },
    };
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

/** Forgets the CURRENT user's sign-in for this extension. Other users keep theirs. */
export async function DisconnectMcpOAuth(
  extensionId: string
): Promise<ServerActionResponse<{ connected: false }>> {
  try {
    if (typeof extensionId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(extensionId)) {
      return { status: "ERROR", errors: [{ message: "Extension not found." }] };
    }
    const userId = await userHashedId();
    const store = keyVaultSecretStore();
    const names = mcpOAuthUserSecretNames(extensionId, userId);
    const tags = { [MCP_EXTENSION_TAG]: extensionId };
    // Only overwrite a record that exists: no new entries for random ids.
    if (await store.get(names.tokens)) await store.set(names.tokens, "null", tags);
    return { status: "OK", response: { connected: false } };
  } catch (error) {
    logWarn("DisconnectMcpOAuth failed", { extensionId, error: String(error) });
    return { status: "ERROR", errors: [{ message: "Could not disconnect." }] };
  }
}

/**
 * For each extension id: does it use an OAuth sign-in, and is the CURRENT
 * user connected? Only for extensions the user may use (owner, published,
 * or through `personaId`); other ids are left out.
 */
export async function GetMcpConnections(
  extensionIds: string[],
  personaId?: string
): Promise<ServerActionResponse<Array<{ id: string; oauth: boolean; connected: boolean }>>> {
  try {
    const ids = [...new Set((extensionIds ?? []).filter((id) => typeof id === "string"))].slice(0, 50);
    const userId = await userHashedId();
    const store = keyVaultSecretStore();
    const result: Array<{ id: string; oauth: boolean; connected: boolean }> = [];
    for (const id of ids) {
      const extension = await findUsableExtension({ extensionId: id, personaId, userId });
      if (!extension || extension.kind !== "mcp" || !extension.mcp) continue;
      const oauth = extension.mcp.auth === "oauth";
      result.push({
        id,
        oauth,
        connected: oauth && (await hasMcpUserTokens(store, id, extension.mcp.url, userId)),
      });
    }
    return { status: "OK", response: result };
  } catch (error) {
    logWarn("GetMcpConnections failed", { error: String(error) });
    return { status: "ERROR", errors: [{ message: "Could not read the connections." }] };
  }
}
