/**
 * compaction-part.ts
 *
 * The wire contract for the `data-compaction` UI message part, plus the copy
 * derived from it. Pure and client-safe on purpose: the route writes these
 * parts into the UI message stream, the transcript renders them, and the
 * thread loader synthesises one from the persisted `CHAT_HISTORY_SUMMARY` row
 * so the marker survives a reload. All three need the same shape and the same
 * words.
 *
 * ## Why the user is told at all
 *
 * A trim is the one thing the chat does that quietly makes the model know less
 * than the transcript on screen. The rows stay in Cosmos and keep rendering,
 * so without a marker the user has no way to tell that the model can no longer
 * quote the turns they can still scroll to. The divider is where the
 * conversation the model sees actually begins.
 *
 * ## Reconciliation
 *
 * Every part carries the SAME `id` (`COMPACTION_PART_ID`) for a given turn.
 * The AI SDK reconciles data parts by `(type, id)` — a second write with the
 * same id replaces the first in place rather than appending — which is what
 * lets a "running" notice become a "done" notice without leaving two dividers
 * in the transcript.
 */

/** The part type. `data-` prefixed, as the AI SDK requires for custom parts. */
export const COMPACTION_DATA_PART_TYPE = "data-compaction" as const;

/**
 * Stable part id. One compaction per turn, so one id is enough, and reusing it
 * is what makes the second write an update instead of a second divider.
 */
export const COMPACTION_PART_ID = "compaction" as const;

/**
 * Why the dropped turns have, or have not, a summary standing in for them.
 *
 * A boolean could not tell "the operator turned it off" from "the summariser
 * 404'd", and the difference is the whole diagnosis: the first is a
 * configuration choice, the second is an incident. The live defect that
 * prompted this was invisible for exactly that reason — the UI said "feature
 * off" while the feature was on and the deployment was answering 404.
 */
export type SummaryOutcome =
  /** A summary was written for this block. */
  | "ok"
  /** `HISTORY_SUMMARY_ENABLED` is not "true". */
  | "off"
  /** The summariser was called and errored. Details are in the server log. */
  | "failed"
  /** The summariser outran `HISTORY_SUMMARY_TIMEOUT_MS`. */
  | "timeout"
  /** No candidate deployment resolved to a model this app can call. */
  | "no-deployment"
  /**
   * The row predates `summaryOutcome`, so no reason was ever recorded.
   *
   * This is NOT a failure and must not be rendered as one. Mapping it to "off"
   * reproduced the exact defect this type exists to remove: the transcript
   * claimed "no summary, feature off" on a thread whose summariser was on and
   * working. The honest answer for a row that never recorded a reason is to
   * state the compaction and stop, so the notice carries no reason clause.
   */
  | "unknown";

/**
 * Written once the trim (and the summary, if enabled) is complete.
 *
 * ## Why the token counts are optional
 *
 * They are REAL provider numbers, not estimates, and the real number for this
 * turn does not exist until the turn finishes: `tokensAfter` is the size of
 * this request's LAST prompt (its final step's `usage.inputTokens`). So the
 * part is written twice under one id — first
 * without counts ("Compacted 2 older turns into a summary"), then again at
 * stream end with them ("… (34,012 → 17,565 tokens)"). The AI SDK reconciles
 * data parts by `(type, id)`, so the line fills in rather than duplicating.
 *
 * An estimate would have been available immediately, and was deliberately
 * rejected: a number in the header that later disagrees with the provider's
 * own accounting is worse than no number for a few seconds.
 *
 * `tokensBefore` is the size of the PREVIOUS request's last prompt for this
 * thread. On the first turn there is no previous request, so it stays absent
 * and the line shows only what the prompt is now.
 *
 * ## Why both ends are prompt sizes and never the billed total
 *
 * AI SDK 7 sums step usage over a turn ("When there are multiple steps, the
 * usage is the sum of all step usages"). A tool turn therefore BILLS several
 * prompts while never sending more than one at a time. This notice claims the
 * prompt got smaller, so both ends must be single-prompt sizes; feeding it the
 * roll-up would let a 3-step turn report a trim that made the prompt grow.
 */
export interface CompactionDoneData {
  status: "done";
  trimmedTurns: number;
  /**
   * Size of the previous request's LAST prompt. Absent on a thread's first
   * turn.
   */
  tokensBefore?: number;
  /**
   * Size of this request's LAST prompt (its final step's `inputTokens`).
   * Absent until the turn finishes.
   */
  tokensAfter?: number;
  /**
   * Whether anything stands in for the dropped turns, and if not, why. The
   * turns are dropped either way.
   */
  summaryOutcome: SummaryOutcome;
  /** Model that wrote the summary. Absent unless the outcome is "ok". */
  summaryModel?: string;
  /** Wall-clock of the trim, including the summariser call. */
  durationMs: number;
  /**
   * The summary text itself, so "Show summary" needs no second request. Capped
   * by the summariser's own output ceiling (2,000 tokens), which is small
   * enough to ship inline.
   */
  summaryText?: string;
}

