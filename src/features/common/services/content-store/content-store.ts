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
}

export interface CleanupResult {
  scanned: number;
  deleted: Array<{ scope: string; sha256: string }>;
  keptReferenced: number;
  keptRecent: number;
}

export const DEFAULT_CLEANUP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// put() refreshes the change time of reused content older than this.
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

// Blob metadata keys (Azure stores them case-insensitive; lowercase here).
const META_SHA256 = "sha256";
const META_OPENAI_FILE_ID = "openaifileid";
const META_OPENAI_FILE_NAME = "openaifilename";

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
   * afterwards.
   */
  async function markdown(
    scope: string,
    sha256: string,
    extract: () => Promise<string>
  ): Promise<{ markdown: string; cached: boolean }> {
    assertScope(scope);
    assertHash(sha256);
    const key = contentBlobPath(scope, sha256, ".md");

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
   */
  async function openAiFile(
    scope: string,
    sha256: string,
    file: { name: string; contentType?: string; bytes?: Uint8Array; blob?: Blob }
  ): Promise<{ fileId: string; uploaded: boolean }> {
    assertScope(scope);
    assertHash(sha256);
    const blobKey = contentBlobPath(scope, sha256);
    const name = file.name;

    const cachedId = async (): Promise<string | undefined> => {
      const props = await blobs.head(blobKey);
      if (!props) throw new Error("Content not found in the store");
      const id = props.metadata[META_OPENAI_FILE_ID];
      const cachedName = decodeMeta(props.metadata[META_OPENAI_FILE_NAME]);
      if (!id || cachedName !== name) return undefined;
      return (await deps.openAiFiles().exists(id)) ? id : undefined;
    };

    const first = await cachedId();
    if (first) return { fileId: first, uploaded: false };

    return once(`oai:${blobKey}:${name}`, async () => {
      const again = await cachedId();
      if (again) return { fileId: again, uploaded: false };

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

      const props = await blobs.head(blobKey);
      await blobs.setMetadata(blobKey, {
        ...(props?.metadata ?? {}),
        [META_SHA256]: sha256,
        [META_OPENAI_FILE_ID]: fileId,
        [META_OPENAI_FILE_NAME]: encodeMeta(name),
      });
      return { fileId, uploaded: true };
    });
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
   * that is older than the grace period. Scan based: run it on a schedule.
   * OpenAI files are not deleted here (chats that started with them can
   * still use them).
   */
  async function cleanup(options: CleanupOptions): Promise<CleanupResult> {
    const graceMs = options.graceMs ?? DEFAULT_CLEANUP_GRACE_MS;
    const cutoff = now().getTime() - graceMs;
    if (options.scope !== undefined) assertScope(options.scope);
    const prefix = options.scope ? `content/${options.scope}/` : "content/";

    // scope/hash -> newest change of the content or its Markdown, and keys.
    const groups = new Map<
      string,
      { scope: string; sha256: string; newest: number; keys: string[] }
    >();
    for await (const blob of blobs.list(prefix)) {
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

    const result: CleanupResult = {
      scanned: groups.size,
      deleted: [],
      keptReferenced: 0,
      keptRecent: 0,
    };
    for (const group of groups.values()) {
      if (group.newest > cutoff) {
        result.keptRecent++;
        continue;
      }
      if (await options.isReferenced(group.scope, group.sha256)) {
        result.keptReferenced++;
        continue;
      }
      if (!options.dryRun) {
        // Reused while the scan ran (put touches reused content): keep it.
        const latest = await blobs.head(contentBlobPath(group.scope, group.sha256));
        if (latest && latest.lastModified.getTime() > cutoff) {
          result.keptRecent++;
          continue;
        }
        // The Markdown first: content without Markdown is still complete.
        const ordered = [...group.keys].sort((a, b) => b.length - a.length);
        for (const key of ordered) await blobs.delete(key);
      }
      result.deleted.push({ scope: group.scope, sha256: group.sha256 });
    }
    return result;
  }

  return { put, putBlob, markdown, openAiFile, ensureIndexed, cleanup };
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
