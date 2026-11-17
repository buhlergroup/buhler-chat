import "server-only";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpToolInfo, McpTransport } from "../models";
import { createGuardedFetch, type McpFetch } from "./mcp-fetch";
import { McpOAuthRequiredError } from "./mcp-oauth";

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

const CLIENT_INFO = { name: "buhler-chat", version: "1.0.0" };

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
  const requestInit: RequestInit = { headers: options.headers };
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const clientTransport =
    transport === "streamable-http"
      ? new StreamableHTTPClientTransport(url, {
          requestInit,
          authProvider: options.authProvider,
          fetch: fetchImpl,
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
          requestInit,
          authProvider: options.authProvider,
          // Also used for the event stream when no eventSourceInit.fetch is set.
          fetch: fetchImpl,
        });
  try {
    await client.connect(clientTransport, { timeout: MCP_LIMITS.connectTimeoutMs });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return wrapClient(client);
}

const isAuthError = (error: unknown) =>
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
    if (isAuthError(error)) throw error;
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
  if (isAuthError(error)) {
    return "The MCP server needs a sign-in. Ask the extension owner to connect it again.";
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
