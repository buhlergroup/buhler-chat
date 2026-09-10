import { describe, it, expect, vi } from "vitest";

// ── Logger ────────────────────────────────────────────────────────────────────
vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// ── Auth ──────────────────────────────────────────────────────────────────────
vi.mock("@/features/auth-page/helpers", () => ({
  userHashedId: vi.fn(async () => "user-hash"),
}));

// ── Message service ───────────────────────────────────────────────────────────
const mockUpsert = vi.fn(async () => ({ status: "OK" as const }));
vi.mock("../../chat-message-service", () => ({
  UpsertChatMessage: (...a: unknown[]) => mockUpsert(...a),
}));

// ── Thread service ────────────────────────────────────────────────────────────
const mockUpdateThreadUsage = vi.fn(async () => ({ status: "OK" }));
vi.mock("../../chat-thread-service", () => ({
  UpdateChatThreadUsage: (...a: unknown[]) => mockUpdateThreadUsage(...a),
}));

// ── Usage service ─────────────────────────────────────────────────────────────
const mockIncrementUsage = vi.fn(async () => {});
vi.mock("@/features/common/services/usage-service", () => ({
  IncrementUsage: (...a: unknown[]) => mockIncrementUsage(...a),
}));

// ── Chat metrics (App Insights custom metrics) ────────────────────────────────
const mockReportPromptTokens = vi.fn(async () => {});
const mockReportCompletionTokens = vi.fn(async () => {});
const mockReportCachedTokens = vi.fn(async () => {});
const mockReportCacheWriteTokens = vi.fn(async () => {});
const mockReportUserChatMessage = vi.fn(async () => {});
vi.mock("@/features/common/services/chat-metrics-service", () => ({
  reportPromptTokens: (...a: unknown[]) => mockReportPromptTokens(...(a as [])),
  reportCompletionTokens: (...a: unknown[]) =>
    mockReportCompletionTokens(...(a as [])),
  reportCachedTokens: (...a: unknown[]) => mockReportCachedTokens(...(a as [])),
  reportCacheWriteTokens: (...a: unknown[]) =>
    mockReportCacheWriteTokens(...(a as [])),
  reportUserChatMessage: (...a: unknown[]) =>
    mockReportUserChatMessage(...(a as [])),
}));

// ── Cosmos ────────────────────────────────────────────────────────────────────
// persistThread's atomic-turn path calls HistoryContainer().items.batch(); left
// unmocked it drives the real Cosmos SDK against the fake test endpoint, whose
// retry/backoff blows past the 5s test timeout. Make batch reject so the
// documented sequential-upsert fallback (UpsertChatMessage, mocked above) runs —
// the path these tests assert on.
const mockBatch = vi.fn(async () => {
  throw new Error("batch unavailable in test");
});
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({ items: { batch: (...a: unknown[]) => mockBatch(...a) } }),
}));

import {
  buildAssistantUIMessage,
  deriveStepToolLayout,
  deriveTurnShape,
  persistThread,
} from "../persist-assistant";
import { MODEL_CONFIGS } from "../../models";
import type { UIMessage } from "ai";
import type { ChatMessageModel } from "../../models";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINI_MODEL_ID = "gpt-5.4-mini" as const;
const modelConfig = MODEL_CONFIGS[MINI_MODEL_ID];

/** 1 user + 1 assistant (with 1 tool part) → chatMessagesFromUIMessages yields 3 rows */
function makeMessages(): UIMessage[] {
  return [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Search for azurechat" }],
    },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "Here are the results.", state: "done" },
        {
          type: "dynamic-tool",
          toolName: "web_search",
          toolCallId: "call-001",
          state: "output-available",
          input: { query: "azurechat" },
          output: { hits: 3 },
        } as import("ai").DynamicToolUIPart,
      ],
    },
  ] as UIMessage[];
}

