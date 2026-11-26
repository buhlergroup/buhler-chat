/**
 * Copilot runtime session filesystem on Blob Storage.
 *
 * The runtime routes ALL session-scoped file I/O through this provider: its
 * own session state (events.jsonl, workspace.yaml, checkpoints) and every
 * file the model reads or writes with the file tools. Nothing reaches the
 * server's disk. One instance serves exactly one `{userKey}/{threadId}`
 * namespace; paths are jailed by normalizeSessionPath.
 *
 * Layout inside the container (pointer-blob design):
 *
 *   {ns}/f{path}            pointer blob, empty body, metadata.target = data blob
 *   {ns}/f{dir}/.~dir       marker that makes an (empty) directory exist
 *   {ns}/d/{uuid}           data blob (append blob), never renamed
 *
 * Why pointers: Blob Storage has no rename. Copy-then-delete is not atomic —
 * a crash in between leaves a torn or missing events.jsonl / workspace.yaml.
 * Here rename is ONE overwrite of the destination pointer (a single-blob PUT
 * is atomic: a reader sees the old or the new target, never a mix) followed
 * by a delete of the source pointer conditioned on its ETag. A crash between
 * the two leaves a second pointer (the runtime's `.tmp.*` source name) to the
 * same data blob; the destination is already correct.
 *
 * Data blobs are append blobs so the runtime's frequent appendFile on the
 * event journal (under /session-state) is one append-block call, not a
 * rewrite of the whole file. Workspace files (/workspace) are never changed
 * in place: every write, including an append, creates a new data blob. So a
 * workspace data blob is immutable and its content can be cached by name
 * (the workspace search tools do), and the pointer's `size` metadata is exact.
 */
import { randomUUID } from "node:crypto";
import type { SessionFsProvider } from "@microsoft/copilot-sdk";
import {
  DIR_MARKER_NAME,
  SESSION_STATE_ROOT,
  isRootPath,
  normalizeSessionPath,
  parentPath,
  SessionPathError,
} from "./session-path";

/** Properties of one blob, as far as this provider needs them. */
export interface BlobProps {
  etag: string;
  metadata: Record<string, string>;
  contentLength: number;
  lastModified: Date;
  createdOn?: Date;
}

/**
 * The small slice of Blob Storage the provider uses. The Azure implementation
 * lives in azure-blob-store.ts; tests use an in-memory fake.
 *
 * Errors: a missing blob is `undefined` from getProperties, `false` from
 * delete, and an error with `code: "ENOENT"` from download / appendBlock.
 * A failed ETag condition is an error with `code: "PRECONDITION"`.
 */
export interface BlobStore {
  getProperties(name: string): Promise<BlobProps | undefined>;
  download(name: string): Promise<Buffer>;
  /** Creates (or replaces) an empty append blob. */
  createAppendBlob(name: string): Promise<void>;
  appendBlock(name: string, data: Buffer): Promise<void>;
  /** Uploads a block blob (overwrite unless a condition says otherwise). Returns the new ETag. */
  upload(
    name: string,
    data: Buffer,
    metadata: Record<string, string>,
    conditions?: { ifMatch?: string; ifNoneMatch?: string },
  ): Promise<string>;
  /** Deletes a blob. Returns false when it did not exist. */
  delete(name: string, conditions?: { ifMatch?: string }): Promise<boolean>;
  /** All blob names under the prefix (flat). */
  listNames(prefix: string): Promise<string[]>;
  /** One level under the prefix: virtual sub-directories and blob names. */
  listHierarchy(prefix: string): Promise<{ prefixes: string[]; names: string[] }>;
  /** All blobs under the prefix (flat) with their metadata, in ONE listing. */
  listDetailed(prefix: string): Promise<Array<{ name: string; metadata: Record<string, string>; lastModified: Date }>>;
}

/** One workspace file as the search tools see it (from one listing, no per-file calls). */
export interface WorkspaceEntry {
  /** Normalised path, e.g. /workspace/notes/plan.txt. */
  path: string;
  /** Immutable data blob holding the content. */
  dataKey: string;
  /** Bytes, from the pointer metadata (undefined for pointers written before it existed). */
  size?: number;
  lastModified: Date;
}

/**
 * Per-process LRU of workspace data blob contents, keyed by data blob name.
 * Workspace data blobs never change (see header), so no staleness check.
 */
export class DataBlobCache {
  private readonly entries = new Map<string, Buffer>();
  private bytes = 0;
  hits = 0;
  misses = 0;
  constructor(private readonly maxBytes: number) {}
  get(key: string): Buffer | undefined {
    const value = this.entries.get(key);
    if (!value) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }
  set(key: string, value: Buffer): void {
    if (value.length > this.maxBytes) return;
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.length;
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    this.bytes += value.length;
    for (const [k, v] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(k);
      this.bytes -= v.length;
    }
  }
  get size(): number {
    return this.bytes;
  }
}

