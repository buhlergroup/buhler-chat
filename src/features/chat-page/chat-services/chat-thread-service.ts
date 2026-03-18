"use server";
import "server-only";

import {
  getCurrentUser,
  userHashedId,
  userSession,
} from "@/features/auth-page/helpers";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { uniqueId } from "@/features/common/util";
import {
  CHAT_DEFAULT_PERSONA,
  NEW_CHAT_NAME,
} from "@/features/theme/theme-config";
import { SqlQuerySpec } from "@azure/cosmos";
import { HistoryContainer } from "../../common/services/cosmos";
import { DeleteDocumentsOfChatThread } from "./azure-ai-search/azure-ai-search";
import { FindAllChatDocuments } from "./chat-document-service";
import { FindAllChatMessagesForCurrentUser } from "./chat-message-service";
import {
  CHAT_THREAD_ATTRIBUTE,
  ChatDocumentModel,
  ChatMessageModel,
  ChatThreadModel,
  AttachedFileModel,
} from "./models";
import { redirect } from "next/navigation";
import { ChatApiText } from "./chat-api/chat-api-text";
import { findChildThreads } from "./chat-api/sub-agent-thread-service";

export const FindAllChatThreadForCurrentUser = async (): Promise<
  ServerActionResponse<Array<ChatThreadModel>>
