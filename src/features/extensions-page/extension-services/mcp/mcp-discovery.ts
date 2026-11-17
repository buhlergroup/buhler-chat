import "server-only";

import { logWarn } from "@/features/common/services/logger";
import { buildMcpConnection } from "../extension-runtime";
import type { SecretStore } from "../extension-secrets";
import type { ExtensionModel, McpToolInfo } from "../models";
import { describeMcpError, listMcpTools, openMcpSession, type McpSessionFactory } from "./mcp-client";

/** Largest stored input schema per tool; bigger ones are stored without a schema. */
const MAX_SCHEMA_JSON_CHARS = 32_000;
const MAX_DESCRIPTION_CHARS = 2_000;
const TOOL_NAME = /^[A-Za-z0-9_.\-/]{1,128}$/;

/** Keeps the stored tool list small and well-formed (it lives in the Cosmos document). */
export function sanitizeDiscoveredTools(tools: readonly McpToolInfo[]): McpToolInfo[] {
  const seen = new Set<string>();
  const result: McpToolInfo[] = [];
  for (const t of tools) {
    if (!TOOL_NAME.test(t.name) || seen.has(t.name)) continue;
    seen.add(t.name);
    const schemaJson = t.inputSchema ? JSON.stringify(t.inputSchema) : undefined;
    result.push({
      name: t.name,
      description: t.description?.slice(0, MAX_DESCRIPTION_CHARS),
      inputSchema:
        schemaJson && schemaJson.length <= MAX_SCHEMA_JSON_CHARS ? t.inputSchema : undefined,
    });
  }
  return result;
}

export type McpDiscoveryResult =
  | { ok: true; tools: McpToolInfo[] }
  | { ok: false; error: string };

/** tools/list against the extension's server, with its secrets and OAuth tokens. */
export async function discoverMcpTools(
  extension: ExtensionModel,
  store: SecretStore,
  openSession: McpSessionFactory = openMcpSession
): Promise<McpDiscoveryResult> {
  try {
    // The stored tool list is the OWNER's view of the server (owner secrets
    // and, for OAuth servers, the owner's own sign-in).
    const connection = await buildMcpConnection(extension, store, extension.userId);
    if (!connection) return { ok: false, error: "This extension is not a Remote MCP server." };
    const tools = await listMcpTools(connection, openSession);
    return { ok: true, tools: sanitizeDiscoveredTools(tools) };
  } catch (error) {
    const message = describeMcpError(error);
    logWarn("discoverMcpTools: failed", { extensionId: extension.id, reason: message });
    return { ok: false, error: message };
  }
}
