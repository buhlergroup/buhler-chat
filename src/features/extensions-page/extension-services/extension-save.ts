import "server-only";

// Pure planning for saving an extension's secrets. The browser sends masked
// values for secrets it does not change; this module decides which Key Vault
// entries to write and delete, and refuses ids the stored extension does not
// own. Without that check, an owner could send ANOTHER extension's header id
// with the mask as value and make the chat read that extension's secret.

import { KEY_VAULT_MASK, mcpOAuthSecretNames } from "./extension-secrets";
import type { HeaderModel, McpConfigModel } from "./models";

export interface SecretPlan {
  writes: Array<{ name: string; value: string }>;
  deletes: string[];
  errors: string[];
}

const emptyPlan = (): SecretPlan => ({ writes: [], deletes: [], errors: [] });

/**
 * Headers of an HTTP extension. An id the stored extension has keeps its
 * entry (mask = unchanged, value = replace). Any other id gets a new id and
 * needs a real value. Headers left out are deleted.
 */
export function planHeaders(
  input: readonly HeaderModel[],
  stored: readonly HeaderModel[] | undefined,
  newId: () => string
): { headers: HeaderModel[]; plan: SecretPlan } {
  const plan = emptyPlan();
  const storedIds = new Set((stored ?? []).map((h) => h.id));
  const headers = input.map((h) => {
    const known = !!h.id && storedIds.has(h.id);
    const id = known ? h.id : newId();
    if (h.value === KEY_VAULT_MASK) {
      if (!known) plan.errors.push(`Enter a value for header ${h.key}`);
    } else {
      plan.writes.push({ name: id, value: h.value });
    }
    return { ...h, id, value: KEY_VAULT_MASK };
  });
  const kept = new Set(headers.map((h) => h.id));
  plan.deletes.push(...[...storedIds].filter((id) => !kept.has(id)));
  return { headers, plan };
}

/**
 * Remote MCP settings. Secrets follow the header rules above. The
 * discovered tool list is server-managed: taken from the stored extension,
 * never from the browser, and cleared when URL, transport or auth mode
 * change. OAuth tokens need no reset here: they are stored per user with
 * the server URL they were issued for and are ignored for another URL.
 */
export function planMcpConfig(
  extensionId: string,
  input: McpConfigModel,
  stored: McpConfigModel | undefined,
  newId: () => string
): { config: McpConfigModel; plan: SecretPlan; connectionChanged: boolean } {
  const plan = emptyPlan();
  const storedSecretIds = new Set((stored?.secrets ?? []).map((s) => s.id));

  const secrets = input.secrets.map((s) => {
    const known = !!s.id && storedSecretIds.has(s.id);
    const id = known ? s.id : newId();
    if (s.value === KEY_VAULT_MASK) {
      if (!known) plan.errors.push(`Enter a value for secret ${s.name}`);
    } else {
      plan.writes.push({ name: id, value: s.value });
    }
    return { ...s, id, target: s.target || undefined, value: KEY_VAULT_MASK };
  });
  const kept = new Set(secrets.map((s) => s.id));
  plan.deletes.push(...[...storedSecretIds].filter((id) => !kept.has(id)));

  const connectionChanged =
    !stored ||
    stored.url !== input.url ||
    stored.transport !== input.transport ||
    stored.auth !== input.auth ||
    (stored.oauth?.clientId ?? "") !== (input.oauth?.clientId ?? "");

  const names = mcpOAuthSecretNames(extensionId);
  let oauth: McpConfigModel["oauth"];
  if (input.auth === "oauth") {
    const clientSecretInput = input.oauth?.clientSecret ?? "";
    let clientSecret: string | undefined;
    if (clientSecretInput === KEY_VAULT_MASK) {
      clientSecret = stored?.oauth?.clientSecret ? KEY_VAULT_MASK : undefined;
    } else if (clientSecretInput) {
      plan.writes.push({ name: names.clientSecret, value: clientSecretInput });
      clientSecret = KEY_VAULT_MASK;
    }
    oauth = {
      clientId: input.oauth?.clientId || undefined,
      clientSecret,
      scopes: input.oauth?.scopes || undefined,
    };
  }

  const config: McpConfigModel = {
    url: input.url,
    transport: input.transport,
    secrets,
    toolAllowList: [...new Set(input.toolAllowList.map((t) => t.trim()).filter(Boolean))],
    auth: input.auth,
    oauth,
    tools: connectionChanged ? undefined : stored?.tools,
    toolsDiscoveredAt: connectionChanged ? undefined : stored?.toolsDiscoveredAt,
  };
  return { config, plan, connectionChanged };
}

/**
 * Key Vault entries of an extension known by name, for delete. Per-user
 * OAuth records are found by their extension tag (SecretStore.removeTagged).
 */
export function extensionSecretNames(extension: {
  id: string;
  headers?: readonly HeaderModel[];
  mcp?: McpConfigModel;
}): string[] {
  const names = (extension.headers ?? []).map((h) => h.id);
  if (extension.mcp) {
    names.push(...extension.mcp.secrets.map((s) => s.id));
    if (extension.mcp.auth === "oauth") {
      const oauth = mcpOAuthSecretNames(extension.id);
      names.push(oauth.client, oauth.clientSecret);
    }
  }
  return names;
}