const g = globalThis as typeof globalThis & { __copilotDataCache?: DataBlobCache };
/** Shared by all sessions of this process; 64 MB unless COPILOT_SEARCH_CACHE_MB says otherwise. */
export const sharedDataCache = (): DataBlobCache =>
  (g.__copilotDataCache ??= new DataBlobCache((Number(process.env.COPILOT_SEARCH_CACHE_MB) || 64) * 1024 * 1024));

/** Biggest block one appendBlock call may carry (Azure limit 4 MiB). */
const MAX_APPEND_BLOCK = 4 * 1024 * 1024;

const enoent = (path: string): Error =>
  Object.assign(new Error(`ENOENT: no such file or directory: ${path}`), {
    code: "ENOENT",
  });

/** Optional hook for tests and the smoke script: sees every operation. */
export type SessionFsOpListener = (op: string, path: string, extra?: unknown) => void;

export class BlobSessionFs implements SessionFsProvider {
  constructor(
    private readonly store: BlobStore,
    private readonly namespace: string,
    private readonly onOp?: SessionFsOpListener,
    private readonly cache: DataBlobCache = sharedDataCache(),
  ) {
    if (!namespace || namespace.includes("..") || namespace.startsWith("/")) {
      throw new SessionPathError("Invalid namespace");
    }
  }

  // ── key mapping ───────────────────────────────────────────────────────
  private fileKey(normalized: string): string {
    return `${this.namespace}/f${normalized}`;
  }
  private dirPrefix(normalized: string): string {
    return `${this.namespace}/f${normalized}/`;
  }
  private dirMarkerKey(normalized: string): string {
    return `${this.dirPrefix(normalized)}${DIR_MARKER_NAME}`;
  }
  private newDataKey(): string {
    return `${this.namespace}/d/${randomUUID()}`;
  }
  /** A pointer may only name a data blob of THIS namespace. */
  private targetOf(props: BlobProps): string | undefined {
    const target = props.metadata?.target;
    if (typeof target !== "string") return undefined;
    return target.startsWith(`${this.namespace}/d/`) ? target : undefined;
  }

  private norm(op: string, path: string, extra?: unknown): string {
    this.onOp?.(op, path, extra);
    return normalizeSessionPath(path);
  }

  // ── helpers ───────────────────────────────────────────────────────────
  private async pointer(normalized: string): Promise<{ props: BlobProps; target: string } | undefined> {
    const props = await this.store.getProperties(this.fileKey(normalized));
    if (!props) return undefined;
    const target = this.targetOf(props);
    return target ? { props, target } : undefined;
  }

  private async isDirectory(normalized: string): Promise<boolean> {
    if (isRootPath(normalized)) return true;
    if (await this.store.getProperties(this.dirMarkerKey(normalized))) return true;
    const listing = await this.store.listHierarchy(this.dirPrefix(normalized));
    return listing.prefixes.length > 0 || listing.names.length > 0;
  }

  private async appendChunks(dataKey: string, data: Buffer): Promise<void> {
    for (let offset = 0; offset < data.length; offset += MAX_APPEND_BLOCK) {
      await this.store.appendBlock(dataKey, data.subarray(offset, offset + MAX_APPEND_BLOCK));
    }
  }

  private async writeBuffer(normalized: string, data: Buffer): Promise<void> {
    const previous = await this.pointer(normalized);
    const dataKey = this.newDataKey();
    await this.store.createAppendBlob(dataKey);
    await this.appendChunks(dataKey, data);
    // The pointer swap is the commit point: before it, readers see the old
    // content; after it, the new.
    await this.store.upload(this.fileKey(normalized), Buffer.alloc(0), {
      target: dataKey,
      size: String(data.length),
    });
    if (previous && previous.target !== dataKey) {
      await this.store.delete(previous.target).catch(() => false);
    }
  }

  private async readBuffer(normalized: string): Promise<Buffer> {
    const ptr = await this.pointer(normalized);
    if (!ptr) throw enoent(normalized);
    return this.store.download(ptr.target);
  }

  /**
   * Every file under a directory (recursive), as normalised paths. Used by the
   * workspace glob/grep tools, which replace the runtime's own (those read the
   * host disk, not this provider).
   */
  async listFiles(dir: string): Promise<string[]> {
    return (await this.listEntries(dir)).map((e) => e.path).sort();
  }

