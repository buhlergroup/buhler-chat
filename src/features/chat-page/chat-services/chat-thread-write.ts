import "server-only";

/**
 * Server-side writes of chat threads.
 *
 * No `"use server"` here on purpose: these functions write a thread exactly
 * as the server built it (personaId, extension ids, persona documents, ...),
 * so they must not be RPC endpoints. The client-facing action is
 * `UpsertChatThread` in chat-thread-service.ts, which takes only the fields
 * of `applyUserThreadChanges` from the client.
 */

import { ServerActionResponse } from "@/features/common/server-action-response";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { ChatThreadModel } from "./models";

/**
 * Upserts a thread that server code built or loaded from the user's own
 * partition, and stamps lastMessageAt.
 */
export const saveChatThread = async (
  chatThread: ChatThreadModel
): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    chatThread.lastMessageAt = new Date();
    const { resource } = await HistoryContainer().items.upsert<ChatThreadModel>(
      chatThread
    );

    if (resource) {
      return {
        status: "OK",
        response: resource,
      };
    }

    return {
      status: "ERROR",
      errors: [{ message: `Chat thread not found` }],
    };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

/**
 * The thread fields a user may change directly: the title and the bookmark.
 * Every other field comes from the stored thread. Fields that grant access or
 * capability (personaId, extension, personaDocumentIds, subAgentIds,
 * defaultTools, personaMessage, attachedFiles, userId, ...) change only
 * through server code or through the dedicated actions that check them.
 */
export const applyUserThreadChanges = (
  stored: ChatThreadModel,
  incoming: Partial<ChatThreadModel>
): ChatThreadModel => ({
  ...stored,
  ...(typeof incoming.name === "string" ? { name: incoming.name } : {}),
  ...(typeof incoming.bookmarked === "boolean"
    ? { bookmarked: incoming.bookmarked }
    : {}),
});
