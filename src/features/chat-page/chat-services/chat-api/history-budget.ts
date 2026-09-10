/**
 * history-budget.ts
 *
 * Decides how much of a thread's persisted history goes into the next prompt.
 *
 * ## Why this module exists
 *
 * The chat path used to load history with `SELECT TOP 30 … ORDER BY createdAt
 * DESC`. Row 31 onwards did not exist as far as the model was concerned, and —
 * worse — every new turn pushed the oldest row out of the window. That moves
 * the start of the conversation, which moves the first byte of the prompt after
 * the developer message, which invalidates the prompt cache. Measured on
 * production traffic: the prompt shrank on 20 % of turn pairs and the cache hit
 * rate fell from 80 % to 30 % once a thread passed the cap. Threads longer than
 * ten turns account for 37 % of all written tokens, so the sliding window was
 * re-billing a large share of the traffic at the cache-write rate (1.25x).
 *
 * The fix has two halves. The loader now reads the WHOLE thread (see
 * `FindAllChatMessagesForCurrentUser`), and this module compacts it when the
 * provider says the prompt has grown past the budget, with two properties the
 * row cap did not have:
 *
 *   1. **Turn-boundary cuts.** A cut only ever lands where a user message
 *      starts, so the surviving history is always a whole number of turns and
 *      never a dangling tool result with no call.
 *   2. **Hysteresis.** Nothing happens until the measured prompt exceeds the
 *      budget, and when a compaction does happen the history starts again from
 *      a summary. The prefix then stays byte-identical for the many turns it
 *      takes to grow back to the budget, instead of shifting on every single
 *      turn. This is the whole point: one big cache miss every few dozen turns
 *      beats a small one every turn.
 *
 * ## One number, from the provider. Nothing is estimated.
 *
 * There is no token estimator anywhere in this decision. Guessing was never
 * necessary: the provider reports the size of the prompt it received, and the
 * app persists that figure per thread (`ThreadUsage.lastPromptTokens` — the
 * LAST step's `inputTokens`, not the all-steps roll-up, which sums one prompt
 * per step of a tool turn).
 *
 * So the whole decision is:
 *
 *   measured last prompt > budget   ->  compact the history and start again
 *   anything else                   ->  do nothing
 *
 * "Compact and start again" is literal: the history up to the newest
 * `minKeptTurns` turns is handed to the summariser and leaves the prompt, and
 * the thread carries on from the summary. There is no target to hit, no
 * per-turn token accounting, and no attempt to work out which turn is
 * responsible for how many tokens — that question needs a tokenizer we do not
 * have, and its answer would only ever be a guess.
 *
 * It is also self-correcting, which is why it needs no arithmetic. The next
 * request measures the new prompt for us. If the compaction was not enough,
 * the next turn is over budget again and compacts again; if it was enough, the
 * thread is quiet for the dozens of turns it takes to grow back.
 *
 * With no measurement (a thread's first turn, or a row written before the
 * field existed) NOTHING happens and no summariser call is spent. There is
 * nothing to compare, and an oversized first message could not be helped
 * anyway: the current user turn is never droppable.
 *
 * `estimateTextTokens` survives at the bottom of this file for one reason —
 * the summary writer stamps an informational size on the row it persists.
 * Nothing decides anything with it.
 *
 * ## Contract
 *
 * Everything here is pure and deterministic: same input, same output, in any
 * process, on any pod, under any locale. The compaction decision feeds a cache
 * key, so a non-deterministic one would defeat its own purpose.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Default ceiling on estimated history tokens, used when the model config
 * carries no `historyTokenBudget`.
 *
 * Not a context limit — the 5.6 family has a ~1M-token context window — but a
 * COST limit on the history that is re-sent every turn.
 *
 * 256k, i.e. summarisation only kicks in for genuinely long threads. Trimming
 * is lossy: the dropped block survives only as a ~1,500-token summary, and a
 * user who scrolls up can still see the turns the model can no longer quote.
 * That is a real cost, and it should be paid late rather than early. The
 * counter-pressure is that a cache entry is not forever: once it is evicted the
 * NEXT turn rewrites the whole prompt at 1.25x the uncached input rate, so the
 * bigger the carried history the bigger that periodic re-write.
 *
 * 256k is also where the long-context guard below happens to bite on the 5.6
 * family (272k threshold − 16k reserve = 256k), so on the default model the
 * configured budget and the guard agree, and no thread is carried into the 2x
 * long-context billing tier by history alone.
 */
