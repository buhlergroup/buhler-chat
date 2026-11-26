import "server-only";

/**
 * Content-addressed file store: each file content (by SHA-256) is stored,
 * extracted, uploaded to OpenAI and indexed at most once per owner.
 *
 * Not a "use server" module: nothing here is callable from the browser. The
 * callers check the session and the ownership first and pass the owner as
 * `scope`.
 *
 * Rules:
 *   - `scope` is the owner: the user's hashed id, or the agent OWNER's hashed
 *     id for agent files. Content is never shared between scopes: a match
 *     across users would tell one user that another user has the same file.
 *   - The server computes the hash from the bytes; a client hash is never
 *     trusted.
 *   - A content blob is written once (If-None-Match: *) and never
 *     overwritten. Everything that changes is a reference (a chat document
 *     row, an agent file row) that points to a hash; an edit is new bytes
 *     and so a new hash.
 *   - The extracted Markdown sits next to the content (`<hash>.md`), also
 *     written once. The OpenAI file id is cached in the content blob's
 *     metadata (metadata changes, the bytes do not).
 *   - A content blob is deleted only by `cleanup`, when no reference points
 *     to it and it is older than the grace period.
 */

import { createHash } from "node:crypto";
import { contentBlobPath, isSha256Hex, parseContentBlobPath } from "@/features/common/blob-path";
import { isValidId } from "@/features/common/odata-filter";

/** Properties of a stored blob. Metadata keys are lowercase. */
export interface ContentBlobProperties {
  size: number;
  lastModified: Date;
  metadata: Record<string, string>;
  contentType?: string;
}

/** The blob operations the content store needs (Azure Blob or in memory). */
export interface ContentBlobBackend {
  /** Properties, or undefined when the blob does not exist. */
  head(key: string): Promise<ContentBlobProperties | undefined>;
  /**
   * Writes the blob only when no blob has this key (If-None-Match: *).
   * "exists" when another writer was first.
   */
  createIfAbsent(
    key: string,
    data: Buffer,
    options: { contentType?: string; metadata?: Record<string, string> }
  ): Promise<"created" | "exists">;
  /**
   * Like createIfAbsent, from a stream that is read once (`open` is called
   * once); only the chunks in flight are held in memory.
   */
  createIfAbsentFromStream(
    key: string,
    open: () => ReadableStream<Uint8Array>,
    size: number,
    options: { contentType?: string; metadata?: Record<string, string> }
  ): Promise<"created" | "exists">;
  /** The bytes, or undefined when the blob does not exist. */
  read(key: string): Promise<Buffer | undefined>;
  /** Replaces the metadata (not the bytes). */
  setMetadata(key: string, metadata: Record<string, string>): Promise<void>;
  /** Deletes the blob; a missing blob is no error. */
  delete(key: string): Promise<void>;
  /** Every blob whose name starts with `prefix`. */
  list(prefix: string): AsyncIterable<{ key: string; lastModified: Date }>;
  /**
   * One page of the blobs whose name starts with `prefix`, in name order.
   * `continuationToken` (from the previous page) continues the listing; the
   * result has none when the listing is at its end.
   */
  listPage(
    prefix: string,
    options: { continuationToken?: string; maxPageSize: number }
  ): Promise<{ items: Array<{ key: string; lastModified: Date }>; continuationToken?: string }>;
  /**
   * Takes the lock blob `key` (a blob lease of `ttlSeconds`, 15 to 60; the
   * blob is created when missing). Undefined when another holder has it.
   */
  acquireLock(key: string, ttlSeconds: number): Promise<ContentJobLock | undefined>;
}

/** A held lock blob (a blob lease); its metadata keeps the job's state. */
export interface ContentJobLock {
  /** The lock blob's metadata when the lock was taken (lowercase keys). */
  readonly metadata: Record<string, string>;
  /** Extends the lease by its ttl; throws when the lease was lost. */
  renew(): Promise<void>;
  /** Replaces the lock blob's metadata (only while the lease is held). */
  setMetadata(metadata: Record<string, string>): Promise<void>;
  /** Gives the lock up; never throws. */
  release(): Promise<void>;
}

/** The OpenAI file operations the content store needs. */
export interface ContentOpenAiFiles {
  /** False only when OpenAI answers that the file does not exist (404). */
  exists(fileId: string): Promise<boolean>;
  /** Uploads the bytes (purpose "assistants") and returns the file id. */
  upload(data: Buffer | Blob, name: string, contentType: string): Promise<string>;
}

