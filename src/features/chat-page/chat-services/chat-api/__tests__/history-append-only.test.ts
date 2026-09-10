import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * history.append-only.*
 *
 * One rule, stated by the product owner and pinned here: NOTHING MAY EVER
 * REWRITE HISTORY OTHER THAN COMPACTION.
 *
 * Concretely: the list of model messages for turn n must be an exact,
 * item-by-item prefix of the list for turn n+1 — the developer message
 * included. Every byte that survives unchanged from one turn to the next is a
 * byte the prompt cache can replay at a tenth of the price; every byte that
 * moves re-bills everything after it at 1.25x. The `TOP 30` row cap broke this
 * on every turn past row 30, and the document hint broke it, from the very
 * first item, the moment a user attached a file.
 *
 * The one sanctioned exception is compaction: when a thread outgrows its token
 * budget a block of the oldest turns is replaced by a summary. Then the
 * assertion weakens to exactly that — the summary is the only new item at the
 * front, and everything after it still matches the corresponding tail of the
 * previous turn.
 *
 * These tests assert on MODEL messages (post-`convertToModelMessages`) rather
 * than on UIMessages, because a UIMessage carries an id and metadata that
 * legitimately differ between a freshly-built turn and the same turn read back
 * from Cosmos. What reaches the provider — and therefore the cache — is the
 * model message.
 */

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
  getCurrentUser: vi.fn(async () => ({
    name: "Test User",
    email: "test@example.com",
    isAdmin: false,
  })),
}));

// ── Thread service ────────────────────────────────────────────────────────────
const mockEnsureThread = vi.fn();
vi.mock("../../chat-thread-service", () => ({
  EnsureChatThreadOperation: (...a: any[]) => mockEnsureThread(...a),
  UpdateChatThreadUsage: vi.fn(async () => ({ status: "OK" })),
}));

// ── Message service ───────────────────────────────────────────────────────────
const mockFindHistory = vi.fn();
vi.mock("../../chat-message-service", () => ({
  FindAllChatMessagesForCurrentUser: (...a: any[]) => mockFindHistory(...a),
  CreateChatMessage: vi.fn(async () => ({ status: "OK" })),
}));

// ── Document service ──────────────────────────────────────────────────────────
const mockFindDocuments = vi.fn(async () => ({ status: "OK", response: [] as any[] }));
vi.mock("../../chat-document-service", () => ({
  FindAllChatDocuments: (...a: any[]) => mockFindDocuments(...(a as [])),
}));

// ── Image persistence (history file refs pass straight through) ──────────────
vi.mock("../../chat-image-persistence-service", () => ({
  getBase64ImageReference: vi.fn(async (ref: string) => ref),
}));

// ── History compaction: an in-memory stand-in for Cosmos + the summariser ────
let summaryRow: any = null;
let summaryEnabled = true;
const mockRecordCompaction = vi.fn(async (input: any) => {
  summaryRow = {
    id: `summary-${input.threadId}`,
    type: "CHAT_HISTORY_SUMMARY",
    threadId: input.threadId,
    userId: "user-hash",
    isDeleted: false,
    createdAt: new Date("2026-09-07"),
    role: "system",
    kind: "summary",
    content: summaryEnabled ? "FACTS: the earlier turns covered setup." : "",
    coversThroughMessageId: input.coversThroughMessageId,
    coversMessageCount:
      (input.previous?.coversMessageCount ?? 0) + input.droppedMessages.length,
    model: summaryEnabled ? "luna-dep" : "",
    estimatedTokens: summaryEnabled ? 12 : 0,
  };
  return summaryRow;
});
vi.mock("../history-summary-service", () => ({
  FindChatHistorySummary: vi.fn(async () => summaryRow),
  recordHistoryCompaction: (...a: any[]) => mockRecordCompaction(...(a as [any])),
  isHistorySummaryEnabled: () => summaryEnabled,
}));

import { convertToModelMessages, type ModelMessage } from "ai";
import { loadThreadContext } from "../thread-context";
import { buildSystemMessage } from "../prompt-builder";
import { SUMMARY_REPLAY_PREFIX } from "../history-summary";
import { CHARS_PER_TOKEN } from "../history-budget";
import { MESSAGE_ATTRIBUTE } from "../../models";
import type { ChatThreadModel, UserPrompt } from "../../models";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Mirrors the process-constant blocks route.ts assembles around the persona. */
const STATIC_PROMPT = "You are a friendly test assistant.";
const PERSONA = "Be terse. Cite sources.";
const UI_BLOCK = "\n\n## Interactive UI (generative UI)\nrules go here";