export const DEFAULT_HISTORY_TOKEN_BUDGET = 256_000;

/**
 * Tokens held back from the model's own ceiling for everything in the prompt
 * that is NOT carried history: the developer/system message (static prompt,
 * persona, instruction blocks, tool definitions), the document hint, and the
 * user's current turn.
 *
 * 16k is generous for that set — a large persona plus a full toolset lands well
 * under it — and being generous is the right error: the guard exists to keep a
 * request off a billing cliff, so the reserve should absorb a prompt that grew
 * since the last measurement rather than track it exactly.
 *
 * Overridable via `HISTORY_LONG_CONTEXT_RESERVE`; see
 * `resolveHistoryLongContextReserve`.
 */
export const HISTORY_LONG_CONTEXT_RESERVE = 16_000;

/**
 * Fraction of a model's context window the history may occupy when the model
 * declares no `longContextThresholdTokens`, i.e. when there is no billing cliff
 * to stay under and the only thing to avoid is filling the window.
 *
 * 60 % leaves 40 % for the developer message, the current turn, the tool
 * results this turn will produce, and the reply (which on a reasoning model
 * includes the thinking tokens). A prompt that overflows the window is an
 * HTTP 400, not a bigger bill, so this branch is a correctness guard rather
 * than a cost one.
 */
export const CONTEXT_WINDOW_GUARD_RATIO = 0.6;

/**
 * Characters per token, for the ONE thing left that estimates anything: the
 * informational size stamped on a persisted summary row. Not used to decide
 * anything — see `estimateTextTokens`.
 */
export const CHARS_PER_TOKEN = 4;


/**
 * Persisted turns that are never trimmed, counted from the newest end of the
 * rows that were loaded. DEFAULT 0.
 *
 * ## Why zero
 *
 * The current user message is safe whatever this is: the chat path writes it
 * to Cosmos AFTER reading history, so the row list this module sees does not
 * contain it. "0 protected turns" therefore still means "the question being
 * answered survives" — it means every PERSISTED turn is eligible.
 *
 * It used to be 2, and that produced a trim that made the prompt BIGGER.
 * Measured on dev: a thread whose newest turn was a 15k-token paste went over
 * budget; the two newest turns were protected, so the trimmer dropped a small
 * older turn (~2k), added a ~2k summary, and the next prompt came out at 17.5k
 * against 17k before. The user had just been told the conversation was
 * compacted and the prompt grew. Protecting turns from a COST cut is a
 * contradiction: the expensive turn is exactly the one that has to go.
 *
 * With compact-and-start-again there is nothing left to get wrong here: the
 * whole history goes into the summary, so a big newest turn is summarised
 * along with everything else rather than pushing a small old turn out and
 * leaving the prompt bigger than before.
 *
 * Overridable via `HISTORY_PROTECTED_TURNS` for an environment that wants the
 * old shape back; see `resolveHistoryProtectedTurns`.
 */
export const MIN_KEPT_TURNS = 0;

/**
 * Token allowance reserved for the replayed summary. Also the size the
 * summariser is instructed to stay under, so the two cannot drift apart.
 */
export const SUMMARY_TOKEN_RESERVE = 1_500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The subset of a persisted `ChatMessageModel` the budget cares about.
 * Structural on purpose: it keeps this module free of `server-only` imports
 * and lets tests build rows without a full Cosmos document.
 */
export interface BudgetMessage {
  id: string;
  role: string;
  content?: string;
  multiModalImage?: string;
  multiModalImages?: string[];
  reasoningContent?: string;
}

