"use server";
import "server-only";

import {
  getCurrentUser,
  userHashedId,
  userSession,
} from "@/features/auth-page/helpers";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { logError, logInfo, logWarn } from "@/features/common/services/logger";
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
import { SoftDeleteChatHistorySummary } from "./chat-api/history-summary-service";
import {
  CHAT_THREAD_ATTRIBUTE,
  DEFAULT_MODEL,
  MODEL_CONFIGS,
  type ChatModel,
  type ReasoningEffort,
  ChatDocumentModel,
  ChatMessageModel,
  ChatThreadModel,
  AttachedFileModel,
  normalizeChatModelId,
  withNormalizedSelectedModel,
} from "./models";
import { mergeClientAttachedFiles } from "./code-interpreter-file-access";

const VALID_REASONING_EFFORTS: ReadonlyArray<ReasoningEffort> = [
  "minimal",
  "low",
  "medium",
  "high",
];

function isValidChatModel(value: string): value is ChatModel {
  return value in MODEL_CONFIGS;
}

function isValidReasoningEffort(value: string): value is ReasoningEffort {
  return (VALID_REASONING_EFFORTS as ReadonlyArray<string>).includes(value);
}
import { redirect } from "next/navigation";
import { RevalidateCache } from "@/features/common/navigation-helpers";
import { ChatApiTitleAndIntent } from "./chat-api/chat-api-text";
import { applyUserThreadChanges, saveChatThread } from "./chat-thread-write";
import { findUsableExtension } from "@/features/extensions-page/extension-services/extension-runtime";

export const FindAllChatThreadForCurrentUser = async (): Promise<
  ServerActionResponse<Array<ChatThreadModel>>
