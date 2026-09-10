/**
 * prompt-cache-key.ts
 *
 * Decides the `prompt_cache_key` a turn is sent with.
 *
 * Measured on dev against GPT-5.6: implicit caching matches PARTIAL prefixes,
 * and two conversations sent with the SAME prompt_cache_key and the same
 * developer message read each other's cached prefix. Different keys share
 * nothing. So keying on the thread id — today's default — means every new
 * thread pays to write the system prompt and tool block from scratch, even
 * though thousands of threads share exactly that prefix.
 *
 * The "persona" strategy trades that away: threads that share an agent AND a
 * toolset share one key, so the second thread onwards reads the prefix the
 * first one wrote. Two constraints shape the key:
 *
 *   - It must not span DIFFERENT prefixes, or the cache would thrash. Hence
 *     the persona id and a signature of the tool names in the key.
 *   - Azure rate-limits a single key+prefix to roughly 15 requests/minute, so
 *     a popular agent would throttle on one key. The key is therefore sharded
 *     across PROMPT_CACHE_KEY_SHARDS buckets, chosen deterministically from
 *     the user's hashed id so one user always lands on one shard (and keeps
 *     reading their own warm prefix).
 *
 * Only GPT-5.6 gets the persona strategy: it is the generation whose implicit
 * cache was measured to match partial prefixes across conversations. Every
 * other model keeps the thread id.
 */

import { MODEL_CONFIGS, type ChatModel } from "../models";

export type PromptCacheKeyStrategy = "thread" | "persona";

export const DEFAULT_PROMPT_CACHE_KEY_SHARDS = 4;

/** Reads PROMPT_CACHE_KEY_STRATEGY; anything unrecognised means "thread". */
export function getPromptCacheKeyStrategy(
  raw: string | undefined = process.env.PROMPT_CACHE_KEY_STRATEGY,
): PromptCacheKeyStrategy {
  return raw?.trim().toLowerCase() === "persona" ? "persona" : "thread";
}

/**
 * Reads PROMPT_CACHE_KEY_SHARDS. A non-numeric, zero or negative value falls
 * back to the default rather than producing a modulo-by-zero key.
 */
export function getPromptCacheKeyShards(
  raw: string | undefined = process.env.PROMPT_CACHE_KEY_SHARDS,
): number {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_PROMPT_CACHE_KEY_SHARDS;
  }
  return parsed;
}

/**
 * Short, stable signature of a toolset. FNV-1a over the sorted, de-duplicated
 * names: a cache key needs determinism and a low collision rate, not
 * cryptographic strength, and this keeps the module free of any node-only
 * import. Sorting by codepoint (not locale) so the signature cannot depend on
 * the server's locale.
 */
export function toolsetSignature(toolNames: readonly string[]): string {
  const canonical = [...new Set(toolNames)]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join(",");
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Deterministic shard for a user, from an FNV hash of the subject key.
 *
 * One path, deliberately. There used to be a fast path that read the leading
 * hex of a bare SHA-256 digest, but the only caller passes the rate-limit
 * subject — `user:<digest>` — which never matches a leading-hex pattern, so
 * the fast path was unreachable in production and only its fallback ever ran.
 * Hashing every shape gives an even spread and one behaviour to reason about.
 */
export function shardForUser(userKey: string, shards: number): number {
  const buckets = shards >= 1 ? shards : DEFAULT_PROMPT_CACHE_KEY_SHARDS;
  const value = Number.parseInt(toolsetSignature([userKey ?? ""]), 16);
  return value % buckets;
}

export interface ResolvePromptCacheKeyArgs {
  modelId: ChatModel;
  threadId: string;
  /** Agent the thread was started from; absent for a plain chat. */
  personaId?: string;
  /**
   * Names of the tools this turn declares. The built-in names are derived
   * from the turn's toggles by the caller, because the key has to be known
   * before the provider seam builds the actual tool objects — and the toggle
   * set determines the built-ins one-to-one.
   */
  toolNames: readonly string[];
  /**
   * Opaque per-user value used ONLY to pick a shard. Must never be a raw
   * identifier: prompt_cache_key is sent to the provider in the request body,
   * so an email or display name here would leak. Callers pass the SHA-256
   * hashed user id.
   */
  userKey: string;
  /** Overridable for tests. */
  strategy?: PromptCacheKeyStrategy;
  shards?: number;
}

export function resolvePromptCacheKey({
  modelId,
  threadId,
  personaId,
  toolNames,
  userKey,
  strategy = getPromptCacheKeyStrategy(),
  shards = getPromptCacheKeyShards(),
}: ResolvePromptCacheKeyArgs): string {
  if (strategy !== "persona") return threadId;
  // Gated on the generation, not on a per-model flag: this is about how the
  // implicit cache behaves, which is a property of GPT-5.6.
  if (MODEL_CONFIGS[modelId]?.family !== "gpt-5.6") return threadId;

  const signature = toolsetSignature(toolNames);
  const shard = shardForUser(userKey, shards);
  return `persona:${personaId ?? "default"}:${signature}:${shard}`;
}