/** One conversational turn: a user message plus everything it produced. */
export interface HistoryTurn<T extends BudgetMessage = BudgetMessage> {
  /** Index into the input array of this turn's first row. */
  startIndex: number;
  /** Index into the input array of this turn's last row (inclusive). */
  endIndex: number;
  messages: T[];
  /**
   * True for a leading block of rows that precede the thread's first user
   * message (a stray system row, or tool rows orphaned by an old bug). It is
   * not really a turn, but it has to belong somewhere and it must be trimmable.
   */
  isPreamble: boolean;
}

export interface TrimPlanOptions {
  /**
   * Measured-token ceiling on the prompt. Above this, and only above this, the
   * history is compacted.
   */
  budget?: number;
  /**
   * Newest PERSISTED turns that survive a compaction. Default 0 — the current
   * user turn is not in these rows, so 0 still means "the question being
   * answered survives".
   */
  minKeptTurns?: number;
  /**
   * THE input to the decision: the provider's measured size of the LAST prompt
   * of this thread's previous request (its final step's `inputTokens`).
   *
   * Deliberately the LAST STEP's input and not the turn's billed roll-up. AI
   * SDK 7 sums step usage over a turn, so a 3-step tool turn reports about
   * three prompts' worth of input for a conversation that never exceeded one
   * prompt. Measured on dev: a thread reported 285,647 against a 256,000
   * budget while its real prompt was about half that, and compacted a thread
   * that was never over budget.
   *
   * Absent on a thread's first turn, and on a thread whose last row predates
   * the field. Nothing is then compacted — there is nothing to compare, and a
   * compaction could not help an oversized first message anyway, because the
   * current user turn is never droppable.
   */
  measuredPromptTokens?: number;
}

