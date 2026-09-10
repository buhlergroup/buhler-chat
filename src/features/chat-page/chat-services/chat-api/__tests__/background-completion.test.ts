/**
 * Exercises the core invariant of the /api/chat route:
 *
 *   streamText.onEnd fires when the LLM finishes — independent of
 *   whether the response stream's consumer is still alive.
 *
 * We control the LLM speed with a hand-rolled LanguageModelV3 mock that
 * waits a configurable delay between deltas, then we never consume the
 * response stream (simulating a client that navigated away). The route's
 * `result.consumeStream()` should drain the source so onEnd runs and
 * persists the assistant message.
 */
import { describe, it, expect, vi } from "vitest";
import { streamText } from "ai";
import {
  buildAssistantUIMessage,
  persistAssistantFromFinishEvent,
} from "../persist-assistant";

// ── stub the chat-message + chat-thread services so persistThread can run ───
// The row parameter is declared, unused, so `upsertSpy.mock.calls[n][0]` has a
// real tuple type: the assertions below read the persisted row out of it, and
// against a zero-arg vi.fn() that index does not type-check.
const upsertSpy = vi.fn(async (_row: unknown) => ({
  status: "OK" as const,
  response: {},
}));
vi.mock("../../chat-message-service", () => ({
  UpsertChatMessage: (row: unknown) => upsertSpy(row),
}));
const updateUsageSpy = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../../chat-thread-service", () => ({
  UpdateChatThreadUsage: (...args: unknown[]) => updateUsageSpy(...args),
}));
vi.mock("@/features/common/services/usage-service", () => ({
  IncrementUsage: vi.fn(async () => undefined),
}));
vi.mock("@/features/auth-page/helpers", () => ({
  userHashedId: vi.fn(async () => "hash"),
}));
vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
// persistThread's atomic-batch path calls HistoryContainer().items.batch();
// unmocked it drives the real Cosmos SDK against the fake test endpoint and its
// retry/backoff exceeds the 5s test timeout. Reject batch so the sequential
// UpsertChatMessage fallback (stubbed above) runs deterministically.
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: { batch: vi.fn(async () => { throw new Error("batch unavailable in test"); }) },
  }),
}));

// A LanguageModelV3 that streams `words` with `delayMs` between each delta.
function makeSlowModel(words: string[], delayMs: number) {
  return {
    specificationVersion: "v3" as const,
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: "text", text: words.join("") }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t-0" });
          for (const w of words) {
            await new Promise((r) => setTimeout(r, delayMs));
            controller.enqueue({ type: "text-delta", id: "t-0", delta: w });
          }
          controller.enqueue({ type: "text-end", id: "t-0" });
          controller.enqueue({
            type: "finish",
            usage: {
              inputTokens: { total: 1, noCache: 1 },
              outputTokens: { total: words.length, text: words.length },
            },
            finishReason: { unified: "stop", raw: "stop" },
          });
          controller.close();
        },
      });
      return { stream };
    },
  };
}

