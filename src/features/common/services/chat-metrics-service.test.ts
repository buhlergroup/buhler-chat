import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist OpenTelemetry meter mocks
const { mockRecord, mockAdd, mockCreateHistogram, mockCreateCounter, mockGetMeter } = vi.hoisted(() => {
  const mockRecord = vi.fn();
  const mockAdd = vi.fn();
  const mockCreateHistogram = vi.fn(() => ({ record: mockRecord }));
  const mockCreateCounter = vi.fn(() => ({ add: mockAdd }));
  const mockGetMeter = vi.fn(() => ({
    createHistogram: mockCreateHistogram,
    createCounter: mockCreateCounter,
  }));
  return { mockRecord, mockAdd, mockCreateHistogram, mockCreateCounter, mockGetMeter };
});

vi.mock("@opentelemetry/api", () => ({
  metrics: { getMeter: mockGetMeter },
}));

vi.mock("@/features/auth-page/helpers", () => ({
  userSession: vi.fn(async () => ({ email: "user@example.com", name: "Test User" })),
  userHashedId: vi.fn(async () => "hashed-id-abc123"),
}));

describe("common.unit.chat-metrics — reportPromptTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("common.unit.chat-metrics.001: creates histogram and records token count with attributes", async () => {
    const { reportPromptTokens } = await import("./chat-metrics-service");
    await reportPromptTokens(100, "gpt-4", "user");
    expect(mockGetMeter).toHaveBeenCalledWith("chat");
    expect(mockCreateHistogram).toHaveBeenCalledWith("promptTokensUsed", expect.any(Object));
    expect(mockRecord).toHaveBeenCalledWith(
      100,
      expect.objectContaining({
        email: "user@example.com",
        chatModel: "gpt-4",
        role: "user",
      })
    );
  });

  it("common.unit.chat-metrics.002: merges extra attributes with defaults", async () => {
    const { reportPromptTokens } = await import("./chat-metrics-service");
    await reportPromptTokens(50, "gpt-4", "assistant", { requestId: "req-1" });
    expect(mockRecord).toHaveBeenCalledWith(
      50,
      expect.objectContaining({ requestId: "req-1", role: "assistant" })
    );
  });
});

describe("common.unit.chat-metrics — reportCompletionTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("common.unit.chat-metrics.003: creates completions histogram and records with default attributes", async () => {
    const { reportCompletionTokens } = await import("./chat-metrics-service");
    await reportCompletionTokens(200, "gpt-4");
    expect(mockCreateHistogram).toHaveBeenCalledWith("completionsTokensUsed", expect.any(Object));
    expect(mockRecord).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ email: "user@example.com", chatModel: "gpt-4" })
    );
  });

  it("common.unit.chat-metrics.004: merges extra attributes for completion tokens", async () => {
    const { reportCompletionTokens } = await import("./chat-metrics-service");
    await reportCompletionTokens(75, "gpt-4", { conversationId: "conv-42" });
    expect(mockRecord).toHaveBeenCalledWith(
      75,
      expect.objectContaining({ conversationId: "conv-42" })
    );
  });
});

describe("common.unit.chat-metrics — reportCachedTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("common.unit.chat-metrics.007: creates cachedTokensUsed histogram and records with default attributes", async () => {
    const { reportCachedTokens } = await import("./chat-metrics-service");
    await reportCachedTokens(200, "gpt-4");
    expect(mockCreateHistogram).toHaveBeenCalledWith("cachedTokensUsed", expect.any(Object));
    expect(mockRecord).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ email: "user@example.com", chatModel: "gpt-4" })
    );
  });

  it("common.unit.chat-metrics.008: merges extra attributes for cached tokens", async () => {
    const { reportCachedTokens } = await import("./chat-metrics-service");
    await reportCachedTokens(64, "gpt-4", { threadId: "thread-9" });
    expect(mockRecord).toHaveBeenCalledWith(
      64,
      expect.objectContaining({ threadId: "thread-9" })
    );
  });
});

describe("common.unit.chat-metrics — reportUserChatMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("common.unit.chat-metrics.005: creates counter and adds 1 with default attributes", async () => {
    const { reportUserChatMessage } = await import("./chat-metrics-service");
    await reportUserChatMessage("gpt-4");
    expect(mockCreateCounter).toHaveBeenCalledWith("userChatMessage", expect.any(Object));
    expect(mockAdd).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ email: "user@example.com", chatModel: "gpt-4" })
    );
  });

  it("common.unit.chat-metrics.006: merges extra attributes for user chat message", async () => {
    const { reportUserChatMessage } = await import("./chat-metrics-service");
    await reportUserChatMessage("gpt-4", { sessionId: "ses-1" });
    expect(mockAdd).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ sessionId: "ses-1" })
    );
  });
});

