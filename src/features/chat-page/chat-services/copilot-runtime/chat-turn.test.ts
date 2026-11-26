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
  workspaceExtractDeps: () => ({}),
  workspaceUploadsNote: async () => "Files the user uploaded to this chat: /workspace/uploads/a.pdf",
}));
vi.mock("./subagent-resolver", () => ({
  resolveSubAgents: async () => ({ personas: [] }),
  canUsePersona: async () => true,
}));
const recordAgent = vi.fn(async (_id: string, _u: unknown) => undefined);
vi.mock("@/features/common/services/agent-stats-service", () => ({
  RecordAgentInteraction: (id: string, u: unknown) => recordAgent(id, u),
}));
const updateTitle = vi.fn(async () => undefined);
vi.mock("../chat-thread-service", () => ({ UpdateChatTitle: () => updateTitle() }));
const upsert = vi.fn(async (_row: unknown) => undefined);
vi.mock("../chat-message-service", () => ({ UpsertChatMessage: (row: unknown) => upsert(row) }));

import { recordSubAgentInteractions, runCopilotChatTurn, TURN_START_FAILED } from "./chat-turn";
import { ThreadBusyError } from "./thread-lease";
import { TurnLimitError } from "./runtime-limits";
import { MODEL_CONFIGS } from "../models";
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
    thread: { id: threadId, personaId: "agent-1", isTemporary: false, subAgentIds: [] },
    user: { id: "user@example.invalid" },
    threadDocumentIds: [],
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
          turnUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0, byModel: {}, bySubAgent: {} },
          subAgentPersonas: {},
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
    expect(Object.keys(full.toolset)).toContain("extract_text");
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
      byModel: {},
      bySubAgent: {},
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
    // The raw cause stays in the log: the client gets a generic text.
    expect(await res.text()).toBe(TURN_START_FAILED);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sentinel-turn-1", role: "assistant", content: "friendly: runtime unavailable" }),
    );
    expect(hasActivePublisher("thread-fail")).toBe(false);
  });

  it("a user over the concurrent-turn limit gets 429 with the limit text", async () => {
    runCopilotTurn.mockRejectedValue(new TurnLimitError("user"));
    const res = await runCopilotChatTurn({
      ctx: ctx("thread-limit"),
      payload: { message: "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: {},
    });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("maximum number of replies running");
    expect(hasActivePublisher("thread-limit")).toBe(false);
  });

  it("does not offer call_sub_agent / search_sub_agent (the runtime's task tool delegates)", async () => {
    fakeTurnUntilAbort();
    await runCopilotChatTurn({
      ctx: ctx("thread-tools"),
      payload: { message: "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: { call_sub_agent: {} as never, search_sub_agent: {} as never, get_current_time: {} as never },
    });
    const input = runCopilotTurn.mock.calls.at(-1)![0] as { toolset: Record<string, unknown>; subAgents: unknown };
    expect(Object.keys(input.toolset)).toContain("get_current_time");
    expect(Object.keys(input.toolset)).not.toContain("call_sub_agent");
    expect(Object.keys(input.toolset)).not.toContain("search_sub_agent");
    expect(input.subAgents).toEqual({ personas: [] });
    abortPublisher("thread-tools");
  });

  it("prices sub-agent tokens at their own model's price", async () => {
    fakeTurnUntilAbort();
    await runCopilotChatTurn({
      ctx: ctx("thread-cost"),
      payload: { message: "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: {},
    });
    const input = runCopilotTurn.mock.calls.at(-1)![0] as { finishMetadata: (u: unknown) => { usage: Record<string, number> } };
    const bucket = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 });
    const base = { outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 1, bySubAgent: {} };
    // 1M tokens on the turn model only vs. 1M split with an unknown (= turn-priced) model: same cost.
    // Models without a config are priced at the turn model's price (1 USD / 1M input here).
    const unknown = input.finishMetadata({
      ...base,
      inputTokens: 1_000_000,
      byModel: { "test-model-a": bucket(500_000), "test-model-b": bucket(500_000) },
    });
    expect(unknown.usage.costUsd).toBeCloseTo(1, 10);
    // A configured model's tokens use that model's own price.
    const luna = MODEL_CONFIGS["gpt-5.6-luna" as keyof typeof MODEL_CONFIGS];
    const mixed = input.finishMetadata({
      ...base,
      inputTokens: 1_000_000,
      byModel: { "test-model-a": bucket(500_000), "azure/gpt-5.6-luna": bucket(500_000) },
    });
    expect(mixed.usage.costUsd).toBeCloseTo(0.5 + 0.5 * luna.pricing!.inputPerMillion, 10);
    abortPublisher("thread-cost");
  });

  it("records per-agent stats for persona sub-agents with their own tokens", () => {
    const record = vi.fn(async () => undefined);
    recordSubAgentInteractions(
      {
        bySubAgent: {
          "research-abc123": { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 0, calls: 2 },
          general: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 },
        },
      },
      { "research-abc123": "persona-1" },
      record,
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("persona-1", { inputTokens: 100, outputTokens: 10, cachedTokens: 40 });
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