> => {
  try {
    const querySpec: SqlQuerySpec = {
      query:
        "SELECT * FROM root r WHERE r.type=@type AND r.userId=@userId AND (NOT IS_DEFINED(r.isTemporary) OR r.isTemporary=@isTemporary) AND r.isDeleted=@isDeleted ORDER BY r.createdAt DESC",
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
      response: resources.map(withNormalizedSelectedModel),
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
      response: withNormalizedSelectedModel(resource),
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

      // The chat's workspace uploads go with its documents (Copilot path).
      await removeAgentWorkspaceFiles(chatThreadID, "uploads");
      // The Copilot runtime must not continue the deleted turns: drop its
      // live session (all instances) and its journal; a full reset also
      // clears the agent's files. The next turn reseeds from Cosmos.
      await resetAgentRuntime(chatThreadID, startIdx === 0 ? "reset" : "rewind");

      // Drop the history-compaction row with the messages it describes. It
      // holds both a summary of trimmed turns and the watermark marking where
      // the prompt resumes; keeping either after a rewind would let the model
      // go on citing content the user deliberately deleted, with nothing left
      // in the transcript to explain where it came from.
      await SoftDeleteChatHistorySummary(chatThreadID);
    }

    return chatThreadResponse;
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

/**
 * Removes the thread's files in the agent workspace (Copilot path). A no-op
 * where the Copilot path is not configured; never fails the caller.
 */
const removeAgentWorkspaceFiles = async (
  chatThreadId: string,
  scope: "uploads" | "all",
): Promise<void> => {
  const { removeThreadWorkspaceFilesQuietly } = await import(
    "./copilot-runtime/workspace-files"
  );
  await removeThreadWorkspaceFilesQuietly(await userHashedId(), chatThreadId, scope);
};

/** See resetThreadRuntimeQuietly (Copilot path); never fails the caller. */
const resetAgentRuntime = async (chatThreadId: string, mode: "rewind" | "reset"): Promise<void> => {
  const { resetThreadRuntimeQuietly } = await import("./copilot-runtime/workspace-files");
  await resetThreadRuntimeQuietly(await userHashedId(), chatThreadId, mode);
};

export const SoftDeleteChatThreadForCurrentUser = async (
  chatThreadID: string
): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    const chatThreadResponse = await FindChatThreadForCurrentUser(chatThreadID);

    if (chatThreadResponse.status === "OK") {
      const response = await SoftDeleteChatContentsForCurrentUser(chatThreadID);
      if (response.status !== "OK") {
        return response;
      }
      chatThreadResponse.response.isDeleted = true;
      await HistoryContainer().items.upsert(chatThreadResponse.response);
      // The whole agent workspace and session state of the thread (Copilot path).
      await removeAgentWorkspaceFiles(chatThreadID, "all");
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

    // The uploads in the chat's agent workspace go with the documents (Copilot path).
    await removeAgentWorkspaceFiles(chatThreadId, "uploads");

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

  if (response.status !== "OK") {
    return response;
  }

  const currentUser = await getCurrentUser();
  const hashedId = await userHashedId();

  if (currentUser.isAdmin || response.response.userId === hashedId) {
    return response;
  }

  return {
    status: "UNAUTHORIZED",
    errors: [{ message: "You are not authorized to access this chat thread." }],
  };
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
        // Only an extension the user may use can enter the thread: /api/chat
        // resolves the thread's extension ids with their header secrets.
        // The same rule as every chat turn (decideExtensionAccess, through
        // the thread's agent when it has one).
        const extension = await findUsableExtension({
          extensionId: props.extensionId,
          personaId: chatThread.personaId,
          userId: await userHashedId(),
        });
        if (!extension) {
          return {
            status: "NOT_FOUND",
            errors: [{ message: "Extension not found" }],
          };
        }
        chatThread.extension.push(extension.id);
        return await saveChatThread(chatThread);
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

    return await saveChatThread(chatThread);
  }

  return response;
};

/**
 * Client-facing update of an EXISTING chat thread that the user may change.
 *
 * Only the fields of `applyUserThreadChanges` (name, bookmarked) are taken
 * from the input. Every other field, e.g. personaId, extension ids, persona
 * documents, sub-agents, default tools and userId, comes from the stored
 * thread, so a client cannot attach an agent or an extension to a thread, or
 * write a thread for another user. A changed personaId is ignored.
 *
 * The client's `attachedFiles` list is merged on the server with
 * `mergeClientAttachedFiles`: code interpreter files can only be kept or
 * removed, never added (the server records those itself, see
 * code-interpreter-file-access.ts).
 *
 * This action does not create threads. Server code that builds a new thread
 * uses `saveChatThread` (chat-thread-write.ts), which is not an RPC endpoint.
 */
export const UpsertChatThread = async (
  chatThread: ChatThreadModel
): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    if (!chatThread?.id) {
      return {
        status: "NOT_FOUND",
        errors: [{ message: `Chat thread not found` }],
      };
    }

    const response = await EnsureChatThreadOperation(chatThread.id);
    if (response.status !== "OK") {
      return response;
    }

    // The stored thread comes from the caller's own partition; only name and
    // bookmark are taken from the client, plus the server-side merge of the
    // attached files.
    const stored = response.response;
    const updated = applyUserThreadChanges(stored, chatThread);
    const attachedFiles = mergeClientAttachedFiles(
      stored.attachedFiles,
      chatThread.attachedFiles,
    );
    if (attachedFiles !== undefined) {
      updated.attachedFiles = attachedFiles;
    }
    return await saveChatThread(updated);
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

export const CreateChatThread = async (options?: {
  name?: string;
  temporary?: boolean;
}): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    const userId = await userHashedId();
    const modelToSave: ChatThreadModel = {
      name: options?.name ?? NEW_CHAT_NAME,
      useName: (await userSession())!.name,
      userId,
      // The server chooses the id. The temporary chat of a user has one fixed
      // id: the user id.
      id: options?.temporary ? userId : uniqueId(),
      createdAt: new Date(),
      lastMessageAt: new Date(),
      bookmarked: false,
      isDeleted: false,
      type: CHAT_THREAD_ATTRIBUTE,
      personaMessage: "",
      personaMessageTitle: CHAT_DEFAULT_PERSONA,
      selectedModel: DEFAULT_MODEL,
      extension: [],
      personaDocumentIds: [],
      isTemporary: options?.temporary ?? false,
    };

    // The temporary chat reuses one id: nothing of an earlier one may carry
    // over into the agent runtime (Copilot path).
    if (options?.temporary) await resetAgentRuntime(modelToSave.id, "reset");

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
    if (response.status === "OK") {
      const chatThread = response.response;

      // One cheap mini call returns both the title and the conversation
      // intent. Intent is sticky on the thread and drives intent-based model
      // downgrade (model-selection.ts). Truncation to 300 chars happens inside
      // ChatApiTitleAndIntent.
      const { title, intent } = await ChatApiTitleAndIntent(prompt);

      if (title) {
        chatThread.name = title;
      }
      chatThread.intent = intent;

      return await saveChatThread(chatThread);
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
  rawSelectedModel: string
): Promise<ServerActionResponse<ChatThreadModel>> => {
  const selectedModel = normalizeChatModelId(rawSelectedModel);
  if (!isValidChatModel(selectedModel)) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Invalid selectedModel "${selectedModel}". Must be one of: ${Object.keys(
            MODEL_CONFIGS,
          ).join(", ")}`,
        },
      ],
    };
  }
  try {
    const response = await FindChatThreadForCurrentUser(chatThreadId);
    if (response.status === "OK") {
      const chatThread = response.response;
      chatThread.selectedModel = selectedModel;
      return await saveChatThread(chatThread);
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
  if (!isValidReasoningEffort(reasoningEffort)) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Invalid reasoningEffort "${reasoningEffort}". Must be one of: ${VALID_REASONING_EFFORTS.join(", ")}`,
        },
      ],
    };
  }
  try {
    const response = await FindChatThreadForCurrentUser(chatThreadId);
    if (response.status === "OK") {
      const chatThread = response.response;
      chatThread.reasoningEffort = reasoningEffort;
      return await saveChatThread(chatThread);
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
      return await saveChatThread(chatThread);
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
      return await saveChatThread(chatThread);
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
        // Code interpreter files are recorded by the server when they are
        // uploaded (/api/code-interpreter/upload), never from a client id.
        if (file.type !== "search-indexed") {
          return {
            status: "NOT_FOUND",
            errors: [{ message: "File not found" }],
          };
        }
        chatThread.attachedFiles = [...existingFiles, file];
        return await saveChatThread(chatThread);
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
      return await saveChatThread(chatThread);
    }
    return response;
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `${error}` }],
    };
  }
};

