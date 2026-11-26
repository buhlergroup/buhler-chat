import "server-only";

import { createIdGenerator, createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { Tool as AiTool } from "@ai-sdk/provider-utils";
import { userHashedId } from "@/features/auth-page/helpers";
import { logError, logInfo, logWarn } from "@/features/common/services/logger";
import type { ChatModel, ModelConfig, UserPrompt } from "../models";
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
import { ThreadBusyError } from "./thread-lease";

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
}

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
    handle = await runCopilotTurn({
      threadId,
      userKey: await userHashedId(),
      modelId: args.effectiveModel,
      reasoningEffort: args.reasoningEffort,
      systemMessage: args.systemMessage,
      toolset: args.toolset,
      // History before this turn: ctx.history ends with this turn's user message.
      priorHistory: ctx.history.slice(0, -1),
      prompt: payload.message,
      images: payload.multimodalImages,
      contextNote: ctx.documentHintText,
      abortSignal: abortController.signal,
      finishMetadata: (usage): ChatMessageMetadata => ({
        usage: computeRequestUsage({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          ...(typeof usage.lastInputTokens === "number" ? { lastPromptTokens: usage.lastInputTokens } : {}),
          ...(usage.calls > 0 ? { stepCount: usage.calls } : {}),
          modelConfig,
        }),
      }),
    });
  } catch (err) {
    unregisterPublisher(threadId);
    const message = err instanceof Error ? err.message : String(err);
    const busy = err instanceof ThreadBusyError;
    logError("/api/chat copilot: turn did not start", { threadId, turnId: ctx.turnId, message, busy });
    await writeSentinel(busy ? message : friendlyErrorMessage({ message, name: "CopilotRuntimeError" })).catch(
      () => undefined,
    );
    return new Response(message, { status: busy ? 409 : 500 });
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
      });
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
      onError: (err) => (err instanceof Error ? err.message : String(err)),
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
