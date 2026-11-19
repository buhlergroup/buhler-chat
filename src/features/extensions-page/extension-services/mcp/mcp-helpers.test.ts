// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { applyMcpSecrets } from "./mcp-secrets";
import { createGuardedFetch } from "./mcp-fetch";
import {
  createMcpOAuthState,
  extensionIdFromMcpOAuthState,
  hasMcpUserTokens,
  isPendingMcpOAuthValid,
  KeyVaultMcpOAuthProvider,
  McpOAuthRequiredError,
  MCP_OAUTH_PENDING_TTL_MS,
  mcpClientSlug,
  readPendingMcpOAuth,
  safeReturnPath,
} from "./mcp-oauth";
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
