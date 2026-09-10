import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Logger ────────────────────────────────────────────────────────────────────
const logInfo = vi.fn();
const logWarn = vi.fn();
const logDebug = vi.fn();
vi.mock("@/features/common/services/logger", () => ({
  logDebug: (...a: unknown[]) => logDebug(...(a as [])),
  logInfo: (...a: unknown[]) => logInfo(...(a as [])),
  logError: vi.fn(),
  logWarn: (...a: unknown[]) => logWarn(...(a as [])),
}));

// ── Auth ──────────────────────────────────────────────────────────────────────
vi.mock("@/features/auth-page/helpers", () => ({
  userHashedId: vi.fn(async () => "user-hash"),
  getCurrentUser: vi.fn(async () => ({
    name: "Test User",
    email: "test@example.com",
    isAdmin: false,
  })),
}));

// ── Thread service ────────────────────────────────────────────────────────────
const mockEnsureThread = vi.fn();
const mockUpdateThreadUsage = vi.fn(async () => ({ status: "OK" }));
vi.mock("../../chat-thread-service", () => ({
  EnsureChatThreadOperation: (...a: unknown[]) => mockEnsureThread(...a),
  UpdateChatThreadUsage: (...a: unknown[]) => mockUpdateThreadUsage(...a),
}));

// ── Message service ───────────────────────────────────────────────────────────
const mockFindHistory = vi.fn();
const mockCreateMessage = vi.fn(async () => ({ status: "OK" }));
vi.mock("../../chat-message-service", () => ({
  FindAllChatMessagesForCurrentUser: (...a: unknown[]) => mockFindHistory(...a),
  CreateChatMessage: (...a: unknown[]) => mockCreateMessage(...a),
}));

// ── History summary service ───────────────────────────────────────────────────
// Stands in for both Cosmos and the summariser model. `recordHistoryCompaction`
// is the expensive call (one model round-trip per trim), so counting it is how
// these tests assert that a trim happens once and is then reused.
let summaryRow: any = null;
let summaryEnabled = false;
const mockFindSummary = vi.fn(async () => summaryRow);
const mockRecordCompaction = vi.fn(
  async (input: {
    threadId: string;
    coversThroughMessageId: string;
    droppedMessages: unknown[];
    previous?: any;
  }) => {
    summaryRow = {
      id: `summary-${input.threadId}`,
      type: "CHAT_HISTORY_SUMMARY",
      threadId: input.threadId,
      userId: "user-hash",
      isDeleted: false,
      createdAt: new Date("2026-09-07"),
      role: "system",
      kind: "summary",
      content: summaryEnabled ? "FACTS: the earlier turns said things." : "",
      coversThroughMessageId: input.coversThroughMessageId,
      coversMessageCount:
        (input.previous?.coversMessageCount ?? 0) + input.droppedMessages.length,
      model: summaryEnabled ? "gpt-5.6-terra" : "",
      estimatedTokens: summaryEnabled ? 10 : 0,
      // The writer owns the reason code — it is the only place that knows
      // whether the summariser was off, absent, slow or broken.
      summaryOutcome: summaryEnabled ? "ok" : "off",
    };
    return summaryRow;
  },
);
vi.mock("../history-summary-service", () => ({
  FindChatHistorySummary: (...a: unknown[]) => mockFindSummary(...(a as [])),
  recordHistoryCompaction: (...a: unknown[]) =>
    mockRecordCompaction(...(a as [any])),
  isHistorySummaryEnabled: () => summaryEnabled,
}));

// ── Document service ──────────────────────────────────────────────────────────
vi.mock("../../chat-document-service", () => ({
  FindAllChatDocuments: vi.fn(async () => ({ status: "OK", response: [] })),
}));

// ── Extension service ─────────────────────────────────────────────────────────
vi.mock("@/features/extensions-page/extension-services/extension-service", () => ({
  FindAllExtensionForCurrentUserAndIds: vi.fn(async () => ({ status: "OK", response: [] })),
}));

// ── Responses API mapper (async, just return empty array for these tests) ─────
vi.mock("../../utils", () => ({
  mapOpenAIChatMessages: vi.fn(async () => []),
}));

import { loadThreadContext, applyDocumentHintPlacement } from "../thread-context";
import { MESSAGE_ATTRIBUTE } from "../../models";
import type { ChatThreadModel, UserPrompt } from "../../models";
import { SUMMARY_REPLAY_PREFIX } from "../history-summary";
import { CHARS_PER_TOKEN } from "../history-budget";

