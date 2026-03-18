"use server";
import "server-only";

import { userHashedId, userSession } from "@/features/auth-page/helpers";
import { uniqueId } from "@/features/common/util";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { SqlQuerySpec } from "@azure/cosmos";
import {
  CHAT_THREAD_ATTRIBUTE,
  ChatThreadModel,
} from "../models";
import { UpsertChatThread } from "../chat-thread-service";
import { PersonaModel } from "@/features/persona-page/persona-services/models";
import { logInfo, logDebug } from "@/features/common/services/logger";

/**
 * Find an existing sub-agent thread or create a new one.
 * One child thread per (parent-thread, sub-agent persona) pair — context accumulates.
 */
export async function findOrCreateSubAgentThread(
  parentThreadId: string,
  subAgentPersonaId: string,
  persona: PersonaModel
): Promise<ChatThreadModel> {
  const userId = await userHashedId();

  // Query for existing sub-agent thread
  const querySpec: SqlQuerySpec = {
    query:
      "SELECT * FROM root r WHERE r.type=@type AND r.userId=@userId AND r.parentThreadId=@parentThreadId AND r.subAgentPersonaId=@subAgentPersonaId AND r.isDeleted=@isDeleted",
    parameters: [
      { name: "@type", value: CHAT_THREAD_ATTRIBUTE },
      { name: "@userId", value: userId },
      { name: "@parentThreadId", value: parentThreadId },
      { name: "@subAgentPersonaId", value: subAgentPersonaId },
      { name: "@isDeleted", value: false },
    ],
  };

  const { resources } = await HistoryContainer()
    .items.query<ChatThreadModel>(querySpec, { partitionKey: userId })
    .fetchAll();

  if (resources.length > 0) {
    logInfo("Reusing existing sub-agent thread", {
      threadId: resources[0].id,
      parentThreadId,
      subAgentPersonaId,
    });
    return resources[0];
  }

  // Create new sub-agent thread inheriting persona config
  const newThread: ChatThreadModel = {
    id: uniqueId(),
    name: `[Sub-agent] ${persona.name}`,
    createdAt: new Date(),
    lastMessageAt: new Date(),
    userId,
    useName: (await userSession())!.name,
    isDeleted: false,
    bookmarked: false,
    personaMessage: persona.personaMessage,
    personaMessageTitle: persona.name,
    extension: persona.extensionIds || [],
    type: CHAT_THREAD_ATTRIBUTE,
    personaDocumentIds: persona.personaDocumentIds || [],
    selectedModel: persona.selectedModel as any,
    subAgentIds: persona.subAgentIds || [],
    parentThreadId,
    subAgentPersonaId,
  };

  const result = await UpsertChatThread(newThread);
  if (result.status !== "OK") {
    throw new Error(`Failed to create sub-agent thread: ${result.errors?.[0]?.message}`);
  }

  logInfo("Created new sub-agent thread", {
    threadId: result.response.id,
    parentThreadId,
    subAgentPersonaId,
    personaName: persona.name,
  });

  return result.response;
}

/**
 * Find all child threads of a parent thread (for cascade delete).
 */
export async function findChildThreads(
  parentThreadId: string
): Promise<ChatThreadModel[]> {
  const userId = await userHashedId();

  const querySpec: SqlQuerySpec = {
    query:
      "SELECT * FROM root r WHERE r.type=@type AND r.userId=@userId AND r.parentThreadId=@parentThreadId AND r.isDeleted=@isDeleted",
    parameters: [
      { name: "@type", value: CHAT_THREAD_ATTRIBUTE },
      { name: "@userId", value: userId },
      { name: "@parentThreadId", value: parentThreadId },
      { name: "@isDeleted", value: false },
    ],
  };

  const { resources } = await HistoryContainer()
    .items.query<ChatThreadModel>(querySpec, { partitionKey: userId })
    .fetchAll();

  return resources;
}
