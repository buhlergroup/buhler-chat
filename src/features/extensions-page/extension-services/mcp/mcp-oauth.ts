import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";
import { AI_NAME } from "@/features/theme/theme-config";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  MCP_EXTENSION_TAG,
  mcpOAuthSecretNames,
  mcpOAuthUserSecretNames,
  type SecretStore,
} from "../extension-secrets";

/** How long a started sign-in stays valid. */
export const MCP_OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

export const MCP_OAUTH_CALLBACK_PATH = "/api/extensions/mcp/oauth/callback";

export class McpOAuthRequiredError extends Error {
  constructor() {
    super("The MCP server needs a sign-in. Connect the extension and try again.");
    this.name = "McpOAuthRequiredError";
  }
}

export class McpOAuthIssuerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpOAuthIssuerError";
  }
}

/**
 * Compares two authorization server identifiers as parsed URLs, tolerating
 * one trailing "/" (the SDK writes an origin-only URL with a trailing slash;
 * metadata usually has none).
 */
export function issuersMatch(a: string, b: string): boolean {
  let [x, y] = [a, b];
  try {
    [x, y] = [new URL(a).href, new URL(b).href];
  } catch {
    // Not two URLs: compared as written.
  }
  return x === y || (x.endsWith("/") && x.slice(0, -1) === y) || (y.endsWith("/") && y.slice(0, -1) === x);
}

const originOf = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

/**
 * Checks discovered authorization server metadata before any request is sent
 * to its endpoints, and returns the issuer the sign-in is bound to.
 *
 *  - `issuer` must equal the authorization server URL the metadata was read
 *    from (RFC 8414 §3.3).
 *  - authorization, token and (if present) registration endpoints must be on
 *    the issuer's origin. All extensions share one redirect URL, so endpoints
 *    split over hosts could send a code issued by one server to another.
 *
 * Without metadata the SDK uses /authorize, /token and /register on the
 * authorization server URL itself, which is then the issuer.
 */
export function validateAuthorizationServerMetadata(
  authorizationServerUrl: string,
  metadata: AuthorizationServerMetadata | undefined
): string {
  if (!metadata) return authorizationServerUrl;
  const issuer = (metadata as { issuer?: unknown }).issuer;
  if (typeof issuer !== "string" || !originOf(issuer)) {
    throw new McpOAuthIssuerError("The authorization server metadata has no valid issuer");
  }
  if (!issuersMatch(issuer, authorizationServerUrl)) {
    throw new McpOAuthIssuerError("The authorization server metadata names another issuer");
  }
  const issuerOrigin = originOf(issuer);
  const endpoints: Array<[string, unknown]> = [
    ["authorization_endpoint", metadata.authorization_endpoint],
    ["token_endpoint", metadata.token_endpoint],
    ["registration_endpoint", metadata.registration_endpoint],
  ];
  for (const [name, value] of endpoints) {
    if (value === undefined || value === null) {
      if (name === "registration_endpoint") continue;
      throw new McpOAuthIssuerError(`The authorization server metadata has no ${name}`);
    }
    if (typeof value !== "string" || originOf(value) !== issuerOrigin) {
      throw new McpOAuthIssuerError(`The ${name} is not on the issuer's origin`);
    }
  }
  return issuer;
}

/** Sign-in started by one user, kept until the callback arrives. */
export interface PendingMcpOAuth {
  state: string;
  codeVerifier?: string;
  /**
   * Issuer of the authorization server the user was sent to. The callback
   * compares it with the `iss` response parameter (RFC 9207) and with the
   * issuer discovered again for the code exchange.
   */
  issuer?: string;
  /** The server announced RFC 9207 support: its callback must carry `iss`. */
  issRequired?: boolean;
  userId: string;
  /** Agent through which the user may use the extension (re-checked at the callback). */
  personaId?: string;
  /** Same-origin path to return to after the sign-in. */
  returnTo?: string;
  createdAt: number;
}

export interface McpOAuthProviderOptions {
  extensionId: string;
  /** The MCP server URL; tokens and client registrations of another URL are ignored. */
  serverUrl: string;
  /** Whose tokens: the chatting user, or the owner for the save-time tool list. */
  userId: string;
  /** Pre-registered client (owner-provided); otherwise dynamic client registration. */
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  redirectUrl: string;
  store: SecretStore;
  /**
   * interactive: the user is starting a sign-in; the authorization URL is
   * captured instead of opened. Non-interactive (chat time): a missing or
   * expired token that cannot be refreshed fails with McpOAuthRequiredError.
   */
  interactive?: { state: string; personaId?: string; returnTo?: string };
  /**
   * Callback only: the issuer recorded when the sign-in started. Discovery
   * that finds another issuer stops before the code is sent anywhere.
   */
  expectedIssuer?: string;
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

/** A same-origin path, or undefined. Blocks open redirects ("//host", "/\\host", schemes). */
export const safeReturnPath = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 512) return undefined;
  if (!/^\/(?![/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]*$/.test(value)) return undefined;
  return value;
};

/**
 * OAuth client provider for one user of one Remote MCP extension, backed by
 * Key Vault.
 *
 * Each user signs in with their own account: tokens and the pending PKCE
 * verifier are stored per (extension, user) under hashed names (no user id
 * in a Key Vault name) and tagged with the extension id, so deleting the
 * extension can delete them. The client registration is shared per
 * extension: it identifies this app to the authorization server, not a user.
 *
 * Key Vault keeps deleted names reserved (soft delete), so these records are
 * overwritten with "null" instead of deleted while the extension exists.
 */
