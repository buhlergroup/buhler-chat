import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UIMessageChunk } from "ai";

vi.mock("@/features/auth-page/helpers", () => ({ userHashedId: vi.fn(async () => "hashed-user") }));
vi.mock("@/features/common/services/logger", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

const runCopilotTurn = vi.fn();
vi.mock("./copilot-session", () => ({ runCopilotTurn: (...args: unknown[]) => runCopilotTurn(...args) }));

const persist = vi.fn(async (_args: unknown) => undefined);
vi.mock("../chat-api/persist-assistant", () => ({
  persistAssistantFromFinishEvent: (args: unknown) => persist(args),
  friendlyErrorMessage: (e: { message: string }) => `friendly: ${e.message}`,
}));
vi.mock("./workspace-files", () => ({
  threadWorkspace: async () => ({ fs: {} }),
  chatDocumentIndexDeps: () => ({}),
  workspaceUploadsNote: async () => "Files the user uploaded to this chat: /workspace/uploads/a.pdf",
}));
const updateTitle = vi.fn(async () => undefined);
vi.mock("../chat-thread-service", () => ({ UpdateChatTitle: () => updateTitle() }));
const upsert = vi.fn(async (_row: unknown) => undefined);
vi.mock("../chat-message-service", () => ({ UpsertChatMessage: (row: unknown) => upsert(row) }));

import { runCopilotChatTurn } from "./chat-turn";
import { ThreadBusyError } from "./thread-lease";
import { abortPublisher, hasActivePublisher, __resetStreamPublishers } from "../chat-api/stream-publisher";

const modelConfig = {
  id: "gpt-5.5",
  provider: "azure",
  supportsResponsesAPI: true,
  contextWindow: 400_000,
  pricing: { inputPerMillion: 1, outputPerMillion: 10, cachedInputPerMillion: 0.1 },
} as never;

const ctx = (threadId: string) =>
  ({
    thread: { id: threadId, personaId: "agent-1", isTemporary: false },
    history: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }],
    turnId: "turn-1",
    documentHintText: undefined,
  }) as never;

/** A fake Copilot turn whose stream stays open until the turn's abort signal trips. */
function fakeTurnUntilAbort() {
  runCopilotTurn.mockImplementation(async (input: { abortSignal: AbortSignal }) => {
    let controller!: ReadableStreamDefaultController<UIMessageChunk>;
    const stream = new ReadableStream<UIMessageChunk>({ start: (c) => void (controller = c) });
    controller.enqueue({ type: "start" });
    controller.enqueue({ type: "start-step" });
    controller.enqueue({ type: "text-start", id: "t" });
    controller.enqueue({ type: "text-delta", id: "t", delta: "partial" });
    const result = new Promise((resolve) => {
      input.abortSignal.addEventListener("abort", () => {
        controller.enqueue({ type: "text-end", id: "t" });
        controller.enqueue({ type: "finish-step" });
        controller.enqueue({ type: "abort" });
        controller.close();
        resolve({
          text: "partial",
          toolResults: [],
          steps: [{ text: "partial", reasoningText: "", toolCalls: [], toolResults: [] }],
          finishReason: "other",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokenDetails: { reasoningTokens: 0 } },
          aborted: true,
          sessionMode: "live",
          seededEvents: 0,
          turnUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0 },
        });
      });
    });
    return { stream, result };
  });
}

describe("runCopilotChatTurn", () => {
  beforeEach(() => {
    __resetStreamPublishers();
    runCopilotTurn.mockReset();
  });

  it("the stop endpoint's abortPublisher cancels the Copilot turn, and the partial is persisted", async () => {
    fakeTurnUntilAbort();
    const res = await runCopilotChatTurn({
      ctx: ctx("thread-stop"),
      payload: { message: "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: {},
    });
    expect(res.status).toBe(200);
    const input = runCopilotTurn.mock.calls[0][0] as { abortSignal: AbortSignal; priorHistory: unknown[]; userKey: string };
    expect(input.userKey).toBe("hashed-user");
    expect(input.priorHistory).toEqual([]);
    // Copilot path only: index_document joins the app tools, uploads are named.
    const full = runCopilotTurn.mock.calls[0][0] as { toolset: Record<string, unknown>; contextNote?: string };
    expect(Object.keys(full.toolset)).toContain("index_document");
    expect(full.contextNote).toContain("/workspace/uploads/a.pdf");
    expect(input.abortSignal.aborted).toBe(false);
    expect(hasActivePublisher("thread-stop")).toBe(true);

    // What POST /api/chat/[id]/stop does:
    expect(abortPublisher("thread-stop")).toBe(true);
    expect(input.abortSignal.aborted).toBe(true);

    const body = await res.text();
    expect(body).toContain("\"type\":\"text-delta\"");
    expect(body).toContain("\"type\":\"abort\"");
    await vi.waitFor(() => expect(persist).toHaveBeenCalled());
    const persisted = persist.mock.calls[0][0] as { threadId: string; turnId: string; event: { text: string; finishReason: string }; personaId?: string };
    expect(persisted).toMatchObject({ threadId: "thread-stop", turnId: "turn-1", personaId: "agent-1" });
    expect(persisted.event).toMatchObject({ text: "partial", finishReason: "other" });
    await vi.waitFor(() => expect(hasActivePublisher("thread-stop")).toBe(false));
    expect(updateTitle).toHaveBeenCalled(); // first turn of the thread
  });

  it("finish metadata carries the usage numbers the header reads (computeRequestUsage)", async () => {
    fakeTurnUntilAbort();
    await runCopilotChatTurn({
      ctx: ctx("thread-usage"),
      payload: { message: "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: {},
    });
    const input = runCopilotTurn.mock.calls[0][0] as { finishMetadata: (u: unknown) => { usage: Record<string, number> } };
    const meta = input.finishMetadata({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      lastInputTokens: 40_000,
      calls: 3,
    });
    expect(meta.usage).toMatchObject({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedTokens: 500_000,
      lastPromptTokens: 40_000,
      stepCount: 3,
      contextWindowSize: 400_000,
    });
    expect(meta.usage.costUsd).toBeGreaterThan(0);
    abortPublisher("thread-usage");
  });

  it("a turn that cannot start answers 500, writes a sentinel row and frees the publisher", async () => {
    runCopilotTurn.mockRejectedValue(new Error("runtime unavailable"));
    const res = await runCopilotChatTurn({
      ctx: ctx("thread-fail"),
      payload: { message: "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: {},
    });
    expect(res.status).toBe(500);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sentinel-turn-1", role: "assistant", content: "friendly: runtime unavailable" }),
    );
    expect(hasActivePublisher("thread-fail")).toBe(false);
  });

  it("a turn on a thread that another instance or tab is running answers 409", async () => {
    runCopilotTurn.mockRejectedValue(new ThreadBusyError());
    const res = await runCopilotChatTurn({
      ctx: ctx("thread-busy"),
      payload: { message: "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: {},
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/still running/);
    expect(hasActivePublisher("thread-busy")).toBe(false);
  });
});
