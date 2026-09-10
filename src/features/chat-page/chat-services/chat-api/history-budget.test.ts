import { describe, it, expect } from "vitest";
import {
  CHARS_PER_TOKEN,
  CONTEXT_WINDOW_GUARD_RATIO,
  DEFAULT_HISTORY_TOKEN_BUDGET,
  HISTORY_LONG_CONTEXT_RESERVE,
  MIN_KEPT_TURNS,
  applyHistoryWatermark,
  estimateTextTokens,
  planHistoryTrim,
  resolveHistoryBudget,
  resolveHistoryProtectedTurns,
  resolveHistoryLongContextReserve,
  resolveHistoryTokenBudget,
  splitIntoTurns,
  type BudgetMessage,
} from "./history-budget";

// These tests pin the properties that make the measured budget an improvement
// on the `TOP 30` row cap it replaced:
//
//   - ONE input decides: the provider's measured size of the previous
//     request's last prompt. Nothing is estimated;
//   - over budget compacts the history and the thread starts again, so the
//     prompt prefix is byte-stable for the many turns it takes to grow back;
//   - a cut lands on a turn boundary, so history is never cut mid-turn.
//
// Everything here is a pure function; there is no Cosmos, no model, no clock.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;
function row(
  role: BudgetMessage["role"],
  chars: number,
  extra: Partial<BudgetMessage> = {},
): BudgetMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    role,
    content: "x".repeat(chars),
    ...extra,
  };
}

/**
 * A user + assistant pair. `tokens` only shapes how much text the rows carry;
 * nothing in the decision reads it any more — the plan is driven purely by the
 * measured prompt size the caller passes in.
 */
function turn(tokens: number): BudgetMessage[] {
  const chars = Math.floor((tokens * CHARS_PER_TOKEN) / 2);
  return [row("user", chars), row("assistant", chars)];
}

/** `count` turns of `tokens` each, oldest first. */
function turns(count: number, tokens: number): BudgetMessage[] {
  const out: BudgetMessage[] = [];
  for (let i = 0; i < count; i++) out.push(...turn(tokens));
  return out;
}

// ---------------------------------------------------------------------------

describe("chat-page.unit.history-budget.001 — estimateTextTokens is deterministic", () => {
  // The one estimator left in the module, and it decides NOTHING: the summary
  // writer stamps an informational size on the row it persists. The trim path
  // runs on the provider's measured prompt size only.
  it("returns the same number for the same input, every call", () => {
    const text = "x".repeat(4001);
    const first = estimateTextTokens(text);
    expect(Array.from({ length: 25 }, () => estimateTextTokens(text))).toEqual(
      Array.from({ length: 25 }, () => first),
    );
  });

  it("uses chars/4 rounded up, so a non-empty string is never free", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens(undefined)).toBe(0);
    expect(estimateTextTokens("a")).toBe(1);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("abcde")).toBe(2);
    expect(estimateTextTokens("x".repeat(4000))).toBe(1000);
    expect(CHARS_PER_TOKEN).toBe(4);
  });
});

