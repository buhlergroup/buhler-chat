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
 * workspace data blob is immutable and the pointer's `size` metadata is exact.
 *
 * Memory: no file content stays in this process after a call. The search
 * tools stream each data blob (openEntry), whole-file reads of the runtime
 * (readFile / readFileBytes) are capped under /workspace (readFileLimitBytes),
 * and readFileRange serves the runtime's bounded reads with one ranged GET.
 *
 * Quota: writes under /workspace (uploads, tool-result spills, model writes)
 * are checked against a per-thread byte and file-count quota (WorkspaceQuota,
 * COPILOT_WORKSPACE_MAX_BYTES / COPILOT_WORKSPACE_MAX_FILES). The runtime's
 * own /session-state is not counted.
 */
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { SessionFsProvider } from "@microsoft/copilot-sdk";
import {
  DIR_MARKER_NAME,
  SESSION_STATE_ROOT,
  WORKSPACE_ROOT,
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
  listDetailed(prefix: string): Promise<DetailedBlob[]>;
  /** The same flat listing, page by page in name order (the caller may stop early). */
  listDetailedPages(prefix: string): AsyncIterable<DetailedBlob[]>;
  /**
   * Streams a blob, or `count` bytes from `offset`. `size` is the blob's total
   * length at the read. An offset at or past the end gives an empty stream.
   * Destroying the stream (or aborting `signal`) aborts the download.
   */
  openRead(
    name: string,
    options?: { offset?: number; count?: number; signal?: AbortSignal },
  ): Promise<{ stream: Readable; size: number }>;
}

/** One blob of a flat listing with metadata. */
export interface DetailedBlob {
  name: string;
  metadata: Record<string, string>;
  lastModified: Date;
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
 * Biggest file under /workspace the runtime may read whole (readFile /
 * readFileBytes: that RPC carries the full content, it cannot stream).
 * 10 MB unless COPILOT_READFILE_MAX_MB says otherwise. The runtime's own
 * /session-state files are not capped (it must be able to resume).
 */
export const readFileLimitBytes = (env: Record<string, string | undefined> = process.env): number =>
  (Number(env.COPILOT_READFILE_MAX_MB) > 0 ? Number(env.COPILOT_READFILE_MAX_MB) : 10) * 1024 * 1024;

/** Thrown by readFile / readFileBytes for a workspace file over readFileLimitBytes. */
export class FileTooLargeError extends Error {
  readonly code = "EFBIG";
  constructor(path: string, bytes: number, limit: number) {
    const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
    super(
      `File too large to read whole: ${path} is ${mb(bytes)}, the limit is ${mb(limit)}. ` +
        "Use view with view_range to read a range of lines, or rg / grep to search it.",
    );
    this.name = "FileTooLargeError";
  }
}

/** Biggest block one appendBlock call may carry (Azure limit 4 MiB). */
const MAX_APPEND_BLOCK = 4 * 1024 * 1024;

const enoent = (path: string): Error =>
  Object.assign(new Error(`ENOENT: no such file or directory: ${path}`), {
    code: "ENOENT",
  });

/** Optional hook for tests and the smoke script: sees every operation. */
export type SessionFsOpListener = (op: string, path: string, extra?: unknown) => void;

/** Thrown when a write would exceed the thread's workspace quota. */
export class WorkspaceQuotaError extends Error {
  readonly code = "ENOSPC";
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceQuotaError";
  }
}

const isWorkspacePath = (normalized: string) =>
  normalized === WORKSPACE_ROOT || normalized.startsWith(`${WORKSPACE_ROOT}/`);

interface QuotaUsage {
  bytes: number;
  files: number;
  at: number;
}

/**
 * Per-thread quota of /workspace: bytes and file count. Usage comes from one
 * listing with metadata (pointer `size`), cached per namespace for `ttlMs`
 * and updated by this process's own writes in between. Other instances'
 * writes are seen after the cache expires, so the limit is approximate by
 * at most one TTL of concurrent writes.
 */
export class WorkspaceQuota {
  private readonly usage = new Map<string, QuotaUsage>();

  constructor(
    readonly maxBytes: number,
    readonly maxFiles: number,
    private readonly ttlMs = 60_000,
  ) {}