export interface ContentStoreDeps {
  blobs: ContentBlobBackend;
  openAiFiles: () => ContentOpenAiFiles;
  now?: () => Date;
}

export interface StoredContent {
  sha256: string;
  blobKey: string;
  size: number;
  contentType: string;
  /** True when this call wrote the blob; false when the content was there. */
  created: boolean;
}

/** Where content is indexed, and how to tell that it already is. */
export interface IndexTarget {
  /** Stable name of the target, for example `thread:<id>`. */
  key: string;
  /**
   * True when this content is already indexed for the target. The answer
   * comes from the referencing rows (they store the hash), so no download
   * is needed.
   */
  isIndexed: () => Promise<boolean>;
}

export interface CleanupOptions {
  /** True when a row still points to the content of this scope and hash. */
  isReferenced: (scope: string, sha256: string) => Promise<boolean>;
  /** Content younger than this is kept (uploads whose row is not written yet). */
  graceMs?: number;
  /** Only this scope. */
  scope?: string;
  /** Report only, delete nothing. */
  dryRun?: boolean;
  /** Continue the listing where an earlier run stopped (its `continuationToken`). */
  continuationToken?: string;
  /** Blobs per listing call (default 1000). */
  pageSize?: number;
  /** Stop after this many listed blobs (default: no limit). */
  maxBlobs?: number;
  /** Checked before each page and each content: true stops the run (time budget, lost lock). */
  shouldStop?: () => boolean;
}

export interface CleanupResult {
  scanned: number;
  deleted: Array<{ scope: string; sha256: string }>;
  keptReferenced: number;
  keptRecent: number;
  /** Where the next run continues; undefined when this run reached the end. */
  continuationToken?: string;
  /** True when the listing reached its end (all content was looked at). */
  complete: boolean;
}

export const DEFAULT_CLEANUP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_PAGE_SIZE = 1000;

/** Longest file name (UTF-16 units) the store uploads and keeps in metadata. */
export const MAX_STORED_FILE_NAME_LENGTH = 255;

/**
 * The file name the store uploads to OpenAI and keeps in the blob metadata:
 * control characters and path separators replaced, trimmed, and at most
 * MAX_STORED_FILE_NAME_LENGTH characters with the extension kept. A
 * surrogate pair is never cut. Blob metadata is limited to 8 KB in total; an
 * uncapped name could make the metadata write fail after the upload.
 */
export const storedFileName = (name: string): string => {
  const clean =
    String(name ?? "").replace(/[\u0000-\u001f\u007f-\u009f/\\]/g, "_").trim() || "file";
  if (clean.length <= MAX_STORED_FILE_NAME_LENGTH) return clean;
  const dot = clean.lastIndexOf(".");
  const extension = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
  const room = MAX_STORED_FILE_NAME_LENGTH - extension.length;
  let head = "";
  for (const char of clean.slice(0, dot > 0 && extension ? dot : clean.length)) {
    if (head.length + char.length > room) break;
    head += char;
  }
  return head + extension;
};

/**
 * Who uses an OpenAI file of the store. Agent files (documents of an agent,
 * in the agent owner's scope) and the owner's own uploads get separate
 * OpenAI files: a chat of another user with the agent uses the agent file,
 * and deleting the owner's upload never removes it.
 */
export type OpenAiFileUse = "upload" | "agent";

// put() refreshes the change time of reused content older than this.
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

// Blob metadata keys (Azure stores them case-insensitive; lowercase here).
const META_SHA256 = "sha256";
const META_OPENAI_FILE_ID = "openaifileid";
const META_OPENAI_FILE_NAME = "openaifilename";
const META_AGENT_OPENAI_FILE_ID = "agentopenaifileid";
const META_AGENT_OPENAI_FILE_NAME = "agentopenaifilename";

const openAiMetaKeys = (use: OpenAiFileUse) =>
  use === "agent"
    ? { id: META_AGENT_OPENAI_FILE_ID, name: META_AGENT_OPENAI_FILE_NAME }
    : { id: META_OPENAI_FILE_ID, name: META_OPENAI_FILE_NAME };