> => {
  try {
    const querySpec: SqlQuerySpec = {
      query:
        "SELECT * FROM root r WHERE r.type=@type AND r.userId=@userId AND (NOT IS_DEFINED(r.isTemporary) OR r.isTemporary=@isTemporary) AND r.isDeleted=@isDeleted AND (NOT IS_DEFINED(r.parentThreadId) OR r.parentThreadId='') ORDER BY r.createdAt DESC",
      parameters: [
        {
          name: "@type",
          value: CHAT_THREAD_ATTRIBUTE,
        },
        {
          name: "@userId",
          value: await userHashedId(),
        },
        {
          name: "@isTemporary",
          value: false,
        },
        {
          name: "@isDeleted",
          value: false,
        },
      ],
    };

    const { resources } = await HistoryContainer()
      .items.query<ChatThreadModel>(querySpec, {
        partitionKey: await userHashedId(),
      })
      .fetchAll();
    return {
      status: "OK",
      response: resources,
    };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

export const FindChatThreadForCurrentUser = async (
  id: string
): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    const userId = await userHashedId();

    const { resource } = await HistoryContainer()
      .item(id, userId)
      .read<ChatThreadModel>();

    if (!resource) {
      return {
        status: "NOT_FOUND",
        errors: [{ message: `Chat thread not found` }],
      };
    }

    if (resource.type !== CHAT_THREAD_ATTRIBUTE || resource.isDeleted) {
      return {
        status: "NOT_FOUND",
        errors: [{ message: `Chat thread not found` }],
      };
    }

    return {
      status: "OK",
      response: resource,
    };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

/**
 * Returns the start index for deletion, validating existence of untilMessageId or untilMessageIndex.
 * Throws an error if the provided option is invalid or not found.
 * If no option is provided, returns 0 (delete all).
 */
function getValidatedStartIndex(chats: ChatMessageModel[], options?: { untilMessageId?: string, untilMessageIndex?: number }) {
  if (options && (typeof options.untilMessageIndex === "number" || options.untilMessageId)) {
    if (typeof options.untilMessageIndex === "number") {
      if (options.untilMessageIndex < 0 || options.untilMessageIndex >= chats.length) {
        throw new Error("untilMessageIndex is out of bounds");
      }
      return options.untilMessageIndex + 1;
    } else if (options.untilMessageId) {
      const foundIdx = chats.findIndex((chat) => chat.id === options.untilMessageId);
      if (foundIdx === -1) {
        throw new Error("untilMessageId not found");
      }
      return foundIdx + 1;
    }
  }
  // No option provided: delete all
  return 0;
}

export const SoftDeleteChatContentsForCurrentUser = async (
  chatThreadID: string,
  options?: { untilMessageId?: string, untilMessageIndex?: number }
): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    const chatThreadResponse = await FindChatThreadForCurrentUser(chatThreadID);

    if (chatThreadResponse.status === "OK") {
      const chatResponse = await FindAllChatMessagesForCurrentUser(
        chatThreadID
      );

      if (chatResponse.status !== "OK") {
        return chatResponse;
      }
      const chats = chatResponse.response;

      const startIdx = getValidatedStartIndex(chats, options);
      await Promise.all(
        chats.slice(startIdx).map(async (chat) => {
          const itemToUpdate = {
            ...chat,
            isDeleted: true,
          };
          await HistoryContainer().items.upsert(itemToUpdate);
        })
      );

      const chatDocumentsResponse = await FindAllChatDocuments(chatThreadID);

      if (chatDocumentsResponse.status !== "OK") {
        return chatDocumentsResponse;
      }

      const chatDocuments = chatDocumentsResponse.response;

      if (chatDocuments.length !== 0) {
        await DeleteDocumentsOfChatThread(chatThreadID);
      }

      chatDocuments.forEach(async (chatDocument: ChatDocumentModel) => {
        const itemToUpdate = {
          ...chatDocument,
        };
        itemToUpdate.isDeleted = true;
        await HistoryContainer().items.upsert(itemToUpdate);
      });
    }

    return chatThreadResponse;
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

export const SoftDeleteChatThreadForCurrentUser = async (
  chatThreadID: string
): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    const chatThreadResponse = await FindChatThreadForCurrentUser(chatThreadID);

    if (chatThreadResponse.status === "OK") {
      // Cascade delete child threads (sub-agent threads) recursively
      const childThreads = await findChildThreads(chatThreadID);
      for (const childThread of childThreads) {
        await SoftDeleteChatThreadForCurrentUser(childThread.id);
      }

      const response = await SoftDeleteChatContentsForCurrentUser(chatThreadID);
      if (response.status !== "OK") {
        return response;
      }
      chatThreadResponse.response.isDeleted = true;
      await HistoryContainer().items.upsert(chatThreadResponse.response);
    }

    return chatThreadResponse;
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

export const SoftDeleteChatDocumentsForCurrentUser = async (
  chatThreadId: string
): Promise<ServerActionResponse> => {
  try {
    const chatDocumentsResponse = await FindAllChatDocuments(chatThreadId);

    if (chatDocumentsResponse.status !== "OK") {
      return chatDocumentsResponse;
    }

    const chatDocuments = chatDocumentsResponse.response;

    if (chatDocuments.length !== 0) {
      await DeleteDocumentsOfChatThread(chatThreadId);
    }

    chatDocuments.forEach(async (chatDocument: ChatDocumentModel) => {
      const itemToUpdate = {
        ...chatDocument,
      };
      itemToUpdate.isDeleted = true;
      await HistoryContainer().items.upsert(itemToUpdate);
    });

    return {
      status: "OK",
      response: "OK",
    };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

export const EnsureChatThreadOperation = async (
  chatThreadID: string
): Promise<ServerActionResponse<ChatThreadModel>> => {
  const response = await FindChatThreadForCurrentUser(chatThreadID);
  // check access to Persona documents
  const currentUser = await getCurrentUser();
  const hashedId = await userHashedId();

  if (response.status === "OK") {
    if (currentUser.isAdmin || response.response.userId === hashedId) {
      return response;
    }
  }

  return response;
};

export const AddExtensionToChatThread = async (props: {
  chatThreadId: string;
  extensionId: string;
}): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    const response = await FindChatThreadForCurrentUser(props.chatThreadId);
    if (response.status === "OK") {
      const chatThread = response.response;

      const existingExtension = chatThread.extension.find(
        (e) => e === props.extensionId
      );

      if (existingExtension === undefined) {
        chatThread.extension.push(props.extensionId);
        return await UpsertChatThread(chatThread);
      }

      return {
        status: "OK",
        response: chatThread,
      };
    }

    return response;
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

export const RemoveExtensionFromChatThread = async (props: {
  chatThreadId: string;
  extensionId: string;
}): Promise<ServerActionResponse<ChatThreadModel>> => {
  const response = await FindChatThreadForCurrentUser(props.chatThreadId);
  if (response.status === "OK") {
    const chatThread = response.response;
    chatThread.extension = chatThread.extension.filter(
      (e) => e !== props.extensionId
    );

    return await UpsertChatThread(chatThread);
  }

  return response;
};

export const UpsertChatThread = async (
  chatThread: ChatThreadModel
): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    if (chatThread.id) {
      const response = await EnsureChatThreadOperation(chatThread.id);
      if (response.status !== "OK") {
        if (response.status !== "NOT_FOUND") {
          return response;
        }
      }
    }

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

export const CreateChatThread = async (options?: {
  id?: string;
  name?: string;
  temporary?: boolean;
}): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    const modelToSave: ChatThreadModel = {
      name: options?.name ?? NEW_CHAT_NAME,
      useName: (await userSession())!.name,
      userId: await userHashedId(),
      id: options?.id ?? uniqueId(),
      createdAt: new Date(),
      lastMessageAt: new Date(),
      bookmarked: false,
      isDeleted: false,
      type: CHAT_THREAD_ATTRIBUTE,
      personaMessage: "",
      personaMessageTitle: CHAT_DEFAULT_PERSONA,
      extension: [],
      personaDocumentIds: [],
      isTemporary: options?.temporary ?? false,
    };

    // Use upsert to allow both creation of new chat threads and updating existing ones.
    // This ensures that if a thread with the same ID exists, it will be updated instead of failing.
    const { resource } = await HistoryContainer().items.upsert<ChatThreadModel>(
      modelToSave
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

export const ResetChatThread = async (
  chatThreadId: string,
  options?: { toMessageId?: string, toMessageIndex?: number }
): Promise<ServerActionResponse<ChatThreadModel>> => {
  return await SoftDeleteChatContentsForCurrentUser(
    chatThreadId,
    { untilMessageId: options?.toMessageId, untilMessageIndex: options?.toMessageIndex }
  );
};

export const UpdateChatTitle = async (
  chatThreadId: string,
  prompt: string
): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    const response = await FindChatThreadForCurrentUser(chatThreadId);
    const shorterPrompt = prompt.slice(0, 300);
    if (response.status === "OK") {
      const chatThread = response.response;
      const systemPrompt = `- you will generate a short title based on the first message a user begins a conversation with
                            - ensure it is not more than 40 characters long
                            - the title should be a summary or keywords of the user's message
                            - do not use quotes or colons
                            USERPROMPT: ${shorterPrompt}`;

      const name = await ChatApiText(systemPrompt);

      if (name) {
        chatThread.name = name;
      }

      return await UpsertChatThread(chatThread);
    }
    return response;
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

export const UpdateChatThreadSelectedModel = async (
  chatThreadId: string,
  selectedModel: string
): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    const response = await FindChatThreadForCurrentUser(chatThreadId);
    if (response.status === "OK") {
      const chatThread = response.response;
      chatThread.selectedModel = selectedModel as any;
      return await UpsertChatThread(chatThread);
    }
    return response;
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

export const UpdateChatThreadReasoningEffort = async (
  chatThreadId: string,
  reasoningEffort: string
): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    const response = await FindChatThreadForCurrentUser(chatThreadId);
    if (response.status === "OK") {
      const chatThread = response.response;
      chatThread.reasoningEffort = reasoningEffort as any;
      return await UpsertChatThread(chatThread);
    }
    return response;
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

export const UpdateChatThreadCodeInterpreterContainer = async (
  chatThreadId: string,
  containerId: string,
  fileIdsSignature?: string
): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    const response = await FindChatThreadForCurrentUser(chatThreadId);
    if (response.status === "OK") {
      const chatThread = response.response;
      chatThread.codeInterpreterContainerId = containerId;
      if (fileIdsSignature !== undefined) {
        chatThread.codeInterpreterFileIdsSignature = fileIdsSignature;
      }
      return await UpsertChatThread(chatThread);
    }
    return response;
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

export const UpdateChatThreadAttachedFiles = async (
  chatThreadId: string,
  attachedFiles: AttachedFileModel[]
): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    const response = await FindChatThreadForCurrentUser(chatThreadId);
    if (response.status === "OK") {
      const chatThread = response.response;
      chatThread.attachedFiles = attachedFiles;
      return await UpsertChatThread(chatThread);
    }
    return response;
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

export const AddAttachedFile = async (
  chatThreadId: string,
  file: AttachedFileModel
): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    const response = await FindChatThreadForCurrentUser(chatThreadId);
    if (response.status === "OK") {
      const chatThread = response.response;
      const existingFiles = chatThread.attachedFiles || [];
      // Avoid duplicates
      if (!existingFiles.some(f => f.id === file.id)) {
        chatThread.attachedFiles = [...existingFiles, file];
        return await UpsertChatThread(chatThread);
      }
      return response;
    }
    return response;
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

export const RemoveAttachedFile = async (
  chatThreadId: string,
  fileId: string
): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    const response = await FindChatThreadForCurrentUser(chatThreadId);
    if (response.status === "OK") {
      const chatThread = response.response;
      chatThread.attachedFiles = (chatThread.attachedFiles || []).filter(f => f.id !== fileId);
      return await UpsertChatThread(chatThread);
    }
    return response;
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

export const CreateChatAndRedirect = async () => {
  const response = await CreateChatThread();
  if (response.status === "OK") {
    redirect(`/chat/${response.response.id}`);
  }
};
