import "server-only";

// Why there is no "use server" here: these functions return secret values.
// A "use server" module turns its exports into endpoints a browser can call,
// so secret reads must live in a plain server-only module that only other
// server code imports.

import { createHash } from "node:crypto";
import { AzureKeyVaultInstance } from "@/features/common/services/key-vault";

export const KEY_VAULT_MASK = "**********";

/** Minimal secret store, so OAuth state and tests do not depend on Key Vault directly. */
export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  /** `tags` mark entries for removeTagged (e.g. per-user OAuth tokens). */
  set(name: string, value: string, tags?: Record<string, string>): Promise<void>;
  remove(name: string): Promise<void>;
  /** Deletes every entry carrying this tag. Returns how many were deleted. */
  removeTagged(tag: string, value: string): Promise<number>;
}

/** Tag on every Key Vault entry that belongs to one MCP extension. */
export const MCP_EXTENSION_TAG = "mcpExtension";

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
    async set(name, value, tags) {
      if (tags) await vault.setSecret(name, value, { tags });
      else await vault.setSecret(name, value);
    },
    async remove(name) {
      try {
        await vault.beginDeleteSecret(name);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    async removeTagged(tag, value) {
      // Lists the vault (needs the "list" secret permission) and deletes the
      // enabled entries with this tag.
      let deleted = 0;
      for await (const properties of vault.listPropertiesOfSecrets()) {
        if (properties.tags?.[tag] !== value) continue;
        try {
          await vault.beginDeleteSecret(properties.name);
          deleted++;
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      return deleted;
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

/**
 * Key Vault names of the OAuth records of one MCP extension.
 *
 * Extension-level (shared): the client registration and an optional
 * pre-registered client secret. Per user: tokens and the pending sign-in.
 * User records are named after a hash of extension id + user id, so no
 * user id appears in a Key Vault name; they carry the extension tag so
 * DeleteExtension can remove them without knowing the users.
 */
export const mcpOAuthSecretNames = (extensionId: string) => ({
  client: `${extensionId}-mcp-oauth-client`,
  clientSecret: `${extensionId}-mcp-oauth-cs`,
});

export const mcpOAuthUserKey = (extensionId: string, userId: string): string =>
  createHash("sha256").update(`${extensionId}:${userId}`).digest("hex").slice(0, 48);

export const mcpOAuthUserSecretNames = (extensionId: string, userId: string) => {
  const key = mcpOAuthUserKey(extensionId, userId);
  return { tokens: `mcp-tok-${key}`, pending: `mcp-pend-${key}` };
};
