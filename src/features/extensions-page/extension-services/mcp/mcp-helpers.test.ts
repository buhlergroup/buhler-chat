// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { applyMcpSecrets } from "./mcp-secrets";
import { createGuardedFetch } from "./mcp-fetch";
import {
  createMcpOAuthState,
  extensionIdFromMcpOAuthState,
  hasMcpUserTokens,
  isPendingMcpOAuthValid,
  issuersMatch,
  KeyVaultMcpOAuthProvider,
  McpOAuthIssuerError,
  McpOAuthRequiredError,
  MCP_OAUTH_PENDING_TTL_MS,
  mcpClientSlug,
  readPendingMcpOAuth,
  safeReturnPath,
  validateAuthorizationServerMetadata,
} from "./mcp-oauth";
import { openMcpSession, withServerOriginHeaders } from "./mcp-client";
import { AI_NAME } from "@/features/theme/theme-config";
import { MCP_EXTENSION_TAG, mcpOAuthUserSecretNames, type SecretStore } from "../extension-secrets";
import { mcpHeaderErrors, McpSecretSchema } from "../models";

const FAKE = "fake-secret-value-for-tests";

describe("applyMcpSecrets", () => {
  it("sends a header row exactly as typed", () => {
    const r = applyMcpSecrets("https://mcp.example.com/mcp", [
      { name: "Authorization", placement: "header", target: "Authorization", value: `Bearer ${FAKE}` },
      { name: "X-MCP-Readonly", placement: "header", target: "X-MCP-Readonly", value: "true" },
    ]);
    expect(r.headers).toEqual({ Authorization: `Bearer ${FAKE}`, "X-MCP-Readonly": "true" });
    expect(r.url).toBe("https://mcp.example.com/mcp");
  });

  it("keeps legacy records working: bearer, header by name, query parameter", () => {
    const r = applyMcpSecrets("https://mcp.example.com/mcp", [
      { name: "TOKEN", placement: "bearer", value: FAKE },
      { name: "X_TEAM", placement: "header", value: "h" },
      { name: "TEAM2", placement: "header", target: "x-api-key", value: "k" },
      { name: "KEY", placement: "query", target: "api_key", value: "q v" },
    ]);
    expect(r.headers).toEqual({ Authorization: `Bearer ${FAKE}`, X_TEAM: "h", "x-api-key": "k" });
    expect(new URL(r.url).searchParams.get("api_key")).toBe("q v");
  });
});

describe("McpSecretSchema", () => {
  it("refuses reserved and invalid header names", () => {
    const base = { id: "1", value: "x", placement: "header" as const };
    expect(McpSecretSchema.safeParse({ ...base, name: "Host" }).success).toBe(false);
    expect(McpSecretSchema.safeParse({ ...base, name: "A", target: "Mcp-Session-Id" }).success).toBe(false);
    expect(McpSecretSchema.safeParse({ ...base, name: "A", target: "bad header" }).success).toBe(false);
    expect(McpSecretSchema.safeParse({ ...base, name: "bad header" }).success).toBe(false);
    expect(McpSecretSchema.safeParse({ ...base, name: "A", target: "x-api-key" }).success).toBe(true);
    expect(McpSecretSchema.safeParse({ ...base, name: "X-MCP-Readonly", target: "X-MCP-Readonly" }).success).toBe(true);
  });

  it("still reads legacy bearer and query records", () => {
    expect(McpSecretSchema.safeParse({ id: "1", name: "MCP_TOKEN", value: "x", placement: "bearer" }).success).toBe(true);
    expect(
      McpSecretSchema.safeParse({ id: "2", name: "key", value: "x", placement: "query", target: "api_key" }).success
    ).toBe(true);
  });
});