describe("streamText.onEnd — background completion", () => {
  it("fires onEnd with the full text even when the response stream is never consumed", async () => {
    const onEnd = vi.fn(async () => undefined);
    const result = streamText({
      // The mock's structural shape satisfies LanguageModelV3 for the
      // public surface streamText reaches in this test.
      model: makeSlowModel(["hello ", "world ", "from ", "background"], 20) as unknown as Parameters<typeof streamText>[0]["model"],
      messages: [{ role: "user", content: "hi" }],
      onEnd,
    });

    // Drain the stream like the route does. We DELIBERATELY never read the
    // response — equivalent to the browser navigating away mid-stream.
    await result.consumeStream();

    expect(onEnd).toHaveBeenCalledTimes(1);
    const event = onEnd.mock.calls[0]![0]!;
    expect(event.text).toBe("hello world from background");
    expect(event.finishReason).toBe("stop");
  });

  it("buildAssistantUIMessage assembles reasoning + text + tool parts in order", () => {
    const msg = buildAssistantUIMessage(
      {
        text: "Final answer.",
        reasoningText: "Let me think...",
        toolResults: [
          {
            toolCallId: "tc-1",
            toolName: "search",
            input: { q: "x" },
            output: { hits: 0 },
            dynamic: true,
          },
        ],
      },
      "msg-fixed",
    );

    expect(msg.id).toBe("msg-fixed");
    expect(msg.role).toBe("assistant");
    const types = msg.parts.map((p) => p.type);
    expect(types).toEqual(["reasoning", "text", "dynamic-tool"]);
  });

  it("persistAssistantFromFinishEvent writes the assistant + tool rows", async () => {
    upsertSpy.mockClear();
    await persistAssistantFromFinishEvent({
      threadId: "thread-1",
      messageId: "msg-A",
      event: {
        text: "Done.",
        reasoningText: undefined,
        toolResults: [
          {
            toolCallId: "tc-1",
            toolName: "search",
            input: { q: "x" },
            output: { hits: 0 },
            dynamic: true,
          },
        ],
        usage: { inputTokens: 5, outputTokens: 2 },
        // The remaining OnFinishEvent fields aren't read by our code path,
        // so we leave them unset; the function's parameter type is
        // OnFinishEvent<TOOLS> for shape inference at the call site.
      } as unknown as Parameters<typeof persistAssistantFromFinishEvent>[0]["event"],
      modelConfig: {
        id: "gpt-test",
        deploymentName: "gpt-test",
        pricing: {
          inputPerMillion: 1,
          cachedInputPerMillion: 0,
          outputPerMillion: 2,
        },
      } as unknown as Parameters<typeof persistAssistantFromFinishEvent>[0]["modelConfig"],
    });

    expect(upsertSpy).toHaveBeenCalledTimes(2);
    const roles = upsertSpy.mock.calls.map((c) => (c[0] as { role?: string }).role);
    expect(roles).toContain("assistant");
    expect(roles.filter((r) => r === "tool" || r === "function")).toHaveLength(1);
  });

  const usageModelConfig = {
    id: "gpt-test",
    deploymentName: "gpt-test",
    pricing: {
      inputPerMillion: 1,
      cachedInputPerMillion: 0,
      outputPerMillion: 2,
    },
  } as unknown as Parameters<typeof persistAssistantFromFinishEvent>[0]["modelConfig"];

  /** The 7th positional argument of UpdateChatThreadUsage. */
  const persistedPromptTokens = () =>
    updateUsageSpy.mock.calls.at(-1)?.[6];
  /** The 2nd — the TURN TOTAL input, which bills the turn. */
  const persistedTurnInput = () => updateUsageSpy.mock.calls.at(-1)?.[1];

  it("chat-page.unit.persist.steps.001: persists the LAST step's prompt size beside the billed roll-up", async () => {
    // `event.usage` is the all-steps sum ("When there are multiple steps, the
    // usage is the sum of all step usages"). `event.steps.at(-1).usage` is the
    // size of the last prompt sent. Both are persisted, apart.
    updateUsageSpy.mockClear();
    await persistAssistantFromFinishEvent({
      threadId: "thread-steps-3",
      messageId: "msg-S3",
      event: {
        text: "Done.",
        toolResults: [],
        usage: { inputTokens: 99_000, outputTokens: 750 },
        steps: [
          { usage: { inputTokens: 30_000, outputTokens: 200 }, content: [], toolResults: [] },
          { usage: { inputTokens: 34_000, outputTokens: 150 }, content: [], toolResults: [] },
          { usage: { inputTokens: 35_000, outputTokens: 400 }, content: [], toolResults: [] },
        ],
      } as unknown as Parameters<typeof persistAssistantFromFinishEvent>[0]["event"],
      modelConfig: usageModelConfig,
    });

    expect(persistedTurnInput()).toBe(99_000);
    expect(persistedPromptTokens()).toBe(35_000);
  });

  it("chat-page.unit.persist.steps.002: persists one number twice for a single-step turn", async () => {
    updateUsageSpy.mockClear();
    await persistAssistantFromFinishEvent({
      threadId: "thread-steps-1",
      messageId: "msg-S1",
      event: {
        text: "Done.",
        toolResults: [],
        usage: { inputTokens: 17_527, outputTokens: 400 },
        steps: [
          { usage: { inputTokens: 17_527, outputTokens: 400 }, content: [], toolResults: [] },
        ],
      } as unknown as Parameters<typeof persistAssistantFromFinishEvent>[0]["event"],
      modelConfig: usageModelConfig,
    });

    expect(persistedTurnInput()).toBe(17_527);
    expect(persistedPromptTokens()).toBe(17_527);
  });

  it("chat-page.unit.persist.steps.003: persists nothing for the prompt size when there are no steps (negative)", async () => {
    // A sentinel row, or an abort before the first step finished. Leaving the
    // field absent is what lets a reader know to fall back to the roll-up
    // rather than trust a fabricated zero.
    updateUsageSpy.mockClear();
    await persistAssistantFromFinishEvent({
      threadId: "thread-steps-0",
      messageId: "msg-S0",
      event: {
        text: "Done.",
        toolResults: [],
        usage: { inputTokens: 5, outputTokens: 2 },
      } as unknown as Parameters<typeof persistAssistantFromFinishEvent>[0]["event"],
      modelConfig: usageModelConfig,
    });

    expect(persistedTurnInput()).toBe(5);
    expect(persistedPromptTokens()).toBeUndefined();
  });

  const truncatingModelConfig = {
    id: "gpt-test",
    deploymentName: "gpt-test",
    maxOutputTokens: 32000,
    pricing: {
      inputPerMillion: 1,
      cachedInputPerMillion: 0,
      outputPerMillion: 2,
    },
  } as unknown as Parameters<typeof persistAssistantFromFinishEvent>[0]["modelConfig"];

  it("marks a turn the provider cut at the output limit", async () => {
    // finishReason "length" used to be indistinguishable from a finished
    // answer: the text just stopped, usually mid-sentence, and nothing in the
    // reply said why. Reasoning makes it MORE likely, not less — reasoning
    // tokens come out of the same ceiling.
    upsertSpy.mockClear();
    await persistAssistantFromFinishEvent({
      threadId: "thread-1",
      messageId: "msg-T",
      event: {
        text: "Step 1: open the valve. Step 2: wait for the",
        reasoningText: undefined,
        toolResults: [],
        finishReason: "length",
        usage: { inputTokens: 5, outputTokens: 32000 },
      } as unknown as Parameters<typeof persistAssistantFromFinishEvent>[0]["event"],
      modelConfig: truncatingModelConfig,
    });

    const assistantRow = upsertSpy.mock.calls
      .map((c) => c[0] as { role?: string; content?: string })
      .find((r) => r.role === "assistant");
    expect(assistantRow?.content).toContain("Step 2: wait for the");
    expect(assistantRow?.content).toContain("cut at the output limit");
  });

  it("leaves an ordinary finish untouched (negative)", async () => {
    upsertSpy.mockClear();
    await persistAssistantFromFinishEvent({
      threadId: "thread-1",
      messageId: "msg-N",
      event: {
        text: "All done.",
        reasoningText: undefined,
        toolResults: [],
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 3 },
      } as unknown as Parameters<typeof persistAssistantFromFinishEvent>[0]["event"],
      modelConfig: truncatingModelConfig,
    });

    const assistantRow = upsertSpy.mock.calls
      .map((c) => c[0] as { role?: string; content?: string })
      .find((r) => r.role === "assistant");
    expect(assistantRow?.content).toBe("All done.");
  });

  it("does not stack the notice on top of the empty-finish sentinel", async () => {
    // An empty finish already explains itself, and a reply that is BOTH empty
    // and truncated would otherwise get two explanations for one failure.
    upsertSpy.mockClear();
    await persistAssistantFromFinishEvent({
      threadId: "thread-1",
      messageId: "msg-E",
      event: {
        text: "",
        reasoningText: undefined,
        toolResults: [],
        finishReason: "length",
        usage: { inputTokens: 5, outputTokens: 0 },
      } as unknown as Parameters<typeof persistAssistantFromFinishEvent>[0]["event"],
      modelConfig: truncatingModelConfig,
    });

    const assistantRow = upsertSpy.mock.calls
      .map((c) => c[0] as { role?: string; content?: string })
      .find((r) => r.role === "assistant");
    expect(assistantRow?.content).toContain("didn't produce a response");
    expect(assistantRow?.content).not.toContain("cut at the output limit");
  });
});
