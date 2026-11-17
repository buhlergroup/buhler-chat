import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { mcpOAuthSecretNames, type SecretStore } from "../extension-secrets";

/** How long a started sign-in stays valid. */
export const MCP_OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

export const MCP_OAUTH_CALLBACK_PATH = "/api/extensions/mcp/oauth/callback";

export class McpOAuthRequiredError extends Error {
  constructor() {
    super("The MCP server needs a sign-in. The extension owner must connect it again.");
    this.name = "McpOAuthRequiredError";
  }
}

/** Sign-in started by the owner, kept until the callback arrives. */
export interface PendingMcpOAuth {
  state: string;
  codeVerifier?: string;
  userId: string;
  createdAt: number;
}

export interface McpOAuthProviderOptions {
  extensionId: string;
  /** Pre-registered client (owner-provided); otherwise dynamic client registration. */
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  redirectUrl: string;
  store: SecretStore;
  /**
   * interactive: the owner is starting a sign-in; the authorization URL is
   * captured instead of opened. Non-interactive (chat time): a missing or
   * expired token that cannot be refreshed fails with McpOAuthRequiredError.
   */
  interactive?: { userId: string; state: string };
}

const parseJson = <T>(raw: string | undefined): T | undefined => {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as T | null;
    return value ?? undefined;
  } catch {
    return undefined;
  }
};

/** Opaque, unguessable state that also tells the callback which extension it belongs to. */
export const createMcpOAuthState = (extensionId: string): string =>
  `${extensionId}.${randomBytes(24).toString("hex")}`;

export const extensionIdFromMcpOAuthState = (state: string): string | undefined => {
  const match = state.match(/^([A-Za-z0-9]{1,64})\.[0-9a-f]{48}$/);
  return match?.[1];
};

export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * OAuth client provider for one Remote MCP extension, backed by Key Vault.
 *
 * The connection belongs to the extension, i.e. to its owner: every user who
 * may use the extension (directly, or through an agent they can open) calls
 * the MCP server with the owner's tokens. Tokens, the registered client and
 * the pending PKCE verifier are stored as Key Vault secrets and never reach
 * the browser.
 *
 * Key Vault keeps deleted names reserved (soft delete), so these records are
 * overwritten with "null" instead of deleted while the extension exists.
 */
export class KeyVaultMcpOAuthProvider implements OAuthClientProvider {
  private readonly names: ReturnType<typeof mcpOAuthSecretNames>;
  private authorizationUrl: URL | undefined;

  constructor(private readonly options: McpOAuthProviderOptions) {
    this.names = mcpOAuthSecretNames(options.extensionId);
  }

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Bühler Chat",
      redirect_uris: [this.options.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.options.scopes ? { scope: this.options.scopes } : {}),
    };
  }

  /** The authorization URL captured by an interactive sign-in. */
  get capturedAuthorizationUrl(): URL | undefined {
    return this.authorizationUrl;
  }

  state(): string {
    if (!this.options.interactive) throw new McpOAuthRequiredError();
    return this.options.interactive.state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.options.clientId) {
      return {
        client_id: this.options.clientId,
        ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}),
      };
    }
    return parseJson<OAuthClientInformationMixed>(await this.options.store.get(this.names.client));
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    if (this.options.clientId) return;
    await this.options.store.set(this.names.client, JSON.stringify(info));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return parseJson<OAuthTokens>(await this.options.store.get(this.names.tokens));
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.options.store.set(this.names.tokens, JSON.stringify(tokens));
  }

  redirectToAuthorization(url: URL): void {
    if (!this.options.interactive) throw new McpOAuthRequiredError();
    if (url.protocol !== "https:") {
      throw new Error("The authorization server must use https");
    }
    this.authorizationUrl = url;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (!this.options.interactive) throw new McpOAuthRequiredError();
    const pending: PendingMcpOAuth = {
      state: this.options.interactive.state,
      codeVerifier,
      userId: this.options.interactive.userId,
      createdAt: Date.now(),
    };
    await this.options.store.set(this.names.pending, JSON.stringify(pending));
  }

  async codeVerifier(): Promise<string> {
    const pending = await readPendingMcpOAuth(this.options.store, this.options.extensionId);
    if (!pending?.codeVerifier) throw new McpOAuthRequiredError();
    return pending.codeVerifier;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery"
  ): Promise<void> {
    if (scope === "all" || scope === "tokens") {
      await this.options.store.set(this.names.tokens, "null");
    }
    if ((scope === "all" || scope === "client") && !this.options.clientId) {
      await this.options.store.set(this.names.client, "null");
    }
    if (scope === "all" || scope === "verifier") {
      await this.options.store.set(this.names.pending, "null");
    }
  }
}

export async function readPendingMcpOAuth(
  store: SecretStore,
  extensionId: string
): Promise<PendingMcpOAuth | undefined> {
  return parseJson<PendingMcpOAuth>(await store.get(mcpOAuthSecretNames(extensionId).pending));
}

/**
 * Checks a callback against the pending sign-in: same state (constant-time),
 * same user who started it, not older than the TTL.
 */
export function isPendingMcpOAuthValid(
  pending: PendingMcpOAuth | undefined,
  input: { state: string; userId: string; now?: number }
): boolean {
  if (!pending || !pending.codeVerifier) return false;
  if (!safeEqual(pending.state, input.state)) return false;
  if (pending.userId !== input.userId) return false;
  const age = (input.now ?? Date.now()) - pending.createdAt;
  return age >= 0 && age <= MCP_OAUTH_PENDING_TTL_MS;
}