describe("mcpHeaderErrors", () => {
  const header = (name: string) => ({ name, placement: "header" as const, target: name });

  it("accepts plain headers, including Authorization without OAuth", () => {
    expect(
      mcpHeaderErrors({ auth: "none", secrets: [header("Authorization"), header("X-MCP-Readonly")] })
    ).toEqual([]);
  });

  it("requires a name that is a valid HTTP token", () => {
    expect(mcpHeaderErrors({ auth: "none", secrets: [header("")] })).toEqual(["Enter a name for each header."]);
    expect(mcpHeaderErrors({ auth: "none", secrets: [header("X Team")] })[0]).toMatch(/Header names can use/);
    expect(mcpHeaderErrors({ auth: "none", secrets: [header("X:Team")] })).toHaveLength(1);
  });

  it("refuses duplicate header names, case-insensitive, also against a legacy bearer record", () => {
    expect(mcpHeaderErrors({ auth: "none", secrets: [header("X-Team"), header("x-team")] })).toEqual([
      "Use each header name once: x-team",
    ]);
    expect(
      mcpHeaderErrors({
        auth: "none",
        secrets: [{ name: "MCP_TOKEN", placement: "bearer" }, header("authorization")],
      })
    ).toEqual(["Use each header name once: authorization"]);
  });

  it.each(["Host", "Content-Length", "Content-Type", "Accept", "Mcp-Session-Id", "MCP-Protocol-Version"])(
    "refuses %s, which the transport sets itself",
    (name) => {
      expect(mcpHeaderErrors({ auth: "none", secrets: [header(name)] })).toEqual([
        `The connection sets ${name} itself. Use another header name.`,
      ]);
    }
  );

  it("refuses an Authorization header with OAuth sign-in, also a legacy bearer record", () => {
    const message =
      "OAuth sign-in sets the Authorization header. Remove the Authorization row or set sign-in to None.";
    expect(mcpHeaderErrors({ auth: "oauth", secrets: [header("Authorization")] })).toEqual([message]);
    expect(mcpHeaderErrors({ auth: "oauth", secrets: [{ name: "T", placement: "bearer" }] })).toEqual([message]);
    expect(mcpHeaderErrors({ auth: "oauth", secrets: [header("X-MCP-Readonly")] })).toEqual([]);
  });

  it("keeps query parameter names apart from header names", () => {
    expect(
      mcpHeaderErrors({
        auth: "none",
        secrets: [header("api_key"), { name: "k", placement: "query", target: "api_key" }],
      })
    ).toEqual([]);
  });
});

describe("createGuardedFetch", () => {
  const okFetch = vi.fn(async () => new Response("ok", { status: 200 }));

  it.each([
    "http://mcp.example.com/mcp",
    "https://127.0.0.1/mcp",
    "https://169.254.169.254/metadata",
    "https://10.0.0.5/mcp",
    "https://[::1]/mcp",
  ])("blocks %s before any request (SSRF)", async (url) => {
    const f = createGuardedFetch({ timeoutMs: 1000, maxResponseBytes: 100, baseFetch: okFetch as never });
    await expect(f(url)).rejects.toThrow();
    expect(okFetch).not.toHaveBeenCalled();
  });

  it("never lets fetch follow redirects", async () => {
    const base = vi.fn(async (_u: string, _i?: RequestInit) => new Response(null, { status: 204 }));
    const f = createGuardedFetch({
      timeoutMs: 1000,
      maxResponseBytes: 100,
      baseFetch: base as never,
      assertUrl: async () => {},
    });
    await f("https://mcp.example.com/mcp", { method: "POST", redirect: "follow" });
    expect(base.mock.calls[0][1]?.redirect).toBe("manual");
  });

  it("fails a body larger than the limit", async () => {
    const big = "x".repeat(500);
    const f = createGuardedFetch({
      timeoutMs: 1000,
      maxResponseBytes: 100,
      baseFetch: (async () => new Response(big)) as never,
      assertUrl: async () => {},
    });
    const response = await f("https://mcp.example.com/mcp");
    await expect(response.text()).rejects.toThrow(/larger than 100 bytes/);
  });

  it("refuses a declared content-length over the limit", async () => {
    const f = createGuardedFetch({
      timeoutMs: 1000,
      maxResponseBytes: 10,
      baseFetch: (async () =>
        new Response("12345678901", { headers: { "content-length": "11" } })) as never,
      assertUrl: async () => {},
    });
    await expect(f("https://mcp.example.com/mcp")).rejects.toThrow(/larger than 10 bytes/);
  });

  it("passes a body within the limit", async () => {
    const f = createGuardedFetch({
      timeoutMs: 1000,
      maxResponseBytes: 100,
      baseFetch: (async () => new Response("hello")) as never,
      assertUrl: async () => {},
    });
    expect(await (await f("https://mcp.example.com/mcp")).text()).toBe("hello");
  });
});