  /** Throws WorkspaceQuotaError when adding `deltaBytes` / `deltaFiles` would exceed the quota. */
  async check(store: BlobStore, namespace: string, deltaBytes: number, deltaFiles: number): Promise<void> {
    let u = this.usage.get(namespace);
    if (!u || Date.now() - u.at > this.ttlMs) {
      u = await this.measure(store, namespace);
      if (this.usage.size > 10_000) this.usage.clear();
      this.usage.set(namespace, u);
    }
    const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;
    if (deltaBytes > 0 && u.bytes + deltaBytes > this.maxBytes) {
      throw new WorkspaceQuotaError(
        `Workspace quota exceeded: this chat's files would use ${mb(u.bytes + deltaBytes)} of ${mb(this.maxBytes)}. Delete files in /workspace first.`,
      );
    }
    if (deltaFiles > 0 && u.files + deltaFiles > this.maxFiles) {
      throw new WorkspaceQuotaError(
        `Workspace quota exceeded: this chat already has ${u.files} files (limit ${this.maxFiles}). Delete files in /workspace first.`,
      );
    }
  }

  /** Records a write of this process. */
  commit(namespace: string, deltaBytes: number, deltaFiles: number): void {
    const u = this.usage.get(namespace);
    if (!u) return;
    u.bytes = Math.max(0, u.bytes + deltaBytes);
    u.files = Math.max(0, u.files + deltaFiles);
  }

  /** Drops the cached usage (after deletes and renames). */
  forget(namespace: string): void {
    this.usage.delete(namespace);
  }

  private async measure(store: BlobStore, namespace: string): Promise<QuotaUsage> {
    let bytes = 0;
    let files = 0;
    for (const blob of await store.listDetailed(`${namespace}/f${WORKSPACE_ROOT}/`)) {
      if (blob.name.endsWith(`/${DIR_MARKER_NAME}`) || typeof blob.metadata?.target !== "string") continue;
      files += 1;
      bytes += Number(blob.metadata.size) || 0;
    }
    return { bytes, files, at: Date.now() };
  }
}

const gq = globalThis as typeof globalThis & { __copilotWorkspaceQuota?: WorkspaceQuota };
/** 500 MB and 2,000 files per thread unless COPILOT_WORKSPACE_MAX_BYTES / _MAX_FILES say otherwise. */
export const sharedWorkspaceQuota = (): WorkspaceQuota =>
  (gq.__copilotWorkspaceQuota ??= new WorkspaceQuota(
    Number(process.env.COPILOT_WORKSPACE_MAX_BYTES) || 500 * 1024 * 1024,
    Number(process.env.COPILOT_WORKSPACE_MAX_FILES) || 2000,
  ));

export class BlobSessionFs implements SessionFsProvider {
  constructor(
    private readonly store: BlobStore,
    private readonly namespace: string,
    private readonly onOp?: SessionFsOpListener,
    private readonly quota: WorkspaceQuota | undefined = sharedWorkspaceQuota(),
    private readonly readFileLimit: number = readFileLimitBytes(),
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
    const counted = this.quota && isWorkspacePath(normalized);
    const deltaBytes = data.length - (previous ? Number(previous.props.metadata?.size) || 0 : 0);
    const deltaFiles = previous ? 0 : 1;
    if (counted) await this.quota!.check(this.store, this.namespace, deltaBytes, deltaFiles);
    const dataKey = this.newDataKey();
    await this.store.createAppendBlob(dataKey);
    await this.appendChunks(dataKey, data);
    // The pointer swap is the commit point: before it, readers see the old
    // content; after it, the new.
    await this.store.upload(this.fileKey(normalized), Buffer.alloc(0), {
      target: dataKey,
      size: String(data.length),
    });
    if (counted) this.quota!.commit(this.namespace, deltaBytes, deltaFiles);
    if (previous && previous.target !== dataKey) {
      await this.store.delete(previous.target).catch(() => false);
    }
  }

  /** File size from the pointer's metadata, else from the data blob (pointers written before `size` existed). */
  private async sizeOf(ptr: { props: BlobProps; target: string }): Promise<number | undefined> {
    const recorded = Number(ptr.props.metadata?.size);
    if (Number.isFinite(recorded) && ptr.props.metadata?.size !== undefined) return recorded;
    return (await this.store.getProperties(ptr.target))?.contentLength;
  }

  /** Whole file; with `capped`, a /workspace file over readFileLimit fails before any download. */
  private async readBuffer(normalized: string, capped: boolean): Promise<Buffer> {
    const ptr = await this.pointer(normalized);
    if (!ptr) throw enoent(normalized);
    if (capped && isWorkspacePath(normalized)) {
      const size = await this.sizeOf(ptr);
      if (size === undefined) throw enoent(normalized);
      if (size > this.readFileLimit) throw new FileTooLargeError(normalized, size, this.readFileLimit);
    }
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
    const entries: WorkspaceEntry[] = [];
    for await (const page of this.listEntryPages(dir, literalPrefix)) entries.push(...page);
    return entries;
  }

