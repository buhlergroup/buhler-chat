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
import { KeyVaultMcpOAuthProvider } from "./mcp-oauth";
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

describe("OAuth sign-in against a local fake MCP server + authorization server", () => {
  let oauthServer: Server;
  let origin: string;
  const issued = { code: "fake-code", token: "fake-access-token" };
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
        return json(200, { access_token: issued.token, token_type: "Bearer", refresh_token: "fake-refresh", expires_in: 3600 });
      }
      if (url.pathname === "/mcp") {
        if (req.headers.authorization !== `Bearer ${issued.token}`) {
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
    return { get: async (n) => data.get(n), set: async (n, v) => void data.set(n, v), remove: async (n) => void data.delete(n) };
  };
  const looseFetch = () =>
    createGuardedFetch({ timeoutMs: 5_000, maxResponseBytes: 1_000_000, assertUrl: async () => {} });

  it("registers, signs in with PKCE, stores tokens, then lists tools with them", async () => {
    const store = memoryStore();
    const redirectUrl = "https://chat.example.com/api/extensions/mcp/oauth/callback";

    // 1. Owner starts the sign-in: dynamic registration + authorization URL.
    const starting = new KeyVaultMcpOAuthProvider({
      extensionId: "ext1",
      redirectUrl,
      store,
      interactive: { userId: "owner", state: "ext1.state" },
    });
    // The fake authorization server runs on http; the provider demands https
    // for real servers, so loosen only that check for this test.
    const captured: URL[] = [];
    starting.redirectToAuthorization = (u: URL) => void captured.push(u);
    expect(await auth(starting, { serverUrl: `${origin}/mcp`, fetchFn: looseFetch() })).toBe("REDIRECT");
    const authorizeUrl = captured[0];
    expect(authorizeUrl.pathname).toBe("/authorize");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("dyn-client-1");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("state")).toBe("ext1.state");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(redirectUrl);

    // 2. Callback: exchange the code (PKCE verifier from the pending record).
    const finishing = new KeyVaultMcpOAuthProvider({ extensionId: "ext1", redirectUrl, store });
    expect(
      await auth(finishing, { serverUrl: `${origin}/mcp`, authorizationCode: issued.code, fetchFn: looseFetch() })
    ).toBe("AUTHORIZED");
    expect(lastTokenRequest).toContain("code_verifier=");
    expect(await finishing.tokens()).toMatchObject({ access_token: issued.token });

    // 3. Chat time: non-interactive provider, tools listed with the stored token.
    const chatTime = new KeyVaultMcpOAuthProvider({ extensionId: "ext1", redirectUrl, store });
    const tools = await listMcpTools({
      url: `${origin}/mcp`,
      transport: "streamable-http",
      headers: {},
      authProvider: chatTime,
      fetch: looseFetch(),
    });
    expect(tools.map((t) => t.name)).toEqual(["get_price", "fail"]);
  });

  it("fails with a sign-in error at chat time when no token is stored", async () => {
    const chatTime = new KeyVaultMcpOAuthProvider({
      extensionId: "ext2",
      redirectUrl: "https://chat.example.com/cb",
      store: memoryStore(),
    });
    await expect(
      listMcpTools({ url: `${origin}/mcp`, transport: "auto", headers: {}, authProvider: chatTime, fetch: looseFetch() })
    ).rejects.toThrow(/sign-in|Unauthorized/i);
  });
});