describe("MCP OAuth state and provider (per user)", () => {
  const memoryStore = (): SecretStore & {
    data: Map<string, string>;
    tags: Map<string, Record<string, string>>;
  } => {
    const data = new Map<string, string>();
    const tags = new Map<string, Record<string, string>>();
    return {
      data,
      tags,
      get: async (n) => data.get(n),
      set: async (n, v, t) => {
        data.set(n, v);
        if (t) tags.set(n, t);
      },
      remove: async (n) => void data.delete(n),
      removeTagged: async (tag, value) => {
        let count = 0;
        for (const [n, t] of tags) {
          if (t[tag] === value && data.delete(n)) count++;
        }
        return count;
      },
    };
  };
  const SERVER = "https://mcp.example.com/mcp";
  type Options = ConstructorParameters<typeof KeyVaultMcpOAuthProvider>[0];
  const provider = (store: SecretStore, userId: string, extra: Partial<Options> = {}) =>
    new KeyVaultMcpOAuthProvider({
      extensionId: "e1",
      serverUrl: SERVER,
      userId,
      redirectUrl: "https://app/cb",
      store,
      ...extra,
    });

  it("round-trips the extension id through the state", () => {
    const state = createMcpOAuthState("abcDEF123");
    expect(extensionIdFromMcpOAuthState(state)).toBe("abcDEF123");
    expect(extensionIdFromMcpOAuthState("abc.123")).toBeUndefined();
    expect(extensionIdFromMcpOAuthState("../x.y")).toBeUndefined();
  });

  it("accepts a callback only for the same state, same user, within the TTL", () => {
    const pending = { state: "s1", codeVerifier: "v", userId: "u1", createdAt: 1_000 };
    expect(isPendingMcpOAuthValid(pending, { state: "s1", userId: "u1", now: 2_000 })).toBe(true);
    expect(isPendingMcpOAuthValid(pending, { state: "s2", userId: "u1", now: 2_000 })).toBe(false);
    expect(isPendingMcpOAuthValid(pending, { state: "s1", userId: "u2", now: 2_000 })).toBe(false);
    expect(
      isPendingMcpOAuthValid(pending, { state: "s1", userId: "u1", now: 1_001 + MCP_OAUTH_PENDING_TTL_MS })
    ).toBe(false);
    expect(isPendingMcpOAuthValid(undefined, { state: "s1", userId: "u1" })).toBe(false);
  });

  it("keeps tokens per user: user A connected, user B not", async () => {
    const store = memoryStore();
    await provider(store, "userA").saveTokens({ access_token: "a", token_type: "Bearer" });
    expect(await provider(store, "userA").tokens()).toEqual({ access_token: "a", token_type: "Bearer" });
    expect(await provider(store, "userB").tokens()).toBeUndefined();
    expect(await hasMcpUserTokens(store, "e1", SERVER, "userA")).toBe(true);
    expect(await hasMcpUserTokens(store, "e1", SERVER, "userB")).toBe(false);
  });

  it("names user records by a hash, never the raw user id, and tags them with the extension", async () => {
    const store = memoryStore();
    await provider(store, "user-hash-visible").saveTokens({ access_token: "a", token_type: "Bearer" });
    const [name] = [...store.data.keys()];
    expect(name).toBe(mcpOAuthUserSecretNames("e1", "user-hash-visible").tokens);
    expect(name).not.toContain("user-hash-visible");
    expect(name).toMatch(/^mcp-tok-[0-9a-f]{48}$/);
    expect(store.tags.get(name)).toEqual({ [MCP_EXTENSION_TAG]: "e1" });
  });

  it("removes every user's records of an extension by tag", async () => {
    const store = memoryStore();
    await provider(store, "userA").saveTokens({ access_token: "a", token_type: "Bearer" });
    await provider(store, "userB").saveTokens({ access_token: "b", token_type: "Bearer" });
    expect(await store.removeTagged(MCP_EXTENSION_TAG, "e1")).toBe(2);
    expect(await provider(store, "userA").tokens()).toBeUndefined();
  });

  it("ignores tokens and a client registration issued for another server URL", async () => {
    const store = memoryStore();
    await provider(store, "userA").saveTokens({ access_token: "a", token_type: "Bearer" });
    await provider(store, "userA").saveClientInformation({ client_id: "dyn" });
    const moved = provider(store, "userA", { serverUrl: "https://other.example.com/mcp" });
    expect(await moved.tokens()).toBeUndefined();
    expect(await moved.clientInformation()).toBeUndefined();
  });

  it("shares the client registration across users and invalidates only the user's tokens", async () => {
    const store = memoryStore();
    await provider(store, "userA").saveClientInformation({ client_id: "dyn" });
    expect(await provider(store, "userB").clientInformation()).toEqual({ client_id: "dyn" });
    await provider(store, "userA").saveTokens({ access_token: "a", token_type: "Bearer" });
    await provider(store, "userB").saveTokens({ access_token: "b", token_type: "Bearer" });
    await provider(store, "userA").invalidateCredentials("tokens");
    expect(await provider(store, "userA").tokens()).toBeUndefined();
    expect(await provider(store, "userB").tokens()).toMatchObject({ access_token: "b" });
  });

  it("uses a pre-registered client instead of dynamic registration", async () => {
    const p = provider(memoryStore(), "u", { clientId: "cid", clientSecret: "cs" });
    expect(await p.clientInformation()).toEqual({ client_id: "cid", client_secret: "cs" });
  });

  it("never starts a sign-in at chat time", async () => {
    const p = provider(memoryStore(), "u");
    expect(() => p.redirectToAuthorization(new URL("https://auth.example.com/authorize"))).toThrow(
      McpOAuthRequiredError
    );
    await expect(p.saveCodeVerifier("v")).rejects.toThrow(McpOAuthRequiredError);
  });

  it("captures the authorization URL and records the verifier for that user only", async () => {
    const store = memoryStore();
    const p = provider(store, "u1", {
      interactive: { state: "e1.state", personaId: "agent-1", returnTo: "/chat/t1" },
    });
    p.redirectToAuthorization(new URL("https://auth.example.com/authorize?x=1"));
    await p.saveCodeVerifier("verifier");
    expect(p.capturedAuthorizationUrl?.host).toBe("auth.example.com");
    expect(await p.codeVerifier()).toBe("verifier");
    expect(await readPendingMcpOAuth(store, "e1", "u1")).toMatchObject({
      state: "e1.state",
      userId: "u1",
      personaId: "agent-1",
      returnTo: "/chat/t1",
    });
    expect(await readPendingMcpOAuth(store, "e1", "u2")).toBeUndefined();
    expect(() => p.redirectToAuthorization(new URL("http://auth.example.com/authorize"))).toThrow(/https/);
  });

  it("accepts only same-origin return paths", () => {
    expect(safeReturnPath("/chat/abc")).toBe("/chat/abc");
    expect(safeReturnPath("//evil.example.com")).toBeUndefined();
    expect(safeReturnPath("/\\evil.example.com")).toBeUndefined();
    expect(safeReturnPath("https://evil.example.com")).toBeUndefined();
    expect(safeReturnPath(42)).toBeUndefined();
  });
});

