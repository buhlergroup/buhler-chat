import "server-only";

import { createIdGenerator, createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { Tool as AiTool } from "@ai-sdk/provider-utils";
import { userHashedId } from "@/features/auth-page/helpers";
import { logError, logInfo, logWarn } from "@/features/common/services/logger";
import { MODEL_CONFIGS, type ChatModel, type ModelConfig, type UserPrompt } from "../models";
import type { ThreadContext } from "../chat-api/thread-context";
import {
  friendlyErrorMessage,
  persistAssistantFromFinishEvent,
  type PersistPayload,
} from "../chat-api/persist-assistant";
import { computeRequestUsage, type ChatMessageMetadata } from "../chat-api/usage-data";
import { startPublisher, unregisterPublisher } from "../chat-api/stream-publisher";
import { UpdateChatTitle } from "../chat-thread-service";
import { runCopilotTurn } from "./copilot-session";
import { extractTextTool } from "./extract-text";
import { indexDocumentTool } from "./index-document";
import { providerTools, type ProviderToolToggles } from "./provider-tools";
import type { ContainerInputFile } from "./agent-code-interpreter";
import {
  chatDocumentIndexDeps,
  threadWorkspace,
  unindexedWorkspaceUploads,
  workspaceExtractDeps,
  workspaceUploadEntries,
  workspaceUploadsNote,
} from "./workspace-files";
import { storeUpload } from "./workspace-uploads";
import { spillLargePrompt } from "./prompt-spill";
import { copilotOffersWebSearch } from "./tool-defaults";
import { copilotOffersSearchDocuments, withSearchNextMessageNote, withUploadsSearchHint } from "./search-documents-hint";
import { THREAD_BUSY_TEXT, ThreadBusyError } from "./thread-lease";
import { TURN_LIMIT_TEXTS, TurnLimitError } from "./runtime-limits";
import { canUsePersona, resolveSubAgents } from "./subagent-resolver";
import { turnCostUsd, turnUsageByModel } from "./usage-cost";
import { compactionPart, type TurnUsage } from "./event-mapper";
import { RecordAgentInteraction } from "@/features/common/services/agent-stats-service";

const NOTE_SEPARATOR = String.fromCharCode(10, 10);

export interface CopilotChatTurnArgs {
  ctx: ThreadContext;
  payload: UserPrompt;
  modelConfig: ModelConfig;
  effectiveModel: ChatModel;
  reasoningEffort?: string;
  fallbackInfo?: PersistPayload["fallbackInfo"];
  /** The app's system message, WITHOUT the per-turn document hint. */
  systemMessage: string;
  toolset: Record<string, AiTool>;
  /**
   * The user's built-in toggles: served by our own tools (provider-tools.ts).
   * webSearch is the turn's choice (request, else thread); undefined = no
   * choice, and COPILOT_WEB_SEARCH_DEFAULT decides (tool-defaults.ts).
   */
  builtInToggles?: Omit<ProviderToolToggles, "webSearch"> & { webSearch: boolean | undefined };
  /** The run_code container's files: the thread's code interpreter files (agent-code-interpreter.ts). */
  codeInterpreterFiles?: ContainerInputFile[];
  /** Browser-local datetime (get_current_time of persona sub-agents). */
  clientDateTime?: string;
}

/** call_sub_agent / search_sub_agent stay on the AI SDK path; the Copilot path delegates with `task`. */
export function withoutAiSdkSubAgentTools(toolset: Record<string, AiTool>): Record<string, AiTool> {
  const { call_sub_agent: _call, search_sub_agent: _search, ...rest } = toolset;
  return rest;
}

/** Text of the 500 answer when a turn cannot start; the cause goes to the log only. */
export const TURN_START_FAILED = "The reply could not be started. Please try again.";

/**
 * /api/chat on the Copilot runtime (AGENT_RUNTIME=copilot). Same contract as
 * the AI SDK path: a UI message stream response, teed into the stream
 * publisher (resume + stop), and the assistant turn persisted to Cosmos with
 * the same persist path and usage/cost numbers.
 */
export async function runCopilotChatTurn(args: CopilotChatTurnArgs): Promise<Response> {
  const { ctx, payload, modelConfig } = args;
  const threadId = ctx.thread.id;
  const { abortController, publish } = startPublisher(threadId);

  const writeSentinel = async (text: string) => {
    const { UpsertChatMessage } = await import("../chat-message-service");
    await UpsertChatMessage({
      id: `sentinel-${ctx.turnId}`,
      createdAt: new Date(),
      isDeleted: false,
      threadId,
      userId: await userHashedId(),
      name: "system",
      role: "assistant",
      content: text,
      type: "CHAT_MESSAGE",
      turnId: ctx.turnId,
    });
  };

  let handle: Awaited<ReturnType<typeof runCopilotTurn>>;
  try {
    const userKey = await userHashedId();
    // The thread's workspace: extract_text and index_document work on it, and the model is
    // told which uploads it holds (sent again only when the list changes).
    const { fs } = await threadWorkspace(userKey, threadId);
    // A message over the inline limit reaches the model as a file in
    // /workspace/uploads plus a short note in the user message
    // (prompt-spill.ts); Cosmos keeps the full text. Saved before the uploads
    // listing, so the uploads note names the file too.
    const spilled = await spillLargePrompt(payload.message, {
      id: ctx.turnId,
      store: (name, data) => storeUpload({ fs }, name, data),
    }).catch((err: unknown) => {
      logWarn("/api/chat copilot: large message not saved as a file", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { prompt: payload.message, savedTo: undefined, bytes: undefined };
    });
    if (spilled.savedTo) {
      logInfo("/api/chat copilot: large message saved as a file", { threadId, bytes: spilled.bytes });
    }
    const uploadEntries = await workspaceUploadEntries(fs);
    // search_documents: only with indexed chat documents, agent documents or
    // uploads to index (copilotOffersSearchDocuments); it names the uploads
    // that are not indexed when it finds nothing.
    const { search_documents: searchDocuments, ...appTools } = withoutAiSdkSubAgentTools(args.toolset);
    const offerSearch =
      !!searchDocuments &&
      copilotOffersSearchDocuments({
        hasIndexedDocuments: (ctx.threadDocumentIds?.length ?? 0) > 0 || (ctx.personaDocumentIds?.length ?? 0) > 0,
        uploadCount: uploadEntries.length,
      });
    const indexDocument = indexDocumentTool(chatDocumentIndexDeps({ fs, threadId, userKey }));
    const toolset: Record<string, AiTool> = {
      // Sub-agents are the runtime's own (`task`) on this path.
      ...appTools,
      ...(offerSearch && searchDocuments
        ? {
            search_documents: withUploadsSearchHint(searchDocuments, () =>
              unindexedWorkspaceUploads({ entries: uploadEntries, threadId, userKey }),
            ),
          }
        : {}),
      extract_text: extractTextTool(workspaceExtractDeps({ fs, userKey })),
      index_document: offerSearch ? indexDocument : withSearchNextMessageNote(indexDocument),
      // generate_image / run_code when their toggle is on (the route sets
      // run_code's: agent-code-interpreter.ts); web_search when its toggle
      // is on, or with no choice by default (tool-defaults.ts).
      ...(args.builtInToggles
        ? providerTools({
            fs,
            threadId,
            userKey,
            toggles: {
              ...args.builtInToggles,
              webSearch: copilotOffersWebSearch({ toggle: args.builtInToggles.webSearch }),
            },
            containerFiles: args.codeInterpreterFiles ?? [],
          })
        : {}),
    };
    // Sub-agents: `general` + the chat agent's sub-agents the user may open.
    // The agent's current list (loadThreadContext; stored list only for a
    // legacy thread without agent id), never a copy on the thread.
    const subAgents = await resolveSubAgents({
      subAgentIds: ctx.subAgentIds,
      parentPersonaId: ctx.thread.personaId,
      ctx: { user: ctx.user.id, threadId, threadDocumentIds: ctx.threadDocumentIds, clientDateTime: args.clientDateTime },
    });
    const uploads = workspaceUploadsNote(uploadEntries);
    const contextNote = [ctx.documentHintText, uploads].filter(Boolean).join(NOTE_SEPARATOR) || undefined;
    handle = await runCopilotTurn({
      threadId,
      userKey,
      modelId: args.effectiveModel,
      reasoningEffort: args.reasoningEffort,
      systemMessage: args.systemMessage,
      toolset,
      // History before this turn: ctx.history ends with this turn's user message.
      priorHistory: ctx.history.slice(0, -1),
      prompt: spilled.prompt,
      images: payload.multimodalImages,
      contextNote,
      abortSignal: abortController.signal,
      subAgents,
      canUsePersona,
      finishMetadata: (usage): ChatMessageMetadata => ({
        usage: {
          ...computeRequestUsage({
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            ...(typeof usage.lastInputTokens === "number" ? { lastPromptTokens: usage.lastInputTokens } : {}),
            ...(usage.calls > 0 ? { stepCount: usage.calls } : {}),
            modelConfig,
          }),
          // Sub-agents may run on other models: each model at its own price.
          costUsd: turnCostUsd(usage, modelConfig, MODEL_CONFIGS),
        },
      }),
    });
  } catch (err) {
    unregisterPublisher(threadId);
    const message = err instanceof Error ? err.message : String(err);
    // The answer carries fixed texts only; the error text stays in the log.
    const userText =
      err instanceof ThreadBusyError
        ? THREAD_BUSY_TEXT
        : err instanceof TurnLimitError
          ? TURN_LIMIT_TEXTS[err.kind]
          : TURN_START_FAILED;
    const status = err instanceof ThreadBusyError ? 409 : err instanceof TurnLimitError ? 429 : 500;
    logError("/api/chat copilot: turn did not start", { threadId, turnId: ctx.turnId, message, status });
    // The stored row of an unknown error gets the same friendly text as the standard path.
    const refusal = err instanceof ThreadBusyError || err instanceof TurnLimitError;
    await writeSentinel(
      refusal ? userText : friendlyErrorMessage({ message, name: "CopilotRuntimeError" }),
    ).catch(() => undefined);
    return new Response(userText, { status });
  }

  void handle.result
    .then(async (result) => {
      logInfo("/api/chat copilot: turn finished", {
        threadId,
        turnId: ctx.turnId,
        sessionMode: result.sessionMode,
        seededEvents: result.seededEvents,
        finishReason: result.finishReason,
        calls: result.turnUsage.calls,
        inputTokens: result.turnUsage.inputTokens,
        cacheReadTokens: result.turnUsage.cacheReadTokens,
        firstChunkMs: result.firstChunkMs,
      });
      // Each model of the turn (chat model, sub-agents, the tools' own model
      // calls) at its own price; the usage row and metrics count each under its id.
      const byModel = turnUsageByModel(result.turnUsage, modelConfig, MODEL_CONFIGS);
      await persistAssistantFromFinishEvent({
        threadId,
        turnId: ctx.turnId,
        // The mapper builds the onFinish fields persistence reads (text,
        // reasoningText, toolResults, steps, usage, finishReason).
        event: result as unknown as Parameters<typeof persistAssistantFromFinishEvent>[0]["event"],
        modelConfig,
        fallbackInfo: args.fallbackInfo,
        streamError: result.error,
        reasoningDurationMs: result.reasoningDurationMs,
        personaId: ctx.thread.isTemporary ? undefined : ctx.thread.personaId,
        costUsd: byModel.reduce((sum, m) => sum + m.costUsd, 0),
        byModel,
        ...(result.compactionNotice ? { compaction: compactionPart(result.compactionNotice).data } : {}),
      });
      recordSubAgentInteractions(result.turnUsage, result.subAgentPersonas ?? {});
      if (ctx.history.length === 1) {
        UpdateChatTitle(threadId, payload.message).catch((err) =>
          logWarn("/api/chat copilot: UpdateChatTitle failed", {
            threadId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    })
    .catch(async (err) => {
      logError("/api/chat copilot: persist failed", {
        threadId,
        turnId: ctx.turnId,
        error: err instanceof Error ? err.message : String(err),
      });
      await writeSentinel(
        "_The generation completed but the result could not be saved. Please resend your message._",
      ).catch(() => undefined);
    })
    .finally(() => unregisterPublisher(threadId));

  const framed = createUIMessageStreamResponse({
    stream: createUIMessageStream({
      originalMessages: ctx.history,
      generateId: createIdGenerator({ prefix: "msg", size: 16 }),
      onError: (err) => {
        logError("/api/chat copilot: stream error", { threadId, error: err instanceof Error ? err.message : String(err) });
        return TURN_START_FAILED;
      },
      execute: ({ writer }) => {
        writer.merge(handle.stream);
      },
    }),
  });
  if (!framed.body) return framed;
  const [responseBranch, publisherBranch] = framed.body.tee();
  publish(publisherBranch);
  return new Response(responseBranch, {
    status: framed.status,
    statusText: framed.statusText,
    headers: framed.headers,
  });
}

/** Per-agent stats for the persona sub-agents that ran in the turn (their own tokens). */
export function recordSubAgentInteractions(
  usage: Pick<TurnUsage, "bySubAgent">,
  personas: Record<string, string>,
  record: typeof RecordAgentInteraction = RecordAgentInteraction,
): void {
  for (const [name, personaId] of Object.entries(personas)) {
    const u = usage.bySubAgent?.[name];
    if (!u) continue;
    record(personaId, {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cachedTokens: u.cacheReadTokens,
    }).catch((err: unknown) =>
      logWarn("/api/chat copilot: sub-agent stats failed", {
        personaId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
