import "server-only";

// Why there is no "use server" here: these functions return secret values.
// A "use server" module turns its exports into endpoints a browser can call,
// so secret reads must live in a plain server-only module that only other
// server code imports.

import { AzureKeyVaultInstance } from "@/features/common/services/key-vault";

export const KEY_VAULT_MASK = "**********";

/** Minimal secret store, so OAuth state and tests do not depend on Key Vault directly. */
export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  ((error as { statusCode?: number }).statusCode === 404 ||
    (error as { code?: string }).code === "SecretNotFound");

export function keyVaultSecretStore(): SecretStore {
  const vault = AzureKeyVaultInstance();
  return {
    async get(name) {
      try {
        const secret = await vault.getSecret(name);
        return secret.value || undefined;
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    async set(name, value) {
      await vault.setSecret(name, value);
    },
    async remove(name) {
      try {
        await vault.beginDeleteSecret(name);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  };
}

/**
 * Reads one extension secret (header value, MCP secret, OAuth client secret).
 * Server code only; never call this to send a value to the browser.
 */
export async function readExtensionSecret(
  id: string,
  store: SecretStore = keyVaultSecretStore()
): Promise<string | undefined> {
  return store.get(id);
}

/** Key Vault names of the OAuth records of one MCP extension (alphanumeric id + dashes). */
export const mcpOAuthSecretNames = (extensionId: string) => ({
  tokens: `${extensionId}-mcp-oauth-tokens`,
  client: `${extensionId}-mcp-oauth-client`,
  pending: `${extensionId}-mcp-oauth-pending`,
  clientSecret: `${extensionId}-mcp-oauth-cs`,
});
