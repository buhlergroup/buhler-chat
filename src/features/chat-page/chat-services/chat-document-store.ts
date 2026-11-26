import "server-only";

/**
 * CHAT_DOCUMENT rows: server code only. Not a "use server" module: every
 * export of such a module is a Server Action that any signed-in browser can
 * call with its own arguments, and this lookup takes a thread id unchecked.
 * The callers (chat pages, thread context, thread service) read a thread the
 * caller may see first.
 */

import { userHashedId } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { SqlQuerySpec } from "@azure/cosmos";
import { CHAT_DOCUMENT_ATTRIBUTE, ChatDocumentModel } from "./models";

export const FindAllChatDocuments = async (
  chatThreadID: string
): Promise<ServerActionResponse<ChatDocumentModel[]>> => {
  try {
    // A chat document is written into the partition of the user who attached
    // it to their own thread (UploadChatDocument), so the caller's partition
    // holds every document of the caller's threads. With the partition key
    // the query runs in that one partition instead of fanning out to all.
    const userId = await userHashedId();
    const querySpec: SqlQuerySpec = {
      // ORDER BY is load-bearing, not cosmetic. Without it Cosmos returns rows
      // in whatever order the index feed yields, so the document names in the
      // system prompt's DOCUMENT CONTEXT line could reshuffle between turns —
      // rewriting the prompt prefix and voiding the prompt cache for no reason.
      // createdAt ASC is stable for the life of a thread; callers additionally
      // sort names so a same-millisecond tie can't leak through either.
      query:
        "SELECT * FROM root r WHERE r.type=@type AND r.chatThreadId = @threadId AND r.userId=@userId AND r.isDeleted=@isDeleted ORDER BY r.createdAt ASC",
      parameters: [
        {
          name: "@type",
          value: CHAT_DOCUMENT_ATTRIBUTE,
        },
        {
          name: "@threadId",
          value: chatThreadID,
        },
        {
          name: "@userId",
          value: userId,
        },
        {
          name: "@isDeleted",
          value: false,
        },
      ],
    };

    const { resources } = await HistoryContainer()
      .items.query<ChatDocumentModel>(querySpec, { partitionKey: userId })
      .fetchAll();

    if (resources) {
      return {
        status: "OK",
        response: resources,
      };
    } else {
      return {
        status: "ERROR",
        errors: [
          {
            message: "No documents found",
          },
        ],
      };
    }
  } catch (e) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `${e}`,
        },
      ],
    };
  }
};
