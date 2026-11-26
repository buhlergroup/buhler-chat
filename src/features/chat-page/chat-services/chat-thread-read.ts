import "server-only";

/**
 * Server-side reads of chat thread rows, WITH the agent id lists that legacy
 * rows carry.
 *
 * No `"use server"` here on purpose: these functions return the stored row,
 * which a client must never get. The client-facing actions in
 * chat-thread-service.ts read through here and remove the lists
 * (withoutAgentIdLists) before they return a thread.
 *
 * Legacy rows: threads started from an agent before the thread stored the
 * agent id (personaId) hold copies of the agent's Search file ids and
 * sub-agent ids, and nothing else points to the agent. For those threads the
 * stored lists are the only source, so the chat turn still uses them
 * (threadAgentIdLists) and a save keeps them (rowForSave). A thread WITH an
 * agent id reads the lists from the agent's current row instead; its stored
 * copies are ignored and dropped on the next save.
 */

import { getCurrentUser, userHashedId } from "@/features/auth-page/helpers";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { HistoryContainer } from "@/features/common/services/cosmos";
import {
  CHAT_THREAD_ATTRIBUTE,
  ChatThreadModel,
  withNormalizedSelectedModel,
  withoutAgentIdLists,
} from "./models";

/** The agent id lists a legacy thread row stores. Server only. */
export type LegacyThreadAgentIdLists = {
  personaDocumentIds?: string[];
  subAgentIds?: string[];
};

/** A thread row as stored, legacy lists included. Server only. */
export type ChatThreadRow = ChatThreadModel & LegacyThreadAgentIdLists;

/**
 * The caller's thread row from the caller's own partition (point read), or
 * NOT_FOUND when it does not exist, is deleted or is not a thread.
 */
export const readChatThreadRow = async (
  id: string
): Promise<ServerActionResponse<ChatThreadRow>> => {
  try {
    const userId = await userHashedId();

    const { resource } = await HistoryContainer()
      .item(id, userId)
      .read<ChatThreadRow>();

    if (
      !resource ||
      resource.type !== CHAT_THREAD_ATTRIBUTE ||
      resource.isDeleted
    ) {
      return {
        status: "NOT_FOUND",
        errors: [{ message: `Chat thread not found` }],
      };
    }

    return { status: "OK", response: withNormalizedSelectedModel(resource) };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

/**
 * readChatThreadRow plus the ownership check of EnsureChatThreadOperation:
 * the row belongs to the caller (or the caller is an admin).
 */
export const ensureChatThreadRow = async (
  id: string
): Promise<ServerActionResponse<ChatThreadRow>> => {
  const response = await readChatThreadRow(id);
  if (response.status !== "OK") return response;

  const currentUser = await getCurrentUser();
  if (currentUser.isAdmin || response.response.userId === (await userHashedId())) {
    return response;
  }

  return {
    status: "UNAUTHORIZED",
    errors: [{ message: "You are not authorized to access this chat thread." }],
  };
};

/**
 * The stored agent id lists of a LEGACY thread (no personaId), or undefined
 * for a thread with an agent id: its lists come from the agent's current row.
 */
export const legacyThreadAgentIdLists = (
  row: ChatThreadRow
): { personaDocumentIds: string[]; subAgentIds: string[] | undefined } | undefined =>
  row.personaId
    ? undefined
    : {
        personaDocumentIds: row.personaDocumentIds ?? [],
        subAgentIds: row.subAgentIds,
      };

/**
 * The row as it is written: a thread with an agent id loses stored copies of
 * the agent's lists; a legacy thread keeps them, because they are its only
 * source of the agent's documents and sub-agents.
 */
export const rowForSave = <T extends ChatThreadRow>(row: T): T =>
  row.personaId ? withoutAgentIdLists(row) : row;
