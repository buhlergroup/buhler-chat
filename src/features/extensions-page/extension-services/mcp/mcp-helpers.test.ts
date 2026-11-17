// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { parseMcpImportText } from "./mcp-import";
import { applyMcpSecrets } from "./mcp-secrets";
import { createGuardedFetch } from "./mcp-fetch";
import {
  createMcpOAuthState,
  extensionIdFromMcpOAuthState,
  isPendingMcpOAuthValid,
  KeyVaultMcpOAuthProvider,
  McpOAuthRequiredError,
  MCP_OAUTH_PENDING_TTL_MS,
} from "./mcp-oauth";
import type { SecretStore } from "../extension-secrets";
import { McpSecretSchema } from "../models";

const FAKE = "fake-secret-value-for-tests";

describe("parseMcpImportText", () => {
  it("reads the provider format: type, url and NAME=value", () => {
    const r = parseMcpImportText(
      `type: streamable-http\nurl: https://staging.example.com/mcp\nMCP_EXAMPLE_TOKEN=${FAKE}\n`
    );
    expect(r).toEqual({
      url: "https://staging.example.com/mcp",
      transport: "streamable-http",
      secrets: [{ name: "MCP_EXAMPLE_TOKEN", value: FAKE, placement: "bearer" }],
      errors: [],
    });
  });

  it("keeps an url with a query string, strips quotes, skips comments", () => {
    const r = parseMcpImportText(`# comment\nurl: https://x.example.com/mcp?a=b\nTOKEN="${FAKE}"\r\n`);
    expect(r.url).toBe("https://x.example.com/mcp?a=b");
    expect(r.secrets[0].value).toBe(FAKE);
  });

  it("reports bad lines without echoing values", () => {
    const r = parseMcpImportText(`type: websocket\nEMPTY=\nnonsense ${FAKE}`);
    expect(r.errors).toHaveLength(3);
    expect(r.errors.join(" ")).not.toContain(FAKE);
  });
});

describe("applyMcpSecrets", () => {
  it("places secrets as bearer, header and query parameter", () => {
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
    expect(McpSecretSchema.safeParse({ ...base, name: "A", target: "x-api-key" }).success).toBe(true);
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

describe("MCP OAuth state and provider", () => {
  const memoryStore = (): SecretStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return {
      data,
      get: async (n) => data.get(n),
      set: async (n, v) => void data.set(n, v),
      remove: async (n) => void data.delete(n),
    };
  };

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

  it("keeps tokens and the registered client in the secret store", async () => {
    const store = memoryStore();
    const p = new KeyVaultMcpOAuthProvider({ extensionId: "e1", redirectUrl: "https://app/cb", store });
    await p.saveTokens({ access_token: "a", token_type: "Bearer" });
    await p.saveClientInformation({ client_id: "dyn" });
    expect(await p.tokens()).toEqual({ access_token: "a", token_type: "Bearer" });
    expect(await p.clientInformation()).toEqual({ client_id: "dyn" });
    await p.invalidateCredentials("tokens");
    expect(await p.tokens()).toBeUndefined();
  });

  it("uses a pre-registered client instead of dynamic registration", async () => {
    const p = new KeyVaultMcpOAuthProvider({
      extensionId: "e1",
      clientId: "cid",
      clientSecret: "cs",
      redirectUrl: "https://app/cb",
      store: memoryStore(),
    });
    expect(await p.clientInformation()).toEqual({ client_id: "cid", client_secret: "cs" });
  });

  it("never starts a sign-in at chat time", async () => {
    const p = new KeyVaultMcpOAuthProvider({ extensionId: "e1", redirectUrl: "https://app/cb", store: memoryStore() });
    expect(() => p.redirectToAuthorization(new URL("https://auth.example.com/authorize"))).toThrow(
      McpOAuthRequiredError
    );
    await expect(p.saveCodeVerifier("v")).rejects.toThrow(McpOAuthRequiredError);
  });

  it("captures the authorization URL in an interactive sign-in and records the verifier", async () => {
    const store = memoryStore();
    const p = new KeyVaultMcpOAuthProvider({
      extensionId: "e1",
      redirectUrl: "https://app/cb",
      store,
      interactive: { userId: "u1", state: "e1.state" },
    });
    p.redirectToAuthorization(new URL("https://auth.example.com/authorize?x=1"));
    await p.saveCodeVerifier("verifier");
    expect(p.capturedAuthorizationUrl?.host).toBe("auth.example.com");
    expect(await p.codeVerifier()).toBe("verifier");
    expect(JSON.parse(store.data.get("e1-mcp-oauth-pending")!)).toMatchObject({ state: "e1.state", userId: "u1" });
    expect(() => p.redirectToAuthorization(new URL("http://auth.example.com/authorize"))).toThrow(/https/);
  });
});
