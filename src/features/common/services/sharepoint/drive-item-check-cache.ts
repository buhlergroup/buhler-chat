import "server-only";

/**
 * Per-user cache of the SharePoint metadata check of a drive item (linked
 * skills, linked sources of SharePoint files).
 *
 * Chat start and the first message are two requests; both check the same
 * files with the same user's token. The result of a check is kept for 60 s
 * per (user, drive, item), in memory, at most 500 entries (least recently
 * used goes first):
 *   - "ok" (the metadata) and "denied" (401/403/404) are cached;
 *   - timeouts, 5xx and network errors are NOT cached;
 *   - "Check now" bypasses the cache and stores the fresh result;
 *   - a newly stored version updates the cached metadata of that item.
 *
 * The cache is per process (each replica has its own); 60 s is the longest
 * time a change of SharePoint permissions takes to apply to a chat.
 */

import {
  GRAPH_METADATA_TIMEOUT_MS,
  GraphFileError,
  getDriveItemVersion,
  isFileAccessDenied,
  type DriveItemVersion,
} from "./graph-drive";

export const ITEM_CHECK_TTL_MS = 60_000;
export const ITEM_CHECK_MAX_ENTRIES = 500;

interface CachedCheck {
  at: number;
  userId: string;
  driveId: string;
  itemId: string;
  meta?: DriveItemVersion;
  deniedStatus?: number;
}

const cache = new Map<string, CachedCheck>();

// Graph ids never contain "|" (see GRAPH_*_ID_PATTERN); the user id is a hash.
const keyOf = (userId: string, driveId: string, itemId: string) =>
  `${userId}|${driveId}|${itemId}`;

function put(entry: CachedCheck): void {
  const key = keyOf(entry.userId, entry.driveId, entry.itemId);
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > ITEM_CHECK_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export interface DriveItemCheck {
  meta: DriveItemVersion;
  /** True when the answer came from the cache (no Graph call). */
  fromCache: boolean;
}

/**
 * The metadata of a drive item as `userId` sees it. Throws GraphFileError
 * like getDriveItemVersion; a cached denial is thrown again with its status.
 * Without `userId` nothing is cached (never share an answer across users).
 */
export async function checkDriveItem(
  token: string,
  userId: string,
  driveId: string,
  itemId: string,
  options: { bypassCache?: boolean; timeoutMs?: number } = {},
): Promise<DriveItemCheck> {
  const key = userId ? keyOf(userId, driveId, itemId) : undefined;
  if (key && !options.bypassCache) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ITEM_CHECK_TTL_MS) {
      cache.delete(key);
      cache.set(key, hit); // most recently used
      if (hit.deniedStatus !== undefined) {
        throw new GraphFileError(`Graph returned ${hit.deniedStatus}.`, hit.deniedStatus);
      }
      if (hit.meta) return { meta: hit.meta, fromCache: true };
    }
    if (hit) cache.delete(key);
  }

  try {
    const meta = await getDriveItemVersion(
      token,
      driveId,
      itemId,
      options.timeoutMs ?? GRAPH_METADATA_TIMEOUT_MS,
    );
    if (userId) put({ at: Date.now(), userId, driveId, itemId, meta });
    return { meta, fromCache: false };
  } catch (error) {
    if (key) {
      if (isFileAccessDenied(error)) {
        put({
          at: Date.now(),
          userId,
          driveId,
          itemId,
          deniedStatus: (error as GraphFileError).status,
        });
      } else {
        cache.delete(key); // transient errors are not cached
      }
    }
    throw error;
  }
}

/**
 * A new version of the item was stored: cached "ok" entries of every user
 * get the new metadata (read access is per file, not per version), and the
 * user who stored it gets an entry when there was none.
 */
export function rememberDriveItemVersion(
  driveId: string,
  itemId: string,
  meta: DriveItemVersion,
  userId?: string,
): void {
  for (const entry of cache.values()) {
    if (entry.driveId === driveId && entry.itemId === itemId && entry.meta) {
      entry.meta = meta;
    }
  }
  if (userId) put({ at: Date.now(), userId, driveId, itemId, meta });
}

/** For tests. */
export function clearDriveItemChecks(): void {
  cache.clear();
}