/** Machine-readable client name derived from the app name: lowercase, non-alphanumerics become "-". */
export function mcpClientSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class KeyVaultMcpOAuthProvider implements OAuthClientProvider {
  private readonly names: ReturnType<typeof mcpOAuthSecretNames>;
  private readonly userNames: ReturnType<typeof mcpOAuthUserSecretNames>;
  private readonly tags: Record<string, string>;
  private authorizationUrl: URL | undefined;
  private discoveredIssuer: string | undefined;
  private discoveredIssRequired = false;

  constructor(private readonly options: McpOAuthProviderOptions) {
    this.names = mcpOAuthSecretNames(options.extensionId);
    this.userNames = mcpOAuthUserSecretNames(options.extensionId, options.userId);
    this.tags = { [MCP_EXTENSION_TAG]: options.extensionId };
  }

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: AI_NAME,
      redirect_uris: [this.options.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.options.scopes ? { scope: this.options.scopes } : {}),
    };
  }

  /**
   * Called by the SDK right after discovery, before registration, token or
   * authorization requests. No discoveryState() is offered, so every auth()
   * run discovers (and checks) again.
   */
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    const issuer = validateAuthorizationServerMetadata(
      state.authorizationServerUrl,
      state.authorizationServerMetadata
    );
    if (this.options.expectedIssuer !== undefined && !issuersMatch(issuer, this.options.expectedIssuer)) {
      throw new McpOAuthIssuerError("The authorization server changed during the sign-in");
    }
    this.discoveredIssuer = issuer;
    this.discoveredIssRequired =
      (state.authorizationServerMetadata as { authorization_response_iss_parameter_supported?: unknown } | undefined)
        ?.authorization_response_iss_parameter_supported === true;
  }

  /** Issuer bound by the last discovery of this provider. */
  get issuer(): string | undefined {
    return this.discoveredIssuer;
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
    const record = parseJson<{ serverUrl: string; info: OAuthClientInformationMixed }>(
      await this.options.store.get(this.names.client)
    );
    return record?.serverUrl === this.options.serverUrl ? record.info : undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    if (this.options.clientId) return;
    await this.options.store.set(
      this.names.client,
      JSON.stringify({ serverUrl: this.options.serverUrl, info }),
      this.tags
    );
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const record = parseJson<{ serverUrl: string; tokens: OAuthTokens }>(
      await this.options.store.get(this.userNames.tokens)
    );
    return record?.serverUrl === this.options.serverUrl ? record.tokens : undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.options.store.set(
      this.userNames.tokens,
      JSON.stringify({ serverUrl: this.options.serverUrl, tokens }),
      this.tags
    );
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
      issuer: this.discoveredIssuer,
      ...(this.discoveredIssRequired ? { issRequired: true } : {}),
      userId: this.options.userId,
      personaId: this.options.interactive.personaId,
      returnTo: this.options.interactive.returnTo,
      createdAt: Date.now(),
    };
    await this.options.store.set(this.userNames.pending, JSON.stringify(pending), this.tags);
  }

  async codeVerifier(): Promise<string> {
    const pending = await readPendingMcpOAuth(this.options.store, this.options.extensionId, this.options.userId);
    if (!pending?.codeVerifier) throw new McpOAuthRequiredError();
    return pending.codeVerifier;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery"
  ): Promise<void> {
    if (scope === "all" || scope === "tokens") {
      await this.options.store.set(this.userNames.tokens, "null", this.tags);
    }
    if ((scope === "all" || scope === "client") && !this.options.clientId) {
      await this.options.store.set(this.names.client, "null", this.tags);
    }
    if (scope === "all" || scope === "verifier") {
      await this.options.store.set(this.userNames.pending, "null", this.tags);
    }
  }
}

export async function readPendingMcpOAuth(
  store: SecretStore,
  extensionId: string,
  userId: string
): Promise<PendingMcpOAuth | undefined> {
  return parseJson<PendingMcpOAuth>(
    await store.get(mcpOAuthUserSecretNames(extensionId, userId).pending)
  );
}

/** True when this user holds a token for this extension's current server URL. */
export async function hasMcpUserTokens(
  store: SecretStore,
  extensionId: string,
  serverUrl: string,
  userId: string
): Promise<boolean> {
  const record = parseJson<{ serverUrl: string; tokens?: OAuthTokens }>(
    await store.get(mcpOAuthUserSecretNames(extensionId, userId).tokens)
  );
  return record?.serverUrl === serverUrl && !!record.tokens?.access_token;
}

/**
 * Checks a callback against the pending sign-in: same state (constant-time),
 * same user who started it, not older than the TTL, and, when the
 * authorization server sends `iss` (RFC 9207), the issuer recorded for this
 * state.
 */
export function isPendingMcpOAuthValid(
  pending: PendingMcpOAuth | undefined,
  input: { state: string; userId: string; iss?: string | null; now?: number }
): boolean {
  if (!pending || !pending.codeVerifier) return false;
  if (!safeEqual(pending.state, input.state)) return false;
  if (pending.userId !== input.userId) return false;
  if (input.iss !== undefined && input.iss !== null) {
    if (!pending.issuer || !issuersMatch(input.iss, pending.issuer)) return false;
  } else if (pending.issRequired) {
    return false;
  }
  const age = (input.now ?? Date.now()) - pending.createdAt;
  return age >= 0 && age <= MCP_OAUTH_PENDING_TTL_MS;
}