function makeThread(overrides: Partial<ChatThreadModel> = {}): ChatThreadModel {
  return {
    id: "thread-001",
    createdAt: new Date("2026-01-01"),
    isDeleted: false,
    userId: "user-hash",
    name: "Test thread",
    type: "CHAT_THREAD",
    bookmarked: false,
    selectedModel: "gpt-5.6-sol",
    extension: [],
    personaDocumentIds: [],
    attachedFiles: [],
    personaMessage: PERSONA,
    ...overrides,
  } as unknown as ChatThreadModel;
}

let rowSeq = 0;
let clock = Date.parse("2026-09-07T10:00:00.000Z");
function makeRow(
  role: "user" | "assistant" | "tool",
  content: string,
  extra: Record<string, unknown> = {},
) {
  rowSeq += 1;
  clock += 1_000;
  return {
    id: `msg-${rowSeq}`,
    createdAt: new Date(clock),
    isDeleted: false,
    threadId: "thread-001",
    userId: "user-hash",
    name: role === "tool" ? "search_documents" : "",
    content,
    role,
    type: MESSAGE_ATTRIBUTE,
    ...extra,
  };
}

/** One persisted turn: the user's question and the assistant's reply. */
function persistedTurn(question: string, answer: string) {
  return [makeRow("user", question), makeRow("assistant", answer)];
}

/** One persisted turn that used a tool: question, reply, then the tool row. */
function persistedToolTurn(question: string, answer: string) {
  return [
    makeRow("user", question),
    makeRow("assistant", answer),
    makeRow(
      "tool",
      JSON.stringify({
        name: "search_documents",
        arguments: JSON.stringify({ query: question }),
        result: JSON.stringify({ hits: 2 }),
        call_id: `call-${rowSeq}`,
      }),
    ),
  ];
}

/**
 * A thread whose previous request measured `tokens`. That measurement is the
 * ONE input to the compaction decision — nothing is estimated from the rows.
 */
function measuredThread(tokens: number): ChatThreadModel {
  return makeThread({
    usage: {
      totalInputTokens: tokens,
      totalOutputTokens: 0,
      totalCachedTokens: 0,
      totalCostUsd: 0,
      lastUpdated: "2026-01-01T00:00:00.000Z",
      lastInputTokens: tokens,
      lastPromptTokens: tokens,
    },
  } as unknown as Partial<ChatThreadModel>);
}

/** A turn sized to roughly `tokens` characters-worth of text. */
function bigTurn(tokens: number) {
  const chars = Math.floor((tokens * CHARS_PER_TOKEN) / 2);
  return [makeRow("user", "u".repeat(chars)), makeRow("assistant", "a".repeat(chars))];
}

function prompt(message: string): UserPrompt {
  return {
    id: "thread-001",
    message,
    multimodalImage: undefined,
    multimodalImages: [],
  } as unknown as UserPrompt;
}

/**
 * The complete model input for one turn: the developer message route.ts
 * assembles, followed by everything `convertToModelMessages` makes of
 * `ctx.modelHistory`. This is the list the provider — and the prompt cache —
 * actually sees.
 */
async function buildModelInput(
  rows: unknown[],
  message: string,
  thread: ChatThreadModel = makeThread(),
): Promise<ModelMessage[]> {
  mockEnsureThread.mockResolvedValue({ status: "OK", response: thread });
  mockFindHistory.mockResolvedValue({ status: "OK", response: rows });

  const ctx = await loadThreadContext(prompt(message));

  const developer: ModelMessage = {
    role: "system",
    content: buildSystemMessage({
      staticSystemPrompt: STATIC_PROMPT,
      personaMessage: thread.personaMessage ?? "",
      documentHint: ctx.documentHint,
      trailingStaticBlock: UI_BLOCK,
    }),
  };

  return [developer, ...(await convertToModelMessages(ctx.modelHistory))];
}

