// @vitest-environment node
/**
 * End-to-end check against a FAKE MCP server built with the real MCP SDK
 * (McpServer + Streamable HTTP server transport) on 127.0.0.1. No network,
 * no real secrets. The production SSRF guard would refuse a loopback http
 * URL, so the guarded fetch here gets a permissive URL check; the guard
 * itself is covered in mcp-helpers.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

vi.mock("@/features/common/services/cosmos", () => ({ HistoryContainer: vi.fn() }));
vi.mock("@/features/auth-page/helpers", () => ({ userHashedId: vi.fn() }));
vi.mock("@/features/persona-page/persona-services/access-group-service", () => ({ AccessGroupById: vi.fn() }));
vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

import { listMcpTools, openMcpSession, type McpConnectionOptions } from "./mcp-client";
import { createGuardedFetch } from "./mcp-fetch";
import { applyMcpSecrets } from "./mcp-secrets";
import { mcpExtensionTools } from "@/features/chat-page/chat-services/tools/mcp-tool";
import type { ExtensionModel } from "../models";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { createMcpOAuthState, KeyVaultMcpOAuthProvider, readPendingMcpOAuth } from "./mcp-oauth";
import { completeMcpOAuthCallback } from "./mcp-oauth-callback";
import type { SecretStore } from "../extension-secrets";

const FAKE_TOKEN = "fake-local-token";
let server: Server;
let baseUrl: string;
const seenAuth: string[] = [];

function buildFakeMcpServer() {
  const mcp = new McpServer({ name: "fake-market", version: "1.0.0" });
  mcp.registerTool(
    "get_price",
    {
      description: "Price of a symbol",
      inputSchema: { symbol: z.string() },
    },
    async ({ symbol }) => ({ content: [{ type: "text", text: `${symbol}: 42.00` }] })
  );
  mcp.registerTool(
    "fail",
    { description: "Always fails" },
    async () => ({ isError: true, content: [{ type: "text", text: "boom" }] })
  );
  return mcp;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ""));
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    // Stateless: a fresh server + transport per request.
    const mcp = buildFakeMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const connection = (token = FAKE_TOKEN): McpConnectionOptions => {
  const { url, headers } = applyMcpSecrets(baseUrl, [
    { name: "MCP_FAKE_TOKEN", placement: "bearer", value: token },
  ]);
  return {
    url,
    transport: "streamable-http",
    headers,
    fetch: createGuardedFetch({ timeoutMs: 5_000, maxResponseBytes: 1_000_000, assertUrl: async () => {} }),
  };
};

describe("Remote MCP against a local fake server (real SDK on both sides)", () => {
  it("lists the tools with the bearer secret", async () => {
    const tools = await listMcpTools(connection());
    expect(tools.map((t) => t.name)).toEqual(["get_price", "fail"]);
    expect(tools[0].inputSchema).toMatchObject({ type: "object", properties: { symbol: { type: "string" } } });
    expect(seenAuth.at(-1)).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it("runs a tool through the chat tool mapping", async () => {
    const extension = {
      id: "LocalExt0000000000000000000000000000",
      name: "Fake market",
      kind: "mcp",
      mcp: { url: baseUrl, transport: "streamable-http", secrets: [], toolAllowList: [], auth: "none" },
    } as unknown as ExtensionModel;
    const tools = Object.fromEntries(await mcpExtensionTools(extension, connection(), openMcpSession));
    expect(Object.keys(tools)).toEqual(["LocalExt_get_price", "LocalExt_fail"]);

    const run = (name: string, args: unknown) =>
      (tools[name] as unknown as { execute: (a: unknown, o: object) => Promise<unknown> }).execute(args, {});
    expect(await run("LocalExt_get_price", { symbol: "ABB" })).toEqual({ text: "ABB: 42.00" });
    await expect(run("LocalExt_fail", {})).rejects.toThrow(/returned an error: boom/);
  });

  it("fails cleanly with a wrong secret", async () => {
    await expect(listMcpTools(connection("wrong"))).rejects.toThrow();
  });

  it("falls back from Streamable HTTP and still fails closed for auth errors", async () => {
    // "auto" first tries Streamable HTTP; the 401 is not an auth-provider
    // error here, so it tries SSE, which this server does not offer.
    await expect(listMcpTools({ ...connection("wrong"), transport: "auto" })).rejects.toThrow();
  });
});

describe("Per-user OAuth against a local fake MCP server + authorization server", () => {
  let oauthServer: Server;
  let origin: string;
  /** access token → user it was issued to; only these may call /mcp. */
  const validTokens = new Map<string, string>();
  let tokenCounter = 0;
  let lastTokenRequest = "";

  beforeAll(async () => {
    oauthServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", origin);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      };
      const readBody = () =>
        new Promise<string>((resolve) => {
          let data = "";
          req.on("data", (c) => (data += c));
          req.on("end", () => resolve(data));
        });

      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && req.method === "POST") {
        const metadata = JSON.parse(await readBody());
        return json(201, { ...metadata, client_id: "dyn-client-1" });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        lastTokenRequest = await readBody();
        const form = new URLSearchParams(lastTokenRequest);
        // The fake "code" names the user who signed in at the authorization server.
        const user =
          form.get("grant_type") === "refresh_token"
            ? (form.get("refresh_token") ?? "").replace(/^refresh-/, "")
            : (form.get("code") ?? "").replace(/^code-/, "");
        const accessToken = `access-${user}-${++tokenCounter}`;
        validTokens.set(accessToken, user);
        return json(200, {
          access_token: accessToken,
          token_type: "Bearer",
          refresh_token: `refresh-${user}`,
          expires_in: 3600,
        });
      }
      if (url.pathname === "/mcp") {
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        if (!validTokens.has(token)) {
          res
            .writeHead(401, {
              "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            })
            .end();
          return;
        }
        const mcp = buildFakeMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => oauthServer.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(oauthServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => oauthServer.close(() => resolve()));
  });

  const memoryStore = (): SecretStore => {
    const data = new Map<string, string>();
    return {
      get: async (n) => data.get(n),
      set: async (n, v) => void data.set(n, v),
      remove: async (n) => void data.delete(n),
      removeTagged: async () => 0,
    };
  };
  const looseFetch = () =>
    createGuardedFetch({ timeoutMs: 5_000, maxResponseBytes: 1_000_000, assertUrl: async () => {} });
  const redirectUrl = "https://chat.example.com/api/extensions/mcp/oauth/callback";
  const EXT_ID = "OAuthExt000000000000000000000000000";
  const extension = (): ExtensionModel =>
    ({
      id: EXT_ID,
      name: "Fake OAuth server",
      userId: "owner",
      kind: "mcp",
      mcp: {
        url: `${origin}/mcp`,
        transport: "streamable-http",
        secrets: [],
        toolAllowList: [],
        auth: "oauth",
        tools: [{ name: "get_price", inputSchema: { type: "object", properties: { symbol: { type: "string" } } } }],
      },
    }) as unknown as ExtensionModel;
  const provider = (store: SecretStore, userId: string, interactive?: { state: string; personaId?: string }) =>
    new KeyVaultMcpOAuthProvider({
      extensionId: EXT_ID,
      serverUrl: `${origin}/mcp`,
      userId,
      redirectUrl,
      store,
      interactive,
    });
  /** Starts a sign-in like StartMcpOAuth; returns the state. http fake server: capture the URL ourselves. */
  const startSignIn = async (store: SecretStore, userId: string, personaId?: string) => {
    const state = createMcpOAuthState(EXT_ID);
    const p = provider(store, userId, { state, personaId });
    const captured: URL[] = [];
    p.redirectToAuthorization = (u: URL) => void captured.push(u);
    expect(await auth(p, { serverUrl: `${origin}/mcp`, fetchFn: looseFetch() })).toBe("REDIRECT");
    return { state, authorizeUrl: captured[0] };
  };
  const callbackDeps = (store: SecretStore, usable: boolean) => ({
    store,
    findUsableExtension: vi.fn(async () => (usable ? extension() : undefined)),
    redirectUrl: () => redirectUrl,
    fetchFn: looseFetch(),
    refreshOwnerTools: vi.fn(async () => {}),
  });
  const callTool = async (store: SecretStore, userId: string) => {
    const tools = Object.fromEntries(
      await mcpExtensionTools(
        extension(),
        {
          url: `${origin}/mcp`,
          transport: "streamable-http",
          headers: {},
          authProvider: provider(store, userId),
          fetch: looseFetch(),
        },
        openMcpSession,
        "agent-1"
      )
    );
    return (tools["OAuthExt_get_price"] as unknown as {
      execute: (a: unknown, o: object) => Promise<unknown>;
    }).execute({ symbol: "ABB" }, {});
  };

  it("user A connected, user B not: B gets the Connect action, B connects, then B's call works", async () => {
    const store = memoryStore();

    // User A signs in through the callback.
    const a = await startSignIn(store, "userA", "agent-1");
    expect(a.authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(a.authorizeUrl.searchParams.get("state")).toBe(a.state);
    const aResult = await completeMcpOAuthCallback(
      { code: "code-userA", state: a.state, userId: "userA" },
      callbackDeps(store, true)
    );
    expect(aResult).toEqual({ ok: true, returnTo: undefined });
    expect(lastTokenRequest).toContain("code_verifier=");
    expect(await callTool(store, "userA")).toEqual({ text: "ABB: 42.00" });

    // User B has no token: no failure, a Connect action for B.
    expect(await callTool(store, "userB")).toEqual({
      text: expect.stringContaining("Connect Fake OAuth server"),
      mcpConnect: { extensionId: EXT_ID, extensionName: "Fake OAuth server", personaId: "agent-1" },
    });

    // B connects with B's own account; A's token is untouched.
    const b = await startSignIn(store, "userB", "agent-1");
    const bResult = await completeMcpOAuthCallback(
      { code: "code-userB", state: b.state, userId: "userB" },
      callbackDeps(store, true)
    );
    expect(bResult.ok).toBe(true);
    const bTokens = await provider(store, "userB").tokens();
    const aTokens = await provider(store, "userA").tokens();
    expect(validTokens.get(bTokens!.access_token)).toBe("userB");
    expect(validTokens.get(aTokens!.access_token)).toBe("userA");
    expect(await callTool(store, "userB")).toEqual({ text: "ABB: 42.00" });
  });

  it("refuses the callback for a user without access to the extension", async () => {
    const store = memoryStore();
    const c = await startSignIn(store, "userC");
    const deps = callbackDeps(store, false);
    const result = await completeMcpOAuthCallback({ code: "code-userC", state: c.state, userId: "userC" }, deps);
    expect(result).toMatchObject({ ok: false, reason: "no-access" });
    expect(await provider(store, "userC").tokens()).toBeUndefined();
    // The pending sign-in is used up.
    expect(await readPendingMcpOAuth(store, EXT_ID, "userC")).toBeUndefined();
  });

  it("refuses a callback whose state belongs to another user's sign-in", async () => {
    const store = memoryStore();
    const a = await startSignIn(store, "userA");
    const result = await completeMcpOAuthCallback(
      { code: "code-userX", state: a.state, userId: "userX" },
      callbackDeps(store, true)
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid-state" });
  });

  it("refreshes an expired access token through the SDK and stores the new one", async () => {
    const store = memoryStore();
    await provider(store, "userD").saveTokens({
      access_token: "expired-token",
      token_type: "Bearer",
      refresh_token: "refresh-userD",
    });
    expect(await callTool(store, "userD")).toEqual({ text: "ABB: 42.00" });
    const refreshed = await provider(store, "userD").tokens();
    expect(refreshed?.access_token).not.toBe("expired-token");
    expect(validTokens.get(refreshed!.access_token)).toBe("userD");
    expect(lastTokenRequest).toContain("grant_type=refresh_token");
  });

  it("the owner's connection feeds the save-time tool list", async () => {
    const store = memoryStore();
    const o = await startSignIn(store, "owner");
    const deps = callbackDeps(store, true);
    await completeMcpOAuthCallback({ code: "code-owner", state: o.state, userId: "owner" }, deps);
    expect(deps.refreshOwnerTools).toHaveBeenCalledTimes(1);
    const b = await startSignIn(store, "userB");
    const depsB = callbackDeps(store, true);
    await completeMcpOAuthCallback({ code: "code-userB", state: b.state, userId: "userB" }, depsB);
    expect(depsB.refreshOwnerTools).not.toHaveBeenCalled();
  });
});