describe("MCP client identity", () => {
  it("slugs a display name", () => {
    expect(mcpClientSlug("Example Chat")).toBe("example-chat");
    expect(mcpClientSlug("Café  Ünï -- Chat!")).toBe("cafe-uni-chat");
  });

  it("registers the OAuth client under the app name", () => {
    const p = new KeyVaultMcpOAuthProvider({
      store: {} as SecretStore,
      extensionId: "e",
      userId: "u",
      redirectUrl: "https://app.example.com/cb",
    } as never);
    expect(p.clientMetadata.client_name).toBe(AI_NAME);
  });
});

// Pinned: all extensions share one redirect URL, so the metadata of an
// authorization server must not send the code elsewhere (RFC 8414 §3.3,
// RFC 9207).
describe("MCP OAuth issuer binding", () => {
  const AS = "https://as.example.test";
  const meta = (over: Record<string, unknown> = {}) =>
    ({
      issuer: AS,
      authorization_endpoint: `${AS}/authorize`,
      token_endpoint: `${AS}/token`,
      registration_endpoint: `${AS}/register`,
      response_types_supported: ["code"],
      ...over,
    }) as never;

  it("accepts endpoints on the issuer's origin and returns the issuer", () => {
    expect(validateAuthorizationServerMetadata(AS, meta())).toBe(AS);
    expect(validateAuthorizationServerMetadata(`${AS}/`, meta())).toBe(AS);
    expect(validateAuthorizationServerMetadata(AS, meta({ registration_endpoint: undefined }))).toBe(AS);
  });

  it("uses the authorization server URL as issuer when there is no metadata", () => {
    expect(validateAuthorizationServerMetadata(AS, undefined)).toBe(AS);
  });

  it.each([
    ["an issuer other than the URL it was read from", { issuer: "https://other.example.test" }],
    ["an issuer with another path", { issuer: `${AS}/tenant` }],
    ["no issuer", { issuer: undefined }],
    ["a token endpoint on another host", { token_endpoint: "https://collector.example.test/token" }],
    ["an authorization endpoint on another host", { authorization_endpoint: "https://other.example.test/authorize" }],
    ["a registration endpoint on another host", { registration_endpoint: "https://other.example.test/register" }],
    ["a token endpoint on another port", { token_endpoint: `${AS}:8443/token` }],
    ["a token endpoint over http", { token_endpoint: "http://as.example.test/token" }],
  ])("refuses metadata with %s", (_label, over) => {
    expect(() => validateAuthorizationServerMetadata(AS, meta(over))).toThrow(McpOAuthIssuerError);
  });

  it("compares issuers as URLs, tolerating one trailing slash", () => {
    expect(issuersMatch("https://AS.example.test", "https://as.example.test/")).toBe(true);
    expect(issuersMatch("https://as.example.test/a", "https://as.example.test/b")).toBe(false);
  });

  const store = (): SecretStore => {
    const data = new Map<string, string>();
    return {
      get: async (n) => data.get(n),
      set: async (n, v) => void data.set(n, v),
      remove: async (n) => void data.delete(n),
      removeTagged: async () => 0,
    };
  };
  const interactiveProvider = (s: SecretStore, extra: Record<string, unknown> = {}) =>
    new KeyVaultMcpOAuthProvider({
      extensionId: "e1",
      serverUrl: "https://mcp.example.test/mcp",
      userId: "u1",
      redirectUrl: "https://app/cb",
      store: s,
      interactive: { state: "e1.state" },
      ...extra,
    });

  it("records the discovered issuer with the pending sign-in", async () => {
    const s = store();
    const p = interactiveProvider(s);
    p.saveDiscoveryState({ authorizationServerUrl: AS, authorizationServerMetadata: meta() });
    await p.saveCodeVerifier("v");
    expect(await readPendingMcpOAuth(s, "e1", "u1")).toMatchObject({ issuer: AS });
    expect((await readPendingMcpOAuth(s, "e1", "u1"))?.issRequired).toBeUndefined();
  });

  it("refuses metadata in saveDiscoveryState, before any request to its endpoints", () => {
    const p = interactiveProvider(store());
    expect(() =>
      p.saveDiscoveryState({
        authorizationServerUrl: AS,
        authorizationServerMetadata: meta({ token_endpoint: "https://collector.example.test/token" }),
      })
    ).toThrow(McpOAuthIssuerError);
  });

  it("refuses another issuer at the callback than the one the user was sent to", () => {
    const p = interactiveProvider(store(), { expectedIssuer: "https://first.example.test" });
    expect(() => p.saveDiscoveryState({ authorizationServerUrl: AS, authorizationServerMetadata: meta() })).toThrow(
      /changed during the sign-in/
    );
  });

  it("checks the iss response parameter against the issuer of the state", () => {
    const pending = { state: "s1", codeVerifier: "v", userId: "u1", createdAt: 1_000, issuer: AS };
    const check = (iss: string | null | undefined, p: object = pending) =>
      isPendingMcpOAuthValid(p as never, { state: "s1", userId: "u1", iss, now: 2_000 });
    expect(check(AS)).toBe(true);
    expect(check(`${AS}/`)).toBe(true);
    expect(check(null)).toBe(true);
    expect(check("https://other.example.test")).toBe(false);
    expect(check("")).toBe(false);
    // A pending record without an issuer accepts no iss at all.
    expect(check(AS, { ...pending, issuer: undefined })).toBe(false);
    // A server that announced RFC 9207 support must send iss.
    expect(check(null, { ...pending, issRequired: true })).toBe(false);
    expect(check(AS, { ...pending, issRequired: true })).toBe(true);
  });

  it("requires iss when the metadata announces RFC 9207 support", async () => {
    const s = store();
    const p = interactiveProvider(s);
    p.saveDiscoveryState({
      authorizationServerUrl: AS,
      authorizationServerMetadata: meta({ authorization_response_iss_parameter_supported: true }),
    });
    await p.saveCodeVerifier("v");
    expect(await readPendingMcpOAuth(s, "e1", "u1")).toMatchObject({ issuer: AS, issRequired: true });
  });
});