const BASE_PAYLOAD = {
  threadId: "thread-persist-001",
  modelConfig,
  usage: { inputTokens: 1000, outputTokens: 500, cachedTokens: 200 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("persistThread — UpsertChatMessage call count", () => {
  it("upserts every Cosmos row except the user turn — that one was already written by loadThreadContext", async () => {
    // makeMessages() produces 1 user + 1 assistant + 1 tool row. The user
    // row is intentionally skipped inside persistThread to avoid the
    // double-write loadThreadContext.CreateChatMessage already did.
    mockUpsert.mockClear();
    await persistThread({ ...BASE_PAYLOAD, messages: makeMessages() });
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    const roles = mockUpsert.mock.calls.map((c) => c[0]?.role);
    expect(roles).not.toContain("user");
  });
});

describe("persistThread — usage counters", () => {
  it("calls IncrementUsage and UpdateChatThreadUsage with cost derived from pricing", async () => {
    mockIncrementUsage.mockClear();
    mockUpdateThreadUsage.mockClear();

    await persistThread({ ...BASE_PAYLOAD, messages: makeMessages() });

    // Allow fire-and-forget promises to settle.
    await new Promise((r) => setTimeout(r, 0));

    // Compute expected cost: (1000-200)/1M*0.75 + 200/1M*0.075 + 500/1M*4.50
    const pricing = modelConfig.pricing;
    const nonCached = 1000 - 200;
    const expectedCost =
      (nonCached / 1_000_000) * pricing.inputPerMillion +
      (200 / 1_000_000) * pricing.cachedInputPerMillion +
      (500 / 1_000_000) * pricing.outputPerMillion;

    expect(mockIncrementUsage).toHaveBeenCalledWith(
      "user-hash",
      MINI_MODEL_ID,
      1000,
      500,
      200,
      expectedCost
    );
    expect(mockUpdateThreadUsage).toHaveBeenCalledWith(
      "thread-persist-001",
      1000,
      500,
      200,
      expectedCost,
      // Cache writes are persisted too, so the header's cache row survives a
      // reload instead of folding the writes into "plain".
      0,
      // The last step's own prompt size. Undefined here: this payload carries
      // no step information, so nothing is persisted and readers fall back to
      // the turn total.
      undefined,
    );
  });
});

describe("persistThread — cache-write tokens", () => {
  const SOL_MODEL_ID = "gpt-5.6-sol" as const;
  const solConfig = MODEL_CONFIGS[SOL_MODEL_ID];

  it("bills cache writes at cacheWritePerMillion and pulls them out of plain input", async () => {
    mockUpdateThreadUsage.mockClear();
    mockUpsert.mockResolvedValue({ status: "OK" as const });

    await persistThread({
      threadId: "thread-cw-001",
      modelConfig: solConfig,
      messages: makeMessages(),
      usage: {
        inputTokens: 10_000,
        outputTokens: 500,
        cachedTokens: 6_000,
        cacheWriteTokens: 3_000,
        lastPromptTokens: 4_100,
      },
    });

    const pricing = solConfig.pricing;
    // 1_000 uncached + 6_000 cache-read + 3_000 cache-write + 500 output.
    const expectedCost =
      (1_000 / 1_000_000) * pricing.inputPerMillion +
      (6_000 / 1_000_000) * pricing.cachedInputPerMillion +
      (3_000 / 1_000_000) * pricing.cacheWritePerMillion! +
      (500 / 1_000_000) * pricing.outputPerMillion;

    expect(mockUpdateThreadUsage).toHaveBeenCalledWith(
      "thread-cw-001",
      10_000,
      500,
      6_000,
      expectedCost,
      3_000,
      // Cost is billed off the TURN TOTALS above; the last step's own prompt
      // size travels beside them, and is much smaller on a multi-step turn.
      4_100,
    );
  });

  it("keeps write tokens in the uncached-input bucket for a model with no write price (negative)", async () => {
    mockUpdateThreadUsage.mockClear();
    mockUpsert.mockResolvedValue({ status: "OK" as const });

    // gpt-5.4-mini has no cacheWritePerMillion — the provider does not
    // surcharge writes there, so a reported write count must not change cost.
    await persistThread({
      threadId: "thread-cw-002",
      modelConfig,
      messages: makeMessages(),
      usage: {
        inputTokens: 10_000,
        outputTokens: 500,
        cachedTokens: 6_000,
        cacheWriteTokens: 3_000,
      },
    });

    const pricing = modelConfig.pricing;
    const expectedCost =
      (4_000 / 1_000_000) * pricing.inputPerMillion +
      (6_000 / 1_000_000) * pricing.cachedInputPerMillion +
      (500 / 1_000_000) * pricing.outputPerMillion;

    expect(mockUpdateThreadUsage).toHaveBeenCalledWith(
      "thread-cw-002",
      10_000,
      500,
      6_000,
      expectedCost,
      3_000,
      undefined,
    );
  });

  it("emits the cacheWriteTokensUsed metric with the threadId dimension", async () => {
    mockReportCacheWriteTokens.mockClear();
    mockUpsert.mockResolvedValue({ status: "OK" as const });

    await persistThread({
      threadId: "thread-cw-003",
      modelConfig: solConfig,
      messages: makeMessages(),
      usage: {
        inputTokens: 10_000,
        outputTokens: 500,
        cachedTokens: 6_000,
        cacheWriteTokens: 3_000,
      },
    });
    // Metrics are fire-and-forget.
    await new Promise((r) => setTimeout(r, 0));

    expect(mockReportCacheWriteTokens).toHaveBeenCalledWith(
      3_000,
      SOL_MODEL_ID,
      expect.objectContaining({ threadId: "thread-cw-003" }),
    );
  });

  it("reports zero writes rather than skipping the metric when the provider omits them", async () => {
    mockReportCacheWriteTokens.mockClear();
    mockUpsert.mockResolvedValue({ status: "OK" as const });

    await persistThread({ ...BASE_PAYLOAD, messages: makeMessages() });
    await new Promise((r) => setTimeout(r, 0));

    expect(mockReportCacheWriteTokens).toHaveBeenCalledWith(
      0,
      MINI_MODEL_ID,
      expect.objectContaining({ threadId: "thread-persist-001" }),
    );
  });
});

describe("buildAssistantUIMessage — step boundaries", () => {
  const toolResult = {
    type: "dynamic-tool" as const,
    toolName: "get_current_time",
    toolCallId: "call-1",
    input: {},
    output: { now: "noon" },
    dynamic: true as const,
  };

  it("derives one layout entry per step from the event's steps", () => {
    expect(
      deriveStepToolLayout([
        { toolResults: [toolResult] },
        { toolResults: [] },
      ]),
    ).toEqual([{ toolCallIds: ["call-1"] }, { toolCallIds: [] }]);
  });

  it("emits step-start markers so the tool call and the answer land in different steps", () => {
    const msg = buildAssistantUIMessage(
      {
        text: "It is noon.",
        toolResults: [toolResult] as never,
        stepLayout: [{ toolCallIds: ["call-1"] }, { toolCallIds: [] }],
      },
      "a1",
    );
    expect(msg.parts.map((p) => p.type)).toEqual([
      "step-start",
      "dynamic-tool",
      "step-start",
      "text",
    ]);
  });

  it("keeps the flat shape when no step layout is supplied (back-compat)", () => {
    const msg = buildAssistantUIMessage(
      { text: "It is noon.", toolResults: [toolResult] as never },
      "a1",
    );
    expect(msg.parts.map((p) => p.type)).toEqual(["text", "dynamic-tool"]);
  });

  it("still persists a tool result no step claimed (negative)", () => {
    const msg = buildAssistantUIMessage(
      {
        text: "done",
        toolResults: [toolResult] as never,
        // The layout knows nothing about call-1.
        stepLayout: [{ toolCallIds: [] }],
      },
      "a1",
    );
    expect(msg.parts.map((p) => p.type)).toEqual([
      "step-start",
      "text",
      "dynamic-tool",
    ]);
  });
});

describe("deriveTurnShape", () => {
  it("counts a 1-step plain turn", () => {
    expect(deriveTurnShape([{ toolCalls: [], toolResults: [] }])).toEqual({
      stepCount: 1,
      toolCallCount: 0,
    });
  });

  it("counts tool calls across a 3-step turn", () => {
    expect(
      deriveTurnShape([
        { toolCalls: [{}, {}] },
        { toolCalls: [{}] },
        { toolCalls: [] },
      ]),
    ).toEqual({ stepCount: 3, toolCallCount: 3 });
  });

  it("falls back to tool results when a step has no toolCalls array (abort path)", () => {
    expect(deriveTurnShape([{ toolResults: [{}, {}] }])).toEqual({
      stepCount: 1,
      toolCallCount: 2,
    });
  });

  it("reports zeroes for an absent or empty step list (negative)", () => {
    expect(deriveTurnShape(undefined)).toEqual({ stepCount: 0, toolCallCount: 0 });
    expect(deriveTurnShape([])).toEqual({ stepCount: 0, toolCallCount: 0 });
  });
});

describe("persistThread — row sequence", () => {
  /** 1 assistant + 2 tool parts → 3 persisted rows in one batch. */
  function makeThreeItemStep(): UIMessage[] {
    return [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Here you go.", state: "done" },
          {
            type: "dynamic-tool",
            toolName: "search_documents",
            toolCallId: "call-1",
            state: "output-available",
            input: { q: "a" },
            output: { hits: 1 },
          } as import("ai").DynamicToolUIPart,
          {
            type: "dynamic-tool",
            toolName: "get_current_time",
            toolCallId: "call-2",
            state: "output-available",
            input: {},
            output: { now: "noon" },
          } as import("ai").DynamicToolUIPart,
        ],
      },
    ] as UIMessage[];
  }

  it("stamps strictly increasing sequence numbers on rows written in the same millisecond", async () => {
    mockUpsert.mockClear();
    mockUpsert.mockResolvedValue({ status: "OK" as const });
    // Freeze the clock so every row shares one createdAt — the exact case
    // where createdAt alone cannot order them.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:00:00.000Z"));
    try {
      await persistThread({
        ...BASE_PAYLOAD,
        threadId: "thread-seq-001",
        messages: makeThreeItemStep(),
      });
    } finally {
      vi.useRealTimers();
    }

    const rows = mockUpsert.mock.calls.map(
      (c) => (c as unknown[])[0] as ChatMessageModel,
    );
    expect(rows).toHaveLength(3);
    const createdAt = rows.map((r) => new Date(r.createdAt).getTime());
    expect(new Set(createdAt).size).toBe(1);
    const sequences = rows.map((r) => r.sequence);
    expect(sequences).toEqual([1, 2, 3]);
    // Strictly increasing, and in the order the turn produced them.
    expect(rows.map((r) => r.role)).toEqual(["assistant", "tool", "tool"]);
  });

  it("leaves 0 free for the user row written before the turn ran", async () => {
    mockUpsert.mockClear();
    mockUpsert.mockResolvedValue({ status: "OK" as const });
    await persistThread({ ...BASE_PAYLOAD, messages: makeMessages() });
    const rows = mockUpsert.mock.calls.map(
      (c) => (c as unknown[])[0] as ChatMessageModel,
    );
    expect(Math.min(...rows.map((r) => r.sequence ?? -1))).toBe(1);
  });
});

