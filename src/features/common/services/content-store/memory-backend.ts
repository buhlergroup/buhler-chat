/**
 * In-memory blob backend of the content store, for unit tests and the e2e
 * memory backend (AZURECHAT_TEST_BACKEND=memory). Never used in production.
 *
 * It keeps the rules of the Azure backend that matter here: createIfAbsent
 * writes only the first time (If-None-Match: *), and every change of bytes
 * or metadata sets lastModified. `stats` counts the calls.
 */

import type { ContentBlobBackend } from "./content-store";

export interface MemoryContentBlobBackend extends ContentBlobBackend {
  readonly stats: { writes: number; writeConflicts: number; reads: number; deletes: number };
  /** Test hook: change the lastModified of a stored blob. */
  setLastModified(key: string, date: Date): void;
  keys(): string[];
}

export function createMemoryContentBlobBackend(
  now: () => Date = () => new Date()
): MemoryContentBlobBackend {
  const blobs = new Map<
    string,
    { data: Buffer; metadata: Record<string, string>; contentType?: string; lastModified: Date }
  >();
  const stats = { writes: 0, writeConflicts: 0, reads: 0, deletes: 0 };

  return {
    stats,
    setLastModified(key, date) {
      const blob = blobs.get(key);
      if (blob) blob.lastModified = date;
    },
    keys: () => [...blobs.keys()].sort(),

    async head(key) {
      const blob = blobs.get(key);
      if (!blob) return undefined;
      return {
        size: blob.data.length,
        lastModified: blob.lastModified,
        metadata: { ...blob.metadata },
        contentType: blob.contentType,
      };
    },

    async createIfAbsent(key, data, options) {
      // Yield once, so concurrent writers interleave as they do over HTTP.
      await Promise.resolve();
      if (blobs.has(key)) {
        stats.writeConflicts++;
        return "exists";
      }
      stats.writes++;
      blobs.set(key, {
        data: Buffer.from(data),
        metadata: { ...(options.metadata ?? {}) },
        contentType: options.contentType,
        lastModified: now(),
      });
      return "created";
    },

    async read(key) {
      stats.reads++;
      const blob = blobs.get(key);
      return blob ? Buffer.from(blob.data) : undefined;
    },

    async setMetadata(key, metadata) {
      const blob = blobs.get(key);
      if (!blob) {
        const error = new Error("BlobNotFound") as Error & { statusCode: number };
        error.statusCode = 404;
        throw error;
      }
      blob.metadata = { ...metadata };
      blob.lastModified = now();
    },

    async delete(key) {
      if (blobs.delete(key)) stats.deletes++;
    },

    async *list(prefix) {
      for (const [key, blob] of [...blobs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (key.startsWith(prefix)) yield { key, lastModified: blob.lastModified };
      }
    },
  };
}