  /**
   * Files under `dir` in ONE flat listing with metadata. `literalPrefix` (the
   * literal start of a glob, e.g. "notes/re") narrows the Blob prefix. Every
   * name is checked against this namespace, and every target must be a data
   * blob of this namespace.
   */
  async listEntries(dir: string, literalPrefix = ""): Promise<WorkspaceEntry[]> {
    const n = this.norm("listEntries", dir, { literalPrefix });
    if (literalPrefix.includes("..") || literalPrefix.startsWith("/")) {
      throw new SessionPathError(`Invalid pattern prefix: ${literalPrefix}`);
    }
    const base = this.dirPrefix(n);
    const listing = await this.store.listDetailed(base + literalPrefix);
    const entries: WorkspaceEntry[] = [];
    for (const blob of listing) {
      if (!blob.name.startsWith(base)) continue;
      const rel = blob.name.slice(base.length);
      if (rel === DIR_MARKER_NAME || rel.endsWith(`/${DIR_MARKER_NAME}`) || rel.split("/").includes("..")) continue;
      const target = blob.metadata?.target;
      if (typeof target !== "string" || !target.startsWith(`${this.namespace}/d/`)) continue;
      const size = Number(blob.metadata?.size);
      entries.push({
        path: `${n}/${rel}`,
        dataKey: target,
        ...(Number.isFinite(size) && blob.metadata?.size !== undefined ? { size } : {}),
        lastModified: blob.lastModified,
      });
    }
    return entries;
  }

  /** Content of a listed workspace file, from the process cache when possible. */
  async readEntry(entry: WorkspaceEntry): Promise<Buffer> {
    if (!entry.dataKey.startsWith(`${this.namespace}/d/`)) {
      throw new SessionPathError("Entry outside this namespace");
    }
    const cached = this.cache.get(entry.dataKey);
    if (cached) return cached;
    const data = await this.store.download(entry.dataKey);
    this.cache.set(entry.dataKey, data);
    return data;
  }

  // ── SessionFsProvider ─────────────────────────────────────────────────
  async readFile(path: string): Promise<string> {
    const n = this.norm("readFile", path);
    return (await this.readBuffer(n)).toString("utf8");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const n = this.norm("readFileBytes", path);
    return new Uint8Array(await this.readBuffer(n));
  }

  async writeFile(path: string, content: string): Promise<void> {
    const n = this.norm("writeFile", path, { bytes: Buffer.byteLength(content) });
    await this.writeBuffer(n, Buffer.from(content, "utf8"));
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    const n = this.norm("writeFileBytes", path, { bytes: content.byteLength });
    await this.writeBuffer(n, Buffer.from(content));
  }

  async appendFile(path: string, content: string): Promise<void> {
    const n = this.norm("appendFile", path, { bytes: Buffer.byteLength(content) });
    const data = Buffer.from(content, "utf8");
    const ptr = await this.pointer(n);
    if (!ptr) {
      await this.writeBuffer(n, data);
      return;
    }
    if (!n.startsWith(`${SESSION_STATE_ROOT}/`)) {
      // Workspace files stay immutable per data blob: append = new blob.
      const current = await this.store.download(ptr.target);
      await this.writeBuffer(n, Buffer.concat([current, data]));
      return;
    }
    try {
      await this.appendChunks(ptr.target, data);
    } catch (err) {
      // A dangling pointer (data blob gone): start the file again.
      if ((err as { code?: string }).code !== "ENOENT") throw err;
      await this.writeBuffer(n, data);
    }
  }

  async exists(path: string): Promise<boolean> {
    let n: string;
    try {
      n = this.norm("exists", path);
    } catch (err) {
      // A path outside the jail does not exist for the agent. Still no disk.
      if (err instanceof SessionPathError) return false;
      throw err;
    }
    if (await this.pointer(n)) return true;
    return this.isDirectory(n);
  }

  async stat(path: string) {
    const n = this.norm("stat", path);
    const ptr = await this.pointer(n);
    if (ptr) {
      const data = await this.store.getProperties(ptr.target);
      if (!data) throw enoent(n);
      return {
        isFile: true,
        isDirectory: false,
        size: data.contentLength,
        mtime: data.lastModified.toISOString(),
        birthtime: (ptr.props.createdOn ?? data.lastModified).toISOString(),
      };
    }
    if (await this.isDirectory(n)) {
      const marker = await this.store.getProperties(this.dirMarkerKey(n));
      const when = (marker?.lastModified ?? new Date(0)).toISOString();
      return { isFile: false, isDirectory: true, size: 0, mtime: when, birthtime: when };
    }
    throw enoent(n);
  }