describe("persistThread — turn-shape metric dimensions", () => {
  it("passes stepCount and toolCallCount to every metric", async () => {
    mockReportPromptTokens.mockClear();
    mockReportCachedTokens.mockClear();
    mockReportUserChatMessage.mockClear();
    mockUpsert.mockResolvedValue({ status: "OK" as const });

    await persistThread({
      ...BASE_PAYLOAD,
      threadId: "thread-shape-001",
      messages: makeMessages(),
      turnShape: { stepCount: 3, toolCallCount: 4 },
    });
    await new Promise((r) => setTimeout(r, 0));

    const expected = {
      threadId: "thread-shape-001",
      stepCount: 3,
      toolCallCount: 4,
    };
    expect(mockReportPromptTokens).toHaveBeenCalledWith(
      1000,
      MINI_MODEL_ID,
      "user",
      expected,
    );
    expect(mockReportCachedTokens).toHaveBeenCalledWith(
      200,
      MINI_MODEL_ID,
      expected,
    );
    expect(mockReportUserChatMessage).toHaveBeenCalledWith(
      MINI_MODEL_ID,
      expected,
    );
  });

  it("emits zeroes when the caller has no step information (negative)", async () => {
    mockReportCachedTokens.mockClear();
    mockUpsert.mockResolvedValue({ status: "OK" as const });

    await persistThread({ ...BASE_PAYLOAD, messages: makeMessages() });
    await new Promise((r) => setTimeout(r, 0));

    expect(mockReportCachedTokens).toHaveBeenCalledWith(200, MINI_MODEL_ID, {
      threadId: "thread-persist-001",
      stepCount: 0,
      toolCallCount: 0,
    });
  });
});

describe("persistThread — UpsertChatMessage rejection is logged, not thrown", () => {
  it("resolves without throwing when UpsertChatMessage rejects", async () => {
    // NOTE: persistThread catches individual upsert errors via try/catch and logs them.
    // It does NOT re-throw, so callers never see the failure — this is by design per
    // the comment in persist-assistant.ts ("errors surface as logger warnings").
    mockUpsert.mockRejectedValue(new Error("Cosmos write failure"));

    await expect(
      persistThread({ ...BASE_PAYLOAD, messages: makeMessages() })
    ).resolves.toBeUndefined();
  });
});
