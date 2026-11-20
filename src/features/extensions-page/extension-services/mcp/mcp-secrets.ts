// Pure helper: turns resolved MCP secrets into request headers and URL.
// No server imports, so it is unit-testable; it handles secret VALUES, so
// only server code may call it with real data.

import { mcpSecretTargetName, type McpSecretPlacement } from "../models";

export interface ResolvedMcpSecret {
  name: string;
  placement: McpSecretPlacement;
  target?: string;
  value: string;
}

/**
 * bearer → `Authorization: Bearer <value>`
 * header → `<target or name>: <value>`
 * query  → `?<target or name>=<value>` on the server URL
 */
export function applyMcpSecrets(
  url: string,
  secrets: readonly ResolvedMcpSecret[]
): { url: string; headers: Record<string, string> } {
  const target = new URL(url);
  const headers: Record<string, string> = {};
  for (const secret of secrets) {
    const name = mcpSecretTargetName(secret);
    switch (secret.placement) {
      case "bearer":
        headers.Authorization = `Bearer ${secret.value}`;
        break;
      case "header":
        headers[name] = secret.value;
        break;
      case "query":
        target.searchParams.set(name, secret.value);
        break;
    }
  }
  return { url: target.toString(), headers };
}
