import "server-only";

// Notices about whose credentials an extension uses. Computed on the server;
// only booleans and host names go to the browser, never a secret value, a
// secret name or a header.

import { extensionKind, type ExtensionModel } from "./models";

/** What the browser may learn about an extension's credentials. */
export interface ExtensionCredentialInfo {
  id: string;
  /**
   * The extension sends stored secret values (HTTP headers or MCP header
   * rows) that its owner entered. Everyone who uses it, for example through
   * a shared agent, calls the service with those credentials.
   */
  usesStoredSecrets: boolean;
  /** The current user owns the extension (the stored secrets are theirs). */
  ownedByYou: boolean;
}

/** True when the extension sends secret values stored by its owner. */
export function usesStoredSecrets(extension: ExtensionModel): boolean {
  if (extensionKind(extension) === "mcp") return (extension.mcp?.secrets?.length ?? 0) > 0;
  return (extension.headers?.length ?? 0) > 0;
}

export function extensionCredentialInfo(extension: ExtensionModel, userId: string): ExtensionCredentialInfo {
  return {
    id: extension.id,
    usesStoredSecrets: usesStoredSecrets(extension),
    ownedByYou: extension.userId === userId,
  };
}

/** Host (with a non-default port) of a URL, or undefined. */
export function hostOf(url: string | URL): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** Shown before a user signs in to an MCP extension that somebody else set up. */
export interface McpSignInNotice {
  /** Host of the sign-in page (the authorization server). */
  signInHost: string;
  /** Host of the MCP server that receives the user's access. */
  serverHost: string;
}

/**
 * The notice for a sign-in to an extension the current user does not own;
 * undefined for the owner (who set up the extension).
 */
export function mcpSignInNotice(
  extension: ExtensionModel,
  authorizationUrl: URL,
  userId: string
): McpSignInNotice | undefined {
  if (extension.userId === userId) return undefined;
  const signInHost = hostOf(authorizationUrl);
  const serverHost = extension.mcp ? hostOf(extension.mcp.url) : undefined;
  if (!signInHost || !serverHost) return undefined;
  return { signInHost, serverHost };
}
