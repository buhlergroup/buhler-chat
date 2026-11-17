import "server-only";

import { jsonSchema, tool } from "ai";
import type { Tool } from "@ai-sdk/provider-utils";
import { logError, logInfo, logWarn } from "@/features/common/services/logger";
import type { ExtensionModel, McpToolInfo } from "@/features/extensions-page/extension-services/models";
import {
  describeMcpError,
  isMcpAuthError,
  listMcpTools,
  openMcpSession,
  type McpCallResult,
  type McpConnectionOptions,
  type McpSessionFactory,
} from "@/features/extensions-page/extension-services/mcp/mcp-client";
import { buildExtensionToolKey } from "./tool-key";

/** Most characters of tool output handed back to the model. */
export const MAX_MCP_TOOL_OUTPUT_CHARS = 100_000;
/** Longest tool description forwarded to the model. */
const MAX_DESCRIPTION_CHARS = 2_000;

const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {} };

const safeHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
};

/** The tools the model may see: the allow-list filters, an empty list allows all. */
export function filterMcpTools(tools: McpToolInfo[], allowList: readonly string[]): McpToolInfo[] {
  if (allowList.length === 0) return tools;
  const allowed = new Set(allowList);
  return tools.filter((t) => allowed.has(t.name));
}

/** A JSON schema the providers accept as function parameters (must be an object schema). */
export function normalizeMcpInputSchema(schema: Record<string, unknown> | undefined) {
  if (!schema || schema.type !== "object") return EMPTY_OBJECT_SCHEMA;
  return { ...schema, properties: schema.properties ?? {} };
}

const truncate = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}\n[output truncated]` : text;

/**
 * Turns an MCP CallToolResult into tool output for the model: the text parts
 * joined, plus structuredContent when the server sends it. Images, audio and
 * binary resources are named, not forwarded. Output is capped.
 */
export function mapMcpCallResult(result: McpCallResult): { text: string; structuredContent?: unknown } {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    const part = item as {
      type?: string;
      text?: string;
      mimeType?: string;
      resource?: { uri?: string; text?: string; mimeType?: string };
      uri?: string;
      name?: string;
    };
    switch (part.type) {
      case "text":
        parts.push(part.text ?? "");
        break;
      case "resource":
        parts.push(part.resource?.text ?? `[resource ${part.resource?.uri ?? ""} (${part.resource?.mimeType ?? "binary"}) not shown]`);
        break;
      case "resource_link":
        parts.push(`[resource link: ${part.name ?? ""} ${part.uri ?? ""}]`.trim());
        break;
      case "image":
      case "audio":
        parts.push(`[${part.type} (${part.mimeType ?? "unknown type"}) not shown]`);
        break;
      default:
        parts.push(`[${part.type ?? "unknown"} content not shown]`);
    }
  }

  const text = truncate(parts.join("\n"), MAX_MCP_TOOL_OUTPUT_CHARS);
  if (result.structuredContent === undefined) return { text };

  const structuredJson = JSON.stringify(result.structuredContent);
  if (structuredJson === undefined || structuredJson.length > MAX_MCP_TOOL_OUTPUT_CHARS) {
    return { text };
  }
  return { text, structuredContent: result.structuredContent };
}

/**
 * Tool output when an OAuth MCP server has no (valid) sign-in for the
 * chatting user. Not an error: the model tells the user to connect, and the
 * chat renders a "Connect <extension>" button from `mcpConnect`
 * (tool-part-view.tsx) that starts the per-user sign-in.
 */
export interface McpConnectRequired {
  text: string;
  mcpConnect: { extensionId: string; extensionName: string; personaId?: string };
}

export const mcpConnectRequired = (
  extension: Pick<ExtensionModel, "id" | "name">,
  personaId?: string
): McpConnectRequired => ({
  text:
    `The user is not connected to "${extension.name}". Ask the user to select ` +
    `"Connect ${extension.name}" below this message, sign in, and then ask again.`,
  mcpConnect: { extensionId: extension.id, extensionName: extension.name, personaId },
});

/** One MCP server tool as an AI SDK tool. Every call opens its own short session. */
export function mcpTool(
  extension: ExtensionModel,
  info: McpToolInfo,
  connection: McpConnectionOptions,
  openSession: McpSessionFactory = openMcpSession,
  personaId?: string
): Tool {
  return tool({
    description: truncate(info.description ?? `Tool ${info.name} of ${extension.name}`, MAX_DESCRIPTION_CHARS),
    inputSchema: jsonSchema(normalizeMcpInputSchema(info.inputSchema) as Parameters<typeof jsonSchema>[0]),
    execute: async (rawArgs: unknown, { abortSignal }: { abortSignal?: AbortSignal }) => {
      const args =
        typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
      let result: McpCallResult;
      try {
        const session = await openSession(connection);
        try {
          result = await session.callTool(info.name, args, abortSignal);
        } finally {
          await session.close();
        }
      } catch (error) {
        if (extension.mcp?.auth === "oauth" && isMcpAuthError(error)) {
          logInfo("mcpTool: user not connected to OAuth MCP server", {
            extensionId: extension.id,
            tool: info.name,
          });
          return mcpConnectRequired(extension, personaId);
        }
        // Log the host only: the URL can carry a query-string secret.
        logError("mcpTool: call failed", {
          extensionId: extension.id,
          tool: info.name,
          host: safeHost(connection.url),
          errorName: (error as { name?: string })?.name,
        });
        throw new Error(`${extension.name} / ${info.name}: ${describeMcpError(error)}`);
      }

      const mapped = mapMcpCallResult(result);
      if (result.isError) {
        // The server reports a tool-level error; the model gets its text.
        throw new Error(
          `${extension.name} / ${info.name} returned an error: ${truncate(mapped.text, 1_000)}`
        );
      }
      return mapped;
    },
  });
}

/**
 * All tools of one Remote MCP extension, keyed like the HTTP extension tools
 * (`<8-char extension id>_<tool name>`).
 *
 * The tool list comes from the last discovery stored on the extension. That
 * keeps the toolset (and the prompt-cache prefix) stable and costs no network
 * round trip per turn. Only an extension without a stored list is asked live,
 * with a timeout; if that fails the extension is skipped and the chat goes on
 * without it.
 */
export async function mcpExtensionTools(
  extension: ExtensionModel,
  connection: McpConnectionOptions,
  openSession: McpSessionFactory = openMcpSession,
  personaId?: string
): Promise<Array<[string, Tool]>> {
  const config = extension.mcp;
  if (!config) return [];

  let tools = config.tools;
  if (!tools) {
    try {
      tools = await listMcpTools(connection, openSession);
      logInfo("mcpExtensionTools: listed tools at chat time", {
        extensionId: extension.id,
        count: tools.length,
      });
    } catch (error) {
      logWarn("mcpExtensionTools: tools/list failed, extension skipped", {
        extensionId: extension.id,
        host: safeHost(connection.url),
        reason: describeMcpError(error),
      });
      return [];
    }
  }

  return filterMcpTools(tools, config.toolAllowList).map((info) => [
    buildExtensionToolKey(extension.id, info.name),
    mcpTool(extension, info, connection, openSession, personaId),
  ]);
}
