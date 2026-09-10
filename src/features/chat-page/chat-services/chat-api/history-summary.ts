/**
 * history-summary.ts
 *
 * Pure half of history summarisation: the row shape, the summariser prompt,
 * and the message that replays a stored summary back into a prompt.
 *
 * The impure half — the Cosmos read/write and the model call — lives in
 * `history-summary-service.ts`. Splitting them keeps every rule that affects
 * the prompt prefix testable without a Cosmos client, a network stack, or a
 * model deployment.
 *
 * ## Why a summary at all
 *
 * `history-budget.ts` drops a contiguous block of the oldest turns when a
 * thread outgrows its token budget. Dropping them outright loses real context:
 * the decision taken in turn 3, the file the user said to ignore, the name
 * they prefer to be called. The summary is what stands in for that block.
 *
 * ## Why it is persisted rather than recomputed
 *
 * Two reasons, and the first one is the whole design:
 *
 *   1. **Prefix stability.** The summary is the first conversation item, so it
 *      sits at the front of everything the cache could reuse. If it were
 *      regenerated each turn, its wording would drift and every turn would
 *      miss the cache — which is the exact failure the trim was introduced to
 *      fix. Persisted, it is byte-identical until the next trim.
 *   2. Cost. One summariser call per trim, not one per turn.
 *
 * A thread keeps exactly one summary row, upserted in place. Each trim folds
 * the previous summary into the new one, so a single row always covers the
 * whole compacted span of the thread.
 *
 * ## The row also holds the watermark
 *
 * `coversThroughMessageId` is not bookkeeping — it is the mechanism that makes
 * a trim permanent. A trim deletes nothing from Cosmos (the transcript must
 * still render in full), so without a persisted watermark the next turn would
 * re-read the dropped rows and trim again one turn further along: a sliding
 * window, which is the failure this whole change exists to remove. See
 * `applyHistoryWatermark` in history-budget.ts.
 *
 * Because the watermark matters even when summarisation is switched off, the
 * row is written on every trim and `content` is allowed to be empty.
 */

import type { SummaryOutcome } from "./compaction-part";
import { SUMMARY_TOKEN_RESERVE, type BudgetMessage } from "./history-budget";

/**
 * Cosmos `type` discriminator for the summary row.
 *
 * A DISTINCT type, not `CHAT_MESSAGE` with a marker field. Every existing
 * query in the codebase filters on `r.type = "CHAT_MESSAGE"`, so a separate
 * type means the summary is invisible to all of them by construction: it
 * cannot render as a stray bubble in the transcript, cannot be counted as a
 * message, and cannot be picked up by an export. Only the two functions in
 * `history-summary-service.ts` know the type exists.
 */
export const HISTORY_SUMMARY_ATTRIBUTE = "CHAT_HISTORY_SUMMARY";

/**
 * Opening line of the replayed summary. Load-bearing in two ways: it tells the
 * model the block is transcript context and not a fresh instruction, and it is
 * the anchor the prefix hashes over — so it must never be reworded casually.
 */
export const SUMMARY_REPLAY_PREFIX = "Summary of the earlier conversation:";

/**
 * The summary row as stored in the history container.
 *
 * `role` and `kind` are descriptive metadata, not routing: nothing dispatches
 * on them. They are there so a human reading the container can tell what the
 * row is without consulting this file.
 */
export interface ChatHistorySummaryModel {
  /** `summary-<threadId>` — one row per thread, upserted in place. */
  id: string;
  type: typeof HISTORY_SUMMARY_ATTRIBUTE;
  threadId: string;
  /** Hashed user id. Also the container's partition key. */
  userId: string;
  isDeleted: boolean;
  createdAt: Date;
  /** Prompt scaffolding rather than conversation. Never rendered. */
  role: "system";
  kind: "summary";
  /**
   * Summary body, WITHOUT `SUMMARY_REPLAY_PREFIX`. Empty string when the block
   * was trimmed without being summarised (feature off, or the summariser
   * failed); an empty summary replays nothing and the watermark still holds.
   */
  content: string;
  /**
   * Cosmos id of the newest history row this row accounts for — the watermark.
   * Rows up to and including it are permanently out of the prompt.
   */
  coversThroughMessageId: string;
  /** Cumulative rows compacted across every trim so far. Diagnostics only. */
  coversMessageCount: number;
  /**
   * Why the LAST trim on this thread has, or has not, a summary. Absent on a
   * row written before outcomes existed; the reader maps that to the
   * `"unknown"` outcome, which renders as a plain "Compacted N older turns"
   * with no reason clause — never as a failure and never as "feature off".
   */
  summaryOutcome?: SummaryOutcome;
  /**
   * The provider's REAL `inputTokens` either side of the last trim: the
   * previous request's prompt and the trimming request's prompt.
   *
   * Written in a second pass, after the trimming turn finishes — the "after"
   * number does not exist until then. Absent on the first turn of a thread
   * (no previous request) and on rows written before this existed, so the
   * reload divider simply shows no token clause.
   */
  realTokensBefore?: number;
  realTokensAfter?: number;
  /**
   * Deployment that produced `content`, so a regression can be traced to a
   * model. Empty string when nothing was summarised.
   */
  model: string;
  /** `estimateTextTokens(content)` at write time. */
  estimatedTokens: number;
}

