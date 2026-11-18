import "server-only";

// No "use server": takes secret values and injectable dependencies. The
// browser reaches it only through DiscoverDraftMcpTools (mcp-service.ts).

import { logWarn } from "@/features/common/services/logger";
import type { ServerActionResponse } from "@/features/common/server-action-response";
import { planMcpConfig } from "../extension-save";
import { KEY_VAULT_MASK, type SecretStore } from "../extension-secrets";
import {
  McpConfigSchema,
  McpTransportSchema,
  mcpHeaderErrors,
  mcpSecretTargetName,
  type ExtensionModel,
  type McpSecretPlacement,
  type McpToolInfo,
  type McpTransport,
} from "../models";
import { describeMcpError, listMcpTools, MCP_LIMITS, openMcpSession, type McpSessionFactory } from "./mcp-client";
import { sanitizeDiscoveredTools } from "./mcp-discovery";
import { createGuardedFetch, type McpFetch } from "./mcp-fetch";
import { applyMcpSecrets, type ResolvedMcpSecret } from "./mcp-secrets";

/** What the form sends: the connection as typed, not yet saved. */
export interface McpDraftInput {
  /** Id of the saved extension being edited; empty for a new one. */
  extensionId?: string;
  url: string;
  transport: McpTransport;
  /** Header rows. A saved row that was not retyped carries the mask as value. */
  secrets: Array<{
    id: string;
    name: string;
    placement: McpSecretPlacement;
    target?: string;
    value: string;
  }>;
}

export interface McpDraftDiscoveryDeps {
  /**
   * The stored extension if the current user may EDIT it (the edit check of
   * Update/Delete: owner or admin); otherwise undefined.
   */
  loadEditable: (extensionId: string) => Promise<ExtensionModel | undefined>;
  store: SecretStore;
  openSession?: McpSessionFactory;
  /** Override for tests; production uses the guarded fetch with its SSRF guard. */
  fetch?: McpFetch;
}

/** Hard limit for one request of the draft discovery (headers and body). */
export const MCP_DRAFT_TIMEOUT_MS = 15_000;
const MAX_VALUE_CHARS = 8_192;

const fail = (...messages: string[]): ServerActionResponse<never> => ({
  status: "ERROR",
  errors: messages.map((message) => ({ message })),
});

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * tools/list against a connection that is not saved yet (sign-in None).
 *
 * The same rules as save and runtime apply: the header checks of save
 * (mcpHeaderErrors + planMcpConfig), an https URL, and the guarded fetch of
 * the runtime (extension URL guard: https only, no private, loopback,
 * link-local or metadata addresses; no redirects followed by fetch; size
 * limit) with a hard timeout. A row that shows the saved mask uses the value
 * stored in Key Vault for that row id of THIS extension, only for a user who
 * may edit the extension. Returns tool names, descriptions and input
 * schemas only; never a header, a value or a response header.
 */
export async function discoverDraftMcpTools(
  input: McpDraftInput,
  deps: McpDraftDiscoveryDeps
): Promise<ServerActionResponse<McpToolInfo[]>> {
  // The browser is not trusted: check the shape before anything else.
  if (!input || typeof input !== "object") return fail("The MCP server settings are not valid.");
  const extensionId = isString(input.extensionId) ? input.extensionId : "";
  if (input.extensionId !== undefined && !isString(input.extensionId)) {
    return fail("Extension not found.");
  }
  if (extensionId && !/^[A-Za-z0-9]{1,64}$/.test(extensionId)) return fail("Extension not found.");

  const url = McpConfigSchema.shape.url.safeParse(input.url);
  if (!url.success) return fail(url.error.issues[0]?.message ?? "Server URL must be a valid https URL");
  const transport = McpTransportSchema.safeParse(input.transport);
  if (!transport.success) return fail("Choose a transport.");

  if (!Array.isArray(input.secrets)) return fail("The headers are not valid.");
  if (input.secrets.length > 20) return fail("Use up to 20 headers.");
  const secrets = input.secrets.map((s) => ({
    id: isString(s?.id) ? s.id : "",
    name: isString(s?.name) ? s.name : "",
    placement: (["header", "bearer", "query"] as const).includes(s?.placement as McpSecretPlacement)
      ? (s.placement as McpSecretPlacement)
      : "header",
    target: isString(s?.target) ? s.target : undefined,
    value: isString(s?.value) ? s.value : "",
  }));
  if (secrets.some((s) => s.value.length > MAX_VALUE_CHARS)) return fail("A header value is too long.");

  // Header rules of save: names, reserved headers, duplicates.
  const headerErrors = mcpHeaderErrors({ auth: "none", secrets });
  if (headerErrors.length > 0) return fail(...headerErrors);

  let stored: ExtensionModel | undefined;
  if (extensionId) {
    stored = await deps.loadEditable(extensionId);
    if (!stored) {
      return { status: "UNAUTHORIZED", errors: [{ message: "Only the extension owner can do this." }] };
    }
    if (stored.kind !== "mcp" || !stored.mcp) return fail("This extension is not a Remote MCP server.");
  }

  // Value rules of save: a mask only on a row this extension stores, with
  // the same placement; every other row needs a typed value.
  const { config, plan } = planMcpConfig(
    stored?.id ?? "draft",
    { url: url.data, transport: transport.data, secrets, toolAllowList: [], auth: "none" },
    stored?.mcp,
    () => "draft-row"
  );
  if (plan.errors.length > 0) return fail(...plan.errors);

  const resolved: ResolvedMcpSecret[] = [];
  for (const [index, secret] of config.secrets.entries()) {
    // A masked row passed planMcpConfig only with an id of THIS stored
    // extension, so the Key Vault read cannot reach another extension.
    const value =
      secrets[index].value === KEY_VAULT_MASK
        ? await deps.store.get(secret.id).catch(() => undefined)
        : secrets[index].value;
    if (!value) return fail(`The saved value of header ${mcpSecretTargetName(secret)} could not be read.`);
    resolved.push({ name: secret.name, placement: secret.placement, target: secret.target, value });
  }

  try {
    const { url: target, headers } = applyMcpSecrets(config.url, resolved);
    const tools = await listMcpTools(
      {
        url: target,
        transport: config.transport,
        headers,
        fetch:
          deps.fetch ??
          createGuardedFetch({
            timeoutMs: MCP_DRAFT_TIMEOUT_MS,
            maxResponseBytes: MCP_LIMITS.maxResponseBytes,
          }),
      },
      deps.openSession ?? openMcpSession
    );
    return { status: "OK", response: sanitizeDiscoveredTools(tools) };
  } catch (error) {
    const message = describeMcpError(error);
    // Never log the URL (it may carry a query value), a header or a value.
    logWarn("discoverDraftMcpTools: failed", { extensionId: extensionId || undefined, reason: message });
    return fail(message);
  }
}