export const sha256Hex = (data: Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

const assertScope = (scope: string) => {
  if (!isValidId(scope)) throw new Error("Invalid content store scope");
};

const assertHash = (sha256: string) => {
  if (!isSha256Hex(sha256)) throw new Error("Invalid content hash");
};

export function createContentStore(deps: ContentStoreDeps) {
  const { blobs } = deps;
  const now = deps.now ?? (() => new Date());

  // Calls in flight in this process, so two requests for the same work wait
  // for one result. Across processes the write-once blobs decide.
  const inFlight = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const running = inFlight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const started = run().finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
  };

  /**
   * Stores content once under `content/{scope}/sha256/{hash}`. Content
   * already there is reused when its size matches; a different size means
   * the blob is not what its name says, and the call fails.
   */
  async function storeOnce(
    scope: string,
    sha256: string,
    size: number,
    contentType: string,
    write: (blobKey: string, options: { contentType: string; metadata: Record<string, string> }) => Promise<"created" | "exists">
  ): Promise<StoredContent> {
    const blobKey = contentBlobPath(scope, sha256);

    const reuse = (props: ContentBlobProperties): StoredContent => {
      if (props.size !== size) {
        throw new Error("Stored content does not match its hash (size differs)");
      }
      const stored = props.metadata[META_SHA256];
      if (stored && stored !== sha256) {
        throw new Error("Stored content does not match its hash");
      }
      return { sha256, blobKey, size, contentType: props.contentType || contentType, created: false };
    };

    const existing = await blobs.head(blobKey);
    if (existing) {
      const stored = reuse(existing);
      // Content that is reused gets a fresh change time, so the cleanup's
      // grace period covers the row the caller is about to write.
      if (now().getTime() - existing.lastModified.getTime() > TOUCH_AFTER_MS) {
        await blobs.setMetadata(blobKey, { ...existing.metadata, [META_SHA256]: sha256 });
      }
      return stored;
    }

    const result = await write(blobKey, { contentType, metadata: { [META_SHA256]: sha256 } });
    if (result === "exists") {
      const props = await blobs.head(blobKey);
      if (!props) throw new Error("Stored content disappeared during the write");
      return reuse(props);
    }
    return { sha256, blobKey, size, contentType, created: true };
  }

  /** Stores bytes that are in memory already (see putBlob for uploads). */
  async function put(
    scope: string,
    bytes: Uint8Array,
    meta: { contentType?: string } = {}
  ): Promise<StoredContent> {
    assertScope(scope);
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return storeOnce(
      scope,
      sha256Hex(data),
      data.length,
      meta.contentType || "application/octet-stream",
      (key, options) => blobs.createIfAbsent(key, data, options)
    );
  }

  /**
   * Stores a Blob (an uploaded File) without copying it into one buffer:
   * one streamed pass computes the hash, a second pass streams the bytes to
   * the content key (blocks staged, committed with If-None-Match: *). Node
   * holds only the chunks in flight. A Blob cannot change between the
   * passes.
   */
  async function putBlob(
    scope: string,
    blob: Blob,
    meta: { contentType?: string } = {}
  ): Promise<StoredContent> {
    assertScope(scope);
    const hash = createHash("sha256");
    for await (const chunk of blob.stream() as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
    }
    return storeOnce(
      scope,
      hash.digest("hex"),
      blob.size,
      meta.contentType || blob.type || "application/octet-stream",
      (key, options) => blobs.createIfAbsentFromStream(key, () => blob.stream(), blob.size, options)
    );
  }

  /**
   * The extracted Markdown of the content. `extract` runs at most once per
   * scope and hash: its result is stored as `<hash>.md` and read from there
   * afterwards. With `pages` (a canonical page range such as "1-20") the
   * Markdown of those pages is cached apart, as `<hash>.p<pages>.md`.
   */
  async function markdown(
    scope: string,
    sha256: string,
    extract: () => Promise<string>,
    options: { pages?: string } = {}
  ): Promise<{ markdown: string; cached: boolean }> {
    assertScope(scope);
    assertHash(sha256);
    const key = contentBlobPath(
      scope,
      sha256,
      options.pages ? `.p${options.pages}.md` : ".md"
    );

    const cachedText = async () => {
      const cached = await blobs.read(key);
      return cached === undefined ? undefined : cached.toString("utf8");
    };

    const first = await cachedText();
    if (first !== undefined) return { markdown: first, cached: true };

    return once(`md:${key}`, async () => {
      const again = await cachedText();
      if (again !== undefined) return { markdown: again, cached: true };
      const text = await extract();
      if (typeof text !== "string") throw new Error("Extraction returned no text");
      await blobs.createIfAbsent(key, Buffer.from(text, "utf8"), {
        contentType: "text/markdown; charset=utf-8",
        metadata: { [META_SHA256]: sha256 },
      });
      return { markdown: text, cached: false };
    });
  }

  /**
   * The OpenAI file id of the content. The id is cached in the content blob's
   * metadata together with the file name (the code interpreter shows the
   * file under that name). A cached id that OpenAI no longer knows (404), or
   * one under another name, is replaced by a new upload. `bytes` saves the
   * read from the blob when the caller has them; they must hash to `sha256`.
   * `blob` is the upload that putBlob stored in the same request.
   *
   * `use` "agent" (an agent file, scope = agent owner) caches the id under
   * its own metadata keys, so an agent file never shares an OpenAI file with
   * an upload of the owner (see OpenAiFileUse). The name is stored as
   * storedFileName gives it.
   *
   * When the upload worked but recording the id in the metadata fails, the
   * id is still returned (`recorded` false): the caller uses it, and no
   * second upload leaves the first one behind as an orphan.
   */
  async function openAiFile(
    scope: string,
    sha256: string,
    file: {
      name: string;
      contentType?: string;
      bytes?: Uint8Array;
      blob?: Blob;
      use?: OpenAiFileUse;
    }
  ): Promise<{ fileId: string; uploaded: boolean; recorded: boolean }> {
    assertScope(scope);
    assertHash(sha256);
    const blobKey = contentBlobPath(scope, sha256);
    const name = storedFileName(file.name);
    const use: OpenAiFileUse = file.use === "agent" ? "agent" : "upload";
    const keys = openAiMetaKeys(use);

    const cachedId = async (): Promise<string | undefined> => {
      const props = await blobs.head(blobKey);
      if (!props) throw new Error("Content not found in the store");
      const id = props.metadata[keys.id];
      const cachedName = decodeMeta(props.metadata[keys.name]);
      if (!id || cachedName !== name) return undefined;
      return (await deps.openAiFiles().exists(id)) ? id : undefined;
    };

    const first = await cachedId();
    if (first) return { fileId: first, uploaded: false, recorded: true };

    return once(`oai:${use}:${blobKey}:${name}`, async () => {
      const again = await cachedId();
      if (again) return { fileId: again, uploaded: false, recorded: true };

      // A Blob is passed through as it is (it was hashed by putBlob in the
      // same request); bytes are checked against the hash.
      let data: Buffer | Blob | undefined = file.blob;
      if (!data) {
        const bytes = file.bytes
          ? Buffer.isBuffer(file.bytes)
            ? file.bytes
            : Buffer.from(file.bytes)
          : await blobs.read(blobKey);
        if (!bytes) throw new Error("Content not found in the store");
        if (sha256Hex(bytes) !== sha256) throw new Error("Content does not match its hash");
        data = bytes;
      }

      const fileId = await deps
        .openAiFiles()
        .upload(data, name, file.contentType || "application/octet-stream");

      try {
        const props = await blobs.head(blobKey);
        await blobs.setMetadata(blobKey, {
          ...(props?.metadata ?? {}),
          [META_SHA256]: sha256,
          [keys.id]: fileId,
          [keys.name]: encodeMeta(name),
        });
      } catch {
        // The file exists in OpenAI: use it now, upload again next time.
        return { fileId, uploaded: true, recorded: false };
      }
      return { fileId, uploaded: true, recorded: true };
    });
  }

  /**
   * True when `fileId` is the cached OpenAI file of an agent file of this
   * content (OpenAiFileUse "agent"). Such a file is never deleted for an
   * upload of the owner.
   */
  async function isAgentOpenAiFile(scope: string, sha256: string, fileId: string): Promise<boolean> {
    assertScope(scope);
    assertHash(sha256);
    const props = await blobs.head(contentBlobPath(scope, sha256));
    return Boolean(fileId) && props?.metadata[META_AGENT_OPENAI_FILE_ID] === fileId;
  }

  /**
   * Indexes the content for `target` once: `index` runs only when the target
   * does not have this content yet. `index` writes the chunks and the row
   * that records them (so `target.isIndexed` is true afterwards); new
   * content under the same document replaces the old chunks there.
   */
  async function ensureIndexed(
    scope: string,
    sha256: string,
    target: IndexTarget,
    index: () => Promise<void>
  ): Promise<"indexed" | "already-indexed"> {
    assertScope(scope);
    assertHash(sha256);
    return once(`idx:${scope}/${sha256}/${target.key}`, async () => {
      if (await target.isIndexed()) return "already-indexed" as const;
      await index();
      return "indexed" as const;
    });
  }

  /**
   * Deletes content (and its Markdown) that no row points to any more and
   * that is older than the grace period. Scan based: run it on a schedule
   * (cleanup-job.ts). `maxBlobs`, `pageSize` and `shouldStop` bound one run;
   * the returned `continuationToken` lets the next run go on from there.
   * OpenAI files are not deleted here (chats that started with them can
   * still use them).
   */
  async function cleanup(options: CleanupOptions): Promise<CleanupResult> {
    const graceMs = options.graceMs ?? DEFAULT_CLEANUP_GRACE_MS;
    const cutoff = now().getTime() - graceMs;
    if (options.scope !== undefined) assertScope(options.scope);
    const prefix = options.scope ? `content/${options.scope}/` : "content/";
    const pageSize = Math.max(1, Math.floor(options.pageSize ?? DEFAULT_CLEANUP_PAGE_SIZE));
    const maxBlobs = options.maxBlobs ?? Number.POSITIVE_INFINITY;
    const shouldStop = options.shouldStop ?? (() => false);

    type Group = { scope: string; sha256: string; newest: number; keys: string[] };

    const result: CleanupResult = {
      scanned: 0,
      deleted: [],
      keptReferenced: 0,
      keptRecent: 0,
      complete: false,
    };

    const processGroup = async (group: Group) => {
      result.scanned++;
      if (group.newest > cutoff) {
        result.keptRecent++;
        return;
      }
      if (await options.isReferenced(group.scope, group.sha256)) {
        result.keptReferenced++;
        return;
      }
      if (!options.dryRun) {
        // Reused while the scan ran (put touches reused content): keep it.
        const latest = await blobs.head(contentBlobPath(group.scope, group.sha256));
        if (latest && latest.lastModified.getTime() > cutoff) {
          result.keptRecent++;
          return;
        }
        // The Markdown first: content without Markdown is still complete.
        const ordered = [...group.keys].sort((a, b) => b.length - a.length);
        for (const key of ordered) await blobs.delete(key);
      }
      result.deleted.push({ scope: group.scope, sha256: group.sha256 });
    };

    // Page by page, in name order: `<hash>` and `<hash>.md` are neighbours.
    // The last group of a page can go on in the next page, so it is carried
    // over. A group cut by the end of a run is complete enough: the part on
    // the next page is looked at (and checked again) by the next run.
    let token = options.continuationToken;
    let listed = 0;
    let carry: Group | undefined;
    while (listed < maxBlobs && !shouldStop()) {
      const pageStart = token;
      const page = await blobs.listPage(prefix, {
        continuationToken: token,
        maxPageSize: Math.max(1, Math.min(pageSize, maxBlobs - listed)),
      });
      listed += page.items.length;

      // scope/hash -> newest change of the content or its Markdown, and keys.
      const groups = new Map<string, Group>();
      if (carry) groups.set(`${carry.scope}/${carry.sha256}`, carry);
      carry = undefined;
      for (const blob of page.items) {
        const parsed = parseContentBlobPath(blob.key);
        if (!parsed) continue;
        const id = `${parsed.scope}/${parsed.sha256}`;
        const group = groups.get(id) ?? {
          scope: parsed.scope,
          sha256: parsed.sha256,
          newest: 0,
          keys: [],
        };
        group.newest = Math.max(group.newest, blob.lastModified.getTime());
        group.keys.push(blob.key);
        groups.set(id, group);
      }
      const ready = [...groups.values()];
      if (page.continuationToken) carry = ready.pop();

      for (const group of ready) {
        if (shouldStop()) {
          // Stopped inside the page: the next run lists this page again.
          result.continuationToken = pageStart;
          return result;
        }
        await processGroup(group);
      }

      token = page.continuationToken;
      if (!token) {
        result.complete = true;
        return result;
      }
    }
    if (carry && !shouldStop()) await processGroup(carry);
    result.continuationToken = token;
    return result;
  }

  return { put, putBlob, markdown, openAiFile, isAgentOpenAiFile, ensureIndexed, cleanup };
}

export type ContentStore = ReturnType<typeof createContentStore>;

// Metadata values must be ASCII header values: file names are encoded.
const encodeMeta = (value: string) => encodeURIComponent(value);
const decodeMeta = (value: string | undefined) => {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};