/**
 * The compaction part has one shape. The trim happens in `loadThreadContext`,
 * before the stream exists, so the fact is already known when the first frame
 * is written — there was never a "running" phase to render, and the one that
 * was declared here could not be reached from the route.
 */
export type CompactionData = CompactionDoneData;

/** The part as it goes on the wire and onto the message. */
export interface CompactionDataPart {
  type: typeof COMPACTION_DATA_PART_TYPE;
  id: typeof COMPACTION_PART_ID;
  data: CompactionData;
}

/**
 * What a completed compaction produced. Assembled where the trim happens
 * (thread-context) and carried to the route, which turns it into the part
 * below.
 */
export interface HistoryCompactionOutcome {
  trimmedTurns: number;
  /**
   * The measured prompt size that triggered this compaction — the provider's
   * figure for the previous request's last prompt. Logged; the user sees the
   * pair of real prompt sizes either side of the trim instead, which the route
   * assembles once THIS turn finishes. Absent when the plan had no
   * measurement, which cannot happen on a compacting turn.
   */
  measuredPromptTokens?: number;
  summaryOutcome: SummaryOutcome;
  summaryModel?: string;
  durationMs: number;
  summaryText?: string;
  /** Newest row the summary covers through — the divider's anchor on reload. */
  coversThroughMessageId?: string;
}

/**
 * The completed notice. `realTokens` is absent on the first write (the turn has
 * not finished, so the provider has not said what the prompt cost) and present
 * on the second, which reuses the same part id.
 */
export function compactionDonePart(
  outcome: HistoryCompactionOutcome,
  realTokens?: { tokensBefore?: number; tokensAfter?: number },
): CompactionDataPart {
  const data: CompactionDoneData = {
    status: "done",
    trimmedTurns: outcome.trimmedTurns,
    summaryOutcome: outcome.summaryOutcome,
    durationMs: outcome.durationMs,
  };
  // Omit rather than send undefined: the part is JSON on the wire, and an
  // absent field reads the same on both sides.
  if (outcome.summaryModel) data.summaryModel = outcome.summaryModel;
  if (outcome.summaryText) data.summaryText = outcome.summaryText;
  if (typeof realTokens?.tokensBefore === "number") {
    data.tokensBefore = realTokens.tokensBefore;
  }
  if (typeof realTokens?.tokensAfter === "number") {
    data.tokensAfter = realTokens.tokensAfter;
  }
  return { type: COMPACTION_DATA_PART_TYPE, id: COMPACTION_PART_ID, data };
}

/**
 * The persisted marker, as the thread page hands it to the transcript.
 *
 * Deliberately a small plain object rather than the Cosmos row: it crosses the
 * server/client boundary, so it carries only what the divider renders and none
 * of the row's ids, dates or user hash.
 */
export interface ThreadCompactionMarker {
  /** Newest message the summary covers. The divider renders after this row. */
  coversThroughMessageId: string;
  summaryText?: string;
  summaryModel?: string;
  /** Real last-prompt size before the trim, if it was recorded. */
  realTokensBefore?: number;
  /** Real last-prompt size after the trim. */
  realTokensAfter?: number;
}

/**
 * Narrow a persisted `CHAT_HISTORY_SUMMARY` row to the marker, or null when
 * there is nothing to mark. A row with an empty `content` is still a marker:
 * the turns were dropped, there is just no summary to expand (the feature was
 * off, or the summariser failed).
 */
export function threadCompactionMarker(
  row:
    | {
        coversThroughMessageId?: string | null;
        content?: string | null;
        model?: string | null;
        realTokensBefore?: number | null;
        realTokensAfter?: number | null;
      }
    | null
    | undefined,
): ThreadCompactionMarker | null {
  const watermark = row?.coversThroughMessageId;
  if (!watermark) return null;
  const summaryText = row?.content?.trim() || undefined;
  const summaryModel = row?.model?.trim() || undefined;
  const before = row?.realTokensBefore;
  const after = row?.realTokensAfter;
  return {
    coversThroughMessageId: watermark,
    ...(summaryText ? { summaryText } : {}),
    // A model name without a summary would be a label on nothing.
    ...(summaryText && summaryModel ? { summaryModel } : {}),
    // Real provider numbers from the turn that trimmed, so the divider after a
    // reload says the same thing the live notice said. Rows written before
    // these existed simply have no clause.
    ...(typeof before === "number" && before > 0
      ? { realTokensBefore: before }
      : {}),
    ...(typeof after === "number" && after > 0 ? { realTokensAfter: after } : {}),
  };
}