export interface TrimPlan<T extends BudgetMessage = BudgetMessage> {
  /** False when nothing was compacted; `kept` is then the input, untouched. */
  trimmed: boolean;
  /** Rows to send to the model, oldest-first. */
  kept: T[];
  /** Rows the summariser should stand in for, oldest-first. */
  dropped: T[];
  /**
   * The measurement this decision was made from, or undefined when the thread
   * had none. Undefined always means `trimmed: false`.
   */
  measuredPromptTokens?: number;
  /** The ceiling the measurement was compared with. */
  budget: number;
  droppedTurnCount: number;
  keptTurnCount: number;
  /**
   * Cosmos id of the NEWEST dropped row — the watermark the summary covers
   * through. Undefined when nothing was dropped.
   */
  coversThroughMessageId?: string;
  /**
   * Why a thread was left alone. Undefined when it was compacted.
   *
   *   "no-measurement"    the thread has no recorded prompt size yet, so there
   *                       is nothing to compare and nothing is done. A first
   *                       turn, or a row written before `lastPromptTokens`.
   *   "under-budget"      the measured prompt is at or under budget. The
   *                       ordinary outcome for almost every turn.
   *   "nothing-droppable" over budget, but there is no history to compact —
   *                       an empty thread, or every turn protected by
   *                       `minKeptTurns`. A single oversized message cannot be
   *                       helped here: the current turn is never droppable.
   *
   * All three are silent for the user: nothing happened, so there is nothing
   * to show.
   */
  skipReason?: "no-measurement" | "under-budget" | "nothing-droppable";
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/**
 * Deterministic token estimate for a text blob: `ceil(length / 4)`.
 *
 * NOT part of the trim decision or of the trim sizing any more — both run on
 * the provider's measured prompt size, distributed by weight (see the module
 * header). The one remaining caller is the summary writer, which stamps a size
 * on the `CHAT_HISTORY_SUMMARY` row it persists; that figure is informational.
 *
 * `ceil` rather than `round` so that any non-empty string costs at least one
 * token — a row can never be free, which keeps the accumulation strictly
 * monotonic in the number of rows.
 */
export function estimateTextTokens(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Turn segmentation
// ---------------------------------------------------------------------------

/**
 * Split oldest-first rows into turns. A turn opens at every `user` row and
 * runs up to (but not including) the next one, so it carries that user
 * message, the assistant reply, and every `tool` / `reasoning` row generated
 * in between.
 *
 * Cutting on user rows rather than on assistant rows is what makes a trim safe
 * to hand to `convertToModelMessages`: a tool result is never separated from
 * the assistant message that called it, because both sit inside the same turn.
 */
export function splitIntoTurns<T extends BudgetMessage>(
  messages: readonly T[],
): HistoryTurn<T>[] {
  const turns: HistoryTurn<T>[] = [];
  let current: HistoryTurn<T> | undefined;

  messages.forEach((message, index) => {
    const startsNewTurn = message.role === "user";

    if (startsNewTurn || current === undefined) {
      current = {
        startIndex: index,
        endIndex: index,
        messages: [],
        // Only a block that opens without a user row is a preamble.
        isPreamble: !startsNewTurn,
      };
      turns.push(current);
    }

    current.messages.push(message);
    current.endIndex = index;
  });

  return turns;
}

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

/**
 * Drop the rows a previous trim already accounted for.
 *
 * ## Why a watermark is required, and not merely an optimisation
 *
 * A trim does not delete anything — the rows stay in Cosmos so the transcript
 * still renders in full. So the next turn re-reads them, and if the budget were
 * the only input the plan would simply trim again, one turn further along. The
 * cut would advance by one turn on every turn: a sliding window with a bigger
 * number in it, and the same cache behaviour as the `TOP 30` it replaced.
 *
 * The watermark is what makes a trim STICK. It is the Cosmos id of the newest
 * row the last trim removed, persisted on the thread's summary row. Rows up to
 * and including it are gone from the prompt for good, so the retained span
 * starts at a fixed point and the prefix stays byte-identical until the budget
 * is exceeded again — which takes the many turns it needs to grow from 60 %
 * back to 100 %.
 *
 * ## Fail-open
 *
 * A watermark id that is not in the rows means the row it named is gone: the
 * user rewound the thread, or deleted messages. Rather than guess, this returns
 * everything and lets the budget re-derive a cut from scratch. Sending too much
 * history costs tokens; guessing wrong could blank a thread the user can still
 * see on screen.
 */
export function applyHistoryWatermark<T extends BudgetMessage>(
  messages: readonly T[],
  coversThroughMessageId: string | undefined,
): { retained: T[]; alreadyCompacted: T[]; watermarkFound: boolean } {
  if (!coversThroughMessageId) {
    return { retained: [...messages], alreadyCompacted: [], watermarkFound: false };
  }

  const index = messages.findIndex((m) => m.id === coversThroughMessageId);
  if (index === -1) {
    return { retained: [...messages], alreadyCompacted: [], watermarkFound: false };
  }

  return {
    retained: messages.slice(index + 1),
    alreadyCompacted: messages.slice(0, index + 1),
    watermarkFound: true,
  };
}

// ---------------------------------------------------------------------------
// Budget resolution
// ---------------------------------------------------------------------------

/**
 * Reserve for the non-history part of the prompt, from
 * `HISTORY_LONG_CONTEXT_RESERVE`, else `HISTORY_LONG_CONTEXT_RESERVE`'s
 * default. Zero is honoured (an operator may explicitly want the whole
 * threshold available); anything unparseable or negative is not.
 */
export function resolveHistoryLongContextReserve(input?: {
  envReserve?: string;
}): number {
  const raw = input?.envReserve;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return HISTORY_LONG_CONTEXT_RESERVE;
  }
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  return HISTORY_LONG_CONTEXT_RESERVE;
}

/** Where the base budget came from. */
export type HistoryBudgetSource = "env" | "model" | "default";

/** Which model ceiling produced the guard, if any. */
export type HistoryGuardSource = "longContextThreshold" | "contextWindow" | "none";

export interface HistoryBudgetDecision {
  /** What to hand `planHistoryTrim` — the base budget after the guard. */
  budget: number;
  /** The configured budget, before the guard. */
  baseBudget: number;
  baseSource: HistoryBudgetSource;
  /** The model-derived ceiling; undefined when the model declares neither. */
  guard?: number;
  guardSource: HistoryGuardSource;
  /** Tokens held back for the developer message and the current turn. */
  reserve: number;
  /** True when the guard, not the configured budget, decided. */
  cappedByGuard: boolean;
}

/**
 * Resolve the effective history budget: the CONFIGURED budget, bounded by what
 * the model that will answer can afford to be handed.
 *
 * ## Base budget
 *
 * Precedence: `HISTORY_TOKEN_BUDGET` env override > the model config's
 * `historyTokenBudget` > the module default. The env override wins so the
 * budget can be dialled down in one place during an incident without a deploy.
 * A value that is absent, unparseable or non-positive is ignored rather than
 * honoured — a typo in an env var must not silently reduce every thread to no
 * history at all.
 *
 * ## The guard, and why the configured number is not the last word
 *
 * A budget large enough to be worth configuring is also large enough to walk a
 * request over a per-model boundary, and the boundaries are not the same shape:
 *
 *   - `longContextThresholdTokens` — a BILLING cliff. Azure bills GPT-5.6 input
 *     above 272k tokens at a separate "long context" tier at 2x the normal rate
 *     (it shows up as the `LongCo*` meters). Nothing fails; the invoice just
 *     doubles for every token of that request, cached tokens included. Carrying
 *     history over the line is the worst way to cross it, because history is
 *     re-sent every single turn. Guard = threshold − reserve.
 *   - `contextWindow` — a CORRECTNESS limit. No cliff to price, just a wall:
 *     overflow it and the provider answers HTTP 400. Guard =
 *     `CONTEXT_WINDOW_GUARD_RATIO` (60 %) of the window, which leaves the other
 *     40 % for the developer message, the current turn, tool results and the
 *     reply.
 *
 * The threshold wins when both are declared: it is always the lower of the two
 * and it is the one with a price attached. With neither declared there is
 * nothing to bound against, so the configured budget stands.
 *
 * A guard that comes out at or below zero (a reserve larger than the model's
 * own threshold — i.e. a misconfiguration) is discarded rather than applied:
 * the alternative is a budget of zero, which would carry no history at all on
 * every thread of that model.
 */
export function resolveHistoryBudget(input?: {
  modelBudget?: number;
  envBudget?: string;
  longContextThresholdTokens?: number;
  contextWindow?: number;
  envReserve?: string;
}): HistoryBudgetDecision {
  let baseBudget = DEFAULT_HISTORY_TOKEN_BUDGET;
  let baseSource: HistoryBudgetSource = "default";

  const parsedEnv = Number(input?.envBudget);
  const modelBudget = input?.modelBudget;
  if (Number.isFinite(parsedEnv) && parsedEnv > 0) {
    baseBudget = Math.floor(parsedEnv);
    baseSource = "env";
  } else if (
    typeof modelBudget === "number" &&
    Number.isFinite(modelBudget) &&
    modelBudget > 0
  ) {
    baseBudget = Math.floor(modelBudget);
    baseSource = "model";
  }

  const reserve = resolveHistoryLongContextReserve({
    envReserve: input?.envReserve,
  });

  let guard: number | undefined;
  let guardSource: HistoryGuardSource = "none";
  const threshold = input?.longContextThresholdTokens;
  const contextWindow = input?.contextWindow;
  if (typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0) {
    guard = Math.floor(threshold) - reserve;
    guardSource = "longContextThreshold";
  } else if (
    typeof contextWindow === "number" &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0
  ) {
    guard = Math.floor(contextWindow * CONTEXT_WINDOW_GUARD_RATIO);
    guardSource = "contextWindow";
  }

  if (guard !== undefined && guard <= 0) {
    guard = undefined;
    guardSource = "none";
  }

  const budget = guard === undefined ? baseBudget : Math.min(baseBudget, guard);

  return {
    budget,
    baseBudget,
    baseSource,
    guard,
    guardSource,
    reserve,
    cappedByGuard: guard !== undefined && guard < baseBudget,
  };
}

/**
 * The effective budget only. Thin wrapper over `resolveHistoryBudget` for
 * callers that do not need to log which value won.
 */
export function resolveHistoryTokenBudget(input?: {
  modelBudget?: number;
  envBudget?: string;
  longContextThresholdTokens?: number;
  contextWindow?: number;
  envReserve?: string;
}): number {
  return resolveHistoryBudget(input).budget;
}

/**
 * Resolve how many of the newest PERSISTED turns are protected from a trim.
 * `HISTORY_PROTECTED_TURNS` overrides the module default of 0.
 *
 * Zero is a legitimate value and must be honoured, so this cannot use the
 * "falsy means unset" shortcut the other resolvers use. Anything unparseable,
 * negative or fractional falls back to the default rather than silently
 * protecting a strange number of turns.
 */
export function resolveHistoryProtectedTurns(input?: {
  envProtectedTurns?: string;
}): number {
  const raw = input?.envProtectedTurns;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return MIN_KEPT_TURNS;
  }
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  return MIN_KEPT_TURNS;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Decide whether to compact this thread's history, and hand back the two
 * halves if so.
 *
 * The whole decision:
 *
 *   is there a number?   `measuredPromptTokens`. Without it nothing happens
 *                        and no summariser call is spent.
 *   over budget?         measuredPromptTokens > budget
 *   what goes?           everything before the newest `minKeptTurns` turns.
 *                        Not a computed amount — the history is compacted and
 *                        the thread starts again from the summary.
 *
 * No target, no per-turn token accounting, no estimator. The next request
 * measures the result for us: still over budget means compact again, under
 * means quiet for as long as it takes to grow back.
 *
 * The cut lands on a turn boundary, so a tool result is never separated from
 * the assistant message that called it.
 */
export function planHistoryTrim<T extends BudgetMessage>(
  messages: readonly T[],
  options: TrimPlanOptions = {},
): TrimPlan<T> {
  const budget = options.budget ?? DEFAULT_HISTORY_TOKEN_BUDGET;
  const minKeptTurns = options.minKeptTurns ?? MIN_KEPT_TURNS;
  const turns = splitIntoTurns(messages);

  const rawMeasured = options.measuredPromptTokens;
  const hasMeasured =
    typeof rawMeasured === "number" &&
    Number.isFinite(rawMeasured) &&
    rawMeasured > 0;
  const measured = hasMeasured ? Math.floor(rawMeasured as number) : 0;

  const untouched = (
    skipReason: NonNullable<TrimPlan<T>["skipReason"]>,
  ): TrimPlan<T> => ({
    trimmed: false,
    kept: [...messages],
    dropped: [],
    ...(hasMeasured ? { measuredPromptTokens: measured } : {}),
    budget,
    droppedTurnCount: 0,
    keptTurnCount: turns.length,
    skipReason,
  });

  // No measurement, no decision. A thread's first turn, or a row written
  // before `lastPromptTokens` existed.
  if (!hasMeasured) return untouched("no-measurement");

  if (measured <= budget) return untouched("under-budget");

  // Over budget. Everything except the protected tail goes to the summariser.
  const droppedTurnCount = Math.max(0, turns.length - minKeptTurns);
  // Nothing to compact: an empty thread, or every turn protected. A single
  // oversized message cannot be helped here — the current user turn is not in
  // these rows, so it is never droppable.
  if (droppedTurnCount === 0) return untouched("nothing-droppable");

  const cutIndex =
    droppedTurnCount < turns.length
      ? turns[droppedTurnCount].startIndex
      : messages.length;
  const dropped = messages.slice(0, cutIndex);
  const kept = messages.slice(cutIndex);

  return {
    trimmed: true,
    kept: [...kept],
    dropped: [...dropped],
    measuredPromptTokens: measured,
    budget,
    droppedTurnCount,
    keptTurnCount: turns.length - droppedTurnCount,
    coversThroughMessageId: dropped[dropped.length - 1]?.id,
  };
}