  async mkdir(path: string, recursive: boolean): Promise<void> {
    const n = this.norm("mkdir", path, { recursive });
    if (isRootPath(n)) return;
    const chain: string[] = [];
    for (let p: string | undefined = n; p && !isRootPath(p); p = parentPath(p)) {
      chain.unshift(p);
      if (!recursive) break;
    }
    for (const dir of chain) {
      await this.store.upload(this.dirMarkerKey(dir), Buffer.alloc(0), {});
    }
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithTypes(path)).map((e) => e.name);
  }

  async readdirWithTypes(path: string) {
    const n = this.norm("readdir", path);
    if (await this.pointer(n)) {
      throw Object.assign(new Error(`ENOTDIR: not a directory: ${n}`), { code: "ENOTDIR" });
    }
    const prefix = this.dirPrefix(n);
    const listing = await this.store.listHierarchy(prefix);
    const entries: { name: string; type: "file" | "directory" }[] = [];
    for (const p of listing.prefixes) {
      entries.push({ name: p.slice(prefix.length).replace(/\/$/, ""), type: "directory" });
    }
    for (const name of listing.names) {
      const leaf = name.slice(prefix.length);
      if (leaf === DIR_MARKER_NAME) continue;
      entries.push({ name: leaf, type: "file" });
    }
    if (entries.length === 0 && !(await this.isDirectory(n))) throw enoent(n);
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async rm(path: string, recursive: boolean, force: boolean): Promise<void> {
    const n = this.norm("rm", path, { recursive, force });
    const ptr = await this.pointer(n);
    if (ptr) {
      await this.store.delete(this.fileKey(n));
      await this.store.delete(ptr.target).catch(() => false);
      return;
    }
    if (!isRootPath(n) && (await this.isDirectory(n))) {
      const names = await this.store.listNames(this.dirPrefix(n));
      const children = names.filter((name) => !name.endsWith(`/${DIR_MARKER_NAME}`));
      if (children.length > 0 && !recursive) {
        throw Object.assign(new Error(`ENOTEMPTY: directory not empty: ${n}`), { code: "ENOTEMPTY" });
      }
      for (const name of names) {
        const props = await this.store.getProperties(name);
        await this.store.delete(name);
        const target = props ? this.targetOf(props) : undefined;
        if (target) await this.store.delete(target).catch(() => false);
      }
      return;
    }
    if (!force) throw enoent(n);
  }

  async rename(src: string, dest: string): Promise<void> {
    const s = this.norm("rename", src, { dest });
    const d = normalizeSessionPath(dest);
    if (s === d) return;
    const ptr = await this.pointer(s);
    if (ptr) {
      await this.renameFile(s, d, ptr);
      return;
    }
    if (!isRootPath(s) && (await this.isDirectory(s))) {
      // Directory rename moves each entry. Each file move is atomic; the
      // directory as a whole is not (the runtime renames files, not trees).
      const srcPrefix = this.dirPrefix(s);
      const names = await this.store.listNames(srcPrefix);
      for (const name of names) {
        const rel = name.slice(srcPrefix.length);
        if (rel === DIR_MARKER_NAME || rel.endsWith(`/${DIR_MARKER_NAME}`)) {
          const dir = rel === DIR_MARKER_NAME ? d : `${d}/${rel.slice(0, -(DIR_MARKER_NAME.length + 1))}`;
          await this.store.upload(this.dirMarkerKey(dir), Buffer.alloc(0), {});
          await this.store.delete(name);
          continue;
        }
        const childSrc = `${s}/${rel}`;
        const childPtr = await this.pointer(childSrc);
        if (childPtr) await this.renameFile(childSrc, `${d}/${rel}`, childPtr);
      }
      return;
    }
    throw enoent(s);
  }

  private async renameFile(
    s: string,
    d: string,
    ptr: { props: BlobProps; target: string },
  ): Promise<void> {
    const replaced = await this.pointer(d);
    // 1. Commit: the destination pointer now names the source's data.
    const size = ptr.props.metadata?.size;
    await this.store.upload(this.fileKey(d), Buffer.alloc(0), {
      target: ptr.target,
      ...(size !== undefined ? { size } : {}),
    });
    // 2. Drop the source pointer, only if nobody changed it meanwhile.
    try {
      await this.store.delete(this.fileKey(s), { ifMatch: ptr.props.etag });
    } catch (err) {
      if ((err as { code?: string }).code !== "PRECONDITION") throw err;
      // The source was rewritten after we read it: leave the new source alone.
    }
    // 3. The data the destination held before is unreferenced now.
    if (replaced && replaced.target !== ptr.target) {
      await this.store.delete(replaced.target).catch(() => false);
    }
  }
}