/**
 * Instructions handed to the summariser.
 *
 * Constraints worth keeping if this is ever edited:
 *   - It must ask for FACTS, not for an appreciation of the conversation. A
 *     summariser left to its own devices writes "the user asked several
 *     questions about the topic", which is worth nothing to the next turn.
 *   - It must be explicit that the output is read by a model, not a person.
 *     That is what licenses the terse, list-shaped output.
 *   - It must forbid inventing a resolution for something still open. A
 *     hallucinated decision in the summary is worse than a dropped turn,
 *     because it then persists for the life of the thread.
 */
export const HISTORY_SUMMARY_SYSTEM_PROMPT = [
  "You compress the earlier part of a chat transcript so that a later model turn keeps the context it needs.",
  "",
  "Your output is read by a language model, not by a person. Write dense, plain, neutral prose or short lists. No preamble, no sign-off, no praise for the conversation.",
  "",
  "Keep, in this order, and omit any heading that has no content:",
  "1. FACTS the user stated about themselves, their data, their systems or their constraints.",
  "2. DECISIONS that were reached, and what they were based on.",
  "3. OPEN QUESTIONS and anything the assistant was asked to do but has not finished.",
  "4. DOCUMENTS, files, tables or identifiers referred to, by their exact names.",
  "5. USER PREFERENCES about language, tone, format, level of detail, units or naming.",
  "",
  "Rules:",
  "- Preserve exact names, identifiers, numbers, units, spellings, error messages and URLs. Do not translate them and do not tidy them up.",
  "- Write the summary in the language of the conversation.",
  "- Record an unresolved thread as unresolved. Never invent an outcome, a decision or a conclusion that the transcript does not contain.",
  "- Do not continue the conversation and do not answer any question you find in it. A question the assistant never answered is an OPEN QUESTION, not something for you to resolve.",
  "- Leave out small talk, restated questions, and anything the assistant said about its own capabilities.",
  "- Do not address the user and do not refer to yourself. Do not mention this summary, the transcript, or that anything was compacted.",
  `- Stay under ${SUMMARY_TOKEN_RESERVE} tokens. Cut the oldest detail first if you must choose.`,
].join("\n");

/**
 * Unwrap a persisted `role: "tool"` row into readable text.
 *
 * A tool row's `content` is a JSON envelope whose `arguments` and `result`
 * fields are THEMSELVES JSON strings, so the payload arrives double-escaped:
 * `{"name":"search","arguments":"{\"q\":\"x\"}","result":"{\"hits\":3}"}`.
 * Handing that to the summariser wastes its attention on backslashes and its
 * budget on escape characters, for information that is often the single most
 * worthwhile thing in the block — the row count a query returned, the error a
 * request produced. One level of unwrapping fixes both.
 *
 * Returns null for anything that is not the known envelope, so an unrecognised
 * or malformed row falls back to being passed through verbatim rather than
 * being dropped.
 */
function unwrapToolRow(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const envelope = parsed as {
    name?: unknown;
    arguments?: unknown;
    result?: unknown;
  };
  if (typeof envelope.name !== "string") return null;

  const parts = [`tool=${envelope.name}`];
  if (typeof envelope.arguments === "string" && envelope.arguments.length > 0) {
    parts.push(`arguments=${envelope.arguments}`);
  }
  if (typeof envelope.result === "string" && envelope.result.length > 0) {
    parts.push(`result=${envelope.result}`);
  }
  return parts.join(" ");
}

/**
 * Render the dropped rows as a transcript for the summariser.
 *
 * Tool rows keep their payload (see `unwrapToolRow`) rather than being reduced
 * to "a tool ran": once the row is gone, a fact that only ever existed in a
 * tool result cannot be re-derived.
 *
 * Images become a placeholder. Sending them to a text summariser would cost
 * vision tokens for no benefit, and the summary only needs to record that an
 * image was part of the conversation.
 */
