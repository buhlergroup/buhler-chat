import "server-only";

/**
 * Chat document upload through the content store: store the bytes once,
 * extract once, index once per thread.
 *
 *   same bytes, same thread          → no extraction, no indexing
 *   same bytes, other thread (user)  → cached Markdown, indexing for that thread
 *   same bytes, other user           → nothing reused (scope = user)
 *
 * A new content under a file name the thread already has replaces the old
 * one: its chunks are deleted and its row is marked deleted, after the new
 * chunks are in the index.
 *
 * Not a "use server" module: the caller (UploadChatDocument) checks the
 * session and that the thread is the caller's, and passes the user id.
 */

import { ServerActionResponse } from "@/features/common/server-action-response";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { contentStore } from "@/features/common/services/content-store";
import { extractTextWithDocumentIntelligence } from "@/features/common/services/document-extraction";
import { logInfo } from "@/features/common/services/logger";
import { uniqueId } from "@/features/common/util";
import {
  DeleteChunksByIds,
  EnsureIndexIsCreated,
  FindChatDocumentChunkIds,
  IndexDocuments,
} from "./azure-ai-search/azure-ai-search";
import { chunkTextWithOverlap } from "./chat-document-chunks";
import {
  CHAT_DOCUMENT_ATTRIBUTE,
  ChatDocumentModel,
  SupportedFileExtensionsDocumentIntellicence,
  SupportedFileExtensionsTextFiles,
} from "./models";

export interface ChatDocumentUploadResult {
  name: string;
  sha256: string;
  /** Document Intelligence ran for this upload. */
  extracted: boolean;
  /** "already-indexed": the thread had this content; nothing was indexed. */
  indexing: "indexed" | "already-indexed";
  /** Chunks written to the index by this upload. */
  chunks: number;
}

class UserFacingError extends Error {}

const extensionOf = (fileName: string) => fileName.split(".").pop()?.toUpperCase() ?? "";

export const isTextFileName = (fileName: string) =>
  Object.values(SupportedFileExtensionsTextFiles).includes(
    extensionOf(fileName) as SupportedFileExtensionsTextFiles
  );

const isDocumentIntelligenceFileName = (fileName: string) =>
  Object.values(SupportedFileExtensionsDocumentIntellicence).includes(
    extensionOf(fileName) as SupportedFileExtensionsDocumentIntellicence
  );

/** Not deleted CHAT_DOCUMENT rows of a thread with this hash or this name. */
async function findThreadDocuments(
  userId: string,
  threadId: string,
  where: { sha256: string } | { name: string }
): Promise<ChatDocumentModel[]> {
  const [field, value] = "sha256" in where ? ["sha256", where.sha256] : ["name", where.name];
  const { resources } = await HistoryContainer()
    .items.query<ChatDocumentModel>(
      {
        query: `SELECT * FROM root r WHERE r.type = @type AND r.userId = @userId AND r.chatThreadId = @threadId AND r.isDeleted = false AND r.${field} = @value`,
        parameters: [
          { name: "@type", value: CHAT_DOCUMENT_ATTRIBUTE },
          { name: "@userId", value: userId },
          { name: "@threadId", value: threadId },
          { name: "@value", value },
        ],
      },
      { partitionKey: userId }
    )
    .fetchAll();
  return resources ?? [];
}

/**
 * Stores, extracts and indexes one chat document of `userId` in `threadId`.
 * The caller has checked the session and the thread.
 */
export async function ingestChatDocument(args: {
  userId: string;
  threadId: string;
  fileName: string;
  /** The upload; streamed into the store, read whole only to extract. */
  file: Blob;
  contentType?: string;
}): Promise<ServerActionResponse<ChatDocumentUploadResult>> {
  const { userId, threadId, fileName, file } = args;
  const isText = isTextFileName(fileName);
  if (!isText && !isDocumentIntelligenceFileName(fileName)) {
    return { status: "ERROR", errors: [{ message: "Error: Unsupported File Type" }] };
  }

  const index = await EnsureIndexIsCreated();
  if (index.status !== "OK") return index;

  const store = contentStore();
  const stored = await store.putBlob(userId, file, { contentType: args.contentType });
  let extracted = false;
  let chunkCount = 0;

  try {
    const indexing = await store.ensureIndexed(
      userId,
      stored.sha256,
      {
        key: `thread:${threadId}`,
        isIndexed: async () =>
          (await findThreadDocuments(userId, threadId, { sha256: stored.sha256 })).length > 0,
      },
      async () => {
        let text: string;
        if (isText) {
          text = await file.text();
        } else {
          // Read whole only when Document Intelligence runs (cache miss);
          // chat documents are limited by MAX_UPLOAD_DOCUMENT_SIZE.
          const md = await store.markdown(userId, stored.sha256, async () =>
            extractTextWithDocumentIntelligence(new Uint8Array(await file.arrayBuffer()))
          );
          extracted = !md.cached;
          text = md.markdown;
        }

        const chunks = chunkTextWithOverlap(text).filter(
          (c) => c.trim().length > 0
        );
        if (chunks.length === 0) {
          throw new UserFacingError(`${fileName}: Document contains no text that can be indexed.`);
        }

        // Older content under the same name: its chunks are collected before
        // the new ones exist, and deleted once the new ones are in.
        const replaced = (await findThreadDocuments(userId, threadId, { name: fileName })).filter(
          (row) => row.sha256 !== stored.sha256
        );
        const oldChunkIds =
          replaced.length > 0 ? await FindChatDocumentChunkIds(threadId, userId, fileName) : [];

        const results = await IndexDocuments(chunks, fileName, threadId, undefined, userId);
        const failed = results.flatMap((r) => (r.status === "OK" ? [] : r.errors));
        if (results.length === 0 || failed.length > 0) {
          throw new UserFacingError(
            "Looks like not all documents were indexed" +
              failed.map((e) => e.message).join("\n")
          );
        }
        chunkCount = results.length;

        const row: ChatDocumentModel = {
          id: uniqueId(),
          chatThreadId: threadId,
          userId,
          createdAt: new Date(),
          type: CHAT_DOCUMENT_ATTRIBUTE,
          isDeleted: false,
          name: fileName,
          sha256: stored.sha256,
        };
        await HistoryContainer().items.upsert<ChatDocumentModel>(row);

        if (replaced.length > 0) {
          await DeleteChunksByIds(oldChunkIds);
          for (const old of replaced) {
            await HistoryContainer().items.upsert<ChatDocumentModel>({ ...old, isDeleted: true });
          }
        }
      }
    );

    logInfo("chat document: content store upload", {
      threadId,
      sha256: stored.sha256,
      blobCreated: stored.created,
      extracted,
      indexing,
      chunks: chunkCount,
    });
    return {
      status: "OK",
      response: { name: fileName, sha256: stored.sha256, extracted, indexing, chunks: chunkCount },
    };
  } catch (error) {
    if (error instanceof UserFacingError) {
      return { status: "ERROR", errors: [{ message: error.message }] };
    }
    throw error;
  }
}
