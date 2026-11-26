"use server";
import "server-only";

// Browser-callable: every export of this module is a Server Action, so it
// exports only UploadChatDocument, which checks the session and the thread
// itself. CHAT_DOCUMENT lookups are in chat-document-store.ts (server only).

import { userHashedId } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";

import { RevalidateCache } from "@/features/common/navigation-helpers";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { isValidId } from "@/features/common/odata-filter";
import { RestError } from "@azure/storage-blob";
import { logError } from "@/features/common/services/logger";
import { CHAT_THREAD_ATTRIBUTE, ChatThreadModel } from "./models";
import {
  ingestChatDocument,
  type ChatDocumentUploadResult,
} from "./chat-document-ingest";

const DEFAULT_MAX_UPLOAD_DOCUMENT_SIZE: number = 10485760; // 10MB in bytes

// Effective upload limit in bytes: MAX_UPLOAD_DOCUMENT_SIZE from the
// environment, or the 10MB default when it is unset or not a positive number.
// Not exported: a "use server" file may export only async functions.
const getMaxUploadDocumentSize = (): number => {
  const configured = Number(process.env.MAX_UPLOAD_DOCUMENT_SIZE);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_UPLOAD_DOCUMENT_SIZE;
};

const formatMegabytes = (bytes: number): string =>
  `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

/**
 * Uploads a file the user attached to one of their own chat threads: the
 * server stores it in the content store (by its SHA-256, per user),
 * extracts the text once per content and indexes it once per thread, and
 * records the CHAT_DOCUMENT row with the hash. FormData: "file", "id" (the
 * thread id).
 */
export const UploadChatDocument = async (
  formData: FormData
): Promise<ServerActionResponse<ChatDocumentUploadResult>> => {
  const invalid = (message: string): ServerActionResponse<ChatDocumentUploadResult> => ({
    status: "ERROR",
    errors: [{ message }],
  });
  try {
    const userId = await userHashedId();

    const file = formData?.get?.("file");
    const chatThreadId = formData?.get?.("id");
    if (!(file instanceof File) || !file.name) return invalid("No file provided");
    if (!isValidId(chatThreadId)) return invalid("Chat thread not found");

    const { resource } = await HistoryContainer()
      .item(chatThreadId, userId)
      .read<ChatThreadModel>();
    if (
      !resource ||
      resource.type !== CHAT_THREAD_ATTRIBUTE ||
      resource.isDeleted ||
      resource.userId !== userId
    ) {
      return invalid("Chat thread not found");
    }

    const maxSize = getMaxUploadDocumentSize();
    if (file.size >= maxSize) {
      return invalid(`File is too large and must be less than ${formatMegabytes(maxSize)}.`);
    }

    const response = await ingestChatDocument({
      userId,
      threadId: chatThreadId,
      fileName: file.name,
      file,
      contentType: file.type,
    });
    if (response.status === "OK") {
      RevalidateCache({ page: "chat", params: chatThreadId });
    }
    return response;
  } catch (e) {
    logError("UploadChatDocument failed", {
      error: e instanceof Error ? e.message : String(e),
      errorType: e instanceof RestError ? "RestError" : (e as any)?.constructor?.name,
      statusCode: e instanceof RestError ? e.statusCode : undefined,
    });
    return invalid(`${e}`);
  }
};
