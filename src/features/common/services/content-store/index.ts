import "server-only";

/**
 * The app's content store instance: Azure Blob (or the e2e memory backend
 * registered under SERVICE_KEYS.contentBlobs) and the OpenAI files API.
 * See content-store.ts for the rules.
 */

import { toFile } from "openai";
import { OpenAIV1Instance } from "../openai";
import { has, register, resolve, SERVICE_KEYS } from "../service-container";
import { createAzureContentBlobBackend } from "./azure-blob-backend";
import {
  createContentStore,
  type ContentBlobBackend,
  type ContentOpenAiFiles,
  type ContentStore,
} from "./content-store";

if (!has(SERVICE_KEYS.contentBlobs)) {
  register(SERVICE_KEYS.contentBlobs, createAzureContentBlobBackend);
}

const blobs = (): ContentBlobBackend => resolve<ContentBlobBackend>(SERVICE_KEYS.contentBlobs);

// Resolved on every call, so a binding registered later (e2e) is used.
const delegatingBackend: ContentBlobBackend = {
  head: (key) => blobs().head(key),
  createIfAbsent: (key, data, options) => blobs().createIfAbsent(key, data, options),
  createIfAbsentFromStream: (key, open, size, options) =>
    blobs().createIfAbsentFromStream(key, open, size, options),
  read: (key) => blobs().read(key),
  setMetadata: (key, metadata) => blobs().setMetadata(key, metadata),
  delete: (key) => blobs().delete(key),
  list: (prefix) => blobs().list(prefix),
};

const isNotFound = (error: unknown): boolean => {
  const status =
    (error as { status?: number })?.status ?? (error as { statusCode?: number })?.statusCode;
  return status === 404;
};

/** OpenAI files (purpose "assistants", the code interpreter's purpose). */
export const openAiContentFiles = (): ContentOpenAiFiles => {
  const openai = OpenAIV1Instance();
  return {
    async exists(fileId) {
      try {
        await openai.files.retrieve(fileId);
        return true;
      } catch (error) {
        // Only a 404 is "gone"; on any other error the id is kept.
        return !isNotFound(error);
      }
    },
    async upload(data, name, contentType) {
      const created = await openai.files.create({
        // A Blob (an upload) is wrapped, not read: a File made from a Blob
        // refers to its bytes, the SDK streams it.
        file: Buffer.isBuffer(data)
          ? await toFile(data, name, { type: contentType })
          : new File([data], name, { type: contentType }),
        purpose: "assistants",
      });
      return created.id;
    },
  };
};

declare global {
  var __contentStore: ContentStore | undefined;
}

/** The one store of this process (its in-flight map is shared). */
export const contentStore = (): ContentStore =>
  (globalThis.__contentStore ??= createContentStore({
    blobs: delegatingBackend,
    openAiFiles: openAiContentFiles,
  }));

const DEFAULT_MAX_BUFFERED_BYTES = 50 * 1024 * 1024;

/**
 * True when a file that is only available as one in-memory buffer may go
 * through the content store: at most CONTENT_STORE_MAX_BUFFERED_BYTES
 * (default 50 MB). Larger files keep the path without the content store, so
 * the store adds no work for them. Uploads (Blobs) are streamed and have no
 * such limit (putBlob).
 */
export const contentStoreTakesBuffer = (size: number): boolean => {
  const configured = Number(process.env.CONTENT_STORE_MAX_BUFFERED_BYTES);
  const limit = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_BUFFERED_BYTES;
  return size <= limit;
};

export { sha256Hex } from "./content-store";
export type { IndexTarget, StoredContent } from "./content-store";