/**
 * Where the persisted divider goes, and how many turns it stands for.
 *
 * The watermark row is still IN the transcript — a trim drops turns from the
 * prompt, never from Cosmos — so the divider is drawn immediately after it,
 * which is exactly where the conversation the model sees begins.
 *
 * The turn count is derived rather than stored: every user turn at or before
 * the watermark is one the model can no longer quote. (The row's own
 * `coversMessageCount` counts ROWS, cumulatively, so it would say something
 * different and less useful.)
 *
 * Returns null when the watermark row is not in the transcript — the user
 * rewound or deleted messages. Better no divider than one in the wrong place;
 * the same fail-open rule the prompt side applies in `applyHistoryWatermark`.
 */
export function compactionMarkerPlacement(input: {
  marker: ThreadCompactionMarker | null | undefined;
  messages: readonly { id: string; role: string }[];
}): { afterMessageId: string; trimmedTurns: number } | null {
  const watermark = input.marker?.coversThroughMessageId;
  if (!watermark) return null;
  const index = input.messages.findIndex((m) => m.id === watermark);
  if (index === -1) return null;
  let trimmedTurns = 0;
  for (let i = 0; i <= index; i++) {
    if (input.messages[i].role === "user") trimmedTurns++;
  }
  return { afterMessageId: watermark, trimmedTurns };
}

/** Narrowing helper for the transcript's part switch. */
export function isCompactionDataPart(part: {
  type?: string;
}): part is CompactionDataPart {
  return part?.type === COMPACTION_DATA_PART_TYPE;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * Format a token count in full, with thousands separators: 17565 -> "17,565".
 *
 * NOT rounded to "18k". These are the provider's own numbers now, and a reader
 * comparing the notice against the usage panel or an invoice needs the digits
 * to match. The rounding that used to happen here belonged to an estimate.
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  return Math.round(tokens).toLocaleString("en-US");
}

/** "12 older turns" / "1 older turn". */
function turnLabel(count: number): string {
  return `${count} older ${count === 1 ? "turn" : "turns"}`;
}

/**
 * The one line the divider shows. Plain English, short sentences, and it says
 * what happened rather than what the feature is called.
 */
/**
 * The token clause, or nothing.
 *
 * Three shapes, because the numbers arrive late and the first turn has no
 * "before":
 *   both     "(34,012 → 17,565 tokens)"
 *   after    "(17,565 tokens)"       — first turn of a thread
 *   neither  ""                      — the turn has not finished yet
 */
function tokenClause(data: CompactionDoneData): string {
  const after = data.tokensAfter;
  if (typeof after !== "number") return "";
  if (typeof data.tokensBefore === "number") {
    return ` (${formatTokenCount(data.tokensBefore)} → ${formatTokenCount(
      after,
    )} tokens)`;
  }
  return ` (${formatTokenCount(after)} tokens)`;
}

export function compactionNoticeText(data: CompactionData): string {
  const tokens = tokenClause(data);
  switch (data.summaryOutcome) {
    case "ok":
      return `Compacted ${turnLabel(data.trimmedTurns)} into a summary${tokens}`;
    // No reason was recorded, so state the compaction and claim nothing about
    // a summary. Inventing "feature off" here is what made the original defect
    // invisible.
    case "unknown":
      return `Compacted ${turnLabel(data.trimmedTurns)}${tokens}`;
    case "off":
      return `Trimmed ${turnLabel(data.trimmedTurns)} (no summary, feature off)`;
    case "failed":
      return `Trimmed ${turnLabel(
        data.trimmedTurns,
      )} (summary failed, see server log)`;
    case "timeout":
      return `Trimmed ${turnLabel(data.trimmedTurns)} (summary timed out)`;
    case "no-deployment":
      return `Trimmed ${turnLabel(
        data.trimmedTurns,
      )} (no summarizer deployment)`;
  }
}

/**
 * The persisted marker's line, shown after a reload. Carries the same real
 * numbers the live notice ended on, when the row recorded them.
 */
export function compactionMarkerText(
  trimmedTurns: number,
  realTokens?: { tokensBefore?: number; tokensAfter?: number },
): string {
  const base = `Conversation compacted here · ${turnLabel(trimmedTurns)}`;
  const after = realTokens?.tokensAfter;
  if (typeof after !== "number") return base;
  if (typeof realTokens?.tokensBefore === "number") {
    return `${base} · ${formatTokenCount(
      realTokens.tokensBefore,
    )} → ${formatTokenCount(after)} tokens`;
  }
  return `${base} · ${formatTokenCount(after)} tokens`;
}
