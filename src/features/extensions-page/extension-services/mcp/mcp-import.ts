// Client-safe helpers for Remote MCP extensions (no server imports).

import type { McpSecretPlacement, McpTransport } from "../models";

export interface McpImportResult {
  url?: string;
  transport?: McpTransport;
  secrets: Array<{ name: string; value: string; placement: McpSecretPlacement }>;
  errors: string[];
}

const TRANSPORT_ALIASES: Record<string, McpTransport> = {
  "streamable-http": "streamable-http",
  streamablehttp: "streamable-http",
  http: "streamable-http",
  sse: "sse",
};

/**
 * Parses the plain-text connection format MCP providers hand out, e.g.
 *
 *   type: streamable-http
 *   url: https://example.com/mcp
 *   MY_SERVER_TOKEN=abc123
 *
 * `key: value` lines set the transport and URL; `NAME=value` lines are
 * secrets. Blank lines and lines that start with `#` are ignored. Secrets
 * default to `Authorization: Bearer` because that is what the MCP
 * authorization spec and most hosted servers expect; the owner can change
 * the placement per secret afterwards.
 *
 * Error messages never contain secret values.
 */
export function parseMcpImportText(text: string): McpImportResult {
  const result: McpImportResult = { secrets: [], errors: [] };
  const lines = text.split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;

    const secretMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    const keyValueMatch = line.match(/^([A-Za-z_-]+)\s*:\s*(.+)$/);

    // `url: https://...` also contains "=" in query strings, so the
    // key: value form wins when the key is one we know.
    if (keyValueMatch && ["type", "transport", "url"].includes(keyValueMatch[1].toLowerCase())) {
      const key = keyValueMatch[1].toLowerCase();
      const value = keyValueMatch[2].trim();
      if (key === "url") {
        result.url = value;
      } else {
        const transport = TRANSPORT_ALIASES[value.toLowerCase()];
        if (transport) result.transport = transport;
        else result.errors.push(`Line ${index + 1}: transport "${value}" is not supported`);
      }
      return;
    }

    if (secretMatch) {
      const name = secretMatch[1];
      const value = secretMatch[2].trim().replace(/^(['"])(.*)\1$/, "$2");
      if (!value) {
        result.errors.push(`Line ${index + 1}: secret ${name} has no value`);
        return;
      }
      result.secrets.push({ name, value, placement: "bearer" });
      return;
    }

    result.errors.push(`Line ${index + 1}: format not recognized`);
  });

  return result;
}