// Pinned: header rows (for example an API key) are for the MCP server only.
// The SDK also sends requestInit headers to the OAuth authorization server.
describe("MCP header rows reach only the MCP server origin", () => {
  it("adds the rows for the server origin and leaves other origins alone", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const base = async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response("{}");
    };
    const f = withServerOriginHeaders(base, "https://mcp.example.test/mcp", { "X-Api-Key": FAKE });
    await f("https://mcp.example.test/mcp", { headers: { Accept: "application/json" } });
    await f(new URL("https://mcp.example.test/.well-known/oauth-protected-resource/mcp"));
    await f("https://as.example.test/token", { headers: { "content-type": "application/x-www-form-urlencoded" } });
    await f("https://mcp.example.test:8443/mcp");
    expect(seen.map((r) => r.headers.get("x-api-key"))).toEqual([FAKE, FAKE, null, null]);
    expect(seen[0].headers.get("accept")).toBe("application/json");
    expect(seen[2].headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  });

  it("sends no header row to the authorization server during a real SDK sign-in attempt", async () => {
    const MCP = "https://mcp.example.test";
    const AS = "https://as.example.test";
    const seen: Array<{ url: string; headers: Headers }> = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fakeFetch = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, headers: new Headers(init?.headers) });
      if (url === `${MCP}/mcp`) {
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="${MCP}/.well-known/oauth-protected-resource/mcp"` },
        });
      }
      if (url.startsWith(`${MCP}/.well-known/oauth-protected-resource`)) {
        return json({ resource: `${MCP}/mcp`, authorization_servers: [AS] });
      }
      if (url === `${AS}/.well-known/oauth-authorization-server`) {
        return json({
          issuer: AS,
          authorization_endpoint: `${AS}/authorize`,
          token_endpoint: `${AS}/token`,
          registration_endpoint: `${AS}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url === `${AS}/register`) {
        return json({ client_id: "dyn", redirect_uris: ["https://app/cb"] }, 201);
      }
      return new Response(null, { status: 404 });
    };
    const memory = new Map<string, string>();
    const authProvider = new KeyVaultMcpOAuthProvider({
      extensionId: "e1",
      serverUrl: `${MCP}/mcp`,
      userId: "u1",
      redirectUrl: "https://app/cb",
      store: {
        get: async (n) => memory.get(n),
        set: async (n, v) => void memory.set(n, v),
        remove: async (n) => void memory.delete(n),
        removeTagged: async () => 0,
      },
    });

    await expect(
      openMcpSession({
        url: `${MCP}/mcp`,
        transport: "streamable-http",
        headers: { "X-Api-Key": FAKE },
        authProvider,
        fetch: fakeFetch,
      })
    ).rejects.toThrow();

    const toAs = seen.filter((r) => r.url.startsWith(AS));
    const toMcp = seen.filter((r) => r.url.startsWith(MCP));
    // The SDK reached the authorization server (metadata and registration) ...
    expect(toAs.map((r) => new URL(r.url).pathname)).toEqual(
      expect.arrayContaining(["/.well-known/oauth-authorization-server", "/register"])
    );
    // ... without the header row, which went to the MCP server only.
    expect(toAs.every((r) => r.headers.get("x-api-key") === null)).toBe(true);
    expect(toMcp.find((r) => r.url === `${MCP}/mcp`)?.headers.get("x-api-key")).toBe(FAKE);
  });
});