  /**
   * Same as listEntries, one Blob listing page at a time (name order), so a
   * search can stop listing at its limit. Only metadata, never content.
   */
  async *listEntryPages(dir: string, literalPrefix = ""): AsyncGenerator<WorkspaceEntry[]> {
    const n = this.norm("listEntries", dir, { literalPrefix });
    if (literalPrefix.includes("..") || literalPrefix.startsWith("/")) {
      throw new SessionPathError(`Invalid pattern prefix: ${literalPrefix}`);
    }
    const base = this.dirPrefix(n);
    for await (const listing of this.store.listDetailedPages(base + literalPrefix)) {
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
      if (entries.length > 0) yield entries;
    }
  }

  private checkEntry(entry: WorkspaceEntry): void {
    if (!entry.dataKey.startsWith(`${this.namespace}/d/`)) {
      throw new SessionPathError("Entry outside this namespace");
    }
  }

  /** Whole content of a listed workspace file (one download, nothing kept). */
  async readEntry(entry: WorkspaceEntry): Promise<Buffer> {
    this.checkEntry(entry);
    return this.store.download(entry.dataKey);
  }

  /**
   * For the view tool: a file (size from the pointer, streamed on demand), a
   * directory (its entry names), or undefined when nothing is there. One
   * HEAD of the pointer; the content GET only when the caller opens it.
   */
  async viewTarget(path: string): Promise<
    | { kind: "file"; size: number; open: (signal?: AbortSignal) => Promise<Readable> }
    | { kind: "directory"; entries: () => Promise<string[]> }
    | undefined
  > {
    const n = this.norm("view", path);
    const ptr = await this.pointer(n);
    if (ptr) {
      const size = await this.sizeOf(ptr);
      if (size === undefined) return undefined;
      return { kind: "file", size, open: async (signal) => (await this.store.openRead(ptr.target, { signal })).stream };
    }
    if (await this.isDirectory(n)) return { kind: "directory", entries: () => this.readdir(n) };
    return undefined;
  }

  /** Streams a listed workspace file; destroy the stream (or abort `signal`) to stop the download. */
  async openEntry(entry: WorkspaceEntry, signal?: AbortSignal): Promise<Readable> {
    this.checkEntry(entry);
    return (await this.store.openRead(entry.dataKey, { signal })).stream;
  }

  // ── SessionFsProvider ─────────────────────────────────────────────────
  async readFile(path: string): Promise<string> {
    const n = this.norm("readFile", path);
    return (await this.readBuffer(n, true)).toString("utf8");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const n = this.norm("readFileBytes", path);
    // Images for view and inputs of run_code: the SDK caps binary reads (~48 MiB).
    return new Uint8Array(await this.readBuffer(n, false));
  }

  /**
   * Bounded read for the runtime (capabilities.readFileRange): one ranged GET,
   * `byteLength` is the file's total size at that read. Without `length` the
   * read runs to the end and is capped like readFile under /workspace.
   */
  async readFileRange(path: string, offset: number, length?: number): Promise<{ content: Uint8Array; byteLength: number }> {
    const n = this.norm("readFileRange", path, { offset, length });
    const ptr = await this.pointer(n);
    if (!ptr) throw enoent(n);
    if (length === 0) {
      const props = await this.store.getProperties(ptr.target);
      if (!props) throw enoent(n);
      return { content: new Uint8Array(0), byteLength: props.contentLength };
    }
    const { stream, size } = await this.store.openRead(ptr.target, { offset, ...(length !== undefined ? { count: length } : {}) });
    const want = Math.max(0, Math.min(length ?? Infinity, size - offset));
    if (length === undefined && isWorkspacePath(n) && want > this.readFileLimit) {
      stream.destroy();
      throw new FileTooLargeError(n, size, this.readFileLimit);
    }
    const chunks: Buffer[] = [];
    let got = 0;
    for await (const chunk of stream) {
      const c = chunk as Buffer;
      const take = Math.min(c.length, want - got);
      if (take > 0) chunks.push(take === c.length ? c : c.subarray(0, take));
      got += take;
      if (got >= want) break;
    }
    if (got < want) throw new Error(`Short read of ${n}: ${got} of ${want} bytes`);
    const data = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, got);
    return { content: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), byteLength: size };
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
    this.quota?.forget(this.namespace);
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
    // A rename into /workspace adds a file to the quota (out of it, removes one).
    if (this.quota && isWorkspacePath(d) && !isWorkspacePath(s)) {
      const ptr = await this.pointer(s);
      if (ptr) await this.quota.check(this.store, this.namespace, Number(ptr.props.metadata?.size) || 0, 1);
    }
    this.quota?.forget(this.namespace);
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