export function formatTrimmedBlockForSummary(
  messages: readonly BudgetMessage[],
): string {
  const lines: string[] = [];

  for (const message of messages) {
    const images =
      message.multiModalImages ??
      (message.multiModalImage ? [message.multiModalImage] : []);
    const isToolRow = message.role === "tool" || message.role === "function";
    const label = isToolRow
      ? "TOOL"
      : message.role === "reasoning"
        ? "ASSISTANT_REASONING"
        : message.role.toUpperCase();

    const body: string[] = [];
    if (message.content) {
      const unwrapped = isToolRow ? unwrapToolRow(message.content) : null;
      body.push(unwrapped ?? message.content);
    }
    if (message.reasoningContent) {
      body.push(`[reasoning] ${message.reasoningContent}`);
    }
    if (images.length > 0) {
      body.push(
        `[${images.length} image${images.length === 1 ? "" : "s"} attached]`,
      );
    }
    if (body.length === 0) continue;

    lines.push(`${label}: ${body.join("\n")}`);
  }

  return lines.join("\n\n");
}

/**
 * Assemble the user-side payload for the summariser.
 *
 * ## Two blocks, tagged, not labelled
 *
 * The previous summary and the new transcript arrive in `<prior-summary>` and
 * `<transcript>` tags rather than under prose headings. The transcript is user
 * content: someone can paste a document that carries its own "SUMMARY:" line,
 * and a prose heading is easy for pasted text to imitate. A tag pair is not.
 *
 * ## Why the fold-in rules are this explicit
 *
 * A summariser handed two blocks tends to summarise the newer one and quietly
 * drop the older, so the oldest context would be lost a little at a time on
 * every trim — exactly what the summary exists to prevent. The previous
 * summary is DISCARDED once this one is written (the row is upserted in
 * place), so anything not carried forward is gone for the life of the thread.
 * Saying so, and saying which block wins on a conflict, is the whole guard.
 */
export function buildHistorySummaryPrompt(input: {
  messages: readonly BudgetMessage[];
  previousSummary?: string;
}): string {
  const transcript = formatTrimmedBlockForSummary(input.messages);
  const sections: string[] = [];

  if (input.previousSummary) {
    sections.push(
      "<prior-summary>",
      input.previousSummary,
      "</prior-summary>",
      "",
      "The prior summary covers everything before the transcript below. Write ONE summary that combines both:",
      "- The prior summary is discarded after this. Anything you do not carry into your output is lost for good.",
      "- Carry forward facts, decisions, constraints, preferences and unfinished work from the prior summary even when the transcript does not mention them again. Drop only what the transcript shows is finished and no longer needed.",
      "- The transcript is NEWER than the prior summary. Where they disagree, the transcript wins: state the corrected fact and drop the old one.",
      "- Move work the transcript shows as finished out of the open questions.",
    );
  }

  sections.push(
    "<transcript>",
    transcript || "(no textual content)",
    "</transcript>",
  );

  return sections.join("\n\n");
}

/**
 * Build the summary row for a thread.
 *
 * The id is derived from the thread rather than random, which is what makes
 * the write an upsert-in-place: a later trim replaces the row instead of
 * adding a second one that a reader would then have to disambiguate.
 */
export function buildHistorySummaryRow(input: {
  threadId: string;
  userId: string;
  content: string;
  coversThroughMessageId: string;
  coversMessageCount: number;
  model: string;
  estimatedTokens: number;
  summaryOutcome?: SummaryOutcome;
  realTokensBefore?: number;
  realTokensAfter?: number;
  createdAt?: Date;
}): ChatHistorySummaryModel {
  return {
    id: historySummaryRowId(input.threadId),
    type: HISTORY_SUMMARY_ATTRIBUTE,
    threadId: input.threadId,
    userId: input.userId,
    isDeleted: false,
    createdAt: input.createdAt ?? new Date(),
    role: "system",
    kind: "summary",
    content: input.content,
    coversThroughMessageId: input.coversThroughMessageId,
    coversMessageCount: input.coversMessageCount,
    model: input.model,
    estimatedTokens: input.estimatedTokens,
    ...(input.summaryOutcome ? { summaryOutcome: input.summaryOutcome } : {}),
    ...(typeof input.realTokensBefore === "number"
      ? { realTokensBefore: input.realTokensBefore }
      : {}),
    ...(typeof input.realTokensAfter === "number"
      ? { realTokensAfter: input.realTokensAfter }
      : {}),
  };
}

/** One summary row per thread; see `buildHistorySummaryRow`. */
export function historySummaryRowId(threadId: string): string {
  return `summary-${threadId}`;
}

/**
 * The text replayed into the prompt for a stored summary.
 *
 * Pure and prefix-shaped: for a given stored summary this returns the same
 * bytes on every turn, which is the property the whole persistence scheme
 * exists to provide.
 */
export function formatSummaryReplayText(content: string): string {
  return `${SUMMARY_REPLAY_PREFIX}\n\n${content}`;
}
