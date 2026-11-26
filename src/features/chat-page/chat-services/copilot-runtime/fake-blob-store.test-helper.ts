/**
 * In-memory BlobStore for tests: ETags, conditions, hierarchy and flat
 * listings, and a log of every call (to count Blob requests).
 */
import { Readable } from "node:stream";
import type { BlobProps, BlobStore, DetailedBlob } from "./blob-session-fs";

export class FakeBlobStore implements BlobStore {
  blobs = new Map<string, { data: Buffer; metadata: Record<string, string>; etag: string; append: boolean; at: Date }>();
  calls: string[] = [];
  /** Every request, as "<op> <name or prefix>". */
  requests: string[] = [];
  /** Blobs per listDetailedPages page. */
  pageSize = 5000;
  /** Bytes per chunk of an openRead stream. */
  chunkSize = 64 * 1024;
  /** Chunks each openRead stream handed out, per blob name (summed over reads). */
  chunksServed = new Map<string, number>();
  /** openRead streams that were destroyed before their end (download aborted). */
  aborted: string[] = [];
  private n = 0;
  /** Set to make the next delete with ifMatch fail like a concurrent writer. */
  failNextConditionalDelete = false;
  private etag() {
    return `"e${++this.n}"`;
  }
  async getProperties(name: string): Promise<BlobProps | undefined> {
    this.requests.push(`getProperties ${name}`);
    const b = this.blobs.get(name);
    if (!b) return undefined;
    return { etag: b.etag, metadata: b.metadata, contentLength: b.data.length, lastModified: b.at, createdOn: b.at };
  }
  async download(name: string) {
    this.requests.push(`download ${name}`);
    const b = this.blobs.get(name);
    if (!b) throw Object.assign(new Error("nf"), { code: "ENOENT" });
    return Buffer.from(b.data);
  }
  /** A pull stream of chunkSize chunks; it reads at most one chunk ahead of the consumer. */
  async openRead(name: string, options: { offset?: number; count?: number; signal?: AbortSignal } = {}) {
    const ranged = options.offset !== undefined || options.count !== undefined;
    this.requests.push(`download ${name}${ranged ? ` bytes=${options.offset ?? 0}+${options.count ?? "end"}` : ""}`);
    const b = this.blobs.get(name);
    if (!b) throw Object.assign(new Error("nf"), { code: "ENOENT" });
    const data = b.data;
    const start = Math.min(options.offset ?? 0, data.length);
    const end = options.count === undefined ? data.length : Math.min(data.length, start + options.count);
    let pos = start;
    const chunkSize = this.chunkSize;
    const served = this.chunksServed;
    const aborted = this.aborted;
    const stream = new Readable({
      highWaterMark: 1,
      read() {
        if (pos >= end) {
          this.push(null);
          return;
        }
        const next = Math.min(end, pos + chunkSize);
        served.set(name, (served.get(name) ?? 0) + 1);
        const chunk = Buffer.from(data.subarray(pos, next));
        pos = next;
        this.push(chunk);
      },
      destroy(err, callback) {
        if (pos < end) aborted.push(name);
        callback(err);
      },
    });
    options.signal?.addEventListener("abort", () => stream.destroy(), { once: true });
    return { stream, size: data.length };
  }
  async *listDetailedPages(prefix: string): AsyncGenerator<DetailedBlob[]> {
    const all = [...this.blobs.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, b]) => ({ name, metadata: { ...b.metadata }, lastModified: b.at }));
    for (let i = 0; i === 0 || i < all.length; i += this.pageSize) {
      this.requests.push(`listDetailed ${prefix}`);
      yield all.slice(i, i + this.pageSize);
    }
  }
  async createAppendBlob(name: string) {
    this.requests.push(`createAppendBlob ${name}`);
    this.calls.push(`createAppend ${name}`);
    this.blobs.set(name, { data: Buffer.alloc(0), metadata: {}, etag: this.etag(), append: true, at: new Date() });
  }
  async appendBlock(name: string, data: Buffer) {
    this.requests.push(`appendBlock ${name}`);
    const b = this.blobs.get(name);
    if (!b) throw Object.assign(new Error("nf"), { code: "ENOENT" });
    b.data = Buffer.concat([b.data, data]);
    b.etag = this.etag();
  }
  async upload(name: string, data: Buffer, metadata: Record<string, string>, conditions?: { ifMatch?: string; ifNoneMatch?: string }) {
    this.requests.push(`upload ${name}`);
    this.calls.push(`upload ${name}`);
    const existing = this.blobs.get(name);
    if (conditions?.ifMatch && existing?.etag !== conditions.ifMatch) {
      throw Object.assign(new Error("412"), { code: "PRECONDITION" });
    }
    const etag = this.etag();
    this.blobs.set(name, { data, metadata, etag, append: false, at: new Date() });
    return etag;
  }
  async delete(name: string, conditions?: { ifMatch?: string }) {
    this.requests.push(`delete ${name}`);
    this.calls.push(`delete ${name}${conditions?.ifMatch ? " ifMatch" : ""}`);
    const b = this.blobs.get(name);
    if (!b) return false;
    if (conditions?.ifMatch && (this.failNextConditionalDelete || b.etag !== conditions.ifMatch)) {
      this.failNextConditionalDelete = false;
      throw Object.assign(new Error("412"), { code: "PRECONDITION" });
    }
    this.blobs.delete(name);
    return true;
  }
  async listNames(prefix: string) {
    this.requests.push(`listNames ${prefix}`);
    return [...this.blobs.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async listDetailed(prefix: string) {
    this.requests.push(`listDetailed ${prefix}`);
    return [...this.blobs.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, b]) => ({ name, metadata: { ...b.metadata }, lastModified: b.at }));
  }
  async listHierarchy(prefix: string) {
    this.requests.push(`listHierarchy ${prefix}`);
    const prefixes = new Set<string>();
    const names: string[] = [];
    for (const key of this.blobs.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash >= 0) prefixes.add(prefix + rest.slice(0, slash + 1));
      else names.push(key);
    }
    return { prefixes: [...prefixes].sort(), names: names.sort() };
  }
}