/**
 * Accumulate a finished turn onto the thread's usage counters.
 *
 * `inputTokens` / `outputTokens` / `cachedTokens` / `cacheWriteTokens` are the
 * TURN TOTALS — the sum over every step of the turn, which is what was billed.
 * `lastPromptTokens` is the different quantity: the real `inputTokens` of the
 * turn's LAST step, i.e. how big the last prompt was. A tool turn bills
 * several prompts and only ever sends one at a time, so the two must not be
 * confused; the context row and the history budget read the latter.
 */
export const UpdateChatThreadUsage = async (
  chatThreadId: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
  costUsd: number,
  cacheWriteTokens: number = 0,
  lastPromptTokens?: number
): Promise<ServerActionResponse<ChatThreadModel>> => {
  try {
    const response = await FindChatThreadForCurrentUser(chatThreadId);
    if (response.status === "OK") {
      const chatThread = response.response;
      const existing = chatThread.usage || {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedTokens: 0,
        totalCostUsd: 0,
        lastUpdated: new Date().toISOString(),
      };
      chatThread.usage = {
        totalInputTokens: existing.totalInputTokens + inputTokens,
        totalOutputTokens: existing.totalOutputTokens + outputTokens,
        totalCachedTokens: existing.totalCachedTokens + cachedTokens,
        totalCostUsd: existing.totalCostUsd + costUsd,
        lastUpdated: new Date().toISOString(),
        lastInputTokens: inputTokens,
        lastOutputTokens: outputTokens,
        lastCachedTokens: cachedTokens,
        lastCacheWriteTokens: cacheWriteTokens,
        // Only written when the caller could actually read step usage. Left
        // absent otherwise, so a reader knows to fall back rather than trust a
        // fabricated zero.
        ...(typeof lastPromptTokens === "number" &&
        Number.isFinite(lastPromptTokens)
          ? { lastPromptTokens }
          : {}),
      };
      return await saveChatThread(chatThread);
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
    // Invalidate the (chat) layout so the sidebar's thread list includes the
    // new thread on the redirect target — without this, the client's RSC
    // router cache can serve a stale sidebar that omits the newly-created row.
    RevalidateCache({
      page: "chat",
      type: "layout",
    });
    redirect(`/chat/${response.response.id}`);
  }
};