describe("common.unit.chat-metrics — turn-shape dimensions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("common.unit.chat-metrics.009: a 1-step plain turn reports stepCount 1 and toolCallCount 0", async () => {
    const { reportPromptTokens } = await import("./chat-metrics-service");
    await reportPromptTokens(100, "gpt-5.6-terra", "user", {
      threadId: "t1",
      stepCount: 1,
      toolCallCount: 0,
    });
    expect(mockRecord).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ stepCount: 1, toolCallCount: 0 }),
    );
  });

  it("common.unit.chat-metrics.010: a 3-step tool turn reports its step and tool-call counts", async () => {
    const mod = await import("./chat-metrics-service");
    const attrs = { threadId: "t1", stepCount: 3, toolCallCount: 4 };
    await mod.reportPromptTokens(100, "gpt-5.6-terra", "user", { ...attrs });
    await mod.reportCompletionTokens(50, "gpt-5.6-terra", { ...attrs });
    await mod.reportCachedTokens(80, "gpt-5.6-terra", { ...attrs });
    await mod.reportCacheWriteTokens(20, "gpt-5.6-terra", { ...attrs });
    await mod.reportUserChatMessage("gpt-5.6-terra", { ...attrs });

    // Every token histogram carries the dimensions...
    expect(mockRecord).toHaveBeenCalledTimes(4);
    for (const call of mockRecord.mock.calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({ stepCount: 3, toolCallCount: 4 }),
      );
    }
    // ...and so does the message counter.
    expect(mockAdd).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ stepCount: 3, toolCallCount: 4 }),
    );
  });

  it("common.unit.chat-metrics.011: the dimensions default to 0 when the caller omits them", async () => {
    const { reportCachedTokens } = await import("./chat-metrics-service");
    await reportCachedTokens(10, "gpt-5.6-terra", { threadId: "t1" });
    expect(mockRecord).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ stepCount: 0, toolCallCount: 0 }),
    );
  });

  it("common.unit.chat-metrics.012: junk counts are coerced to 0 so the dimension type never splits (negative)", async () => {
    const { reportCachedTokens } = await import("./chat-metrics-service");
    await reportCachedTokens(10, "gpt-5.6-terra", {
      stepCount: "three",
      toolCallCount: -2,
    });
    expect(mockRecord).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ stepCount: 0, toolCallCount: 0 }),
    );
  });

  it("common.unit.chat-metrics.013: existing dimensions are untouched", async () => {
    const { reportPromptTokens } = await import("./chat-metrics-service");
    await reportPromptTokens(5, "gpt-5.6-terra", "user", { threadId: "t1" });
    expect(mockRecord).toHaveBeenCalledWith(
      5,
      expect.objectContaining({
        email: "user@example.com",
        name: "Test User",
        userHashedId: "hashed-id-abc123",
        chatModel: "gpt-5.6-terra",
        threadId: "t1",
        role: "user",
      }),
    );
  });
});

describe("common.unit.chat-metrics — the caller's attribute object is never mutated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds role to the emitted dimensions without writing it back", async () => {
    // persist-assistant hands ONE attribute object to all five emitters inside
    // a single Promise.all. reportPromptTokens used to write `role` onto it,
    // so whichever sibling had not yet copied it emitted a role dimension too
    // — non-deterministically, depending on statement order.
    const { reportPromptTokens } = await import("./chat-metrics-service");
    const shared = { threadId: "t1", stepCount: 2, toolCallCount: 1 };

    await reportPromptTokens(100, "gpt-4", "user", shared);

    expect(shared).toEqual({ threadId: "t1", stepCount: 2, toolCallCount: 1 });
    expect("role" in shared).toBe(false);
    expect(mockRecord).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ role: "user", threadId: "t1", stepCount: 2, toolCallCount: 1 }),
    );
  });

  it("keeps the siblings free of a role dimension when they share the object", async () => {
    const { reportPromptTokens, reportCacheWriteTokens, reportCachedTokens } =
      await import("./chat-metrics-service");
    const shared = { threadId: "t1" };

    await Promise.all([
      reportPromptTokens(10, "gpt-4", "user", shared),
      reportCachedTokens(20, "gpt-4", shared),
      reportCacheWriteTokens(30, "gpt-4", shared),
    ]);

    const withoutRole = mockRecord.mock.calls.filter(
      ([count]) => count === 20 || count === 30,
    );
    expect(withoutRole).toHaveLength(2);
    for (const [, attrs] of withoutRole) {
      expect(attrs).not.toHaveProperty("role");
    }
  });
});
