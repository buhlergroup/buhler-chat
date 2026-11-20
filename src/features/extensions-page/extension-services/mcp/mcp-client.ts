import "server-only";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpToolInfo, McpTransport } from "../models";
import { createGuardedFetch, type McpFetch } from "./mcp-fetch";
import { AI_NAME } from "@/features/theme/theme-config";
import { McpOAuthRequiredError, mcpClientSlug } from "./mcp-oauth";

/** Limits for one MCP exchange. */
export const MCP_LIMITS = {
  /** connect + initialize */
  connectTimeoutMs: 10_000,
  /** tools/list at save time or at chat time */
  listTimeoutMs: 10_000,
  /** one tools/call */
  callTimeoutMs: 60_000,
  /** largest HTTP response body accepted from the server */
  maxResponseBytes: 2 * 1024 * 1024,
  /** most tools taken from one server */
  maxTools: 128,
  /** most tools/list pages read */
  maxListPages: 10,
};

/** Everything needed to reach one MCP server. Holds secret values: never log it. */
export interface McpConnectionOptions {
  url: string;
  transport: McpTransport;
  headers: Record<string, string>;
  authProvider?: OAuthClientProvider;
  /** Override for tests; production uses the guarded fetch. */
  fetch?: McpFetch;
}

export interface McpCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** A connected MCP session. Small on purpose so tests can fake it. */
export interface McpSession {
  listTools(cursor?: string): Promise<{ tools: McpToolInfo[]; nextCursor?: string }>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}

export type McpSessionFactory = (options: McpConnectionOptions) => Promise<McpSession>;

const CLIENT_INFO = { name: mcpClientSlug(AI_NAME), version: "1.0.0" };

function wrapClient(client: Client): McpSession {
  return {
    async listTools(cursor) {
      const result = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: MCP_LIMITS.listTimeoutMs,
      });
      return {
        tools: result.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        })),
        nextCursor: result.nextCursor,
      };
    },
    async callTool(name, args, signal) {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: MCP_LIMITS.callTimeoutMs,
        signal,
      });
      return result as McpCallResult;
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}

async function connectWith(
  transport: "streamable-http" | "sse",
  options: McpConnectionOptions,
  fetchImpl: McpFetch
): Promise<McpSession> {
  const url = new URL(options.url);
  // No requestInit headers: the SDK would also send them to the OAuth
  // authorization server. The header rows go in through the fetch instead.
  const serverFetch = withServerOriginHeaders(fetchImpl, options.url, options.headers);
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const clientTransport =
    transport === "streamable-http"
      ? new StreamableHTTPClientTransport(url, {
          authProvider: options.authProvider,
          fetch: serverFetch,
          redirectPolicy: "same-origin",
          // Short-lived sessions: one connect per list or call.
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1,
          },
        })
      : new SSEClientTransport(url, {
          authProvider: options.authProvider,
          // Also used for the event stream when no eventSourceInit.fetch is set.
          fetch: serverFetch,
        });
  try {
    await client.connect(clientTransport, { timeout: MCP_LIMITS.connectTimeoutMs });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return wrapClient(client);
}

/**
 * Adds the static header rows to requests for the MCP server's own origin
 * only. The SDK sends `requestInit` headers with every request, including
 * OAuth discovery, registration and token requests to the authorization
 * server, which must not receive an API key meant for the MCP server.
 * Header rows win over SDK headers of the same name, as with requestInit.
 */
export function withServerOriginHeaders(
  fetchImpl: McpFetch,
  serverUrl: string,
  headers: Record<string, string>
): McpFetch {
  const entries = Object.entries(headers);
  if (entries.length === 0) return fetchImpl;
  const serverOrigin = new URL(serverUrl).origin;
  return (input, init) => {
    const url = typeof input === "string" ? input : input.href;
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === serverOrigin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) return fetchImpl(input, init);
    const merged = new Headers(init?.headers);
    for (const [name, value] of entries) merged.set(name, value);
    return fetchImpl(input, { ...init, headers: merged });
  };
}

export const isMcpAuthError =(error: unknown): boolean =>
  error instanceof UnauthorizedError || error instanceof McpOAuthRequiredError;

/**
 * Opens an MCP session with the official SDK client. "auto" tries Streamable
 * HTTP and falls back to the legacy HTTP+SSE transport, as the MCP spec
 * recommends for backwards compatibility. An auth failure never falls back.
 */
export const openMcpSession: McpSessionFactory = async (options) => {
  const fetchImpl =
    options.fetch ??
    createGuardedFetch({
      timeoutMs: MCP_LIMITS.callTimeoutMs,
      maxResponseBytes: MCP_LIMITS.maxResponseBytes,
    });

  if (options.transport === "sse") return connectWith("sse", options, fetchImpl);
  if (options.transport === "streamable-http") {
    return connectWith("streamable-http", options, fetchImpl);
  }
  try {
    return await connectWith("streamable-http", options, fetchImpl);
  } catch (error) {
    if (isMcpAuthError(error)) throw error;
    return connectWith("sse", options, fetchImpl);
  }
};

/** Reads the server's tool list (paginated, capped). */
export async function listMcpTools(
  options: McpConnectionOptions,
  openSession: McpSessionFactory = openMcpSession
): Promise<McpToolInfo[]> {
  const session = await openSession(options);
  try {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MCP_LIMITS.maxListPages; page++) {
      const result = await session.listTools(cursor);
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor || tools.length >= MCP_LIMITS.maxTools) break;
    }
    return tools.slice(0, MCP_LIMITS.maxTools);
  } finally {
    await session.close();
  }
}

/**
 * Maps any MCP failure to a short message that is safe to show to the model
 * and the user: no URL (it may carry a query secret), no header, no body.
 */
export function describeMcpError(error: unknown): string {
  if (isMcpAuthError(error)) {
    return "The MCP server needs a sign-in. Connect the extension and try again.";
  }
  const name = (error as { name?: string })?.name;
  const code = (error as { code?: number })?.code;
  if (name === "McpResponseTooLargeError") return "The MCP server sent a response that is too large.";
  if (name === "TimeoutError" || name === "AbortError" || code === -32001) {
    return "The MCP server did not answer in time.";
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("non-public address") || message.includes("must use https")) {
    return "The MCP server address is not allowed.";
  }
  return "The MCP server request failed.";
}