/** Assert `a` is an exact item-by-item prefix of `b`. */
function expectExactPrefix(a: ModelMessage[], b: ModelMessage[]) {
  expect(b.length).toBeGreaterThan(a.length);
  a.forEach((item, index) => {
    // Deep-equal per item, so a diff points at the item that moved.
    expect(b[index], `model message #${index} changed between turns`).toEqual(item);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  summaryRow = null;
  summaryEnabled = true;
  rowSeq = 0;
  clock = Date.parse("2026-09-07T10:00:00.000Z");
  delete process.env.HISTORY_TOKEN_BUDGET;
  delete process.env.HISTORY_PROTECTED_TURNS;
  mockFindDocuments.mockResolvedValue({ status: "OK", response: [] });
});

// ---------------------------------------------------------------------------

describe("history.append-only.001 — plain turns only ever append", () => {
  it("turn n is an exact prefix of turn n+1", async () => {
    const rows = [
      ...persistedTurn("what is the throughput?", "About 40 t/h."),
      ...persistedTurn("and the power draw?", "Roughly 18 kW."),
    ];

    const turnN = await buildModelInput(rows, "what about noise?");
    // The turn that just ran is now persisted, and a new question arrives.
    const turnNPlus1 = await buildModelInput(
      [...rows, ...persistedTurn("what about noise?", "Around 78 dB.")],
      "anything else to check?",
    );

    expectExactPrefix(turnN, turnNPlus1);
  });

  it("holds across five consecutive turns", async () => {
    let rows = [...persistedTurn("first", "first answer")];
    let previous = await buildModelInput(rows, "question 1");

    for (let i = 1; i <= 5; i++) {
      rows = [...rows, ...persistedTurn(`question ${i}`, `answer ${i}`)];
      const next = await buildModelInput(rows, `question ${i + 1}`);
      expectExactPrefix(previous, next);
      previous = next;
    }
  });

  it("keeps the developer message byte-identical", async () => {
    const rows = persistedTurn("q", "a");
    const turnN = await buildModelInput(rows, "next");
    const turnNPlus1 = await buildModelInput(
      [...rows, ...persistedTurn("next", "reply")],
      "after that",
    );
    expect(turnNPlus1[0]).toEqual(turnN[0]);
  });

  it("does not trip on the 30-row boundary that used to slide", async () => {
    // 20 turns = 40 rows, well past the old TOP 30 cap. Under that cap the
    // oldest row left the window on every turn and this assertion failed.
    const rows: unknown[] = [];
    for (let i = 0; i < 20; i++) rows.push(...persistedTurn(`q${i}`, `a${i}`));

    const turnN = await buildModelInput(rows, "question 21");
    const turnNPlus1 = await buildModelInput(
      [...rows, ...persistedTurn("question 21", "answer 21")],
      "question 22",
    );

    expect(turnN.length).toBeGreaterThan(31);
    expectExactPrefix(turnN, turnNPlus1);
  });
});

describe("history.append-only.002 — a tool-using turn only appends", () => {
  it("turn n is an exact prefix of turn n+1 when the new turn called a tool", async () => {
    const rows = [...persistedTurn("hello", "hi")];

    const turnN = await buildModelInput(rows, "search the manual for the seal spec");
    const turnNPlus1 = await buildModelInput(
      [
        ...rows,
        ...persistedToolTurn(
          "search the manual for the seal spec",
          "The manual lists two seals.",
        ),
      ],
      "which of the two is cheaper?",
    );

    expectExactPrefix(turnN, turnNPlus1);
  });

  it("holds when the history ALREADY contains tool rows", async () => {
    const rows = [
      ...persistedToolTurn("look up the seal spec", "Two seals."),
      ...persistedTurn("thanks", "Any time."),
    ];

    const turnN = await buildModelInput(rows, "check the bearings too");
    const turnNPlus1 = await buildModelInput(
      [...rows, ...persistedToolTurn("check the bearings too", "Bearings are fine.")],
      "and the couplings?",
    );

    expectExactPrefix(turnN, turnNPlus1);
  });

  it("keeps a tool result attached to the assistant message that called it", async () => {
    const rows = persistedToolTurn("look it up", "Found it.");
    const input = await buildModelInput(rows, "next question");
    // user, assistant(+tool call), tool result — the tool payload must not
    // drift into a message of its own or attach to the wrong turn.
    const roles = input.map((m) => m.role);
    expect(roles[0]).toBe("system"); // developer message
    expect(roles[1]).toBe("user");
    expect(roles).toContain("tool");
    expect(roles.indexOf("tool")).toBeGreaterThan(roles.indexOf("assistant"));
  });
});

describe("history.append-only.003 — an attached document does not move earlier items", () => {
  const documents = [
    { id: "d1", name: "manual.pdf" },
    { id: "d2", name: "datasheet.pdf" },
  ];

  it("puts the hint in the tail, leaving the developer message static", async () => {
    mockFindDocuments.mockResolvedValue({ status: "OK", response: documents });
    const rows = persistedTurn("q", "a");

    mockEnsureThread.mockResolvedValue({ status: "OK", response: makeThread() });
    mockFindHistory.mockResolvedValue({ status: "OK", response: rows });
    const ctx = await loadThreadContext(prompt("what does the manual say?"));

    // The volatile segment lives in the conversation tail, NOT in the
    // developer message, so attaching a file cannot rewrite item #0.
    expect(ctx.documentHintPlacement).toBe("tail-message");
    expect(ctx.documentHint).toBeUndefined();

    const hintIndex = ctx.modelHistory.findIndex((m) => m.role === "system");
    expect(hintIndex).toBeGreaterThan(-1);
    // Immediately before the current user turn, which is last.
    expect(hintIndex).toBe(ctx.modelHistory.length - 2);
  });

  it("leaves the developer message identical with and without documents", async () => {
    const rows = persistedTurn("q", "a");

    mockFindDocuments.mockResolvedValue({ status: "OK", response: [] });
    const withoutDocs = await buildModelInput(rows, "question");

    mockFindDocuments.mockResolvedValue({ status: "OK", response: documents });
    const withDocs = await buildModelInput(rows, "question");

    // This is the regression: the hint used to sit inside the developer
    // message, so attaching one file rewrote the first item of every prompt.
    expect(withDocs[0]).toEqual(withoutDocs[0]);
  });

  it("keeps every item before the hint unchanged from turn n to turn n+1", async () => {
    mockFindDocuments.mockResolvedValue({ status: "OK", response: documents });
    const rows = [
      ...persistedTurn("what is in the manual?", "Specifications."),
      ...persistedTurn("and the datasheet?", "Dimensions."),
    ];

    const turnN = await buildModelInput(rows, "compare them");
    const turnNPlus1 = await buildModelInput(
      [...rows, ...persistedTurn("compare them", "They differ in tolerance.")],
      "which should I use?",
    );

    // The hint sits just before the current user turn in both lists, so a
    // strict whole-list prefix is not the claim; the claim is that nothing
    // BEFORE the hint moved.
    const hintIndexN = turnN.length - 2;
    expectExactPrefix(turnN.slice(0, hintIndexN), turnNPlus1);
    // And the hint itself is byte-identical while the document set is.
    expect(turnNPlus1[turnNPlus1.length - 2]).toEqual(turnN[hintIndexN]);
  });

  it("falls back to the developer message for a provider without mid-prompt system support", async () => {
    // @ai-sdk/anthropic renders a mid-conversation system message by asking
    // for a beta whose availability on the Azure /anthropic surface cannot be
    // verified without a live call — and a wrong guess is a 400, not a
    // degradation. Claude threads therefore keep the old placement.
    mockFindDocuments.mockResolvedValue({ status: "OK", response: documents });
    mockEnsureThread.mockResolvedValue({
      status: "OK",
      response: makeThread({ selectedModel: "claude-sonnet-5" } as any),
    });
    mockFindHistory.mockResolvedValue({ status: "OK", response: persistedTurn("q", "a") });

    const ctx = await loadThreadContext(prompt("question"));

    expect(ctx.documentHintPlacement).toBe("developer-message");
    expect(ctx.documentHint).toContain("manual.pdf");
    expect(ctx.modelHistory.some((m) => m.role === "system")).toBe(false);
  });

  it("adds no hint item at all when the thread has no documents", async () => {
    mockFindDocuments.mockResolvedValue({ status: "OK", response: [] });
    mockEnsureThread.mockResolvedValue({ status: "OK", response: makeThread() });
    mockFindHistory.mockResolvedValue({ status: "OK", response: persistedTurn("q", "a") });

    const ctx = await loadThreadContext(prompt("question"));
    expect(ctx.documentHintPlacement).toBe("none");
    expect(ctx.documentHint).toBeUndefined();
    expect(ctx.modelHistory.some((m) => m.role === "system")).toBe(false);
  });
});

describe("history.append-only.004 — compaction is the only sanctioned rewrite", () => {
  it("adds the summary at the front and leaves the tail matching", async () => {
    // Turn n fits the budget. Turn n+1 does not, so a block of the oldest
    // turns is replaced by one summary item.
    const rows: unknown[] = [];
    for (let i = 0; i < 20; i++) rows.push(...bigTurn(500));

    // A tail is protected so a compaction still leaves history behind to
    // compare against; with the default 0 the whole history would go.
    process.env.HISTORY_PROTECTED_TURNS = "5";
    process.env.HISTORY_TOKEN_BUDGET = "20000";
    const turnN = await buildModelInput(rows, "question n", measuredThread(10_000));
    expect(mockRecordCompaction).not.toHaveBeenCalled();
    const summaryInN = turnN.filter(
      (m) => typeof m.content === "string" && m.content.includes(SUMMARY_REPLAY_PREFIX),
    );
    expect(summaryInN).toHaveLength(0);

    // Same thread, tighter budget: the next turn must compact.
    process.env.HISTORY_TOKEN_BUDGET = "6000";
    const turnNPlus1 = await buildModelInput(
      [...rows, ...persistedTurn("question n", "answer n")],
      "question n+1",
      measuredThread(10_000),
    );
    expect(mockRecordCompaction).toHaveBeenCalledTimes(1);

    // 1. The developer message is untouched by compaction.
    expect(turnNPlus1[0]).toEqual(turnN[0]);

    // 2. The summary is the ONLY new item at the front.
    const summary = turnNPlus1[1];
    const summaryText = summary.content as unknown;
    const summaryString =
      typeof summaryText === "string"
        ? summaryText
        : JSON.stringify(summaryText);
    expect(summaryString).toContain(SUMMARY_REPLAY_PREFIX);

    // 3. Everything after the summary matches the corresponding tail of turn
    //    n. Turn n+1 carries two items turn n could not (the assistant reply
    //    to question n, and question n+1), so those come off the end first.
    const afterSummary = turnNPlus1.slice(2, turnNPlus1.length - 2);
    const tailOfN = turnN.slice(turnN.length - afterSummary.length);
    expect(afterSummary.length).toBeGreaterThan(0);
    afterSummary.forEach((item, index) => {
      expect(
        tailOfN[index],
        `item ${index} after the summary does not match turn n's tail`,
      ).toEqual(item);
    });
  });

  it("cuts at a turn boundary, so the item after the summary is a user message", async () => {
    const rows: unknown[] = [];
    for (let i = 0; i < 20; i++) rows.push(...bigTurn(500));
    process.env.HISTORY_TOKEN_BUDGET = "6000";
    process.env.HISTORY_PROTECTED_TURNS = "5";

    const input = await buildModelInput(rows, "question", measuredThread(10_000));
    expect(input[0].role).toBe("system"); // developer
    expect(input[1].role).toBe("user"); // the replayed summary
    expect(input[2].role).toBe("user"); // the oldest surviving turn
  });

  it("stops rewriting once the trim has happened — the prefix then holds", async () => {
    const rows: unknown[] = [];
    for (let i = 0; i < 20; i++) rows.push(...bigTurn(500));
    process.env.HISTORY_TOKEN_BUDGET = "6000";
    process.env.HISTORY_PROTECTED_TURNS = "5";

    // The compacting turn.
    let allRows = rows;
    const compacted = await buildModelInput(
      allRows,
      "question 0",
      measuredThread(10_000),
    );
    expect(mockRecordCompaction).toHaveBeenCalledTimes(1);

    // The turns after it must be pure appends again. The compaction shrank the
    // prompt, so the measurement the next turn reads is under budget — which
    // is exactly what the provider reported, not something computed here.
    let previous = compacted;
    for (let i = 0; i < 3; i++) {
      allRows = [...allRows, ...persistedTurn(`question ${i}`, `answer ${i}`)];
      const next = await buildModelInput(
        allRows,
        `question ${i + 1}`,
        measuredThread(3_000),
      );
      expectExactPrefix(previous, next);
      previous = next;
    }
    // Still exactly one compaction across all four turns.
    expect(mockRecordCompaction).toHaveBeenCalledTimes(1);
  });

  it("replays no summary item when compaction ran with summarisation off", async () => {
    summaryEnabled = false;
    const rows: unknown[] = [];
    for (let i = 0; i < 20; i++) rows.push(...bigTurn(500));
    process.env.HISTORY_TOKEN_BUDGET = "6000";
    process.env.HISTORY_PROTECTED_TURNS = "5";

    const input = await buildModelInput(rows, "question", measuredThread(10_000));

    expect(mockRecordCompaction).toHaveBeenCalledTimes(1);
    const hasSummary = input.some(
      (m) => typeof m.content === "string" && m.content.includes(SUMMARY_REPLAY_PREFIX),
    );
    expect(hasSummary).toBe(false);
    // The watermark still holds, so the trim still stuck.
    expect(input[1].role).toBe("user");
  });
});

describe("history.append-only.005 — a same-millisecond write order cannot reshuffle the prompt", () => {
  it("produces the same model input however Cosmos returns tied rows", async () => {
    // Parallel tool calls persist in the same millisecond, and Cosmos leaves
    // their order undefined. The loader breaks the tie; here we prove the
    // resulting prompt is identical either way.
    const at = new Date("2026-09-07T11:00:00.000Z");
    const base = {
      isDeleted: false,
      threadId: "thread-001",
      userId: "user-hash",
      name: "",
      type: MESSAGE_ATTRIBUTE,
    };
    const rows = [
      { ...base, id: "r1", createdAt: at, role: "user", content: "run both checks" },
      { ...base, id: "r2", createdAt: at, role: "assistant", content: "Running." },
      {
        ...base,
        id: "r3",
        createdAt: at,
        role: "tool",
        name: "check_a",
        sequence: 1,
        content: JSON.stringify({ name: "check_a", arguments: "{}", result: "ok" }),
      },
      {
        ...base,
        id: "r4",
        createdAt: at,
        role: "tool",
        name: "check_b",
        sequence: 2,
        content: JSON.stringify({ name: "check_b", arguments: "{}", result: "ok" }),
      },
    ];

    // The loader is mocked here, so apply the same ordering the real loader
    // applies before handing rows over.
    const { sortHistoryRowsDeterministically } = await import(
      "../../chat-history-order"
    );

    const forward = await buildModelInput(
      sortHistoryRowsDeterministically(rows as never),
      "next question",
    );
    const shuffled = await buildModelInput(
      sortHistoryRowsDeterministically([rows[3], rows[1], rows[0], rows[2]] as never),
      "next question",
    );

    expect(shuffled).toEqual(forward);
  });
});

// ---------------------------------------------------------------------------

describe("history.append-only.006 — a persisted step layout replays through the loader", () => {
  /**
   * The seam between the two halves of this change set.
   *
   * The cache half writes two extra fields on the rows of a tool turn:
   * `stepLayout` (the step boundaries the live turn had) and `sequence` (the
   * write order within the turn). The history half is what reads them back —
   * it orders the thread on (createdAt, sequence, id) and hands the rows to
   * the adapter that re-inserts the step boundaries.
   *
   * If either field were dropped, renamed or reordered on the way through, the
   * replayed turn would serialise to a DIFFERENT list of model messages than
   * the live turn produced, and the provider's cached prefix would not match —
   * which is the whole failure both halves exist to remove. So: the layout
   * must survive the loader, and the result must still be append-only.
   */

  /** One tool turn, persisted exactly as persist-assistant.ts writes it. */
  function persistedToolTurnWithLayout(
    question: string,
    answer: string,
    callId: string,
  ) {
    return [
      // The user row is written by loadThreadContext and carries no sequence.
      makeRow("user", question),
      makeRow("assistant", answer, {
        sequence: 1,
        stepLayout: ["step-start", `tool:${callId}`, "step-start", `text:${answer.length}`],
      }),
      makeRow(
        "tool",
        JSON.stringify({
          name: "search_documents",
          arguments: JSON.stringify({ query: question }),
          result: JSON.stringify({ hits: 2 }),
          call_id: callId,
        }),
        { sequence: 2 },
      ),
    ];
  }

  it("splits the replayed turn on the persisted step boundaries", async () => {
    const rows = persistedToolTurnWithLayout("find it", "Found it.", "call-1");
    const input = await buildModelInput(rows, "and now this");

    // Live shape: assistant(tool-call) → tool(result) → assistant(text).
    // Without the layout the adapter emits ONE assistant message carrying both
    // the tool call and the text, which is a different prefix.
    const roles = input.map((m) => m.role);
    expect(roles).toEqual([
      "system", // developer message
      "user", // find it
      "assistant", // the tool call
      "tool", // its result
      "assistant", // Found it.
      "user", // and now this
    ]);

    const textAssistant = input[4];
    expect(JSON.stringify(textAssistant.content)).toContain("Found it.");
  });

  it("keeps the layout intact through the deterministic order", async () => {
    const { sortHistoryRowsDeterministically } = await import(
      "../../chat-history-order"
    );
    const rows = persistedToolTurnWithLayout("find it", "Found it.", "call-1");

    const forward = await buildModelInput(
      sortHistoryRowsDeterministically(rows as never),
      "and now this",
    );
    // Same rows, handed over in the order a same-millisecond Cosmos read could
    // produce. `sequence` is the only thing that can put them back.
    const tied = rows.map((r) => ({ ...r, createdAt: new Date("2026-09-07T11:00:00.000Z") }));
    const shuffled = await buildModelInput(
      sortHistoryRowsDeterministically([tied[2], tied[1], tied[0]] as never),
      "and now this",
    );

    expect(shuffled).toEqual(forward);
  });

  it("turn n is an exact prefix of turn n+1 across tool turns with layouts", async () => {
    let rows = persistedToolTurnWithLayout("find it", "Found it.", "call-1");
    let previous = await buildModelInput(rows, "question 1");

    for (let i = 1; i <= 3; i++) {
      rows = [
        ...rows,
        ...persistedToolTurnWithLayout(`question ${i}`, `answer ${i}`, `call-${i + 1}`),
      ];
      const next = await buildModelInput(rows, `question ${i + 1}`);
      expectExactPrefix(previous, next);
      previous = next;
    }
  });

  it("still replays rows written before the layout existed", async () => {
    // Backward compatibility: no stepLayout, no sequence — the flat shape the
    // adapter has always produced, and it must stay append-only too.
    const oldRows = persistedToolTurn("legacy question", "legacy answer");
    const turnN = await buildModelInput(oldRows, "question n");
    const turnNPlus1 = await buildModelInput(
      [...oldRows, ...persistedTurn("question n", "answer n")],
      "question n+1",
    );
    expectExactPrefix(turnN, turnNPlus1);
  });

  it("mixes layout-carrying and layout-less turns without moving the older ones", async () => {
    const legacy = persistedToolTurn("legacy question", "legacy answer");
    const modern = persistedToolTurnWithLayout("modern question", "modern answer", "call-9");

    const turnN = await buildModelInput(legacy, "question n");
    const turnNPlus1 = await buildModelInput(
      [...legacy, ...persistedTurn("question n", "answer n"), ...modern],
      "question n+1",
    );
    expectExactPrefix(turnN, turnNPlus1);
  });
});

// ---------------------------------------------------------------------------

describe("history.append-only.007 — the compaction row never enters the history", () => {
  it("uses a type no message query selects", async () => {
    const { HISTORY_SUMMARY_ATTRIBUTE } = await import("../history-summary");
    // The loader filters on r.type = MESSAGE_ATTRIBUTE, so a distinct type is
    // what keeps the summary row out of the transcript AND out of the step
    // layout replay. If these two ever became equal, the row would be loaded
    // as a message.
    expect(HISTORY_SUMMARY_ATTRIBUTE).not.toBe(MESSAGE_ATTRIBUTE);
  });

  it("replays the summary as a plain item with no step layout to apply", async () => {
    const rows: unknown[] = [];
    for (let i = 0; i < 20; i++) rows.push(...bigTurn(500));
    process.env.HISTORY_TOKEN_BUDGET = "6000";

    mockEnsureThread.mockResolvedValue({
      status: "OK",
      response: measuredThread(10_000),
    });
    mockFindHistory.mockResolvedValue({ status: "OK", response: rows });
    const ctx = await loadThreadContext(prompt("question"));

    const replayed = ctx.modelHistory[0];
    expect(replayed.role).toBe("user");
    // No metadata at all — so uiMessagesFromChatMessages' step-layout pass has
    // nothing to act on even if the item were routed through it.
    expect((replayed as { metadata?: unknown }).metadata).toBeUndefined();
    expect(replayed.parts).toHaveLength(1);
    expect(replayed.parts[0].type).toBe("text");

    // And it is prompt scaffolding only: the browser-facing history must not
    // contain it, or the user would see a summary bubble appear in the thread.
    expect(ctx.history).not.toContain(replayed);
    expect(
      ctx.history.some((m) =>
        m.parts.some(
          (p) => p.type === "text" && p.text.includes(SUMMARY_REPLAY_PREFIX),
        ),
      ),
    ).toBe(false);
  });
});
