/**
 * In-memory BlobStore for tests: ETags, conditions, hierarchy and flat
 * listings, and a log of every call (to count Blob requests).
 */
import type { BlobProps, BlobStore } from "./blob-session-fs";

export class FakeBlobStore implements BlobStore {
  blobs = new Map<string, { data: Buffer; metadata: Record<string, string>; etag: string; append: boolean; at: Date }>();
  calls: string[] = [];
  /** Every request, as "<op> <name or prefix>". */
  requests: string[] = [];
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