describe("chat-page.unit.history-budget.002 — splitIntoTurns cuts on user rows", () => {
  it("groups a user row with the tool and assistant rows that follow it", () => {
    const rows = [
      row("user", 40),
      row("assistant", 40),
      row("tool", 40),
      row("assistant", 40),
      row("user", 40),
      row("assistant", 40),
    ];
    const result = splitIntoTurns(rows);
    expect(result).toHaveLength(2);
    expect(result[0].messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(result[1].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(result[0].startIndex).toBe(0);
    expect(result[0].endIndex).toBe(3);
    expect(result[1].startIndex).toBe(4);
  });

  it("puts rows that precede the first user row into a trimmable preamble", () => {
    const rows = [row("system", 40), row("user", 40), row("assistant", 40)];
    const result = splitIntoTurns(rows);
    expect(result).toHaveLength(2);
    expect(result[0].isPreamble).toBe(true);
    expect(result[1].isPreamble).toBe(false);
  });

  it("returns no turns for no rows", () => {
    expect(splitIntoTurns([])).toEqual([]);
  });

  it("carries the index span of each turn, and nothing else", () => {
    // No token figure on a turn any more: sizing a turn needs a tokenizer we
    // do not have, and the decision no longer asks the question.
    const rows = [...turn(500), ...turn(500)];
    const [first, second] = splitIntoTurns(rows);
    expect([first.startIndex, first.endIndex]).toEqual([0, 1]);
    expect([second.startIndex, second.endIndex]).toEqual([2, 3]);
  });
});

describe("chat-page.unit.history-budget.003 — one measured number decides", () => {
  it("does nothing when the thread has no measured prompt size yet", () => {
    // A thread's first turn, or a row written before `lastPromptTokens`
    // existed. Nothing to compare against, so nothing is compacted and no
    // summariser call is spent.
    const rows = turns(80, 1_000);
    const plan = planHistoryTrim(rows, { budget: 12_000 });
    expect(plan.trimmed).toBe(false);
    expect(plan.skipReason).toBe("no-measurement");
    expect(plan.dropped).toEqual([]);
    expect(plan.kept.map((m) => m.id)).toEqual(rows.map((m) => m.id));
    expect(plan.measuredPromptTokens).toBeUndefined();
    expect(plan.coversThroughMessageId).toBeUndefined();
  });

  it("keeps an old persisted row without the new field from compacting", () => {
    // `thread-context` passes no measurement at all when the row predates
    // `lastPromptTokens` — it does NOT fall back to the all-steps roll-up — so
    // a legacy row reaches the plan exactly like a first turn. No number, no
    // compaction.
    const rows = turns(80, 1_000);
    for (const measuredPromptTokens of [undefined, 0, -1, Number.NaN]) {
      const plan = planHistoryTrim(rows, {
        budget: 12_000,
        ...(measuredPromptTokens === undefined ? {} : { measuredPromptTokens }),
      });
      expect(plan.trimmed).toBe(false);
      expect(plan.skipReason).toBe("no-measurement");
    }
  });

  it("does nothing while the measured prompt is at or under budget", () => {
    const rows = turns(20, 100);
    const plan = planHistoryTrim(rows, {
      budget: 10_000,
      measuredPromptTokens: 9_999,
    });
    expect(plan.trimmed).toBe(false);
    expect(plan.skipReason).toBe("under-budget");
    expect(plan.measuredPromptTokens).toBe(9_999);
    expect(plan.kept.map((m) => m.id)).toEqual(rows.map((m) => m.id));
  });

  it("does not compact at exactly the budget (the trigger is strictly above)", () => {
    const rows = turns(4, 250);
    expect(
      planHistoryTrim(rows, { budget: 1_000, measuredPromptTokens: 1_000 })
        .trimmed,
    ).toBe(false);
    expect(
      planHistoryTrim(rows, { budget: 1_000, measuredPromptTokens: 1_001 })
        .trimmed,
    ).toBe(true);
  });

  it("ignores the size of the rows entirely — only the measurement counts", () => {
    // Two threads, wildly different in length, same measurement. The plan is
    // identical, because the rows never get a token figure of their own.
    const small = planHistoryTrim(turns(2, 10), {
      budget: 1_000,
      measuredPromptTokens: 5_000,
    });
    const large = planHistoryTrim(turns(200, 5_000), {
      budget: 1_000,
      measuredPromptTokens: 5_000,
    });
    expect(small.trimmed).toBe(true);
    expect(large.trimmed).toBe(true);
    expect(small.kept).toEqual([]);
    expect(large.kept).toEqual([]);
  });

  it("does not compact an empty history", () => {
    const plan = planHistoryTrim([], {
      budget: 10,
      measuredPromptTokens: 10_000,
    });
    expect(plan.trimmed).toBe(false);
    expect(plan.skipReason).toBe("nothing-droppable");
    expect(plan.kept).toEqual([]);
  });
});

describe("chat-page.unit.history-budget.004 — over budget compacts the history and starts again", () => {
  const budget = 10_000;
  const rows = turns(40, 500);
  const overBudget = { budget, measuredPromptTokens: 20_000 };

  it("hands the whole history to the summariser by default", () => {
    // MIN_KEPT_TURNS is 0 and the current user turn is not in these rows, so
    // "compact and start again" is literal: the thread carries on from the
    // summary plus the question being answered.
    const plan = planHistoryTrim(rows, overBudget);
    expect(plan.trimmed).toBe(true);
    expect(plan.kept).toEqual([]);
    expect(plan.dropped.map((m) => m.id)).toEqual(rows.map((m) => m.id));
    expect(plan.droppedTurnCount).toBe(40);
    expect(plan.keptTurnCount).toBe(0);
    expect(plan.measuredPromptTokens).toBe(20_000);
  });

  it("cuts at a turn boundary when a tail is protected", () => {
    const plan = planHistoryTrim(rows, { ...overBudget, minKeptTurns: 3 });
    expect(plan.trimmed).toBe(true);
    expect(plan.kept[0].role).toBe("user");
    expect(plan.dropped[plan.dropped.length - 1].role).toBe("assistant");
    // dropped ++ kept must reconstruct the input exactly, in order.
    expect([...plan.dropped, ...plan.kept].map((m) => m.id)).toEqual(
      rows.map((m) => m.id),
    );
  });

  it("never separates a tool row from the turn that produced it", () => {
    const withTools: BudgetMessage[] = [];
    for (let i = 0; i < 20; i++) {
      withTools.push(row("user", 800), row("tool", 800), row("assistant", 800));
    }
    const plan = planHistoryTrim(withTools, {
      budget: 4_000,
      measuredPromptTokens: 40_000,
      minKeptTurns: 4,
    });
    expect(plan.trimmed).toBe(true);
    expect(plan.kept[0].role).toBe("user");
    plan.kept.forEach((message, index) => {
      if (message.role === "tool") expect(index).toBeGreaterThan(0);
    });
  });

  it("reports the newest dropped row as the watermark", () => {
    const plan = planHistoryTrim(rows, { ...overBudget, minKeptTurns: 3 });
    expect(plan.coversThroughMessageId).toBe(
      plan.dropped[plan.dropped.length - 1].id,
    );
  });
});

describe("chat-page.unit.history-budget.005 — hysteresis: a compaction is followed by many quiet turns", () => {
  it("does nothing on the turns after a compaction, and needs no arithmetic to know", () => {
    // The next request measures the new prompt for us. After a compaction the
    // prompt is the developer message, the summary and the current turn, so
    // the measurement drops far under budget and stays there for as long as it
    // takes to grow back. That is the whole hysteresis — no target, no ratio.
    const budget = 10_000;
    const plan = planHistoryTrim(turns(40, 500), {
      budget,
      measuredPromptTokens: 20_000,
      minKeptTurns: 2,
    });
    expect(plan.trimmed).toBe(true);

    let retained = plan.kept;
    let measured = 3_000; // what the provider reports after the compaction
    for (let i = 0; i < 4; i++) {
      retained = [...retained, ...turn(300)];
      measured += 600;
      const next = planHistoryTrim(retained, {
        budget,
        measuredPromptTokens: measured,
      });
      expect(next.trimmed).toBe(false);
      expect(next.skipReason).toBe("under-budget");
      expect(next.kept.map((m) => m.id)).toEqual(retained.map((m) => m.id));
    }
  });

  it("compacts again, and only again, once the measurement passes the budget", () => {
    const budget = 10_000;
    let retained = turns(4, 250);
    let quietTurns = 0;
    let measured = 3_000;
    for (let i = 0; i < 500; i++) {
      retained = [...retained, ...turn(250)];
      measured += 500;
      if (planHistoryTrim(retained, { budget, measuredPromptTokens: measured }).trimmed) {
        break;
      }
      quietTurns++;
    }
    // 3,000 -> 10,000 at 500 a turn: 14 quiet turns. The old row cap re-cut on
    // EVERY turn.
    expect(quietTurns).toBe(14);
  });
});

describe("chat-page.unit.history-budget.006 — no persisted turn is protected by default", () => {
  it("protects nothing by default, so even the newest persisted turn can go", () => {
    // The current user message is NOT in these rows (the chat path writes it
    // after reading history), so "0 protected" still leaves the question
    // being answered intact. What it stops is a cost cut that spares the
    // expensive turn.
    expect(MIN_KEPT_TURNS).toBe(0);
    expect(resolveHistoryProtectedTurns()).toBe(0);

    const rows: BudgetMessage[] = [...turn(100), ...turn(100), ...turn(15_000)];
    const plan = planHistoryTrim(rows, {
      budget: 12_000,
      measuredPromptTokens: 15_400,
    });

    expect(plan.trimmed).toBe(true);
    // The 15k turn is the newest AND the reason the thread is over budget.
    // Protecting it was the defect: the trimmer dropped the two small turns
    // instead, added a summary, and the prompt grew.
    expect(plan.kept).toEqual([]);
    expect(plan.droppedTurnCount).toBe(3);
  });

  it("restores the old shape when HISTORY_PROTECTED_TURNS asks for it", () => {
    expect(resolveHistoryProtectedTurns({ envProtectedTurns: "2" })).toBe(2);
    // Junk, negatives and fractions fall back to the default rather than
    // protecting a strange number of turns.
    for (const envProtectedTurns of ["", "  ", "abc", "-1", "1.5", "NaN"]) {
      expect(resolveHistoryProtectedTurns({ envProtectedTurns })).toBe(0);
    }
    // An explicit zero is honoured, not treated as "unset".
    expect(resolveHistoryProtectedTurns({ envProtectedTurns: "0" })).toBe(0);

    const rows = turns(30, 1_000);
    const lastFourIds = rows.slice(-4).map((m) => m.id); // 2 turns x 2 rows
    const plan = planHistoryTrim(rows, {
      budget: 2_000,
      measuredPromptTokens: 30_000,
      minKeptTurns: 2,
    });
    expect(plan.kept.map((m) => m.id).slice(-4)).toEqual(lastFourIds);
    expect(plan.dropped.map((m) => m.id)).not.toContain(lastFourIds[0]);
  });

  it("keeps exactly the newest minKeptTurns turns", () => {
    const rows = turns(20, 1_000);
    const newestFiveTurnIds = rows.slice(-10).map((m) => m.id);
    const plan = planHistoryTrim(rows, {
      budget: 12_000,
      measuredPromptTokens: 20_000,
      minKeptTurns: 5,
    });

    expect(plan.trimmed).toBe(true);
    expect(splitIntoTurns(plan.kept)).toHaveLength(5);
    // The protected turns are all still there, verbatim.
    expect(plan.kept.map((m) => m.id).slice(-10)).toEqual(newestFiveTurnIds);
    for (const id of newestFiveTurnIds) {
      expect(plan.dropped.map((m) => m.id)).not.toContain(id);
    }
  });
});

describe("chat-page.unit.history-budget.012 — a compaction that cannot help is not taken", () => {
  it("declines when every turn is protected, so nothing can be compacted", () => {
    const rows: BudgetMessage[] = [...turn(100), ...turn(15_000)];
    const plan = planHistoryTrim(rows, {
      budget: 12_000,
      measuredPromptTokens: 15_100,
      minKeptTurns: 2,
    });

    expect(plan.trimmed).toBe(false);
    expect(plan.skipReason).toBe("nothing-droppable");
    expect(plan.dropped).toEqual([]);
    // Nothing was dropped, so the caller must not spend a summariser call.
    expect(plan.droppedTurnCount).toBe(0);
  });

  it("declines for a single oversized current message with no history behind it", () => {
    // The current user turn is never in these rows, so a compaction cannot
    // help it. Saying so is better than dropping context and pretending.
    const plan = planHistoryTrim([], {
      budget: 12_000,
      measuredPromptTokens: 600_000,
    });
    expect(plan.trimmed).toBe(false);
    expect(plan.skipReason).toBe("nothing-droppable");
  });
});

describe("chat-page.unit.history-budget.013 — the measured prompt size is the only trigger", () => {
  it("does not compact a thread the aggregation only made look over budget", () => {
    // The live defect, from the dev container log of 2026-09-10T06:54:11Z:
    //
    //   triggerTokens 285,647   budget 256,000   -> WARN, over budget
    //
    // 285,647 was the ALL-STEPS sum of a 2-step turn (the panel showed reads
    // 135,637 + writes 138,958 + plain 6, and `plain 6` is 2 x the same 3
    // uncacheable tail tokens). The real last prompt was about half of it, so
    // the thread was never over budget and nothing should happen at all.
    const rows = turns(13, 11_000);
    const plan = planHistoryTrim(rows, {
      budget: 256_000,
      measuredPromptTokens: 142_800,
    });
    expect(plan.trimmed).toBe(false);
    expect(plan.skipReason).toBe("under-budget");
    expect(plan.dropped).toEqual([]);
    expect(plan.coversThroughMessageId).toBeUndefined();
    // And the old roll-up would have compacted it.
    expect(
      planHistoryTrim(rows, { budget: 256_000, measuredPromptTokens: 285_647 })
        .trimmed,
    ).toBe(true);
  });

  it("compacts a thread whose last prompt really is over budget", () => {
    const rows = turns(13, 11_000);
    const plan = planHistoryTrim(rows, {
      budget: 256_000,
      measuredPromptTokens: 300_000,
    });
    expect(plan.trimmed).toBe(true);
    expect(plan.measuredPromptTokens).toBe(300_000);
    expect(plan.kept).toEqual([]);
    expect(plan.dropped.map((m) => m.id)).toEqual(rows.map((m) => m.id));
  });

  it("floors a fractional measurement rather than carrying it through", () => {
    const plan = planHistoryTrim(turns(4, 100), {
      budget: 1_000,
      measuredPromptTokens: 1_200.9,
    });
    expect(plan.measuredPromptTokens).toBe(1_200);
  });
});

describe("chat-page.unit.history-budget.007 — applyHistoryWatermark makes a trim stick", () => {
  it("drops everything up to and including the watermark row", () => {
    const rows = turns(6, 100);
    const { retained, alreadyCompacted, watermarkFound } = applyHistoryWatermark(
      rows,
      rows[3].id,
    );
    expect(watermarkFound).toBe(true);
    expect(alreadyCompacted.map((m) => m.id)).toEqual(
      rows.slice(0, 4).map((m) => m.id),
    );
    expect(retained.map((m) => m.id)).toEqual(rows.slice(4).map((m) => m.id));
  });

  it("returns everything when there is no watermark", () => {
    const rows = turns(3, 100);
    const { retained, watermarkFound } = applyHistoryWatermark(rows, undefined);
    expect(watermarkFound).toBe(false);
    expect(retained.map((m) => m.id)).toEqual(rows.map((m) => m.id));
  });

  it("fails open when the watermark row is gone (a rewound thread)", () => {
    const rows = turns(3, 100);
    const { retained, alreadyCompacted, watermarkFound } = applyHistoryWatermark(
      rows,
      "a-row-that-was-deleted",
    );
    expect(watermarkFound).toBe(false);
    expect(alreadyCompacted).toEqual([]);
    expect(retained.map((m) => m.id)).toEqual(rows.map((m) => m.id));
  });

  it("keeps the retained span fixed as the thread grows — the prefix holds", () => {
    // The regression this pins: without the watermark, re-reading the full
    // thread each turn made the budget re-cut one turn further along every
    // turn, i.e. the same sliding window as `TOP 30`.
    const budget = 10_000;
    const initial = turns(40, 500);
    const firstPlan = planHistoryTrim(initial, {
      budget,
      measuredPromptTokens: 20_000,
      minKeptTurns: 2,
    });
    const watermark = firstPlan.coversThroughMessageId;
    expect(watermark).toBeDefined();

    let fullThread = initial;
    const retainedHeadIds: string[] = [];
    let measured = 3_000;
    for (let i = 0; i < 5; i++) {
      fullThread = [...fullThread, ...turn(200)];
      measured += 400;
      const { retained } = applyHistoryWatermark(fullThread, watermark);
      const plan = planHistoryTrim(retained, {
        budget,
        measuredPromptTokens: measured,
      });
      expect(plan.trimmed).toBe(false);
      retainedHeadIds.push(plan.kept[0].id);
    }
    // Same first row every turn => the prompt prefix did not move.
    expect(new Set(retainedHeadIds).size).toBe(1);
    expect(retainedHeadIds[0]).toBe(firstPlan.kept[0].id);
  });
});

describe("chat-page.unit.history-budget.008 — resolveHistoryTokenBudget precedence", () => {
  it("defaults to 256,000 tokens, so summarisation is a late event", () => {
    // Trimming is lossy - the dropped block survives only as a ~1,500-token
    // summary - so it should be paid late. 256k is also exactly where the 5.6
    // guard lands (272k threshold - 16k reserve), so on the default model the
    // configured budget and the model ceiling agree.
    expect(DEFAULT_HISTORY_TOKEN_BUDGET).toBe(256_000);
  });

  it("falls back to the module default", () => {
    expect(resolveHistoryTokenBudget()).toBe(DEFAULT_HISTORY_TOKEN_BUDGET);
    expect(resolveHistoryTokenBudget({})).toBe(DEFAULT_HISTORY_TOKEN_BUDGET);
  });

  it("uses the model config budget when there is no env override", () => {
    expect(resolveHistoryTokenBudget({ modelBudget: 40_000 })).toBe(40_000);
  });

  it("lets the env override win over the model config", () => {
    expect(
      resolveHistoryTokenBudget({ modelBudget: 40_000, envBudget: "25000" }),
    ).toBe(25_000);
  });

  it("ignores an unusable env value instead of honouring it", () => {
    // A typo in an env var must not silently reduce every thread to no
    // history at all, so anything non-numeric or non-positive is discarded.
    for (const envBudget of ["", "  ", "abc", "0", "-5", "NaN"]) {
      expect(resolveHistoryTokenBudget({ modelBudget: 40_000, envBudget })).toBe(
        40_000,
      );
    }
  });

  it("ignores an unusable model budget", () => {
    expect(resolveHistoryTokenBudget({ modelBudget: 0 })).toBe(
      DEFAULT_HISTORY_TOKEN_BUDGET,
    );
    expect(resolveHistoryTokenBudget({ modelBudget: -1 })).toBe(
      DEFAULT_HISTORY_TOKEN_BUDGET,
    );
  });

  it("floors a fractional value so the budget is always a whole number", () => {
    expect(resolveHistoryTokenBudget({ envBudget: "1234.9" })).toBe(1234);
  });
});

describe("chat-page.unit.history-budget.010 - long-context guard", () => {
  it("reserves 16,000 tokens for the developer message and the current turn", () => {
    expect(HISTORY_LONG_CONTEXT_RESERVE).toBe(16_000);
    expect(resolveHistoryLongContextReserve()).toBe(16_000);
    expect(resolveHistoryLongContextReserve({})).toBe(16_000);
    expect(resolveHistoryLongContextReserve({ envReserve: "32000" })).toBe(32_000);
    // An explicit zero is a choice; junk is not.
    expect(resolveHistoryLongContextReserve({ envReserve: "0" })).toBe(0);
    for (const envReserve of ["", "  ", "abc", "-1", "NaN"]) {
      expect(resolveHistoryLongContextReserve({ envReserve })).toBe(
        HISTORY_LONG_CONTEXT_RESERVE,
      );
    }
  });

  it("keeps a 5.6 thread just under the 272k long-context billing tier", () => {
    // Azure bills 5.6 input above 272k at 2x (the LongCo* meters). 272k minus
    // the 16k reserve is 256k, which is also the configured default, so the
    // two agree and neither is silently doing the other's job.
    const decision = resolveHistoryBudget({
      longContextThresholdTokens: 272_000,
      contextWindow: 1_050_000,
    });
    expect(decision.budget).toBe(256_000);
    expect(decision.guard).toBe(256_000);
    expect(decision.guardSource).toBe("longContextThreshold");
    expect(decision.baseSource).toBe("default");
    expect(decision.cappedByGuard).toBe(false);
  });

  it("takes 60 % of the context window when the model declares no threshold", () => {
    // No billing cliff to price, just a wall: a 128k window gives 76,800 and
    // leaves 40 % for the developer message, the current turn, tool results
    // and the reply.
    const decision = resolveHistoryBudget({ contextWindow: 128_000 });
    expect(decision.budget).toBe(76_800);
    expect(decision.guard).toBe(76_800);
    expect(decision.guardSource).toBe("contextWindow");
    expect(decision.cappedByGuard).toBe(true);
    expect(CONTEXT_WINDOW_GUARD_RATIO).toBe(0.6);
  });

  it("caps an env budget that is larger than the guard", () => {
    // The env override wins the BASE budget and still loses to the guard: it
    // is a lever for dialling the budget down, not for overrunning a model.
    const capped = resolveHistoryBudget({
      envBudget: "900000",
      longContextThresholdTokens: 272_000,
      contextWindow: 1_050_000,
    });
    expect(capped.baseBudget).toBe(900_000);
    expect(capped.baseSource).toBe("env");
    expect(capped.budget).toBe(256_000);
    expect(capped.cappedByGuard).toBe(true);

    // Same for a small-window model.
    expect(
      resolveHistoryBudget({ envBudget: "500000", contextWindow: 128_000 }).budget,
    ).toBe(76_800);

    // Below the guard the env value stands, untouched.
    const under = resolveHistoryBudget({
      envBudget: "40000",
      longContextThresholdTokens: 272_000,
    });
    expect(under.budget).toBe(40_000);
    expect(under.cappedByGuard).toBe(false);
  });

  it("prefers the threshold over the context window, and honours the reserve", () => {
    const decision = resolveHistoryBudget({
      envBudget: "900000",
      longContextThresholdTokens: 272_000,
      contextWindow: 128_000,
      envReserve: "32000",
    });
    // The priced cliff decides, not the wall.
    expect(decision.guardSource).toBe("longContextThreshold");
    expect(decision.reserve).toBe(32_000);
    expect(decision.budget).toBe(240_000);
  });

  it("stands the configured budget when the model declares neither ceiling", () => {
    const decision = resolveHistoryBudget({ modelBudget: 40_000 });
    expect(decision.budget).toBe(40_000);
    expect(decision.baseSource).toBe("model");
    expect(decision.guard).toBeUndefined();
    expect(decision.guardSource).toBe("none");
    expect(decision.cappedByGuard).toBe(false);
  });

  it("discards a guard that would come out at or below zero (negative)", () => {
    // A reserve bigger than the model's own threshold is a misconfiguration.
    // Applying it would carry NO history on every thread of that model.
    const decision = resolveHistoryBudget({
      longContextThresholdTokens: 8_000,
      envReserve: "16000",
    });
    expect(decision.guard).toBeUndefined();
    expect(decision.guardSource).toBe("none");
    expect(decision.budget).toBe(DEFAULT_HISTORY_TOKEN_BUDGET);
  });

});

describe("chat-page.unit.history-budget.011 - the compaction follows the effective budget", () => {
  it("compares the measurement with the EFFECTIVE budget, not the configured one", () => {
    // Configured 900k, guarded down to 76,800 by a 128k window. A 90k prompt
    // is under the configured budget and over the effective one, and the
    // effective one is what the model actually had.
    const budget = resolveHistoryTokenBudget({
      envBudget: "900000",
      contextWindow: 128_000,
    });
    expect(budget).toBe(76_800);

    const rows = turns(40, 800);
    const plan = planHistoryTrim(rows, {
      budget,
      measuredPromptTokens: 90_000,
    });
    expect(plan.trimmed).toBe(true);
    expect(plan.budget).toBe(76_800);
    expect(plan.kept).toEqual([]);

    expect(
      planHistoryTrim(rows, { budget, measuredPromptTokens: 70_000 }).trimmed,
    ).toBe(false);
  });
});