beforeEach(() => {
  summaryRow = null;
  summaryEnabled = false;
  delete process.env.HISTORY_TOKEN_BUDGET;
  delete process.env.HISTORY_PROTECTED_TURNS;
  mockFindSummary.mockClear();
  mockRecordCompaction.mockClear();
  logInfo.mockClear();
  logWarn.mockClear();
  logDebug.mockClear();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A thread row. `lastPromptTokens` is the ONE input to the compaction
 * decision: the provider's measured size of this thread's previous last
 * prompt. Omitted means "no usage recorded yet", i.e. a first turn, and then
 * nothing is ever compacted.
 */
function makeThread(
  id = "thread-001",
  lastPromptTokens?: number,
): ChatThreadModel {
  return {
    id,
    createdAt: new Date("2026-01-01"),
    isDeleted: false,
    userId: "user-hash",
    name: "Test thread",
    type: "CHAT_THREAD",
    bookmarked: false,
    selectedModel: "gpt-5.4-mini",
    extension: [],
    personaDocumentIds: [],
    attachedFiles: [],
    ...(typeof lastPromptTokens === "number"
      ? {
          usage: {
            totalInputTokens: lastPromptTokens,
            totalOutputTokens: 0,
            totalCachedTokens: 0,
            totalCostUsd: 0,
            lastUpdated: "2026-01-01T00:00:00.000Z",
            lastInputTokens: lastPromptTokens,
            lastPromptTokens,
          },
        }
      : {}),
  } as unknown as ChatThreadModel;
}

/** A thread whose previous last prompt measured `tokens`. */
function measured(tokens: number): { status: string; response: ChatThreadModel } {
  return { status: "OK", response: makeThread("thread-001", tokens) };
}

function makeUserPrompt(threadId = "thread-001"): UserPrompt {
  return {
    id: threadId,
    message: "Hello world",
    multimodalImage: undefined,
    multimodalImages: [],
  } as unknown as UserPrompt;
}

let rowSeq = 0;
function makeHistoryRow(
  role: "user" | "assistant",
  content: string,
  id?: string,
) {
  rowSeq += 1;
  return {
    id: id ?? `msg-${role}-${rowSeq}`,
    createdAt: new Date("2026-01-01"),
    isDeleted: false,
    threadId: "thread-001",
    userId: "user-hash",
    name: "",
    content,
    role,
    type: MESSAGE_ATTRIBUTE,
  };
}

/** `count` user+assistant pairs, each side costing ~`tokens/2` estimated tokens. */
function makeTurns(count: number, tokensPerTurn: number) {
  const chars = Math.floor((tokensPerTurn * CHARS_PER_TOKEN) / 2);
  const rows: ReturnType<typeof makeHistoryRow>[] = [];
  for (let i = 0; i < count; i++) {
    rows.push(makeHistoryRow("user", "u".repeat(chars)));
    rows.push(makeHistoryRow("assistant", "a".repeat(chars)));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadThreadContext — fresh thread (no history)", () => {
  it("creates thread via EnsureChatThreadOperation and returns history containing the new user turn", async () => {
    const thread = makeThread();
    mockEnsureThread.mockResolvedValue({ status: "OK", response: thread });
    mockFindHistory.mockResolvedValue({ status: "OK", response: [] });

    const ctx = await loadThreadContext(makeUserPrompt());

    expect(ctx.thread).toBe(thread);
    // loadThreadContext appends the just-written user message to history so
    // streamText doesn't trip over an empty prompt — see thread-context.ts.
    expect(ctx.history).toHaveLength(1);
    expect(ctx.history[0]?.role).toBe("user");
  });
});

describe("loadThreadContext — existing thread with history", () => {
  it("hydrates at least 1 UIMessage from 1 user + 1 assistant row", async () => {
    const thread = makeThread();
    mockEnsureThread.mockResolvedValue({ status: "OK", response: thread });
    // FindAllChatMessagesForCurrentUser orders createdAt ASC, i.e. oldest
    // first — no reversal in thread-context any more.
    mockFindHistory.mockResolvedValue({
      status: "OK",
      response: [
        makeHistoryRow("user", "Hello"),
        makeHistoryRow("assistant", "I can help with that."),
      ],
    });

    const ctx = await loadThreadContext(makeUserPrompt());

    expect(ctx.history.length).toBeGreaterThanOrEqual(1);
    const roles = ctx.history.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
  });
});

describe("loadThreadContext — CreateChatMessage is called once for the new user turn", () => {
  it("calls CreateChatMessage exactly once before returning", async () => {
    const thread = makeThread();
    mockEnsureThread.mockResolvedValue({ status: "OK", response: thread });
    mockFindHistory.mockResolvedValue({ status: "OK", response: [] });
    mockCreateMessage.mockClear();

    await loadThreadContext(makeUserPrompt());

    expect(mockCreateMessage).toHaveBeenCalledTimes(1);
    const [arg] = mockCreateMessage.mock.calls[0] as [Record<string, unknown>];
    expect(arg.role).toBe("user");
    expect(arg.content).toBe("Hello world");
    // turnId is now stamped on the user row (architect2 SEV-2 B7+B8).
    expect(typeof arg.turnId).toBe("string");
    expect(arg.turnId as string).toMatch(/^turn-/);
  });
});

describe("loadThreadContext — turnId is minted per request", () => {
  it("returns a unique turnId every call", async () => {
    const thread = makeThread();
    mockEnsureThread.mockResolvedValue({ status: "OK", response: thread });
    mockFindHistory.mockResolvedValue({ status: "OK", response: [] });

    const ctxA = await loadThreadContext(makeUserPrompt());
    const ctxB = await loadThreadContext(makeUserPrompt());
    expect(ctxA.turnId).toMatch(/^turn-/);
    expect(ctxB.turnId).toMatch(/^turn-/);
    expect(ctxA.turnId).not.toBe(ctxB.turnId);
  });
});

// ---------------------------------------------------------------------------
// History loading: full thread, token budget, summary replay
// ---------------------------------------------------------------------------

describe("chat-page.unit.thread-context.001 — the chat path loads the whole thread", () => {
  it("calls the un-capped loader with only the thread id (no row limit)", async () => {
    mockEnsureThread.mockResolvedValue({ status: "OK", response: makeThread() });
    mockFindHistory.mockResolvedValue({ status: "OK", response: [] });

    await loadThreadContext(makeUserPrompt());

    expect(mockFindHistory).toHaveBeenCalledWith("thread-001");
    // The old `TOP 30` path passed a row cap here; a second argument would
    // mean the sliding window is back.
    expect(mockFindHistory.mock.calls[0]).toHaveLength(1);
  });

  it("keeps far more than 30 rows when they fit the token budget", async () => {
    // 100 tiny turns = 200 rows, a few thousand estimated tokens. Under the
    // old cap the model saw 30 rows; it must now see all of them.
    const rows = makeTurns(100, 40);
    mockEnsureThread.mockResolvedValue({ status: "OK", response: makeThread() });
    mockFindHistory.mockResolvedValue({ status: "OK", response: rows });

    const ctx = await loadThreadContext(makeUserPrompt());

    // 200 history rows + the current user turn.
    expect(ctx.history).toHaveLength(201);
    expect(mockRecordCompaction).not.toHaveBeenCalled();
  });

  it("treats loaded rows as oldest-first without reversing them", async () => {
    mockEnsureThread.mockResolvedValue({ status: "OK", response: makeThread() });
    mockFindHistory.mockResolvedValue({
      status: "OK",
      response: [
        makeHistoryRow("user", "first question"),
        makeHistoryRow("assistant", "first answer"),
        makeHistoryRow("user", "second question"),
      ],
    });

    const ctx = await loadThreadContext(makeUserPrompt());
    const texts = ctx.history.map((m) =>
      m.parts.map((p) => (p as { text?: string }).text ?? "").join(""),
    );
    expect(texts.indexOf("first question")).toBeLessThan(
      texts.indexOf("first answer"),
    );
    expect(texts.indexOf("first answer")).toBeLessThan(
      texts.indexOf("second question"),
    );
  });
});

describe("chat-page.unit.thread-context.002 — the token budget trims once and the trim sticks", () => {
  it("records the compaction exactly once across two loads", async () => {
    // The property that matters: the summariser (and the Cosmos write) run on
    // the turn that trims, and NOT on the turns after it. A per-turn call here
    // would mean the prefix moves every turn, which is the failure this whole
    // change removes.
    process.env.HISTORY_TOKEN_BUDGET = "10000";
    summaryEnabled = true;
    const rows = makeTurns(40, 500);
    mockEnsureThread.mockResolvedValue(measured(20_000));
    mockFindHistory.mockResolvedValue({ status: "OK", response: rows });

    const first = await loadThreadContext(makeUserPrompt());
    expect(mockRecordCompaction).toHaveBeenCalledTimes(1);

    // Second turn: the same rows come back from Cosmos (a trim deletes
    // nothing) plus a new turn. The persisted watermark must absorb them —
    // and the measurement the previous turn recorded is now the SMALL prompt
    // the compaction produced, which is what stops a second compaction. No
    // arithmetic in this module had to predict that; the provider measured it.
    mockEnsureThread.mockResolvedValue(measured(2_500));
    mockFindHistory.mockResolvedValue({
      status: "OK",
      response: [...rows, ...makeTurns(1, 200)],
    });
    const second = await loadThreadContext(makeUserPrompt());

    expect(mockRecordCompaction).toHaveBeenCalledTimes(1);
    // And the prefix did not move: same first item in the list that reaches
    // the model (the replayed summary), both turns.
    const firstItem = (m: typeof first) =>
      m.modelHistory[0].parts
        .map((p) => (p as { text?: string }).text ?? "")
        .join("");
    expect(firstItem(second)).toBe(firstItem(first));
  });

  it("reports the trim on the context, so the UI can say it happened", async () => {
    // The rows stay in Cosmos and keep rendering, so a trim is invisible
    // unless the turn says so. This outcome is what /api/chat turns into the
    // data-compaction part.
    process.env.HISTORY_TOKEN_BUDGET = "10000";
    summaryEnabled = true;
    const rows = makeTurns(40, 500);
    mockEnsureThread.mockResolvedValue(measured(20_000));
    mockFindHistory.mockResolvedValue({ status: "OK", response: rows });

    const ctx = await loadThreadContext(makeUserPrompt());

    expect(ctx.compaction).toBeDefined();
    expect(ctx.compaction!.trimmedTurns).toBeGreaterThan(0);
    // The measurement that triggered it, carried for the log. No estimate of
    // the result: the next request measures that for us.
    expect(ctx.compaction!.measuredPromptTokens).toBe(20_000);
    expect(ctx.compaction!.summaryOutcome).toBe("ok");
    expect(ctx.compaction!.summaryText).toContain("the earlier turns said things");
    expect(ctx.compaction!.summaryModel).toBe("gpt-5.6-terra");
    expect(ctx.compaction!.durationMs).toBeGreaterThanOrEqual(0);
    // The anchor the persisted divider is drawn after.
    const call = mockRecordCompaction.mock.calls[0][0] as unknown as {
      coversThroughMessageId: string;
    };
    expect(ctx.compaction!.coversThroughMessageId).toBe(call.coversThroughMessageId);
  });

  it("reports a trim with no summary as exactly that", async () => {
    // Feature off: the turns are dropped and nothing stands in for them. The
    // notice must not claim a summary exists, even if the row carries text
    // from a trim taken while the feature was on.
    process.env.HISTORY_TOKEN_BUDGET = "10000";
    summaryEnabled = false;
    mockEnsureThread.mockResolvedValue(measured(20_000));
    mockFindHistory.mockResolvedValue({
      status: "OK",
      response: makeTurns(40, 500),
    });

    const ctx = await loadThreadContext(makeUserPrompt());

    expect(ctx.compaction).toBeDefined();
    expect(ctx.compaction!.summaryOutcome).toBe("off");
    expect(ctx.compaction!.summaryText).toBeUndefined();
    expect(ctx.compaction!.summaryModel).toBeUndefined();
  });

  it("does not present an earlier summary as this block's when the summariser failed", async () => {
    // The defect this reason code exists for. The row can carry text from an
    // EARLIER trim while THIS trim failed; showing it would tell the user the
    // dropped turns are covered when they are not.
    process.env.HISTORY_TOKEN_BUDGET = "10000";
    summaryEnabled = true;
    mockRecordCompaction.mockImplementationOnce(async (input: any) => ({
      id: `summary-${input.threadId}`,
      type: "CHAT_HISTORY_SUMMARY",
      threadId: input.threadId,
      userId: "user-hash",
      isDeleted: false,
      createdAt: new Date("2026-09-07"),
      role: "system",
      kind: "summary",
      content: "FACTS: carried over from an earlier trim.",
      coversThroughMessageId: input.coversThroughMessageId,
      coversMessageCount: 6,
      model: "gpt-5.6-terra",
      estimatedTokens: 10,
      summaryOutcome: "failed",
    }));
    mockEnsureThread.mockResolvedValue(measured(20_000));
    mockFindHistory.mockResolvedValue({
      status: "OK",
      response: makeTurns(40, 500),
    });

    const ctx = await loadThreadContext(makeUserPrompt());

    expect(ctx.compaction!.summaryOutcome).toBe("failed");
    expect(ctx.compaction!.summaryText).toBeUndefined();
    expect(ctx.compaction!.summaryModel).toBeUndefined();
  });

  it("logs nothing-droppable at INFO on a small configured budget, WARN on the default", async () => {
    // Over budget with no history left that may be compacted. With a
    // deliberately small budget and protected turns that happens routinely,
    // and warning on every turn would train people to ignore the log. On the
    // shipped default it means one turn is genuinely enormous.
    const nothing = (calls: typeof logInfo.mock.calls) =>
      calls.filter((c) =>
        String(c[0]).includes("nothing can be compacted"),
      );

    // Every turn protected, so there is nothing to hand the summariser.
    summaryEnabled = true;
    process.env.HISTORY_TOKEN_BUDGET = "1000";
    process.env.HISTORY_PROTECTED_TURNS = "6";
    mockEnsureThread.mockResolvedValue(measured(5_000));
    mockFindHistory.mockResolvedValue({ status: "OK", response: makeTurns(6, 800) });

    await loadThreadContext(makeUserPrompt());

    expect(nothing(logInfo.mock.calls)).toHaveLength(1);
    expect(nothing(logWarn.mock.calls)).toHaveLength(0);
    expect(nothing(logInfo.mock.calls)[0][1]).toMatchObject({
      budgetSource: "env",
      skipReason: "nothing-droppable",
      measuredPromptTokens: 5_000,
    });
    // And no summariser call was spent on a compaction that could not help.
    expect(mockRecordCompaction).not.toHaveBeenCalled();

    // The shipped default budget: a single turn over 256k with nothing behind
    // it. That is a warning.
    logInfo.mockClear();
    logWarn.mockClear();
    delete process.env.HISTORY_TOKEN_BUDGET;
    delete process.env.HISTORY_PROTECTED_TURNS;
    mockEnsureThread.mockResolvedValue(measured(600_000));
    mockFindHistory.mockResolvedValue({ status: "OK", response: [] });

    await loadThreadContext(makeUserPrompt());

    expect(nothing(logWarn.mock.calls)).toHaveLength(1);
    expect(nothing(logInfo.mock.calls)).toHaveLength(0);
    expect(nothing(logWarn.mock.calls)[0][1]).toMatchObject({
      budgetSource: "default",
    });
  });

  it("does nothing, and says so at DEBUG, when the thread has no measurement yet", async () => {
    // A thread's first turn, or a row written before `lastPromptTokens`
    // existed. Nothing to compare against, so no compaction and no summariser
    // call — however big the history looks.
    process.env.HISTORY_TOKEN_BUDGET = "1000";
    summaryEnabled = true;
    mockEnsureThread.mockResolvedValue({ status: "OK", response: makeThread() });
    mockFindHistory.mockResolvedValue({
      status: "OK",
      response: makeTurns(40, 500),
    });

    const ctx = await loadThreadContext(makeUserPrompt());

    expect(ctx.compaction).toBeUndefined();
    expect(mockRecordCompaction).not.toHaveBeenCalled();
    expect(
      logDebug.mock.calls.filter((c) =>
        String(c[0]).includes("no measured prompt size yet"),
      ),
    ).toHaveLength(1);
  });

  it("falls back to the all-steps roll-up for a row written before lastPromptTokens", async () => {
    // Old rows carry only `lastInputTokens`. It is exact for a single-step
    // turn and overstates a multi-step one, so the fallback errs towards
    // compacting — the safe direction.
    process.env.HISTORY_TOKEN_BUDGET = "10000";
    summaryEnabled = true;
    const legacy = makeThread("thread-001", 20_000) as unknown as {
      usage: Record<string, unknown>;
    };
    delete legacy.usage.lastPromptTokens;
    mockEnsureThread.mockResolvedValue({ status: "OK", response: legacy });
    mockFindHistory.mockResolvedValue({
      status: "OK",
      response: makeTurns(40, 500),
    });

    const ctx = await loadThreadContext(makeUserPrompt());

    expect(ctx.compaction).toBeDefined();
    expect(ctx.compaction!.measuredPromptTokens).toBe(20_000);
  });

  it("reports nothing when the thread fitted (negative)", async () => {
    process.env.HISTORY_TOKEN_BUDGET = "100000";
    mockEnsureThread.mockResolvedValue({ status: "OK", response: makeThread() });
    mockFindHistory.mockResolvedValue({
      status: "OK",
      response: makeTurns(20, 100),
    });

    const ctx = await loadThreadContext(makeUserPrompt());

    expect(ctx.compaction).toBeUndefined();
    expect(mockRecordCompaction).not.toHaveBeenCalled();
  });

  it("passes the newest dropped row as the watermark", async () => {
    process.env.HISTORY_TOKEN_BUDGET = "10000";
    const rows = makeTurns(40, 500);
    mockEnsureThread.mockResolvedValue(measured(20_000));
    mockFindHistory.mockResolvedValue({ status: "OK", response: rows });

    await loadThreadContext(makeUserPrompt());

    const call = mockRecordCompaction.mock.calls[0][0] as unknown as {
      coversThroughMessageId: string;
      droppedMessages: { id: string }[];
    };
    const dropped = call.droppedMessages;
    expect(dropped.length).toBeGreaterThan(0);
    expect(call.coversThroughMessageId).toBe(dropped[dropped.length - 1].id);
  });

  it("cuts at a turn boundary, so the oldest surviving row is a user row", async () => {
    process.env.HISTORY_TOKEN_BUDGET = "10000";
    process.env.HISTORY_PROTECTED_TURNS = "3";
    const rows = makeTurns(40, 500);
    mockEnsureThread.mockResolvedValue(measured(20_000));
    mockFindHistory.mockResolvedValue({ status: "OK", response: rows });

    const ctx = await loadThreadContext(makeUserPrompt());
    expect(ctx.history[0].role).toBe("user");
    expect(ctx.history.length).toBeLessThan(rows.length);
  });

  it("does not trim, or call the summariser, when the thread fits", async () => {
    process.env.HISTORY_TOKEN_BUDGET = "100000";
    mockEnsureThread.mockResolvedValue({ status: "OK", response: makeThread() });
    mockFindHistory.mockResolvedValue({ status: "OK", response: makeTurns(20, 100) });

    const ctx = await loadThreadContext(makeUserPrompt());

    expect(mockRecordCompaction).not.toHaveBeenCalled();
    expect(ctx.history).toHaveLength(41); // 40 rows + current turn
  });
});

describe("chat-page.unit.thread-context.007 — one compaction, not a loop", () => {
  // The live defect, as a test. A thread whose newest turn was a 15k paste
  // went over a 12k budget; the two newest turns were protected, so every
  // single turn dropped the newest SMALL turn, wrote a fresh summary, and came
  // out bigger: "Compacted 1 older turn into a summary (17k → 19k tokens)",
  // again and again, with a new summariser call each time.

  /** One 15k-token turn followed by several small ones, as the user had. */
  function pasteThread() {
    return [...makeTurns(1, 15_000), ...makeTurns(4, 100)];
  }

  it("compacts exactly ONCE across five consecutive loads", async () => {
    process.env.HISTORY_TOKEN_BUDGET = "12000";
    summaryEnabled = true;
    mockEnsureThread.mockResolvedValue(measured(15_400));

    const rows = pasteThread();
    mockFindHistory.mockResolvedValue({ status: "OK", response: rows });

    const first = await loadThreadContext(makeUserPrompt());
    expect(first.compaction).toBeDefined();
    expect(mockRecordCompaction).toHaveBeenCalledTimes(1);
    // The point of protecting nothing: the expensive turn is the one that goes.
    expect(first.compaction!.trimmedTurns).toBe(5);

    // Four more turns. A compaction deletes nothing from Cosmos, so the same
    // rows come back every time plus a new small turn; the watermark absorbs
    // them, and the measurement the compacting turn recorded is the small
    // prompt it produced.
    mockEnsureThread.mockResolvedValue(measured(2_000));
    let grown = rows;
    for (let i = 0; i < 4; i++) {
      grown = [...grown, ...makeTurns(1, 100)];
      mockFindHistory.mockResolvedValue({ status: "OK", response: grown });
      const ctx = await loadThreadContext(makeUserPrompt());
      expect(ctx.compaction).toBeUndefined();
    }

    // ONE summariser call across five loads, and one notice.
    expect(mockRecordCompaction).toHaveBeenCalledTimes(1);
  });

  it("does not compact again while the measured prompt stays under budget", async () => {
    // The replayed summary is really in the prompt, so the provider measures
    // it along with everything else. Nothing here has to model that — the
    // number already includes it.
    process.env.HISTORY_TOKEN_BUDGET = "12000";
    summaryEnabled = true;
    mockEnsureThread.mockResolvedValue(measured(15_400));

    let rows = pasteThread();
    mockFindHistory.mockResolvedValue({ status: "OK", response: rows });
    await loadThreadContext(makeUserPrompt());
    expect(mockRecordCompaction).toHaveBeenCalledTimes(1);

    // Ten small turns on top. The measurement climbs but stays under budget.
    let promptTokens = 2_000;
    for (let i = 0; i < 10; i++) {
      rows = [...rows, ...makeTurns(1, 100)];
      promptTokens += 200;
      mockEnsureThread.mockResolvedValue(measured(promptTokens));
      mockFindHistory.mockResolvedValue({ status: "OK", response: rows });
      const ctx = await loadThreadContext(makeUserPrompt());
      expect(ctx.compaction).toBeUndefined();
    }
    expect(mockRecordCompaction).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all, five times over, when the target is unreachable", async () => {
    // Turns protected by configuration, and they alone are over target. The
    // old code trimmed something anyway on every single turn. Now: no trim, no
    // summariser call, no notice — and no log spam pretending otherwise.
    process.env.HISTORY_TOKEN_BUDGET = "12000";
    process.env.HISTORY_PROTECTED_TURNS = "2";
    summaryEnabled = true;
    mockEnsureThread.mockResolvedValue(measured(15_400));

    // The same rows come back on every load — which is exactly what happened
    // live, because the user's new message is not in history yet and a trim
    // deletes nothing. The newest two turns hold the 15k paste, so no legal
    // cut can reach the target, on this load or any of the next four.
    const rows = [...makeTurns(1, 100), ...makeTurns(1, 15_000)];
    for (let i = 0; i < 5; i++) {
      mockFindHistory.mockResolvedValue({ status: "OK", response: rows });
      const ctx = await loadThreadContext(makeUserPrompt());
      expect(ctx.compaction).toBeUndefined();
    }

    expect(mockRecordCompaction).not.toHaveBeenCalled();
    // (Once enough small turns arrive that the paste is no longer among the
    // protected two, it becomes droppable and ONE compaction happens — the
    // first test in this suite covers that.)
  });

  it("never shows the summariser the message being answered", async () => {
    // The current user turn is written to Cosmos AFTER history is read, so it
    // cannot be in the dropped block — but that is an invariant of the read
    // order, and the read order is the kind of thing that gets refactored.
    process.env.HISTORY_TOKEN_BUDGET = "12000";
    summaryEnabled = true;
    mockEnsureThread.mockResolvedValue(measured(15_400));
    mockFindHistory.mockResolvedValue({
      status: "OK",
      response: pasteThread(),
    });

    await loadThreadContext(makeUserPrompt());

    const call = mockRecordCompaction.mock.calls[0][0] as unknown as {
      droppedMessages: { content?: string }[];
    };
    expect(call.droppedMessages.length).toBeGreaterThan(0);
    for (const message of call.droppedMessages) {
      expect(message.content ?? "").not.toContain("Hello world");
    }
  });
});

describe("chat-page.unit.thread-context.003 — a stored summary is replayed, not regenerated", () => {
  function storedSummary(overrides: Record<string, unknown> = {}) {
    return {
      id: "summary-thread-001",
      type: "CHAT_HISTORY_SUMMARY",
      threadId: "thread-001",
      userId: "user-hash",
      isDeleted: false,
      createdAt: new Date("2026-09-01"),
      role: "system",
      kind: "summary",
      content: "FACTS: answer in metric units.",
      coversThroughMessageId: "msg-watermark",
      coversMessageCount: 4,
      model: "luna-dep",
      estimatedTokens: 8,
      ...overrides,
    };
  }

  it("puts the summary first, prefixed, and reuses it with no new call", async () => {
    summaryRow = storedSummary();
    const rows = [
      makeHistoryRow("user", "old question", "msg-old"),
      makeHistoryRow("assistant", "old answer", "msg-watermark"),
      makeHistoryRow("user", "recent question"),
      makeHistoryRow("assistant", "recent answer"),
    ];
    mockEnsureThread.mockResolvedValue({ status: "OK", response: makeThread() });
    mockFindHistory.mockResolvedValue({ status: "OK", response: rows });

    const ctx = await loadThreadContext(makeUserPrompt());

    const first = ctx.modelHistory[0];
    const firstText = first.parts
      .map((p) => (p as { text?: string }).text ?? "")
      .join("");
    expect(firstText.startsWith(SUMMARY_REPLAY_PREFIX)).toBe(true);
    expect(firstText).toContain("FACTS: answer in metric units.");
    // A user message, so every provider seam handles it without change.
    expect(first.role).toBe("user");
    // Reused, not regenerated.
    expect(mockRecordCompaction).not.toHaveBeenCalled();

    // Scaffolding stays out of `history`, which callers still use to count
    // turns and as `originalMessages` for the browser.
    expect(
      ctx.history.some((m) =>
        m.parts.some((p) =>
          ((p as { text?: string }).text ?? "").includes(SUMMARY_REPLAY_PREFIX),
        ),
      ),
    ).toBe(false);

    // The watermarked rows are gone from the prompt but still in Cosmos.
    const allText = ctx.modelHistory
      .flatMap((m) => m.parts.map((p) => (p as { text?: string }).text ?? ""))
      .join(" ");
    expect(allText).not.toContain("old question");
    expect(allText).toContain("recent question");
  });

  it("replays nothing when the row is a watermark with no summary text", async () => {
    // The feature can be off while the watermark still holds; an empty summary
    // must not put a bare heading in front of the conversation.
    summaryRow = storedSummary({ content: "", model: "", estimatedTokens: 0 });
    const rows = [
      makeHistoryRow("user", "old question", "msg-old"),
      makeHistoryRow("assistant", "old answer", "msg-watermark"),
      makeHistoryRow("user", "recent question"),
    ];
    mockEnsureThread.mockResolvedValue({ status: "OK", response: makeThread() });
    mockFindHistory.mockResolvedValue({ status: "OK", response: rows });

    const ctx = await loadThreadContext(makeUserPrompt());
    const firstText = ctx.modelHistory[0].parts
      .map((p) => (p as { text?: string }).text ?? "")
      .join("");
    expect(firstText).not.toContain(SUMMARY_REPLAY_PREFIX);
    expect(firstText).toContain("recent question");
  });

  it("falls back to the full history when the watermark row is gone", async () => {
    summaryRow = storedSummary({
      coversThroughMessageId: "a-row-the-user-deleted",
    });
    mockEnsureThread.mockResolvedValue({ status: "OK", response: makeThread() });
    mockFindHistory.mockResolvedValue({
      status: "OK",
      response: [makeHistoryRow("user", "still here")],
    });

    const ctx = await loadThreadContext(makeUserPrompt());
    const allText = ctx.modelHistory
      .flatMap((m) => m.parts.map((p) => (p as { text?: string }).text ?? ""))
      .join(" ");
    expect(allText).toContain("still here");
  });
});

describe("chat-page.unit.thread-context.004 — the document hint is deterministic", () => {
  /** The hint rides in the prompt tail as a system message; read it back. */
  const hintTextOf = (ctx: {
    modelHistory: { role: string; parts: unknown[] }[];
  }) =>
    ctx.modelHistory
      .filter((m) => m.role === "system")
      .flatMap((m) => m.parts.map((p) => (p as { text?: string }).text ?? ""))
      .join("");

  it("lists document names in sorted order regardless of Cosmos order", async () => {
    const { FindAllChatDocuments } = await import("../../chat-document-service");
    mockEnsureThread.mockResolvedValue({ status: "OK", response: makeThread() });
    mockFindHistory.mockResolvedValue({ status: "OK", response: [] });

    const docs = [
      { id: "d1", name: "zeta.pdf" },
      { id: "d2", name: "alpha.pdf" },
      { id: "d3", name: "mid.pdf" },
    ];
    vi.mocked(FindAllChatDocuments).mockResolvedValue({
      status: "OK",
      response: docs,
    } as never);
    const forward = await loadThreadContext(makeUserPrompt());

    vi.mocked(FindAllChatDocuments).mockResolvedValue({
      status: "OK",
      response: [...docs].reverse(),
    } as never);
    const reversed = await loadThreadContext(makeUserPrompt());

    expect(hintTextOf(forward)).toContain("alpha.pdf, mid.pdf, zeta.pdf");
    // Byte-identical either way: the hint is a function of the document SET.
    expect(hintTextOf(reversed)).toBe(hintTextOf(forward));

    vi.mocked(FindAllChatDocuments).mockResolvedValue({
      status: "OK",
      response: [],
    } as never);
  });

  it("orders the document names by codepoint, not by locale", async () => {
    // Same reason as the toolset: a locale-aware sort is the pod's ICU build
    // talking, so "Report.pdf" vs "annex.pdf" could order one way on one
    // replica and the other way on the next. Codepoint puts capitals first.
    const { FindAllChatDocuments } = await import("../../chat-document-service");
    mockEnsureThread.mockResolvedValue({ status: "OK", response: makeThread() });
    mockFindHistory.mockResolvedValue({ status: "OK", response: [] });
    vi.mocked(FindAllChatDocuments).mockResolvedValue({
      status: "OK",
      response: [
        { id: "d1", name: "annex.pdf" },
        { id: "d2", name: "Report.pdf" },
        { id: "d3", name: "Zeta.pdf" },
      ],
    } as never);

    const ctx = await loadThreadContext(makeUserPrompt());

    expect(hintTextOf(ctx)).toContain("Report.pdf, Zeta.pdf, annex.pdf");

    vi.mocked(FindAllChatDocuments).mockResolvedValue({
      status: "OK",
      response: [],
    } as never);
  });

  it("keeps the hint out of the developer message for an Azure-served thread", async () => {
    const { FindAllChatDocuments } = await import("../../chat-document-service");
    mockEnsureThread.mockResolvedValue({ status: "OK", response: makeThread() });
    mockFindHistory.mockResolvedValue({ status: "OK", response: [] });
    vi.mocked(FindAllChatDocuments).mockResolvedValue({
      status: "OK",
      response: [{ id: "d1", name: "manual.pdf" }],
    } as never);

    const ctx = await loadThreadContext(makeUserPrompt());

    expect(ctx.documentHintPlacement).toBe("tail-message");
    expect(ctx.documentHint).toBeUndefined();
    expect(hintTextOf(ctx)).toContain("manual.pdf");

    vi.mocked(FindAllChatDocuments).mockResolvedValue({
      status: "OK",
      response: [],
    } as never);
  });
});

// ---------------------------------------------------------------------------

describe("chat-page.unit.thread-context.005 — the hint follows the model that runs the turn", () => {
  /**
   * loadThreadContext places the hint from `thread.selectedModel`, because the
   * effective model cannot be resolved until it has returned the thread. The
   * route corrects it afterwards. Without the correction a thread pinned to an
   * Azure model but answered by Claude — this turn's picker, or a cap/intent
   * downgrade — would send Claude a mid-conversation system message, which is
   * the one placement the Azure /anthropic surface may reject outright.
   */
  const hintItems = (ctx: { modelHistory: { id?: string }[] }) =>
    ctx.modelHistory.filter((m) => m.id === "dochint-thread-001");

  async function ctxWithDocument(threadModel: string) {
    const { FindAllChatDocuments } = await import("../../chat-document-service");
    const thread = { ...makeThread(), selectedModel: threadModel } as never;
    mockEnsureThread.mockResolvedValue({ status: "OK", response: thread });
    mockFindHistory.mockResolvedValue({
      status: "OK",
      response: [makeHistoryRow("user", "earlier"), makeHistoryRow("assistant", "reply")],
    });
    vi.mocked(FindAllChatDocuments).mockResolvedValue({
      status: "OK",
      response: [{ id: "d1", name: "manual.pdf" }],
    } as never);
    const ctx = await loadThreadContext(makeUserPrompt());
    vi.mocked(FindAllChatDocuments).mockResolvedValue({ status: "OK", response: [] } as never);
    return ctx;
  }

  it("pulls the hint out of the tail when the effective model is Claude", async () => {
    const ctx = await ctxWithDocument("gpt-5.4-mini");
    expect(ctx.documentHintPlacement).toBe("tail-message");
    expect(hintItems(ctx)).toHaveLength(1);

    const corrected = applyDocumentHintPlacement(ctx, "anthropic");

    expect(corrected.documentHintPlacement).toBe("developer-message");
    expect(hintItems(corrected)).toHaveLength(0);
    expect(corrected.documentHint).toContain("manual.pdf");
    // The conversation itself is untouched — only the scaffolding moved.
    expect(corrected.modelHistory).toHaveLength(ctx.modelHistory.length - 1);
    expect(corrected.history).toBe(ctx.history);
  });

  it("moves the hint into the tail when a Claude thread is answered by Azure", async () => {
    const ctx = await ctxWithDocument("claude-sonnet-5");
    expect(ctx.documentHintPlacement).toBe("developer-message");
    expect(hintItems(ctx)).toHaveLength(0);

    const corrected = applyDocumentHintPlacement(ctx, "azure");

    expect(corrected.documentHintPlacement).toBe("tail-message");
    expect(corrected.documentHint).toBeUndefined();
    const items = hintItems(corrected);
    expect(items).toHaveLength(1);
    // Immediately before the current user turn, and nowhere else.
    expect(corrected.modelHistory[corrected.modelHistory.length - 2]).toBe(items[0]);
    expect(corrected.modelHistory[corrected.modelHistory.length - 1].role).toBe("user");
  });

  it("is a no-op when the placement already matches, and is idempotent", async () => {
    const ctx = await ctxWithDocument("gpt-5.4-mini");
    expect(applyDocumentHintPlacement(ctx, "azure")).toBe(ctx);

    const once = applyDocumentHintPlacement(ctx, "anthropic");
    const twice = applyDocumentHintPlacement(once, "anthropic");
    expect(twice).toBe(once);
    // And back again lands on exactly one hint item, not two.
    const back = applyDocumentHintPlacement(once, "azure");
    expect(hintItems(back)).toHaveLength(1);
    expect(back.modelHistory).toEqual(ctx.modelHistory);
  });

  it("does nothing at all for a thread with no documents", async () => {
    mockEnsureThread.mockResolvedValue({ status: "OK", response: makeThread() });
    mockFindHistory.mockResolvedValue({ status: "OK", response: [] });
    const ctx = await loadThreadContext(makeUserPrompt());

    expect(ctx.documentHintPlacement).toBe("none");
    expect(applyDocumentHintPlacement(ctx, "anthropic")).toBe(ctx);
    expect(applyDocumentHintPlacement(ctx, "azure")).toBe(ctx);
  });
});
