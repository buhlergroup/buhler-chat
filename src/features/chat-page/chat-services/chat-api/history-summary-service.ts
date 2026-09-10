import "server-only";

/**
 * Why there is no `"use server"` here
 * -----------------------------------
 * `"use server"` marks a module as a SERVER ACTION surface: Next turns every
 * export into an RPC endpoint a client component may call, and therefore
 * rejects any export that is not an async function. This module is reached
 * only from other server modules, never from a client component, so it wants
 * the opposite guarantee — "never bundle me for the browser" — which is what
 * `import "server-only"` gives. That is the convention the neighbouring
 * non-action server modules follow (`persist-assistant.ts`, `rate-limit.ts`,
 * `stream-publisher.ts`, ...). Do not add the directive back: it is not needed
 * for a server module, and it breaks `next build` the moment this file gains a
 * sync export.
 */

/**
 * history-summary-service.ts
 *
 * Impure half of history compaction: the Cosmos read/write of the thread's
 * compaction row and the model call that fills in its summary text.
 * Everything prompt-shaped lives in `history-summary.ts` and is unit-tested
 * there.
 *
 * ## Two jobs, one row
 *
 * The row this module manages carries two things:
 *
 *   - `coversThroughMessageId` — the WATERMARK. Load-bearing regardless of any
 *     feature flag: it is what makes a trim stick instead of sliding forward a
 *     turn at a time (see `applyHistoryWatermark`). The row is therefore
 *     written on every trim, summarisation or not.
 *   - `content` — the summary of everything up to the watermark. Empty when
 *     summarisation is off or when the summariser failed. An empty summary
 *     replays nothing; the watermark still holds.
 *
 * ## Feature gating
 *
 * Summary TEXT is produced only when `HISTORY_SUMMARY_ENABLED=true`. With the
 * flag off, an over-budget thread is still trimmed and still watermarked — it
 * just loses the dropped block rather than getting a précis of it. That
 * ordering is deliberate: the cost and cache benefit of the trim must not
 * depend on a second model call working.
 *
 * ## Failure policy
 *
 * Every failure path degrades and never throws into the chat turn. A
 * summariser that is down, rate-limited or misconfigured must cost the user a
 * bit of old context, not their answer.
 */

import { SqlQuerySpec } from "@azure/cosmos";
import { userHashedId } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { generateText } from "ai";
import { resolveProvider } from "../models/provider-seam";
import { reportHistorySummaryTokens } from "@/features/common/services/chat-metrics-service";
import { logError, logInfo, logWarn } from "@/features/common/services/logger";
import { estimateTextTokens, type BudgetMessage } from "./history-budget";
import { MODEL_CONFIGS, type ChatModel, type ModelConfig } from "../models";
import type { SummaryOutcome } from "./compaction-part";
import {
  HISTORY_SUMMARY_ATTRIBUTE,
  HISTORY_SUMMARY_SYSTEM_PROMPT,
  buildHistorySummaryPrompt,
  buildHistorySummaryRow,
  type ChatHistorySummaryModel,
} from "./history-summary";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Feature flag. Strict equality with "true" — anything else is off. */
export function isHistorySummaryEnabled(): boolean {
  return process.env.HISTORY_SUMMARY_ENABLED === "true";
}

/** Where the summariser model came from. Logged, so a surprise is traceable. */
export type HistorySummaryModelSource =
  | "env"
  | "thread"
  | "terra"
  | "luna"
  | "titles";

export interface HistorySummaryModel {
  /** A key of MODEL_CONFIGS — what the provider seam needs to build a client. */
  modelId: ChatModel;
  config: ModelConfig;
  deploymentName: string;
  source: HistorySummaryModelSource;
}

/** The model config that owns a deployment name, if any model does. */
function modelOwningDeployment(
  deploymentName: string,
): { modelId: ChatModel; config: ModelConfig } | undefined {
  for (const [modelId, config] of Object.entries(MODEL_CONFIGS)) {
    if (config.deploymentName && config.deploymentName === deploymentName) {
      return { modelId: modelId as ChatModel, config };
    }
  }
  return undefined;
}

/**
 * The model that summarises, resolved to a MODEL rather than to a bare
 * deployment name.
 *
 * ## Why a model id and not a deployment string
 *
 * This used to return a deployment name and call it through the legacy Azure
 * OpenAI chat-completions client (`*.openai.azure.com` + `api-version`). That
 * client answers **404 Resource not found** for the GPT-5.6 deployments, which
 * are served on the `/openai/v1` surface — so on dev every trim logged
 * "summariser call failed: 404" and the UI reported "no summary, feature off"
 * while the feature was on. The fix is to stop having a second way to reach a
 * model: the summariser now goes through the SAME provider seam as the chat
 * path and the sub-agent, and the seam needs a model id to build the client.
 *
 * A consequence worth naming: because the seam covers all three providers, a
 * Claude or Foundry thread can now summarise on its own model too. The old
 * "fall back to Terra for those" rule existed only because the legacy client
 * could not call them.
 *
 * ## Order
 *
 * `HISTORY_SUMMARY_DEPLOYMENT_NAME` > the thread's own model > Terra > Luna >
 * the deployment already used for thread titles. A candidate that names a
 * deployment no model config owns is SKIPPED and logged — the seam could not
 * build a client for it, and a silent 404 on every trim is what this whole
 * change is fixing.
 *
 * ## Why the thread's own model
 *
 * The block being summarised is the block that model just had in its context.
 * Sending it elsewhere pays for every one of those tokens again, cold, on a
 * deployment that has never seen them — and the summary is the only thing that
 * stands in for the dropped turns, so it is the wrong place to save a few
 * cents.
 *
 * NOTE on caching: a cache READ needs a shared byte prefix. The summariser
 * sends its own instructions first, so it matches nothing today and is billed
 * as uncached input either way. Same model is what makes a prefix-sharing
 * summariser call possible later; it is not on its own a discount.
 */
export function resolveHistorySummaryModel(input?: {
  selectedModel?: ChatModel | string;
}): HistorySummaryModel | undefined {
  const candidates: Array<
    | { source: HistorySummaryModelSource; deploymentName: string | undefined }
    | { source: HistorySummaryModelSource; modelId: string | undefined }
  > = [
    { source: "env", deploymentName: process.env.HISTORY_SUMMARY_DEPLOYMENT_NAME },
    { source: "thread", modelId: input?.selectedModel },
    { source: "terra", modelId: "gpt-5.6-terra" },
    { source: "luna", modelId: "gpt-5.6-luna" },
    {
      source: "titles",
      deploymentName: process.env.AZURE_OPENAI_API_MINI_DEPLOYMENT_NAME,
    },
  ];

  for (const candidate of candidates) {
    if ("deploymentName" in candidate) {
      const name = candidate.deploymentName;
      if (!name) continue;
      const owner = modelOwningDeployment(name);
      if (!owner) {
        // Named a deployment, but no model config claims it — so the seam has
        // no client to build. Skipping beats 404ing on every trim.
        logWarn(
          "history-summary: configured deployment has no model config; trying the next candidate",
          { source: candidate.source, deploymentName: name },
        );
        continue;
      }
      return { ...owner, deploymentName: name, source: candidate.source };
    }

    const modelId = candidate.modelId;
    if (!modelId) continue;
    const config = MODEL_CONFIGS[modelId as ChatModel];
    if (!config?.deploymentName) {
      // Either an id that is not in the table, or a model this environment has
      // not deployed. Both mean "cannot call it"; only the first is worth a log.
      if (candidate.source === "thread" && !config) {
        logWarn("history-summary: thread model is not in MODEL_CONFIGS", {
          modelId,
        });
      }
      continue;
    }
    return {
      modelId: modelId as ChatModel,
      config,
      deploymentName: config.deploymentName,
      source: candidate.source,
    };
  }

  return undefined;
}

/**
 * Hard ceiling on the transcript handed to the summariser, in characters.
 *
 * A trim can drop a very large block — the first trim on a thread that grew
 * past the budget in one enormous tool result, say. Without a cap the
 * summariser call could cost more than the turn it is meant to make cheaper.
 * 400k characters is ~100k estimated tokens, which fits every candidate
 * summariser with room to spare. Over the cap the NEWEST characters are kept:
 * the tail of the dropped block is the part still bearing on what follows it.
 */
const MAX_SUMMARY_INPUT_CHARS = 400_000;

/**
 * Ceiling on what the summariser may EMIT.
 *
 * The prompt asks it to stay under SUMMARY_TOKEN_RESERVE (1,500) tokens, but
 * an instruction is not a limit — and this output is replayed at the front of
 * every later prompt in the thread, so an oversized summary is not a one-off
 * cost, it is rent. 2,000 leaves headroom above the instruction without
 * letting a runaway summary become a permanent line item.
 */
const SUMMARY_MAX_OUTPUT_TOKENS = 2_000;

/**
 * How long the summariser gets before the trim gives up on it.
 *
 * This call sits ON THE REQUEST PATH: it runs inside loadThreadContext, before
 * the stream starts, so every millisecond it takes is a millisecond the user
 * spends looking at nothing. It only happens on a trimming turn — once every
 * few dozen turns — but a throttled or hanging deployment would otherwise
 * stall that turn indefinitely, with no ceiling at all.
 *
 * A timeout is not a degradation here: the fallback is the plain trim, which
 * is what the feature flag being off does anyway. The watermark is still
 * written, so the trim still sticks; only the summary text is lost.
 *
 * 20 seconds is generous for ~2,000 output tokens on the cheapest model in
 * the family, and still well inside what a user will wait for a first token.
 */
export const DEFAULT_HISTORY_SUMMARY_TIMEOUT_MS = 20_000;

/**
 * Resolve the summariser timeout. `HISTORY_SUMMARY_TIMEOUT_MS` overrides the
 * default; a value that is absent, unparseable or non-positive is ignored
 * rather than honoured, because a typo must not turn into "give up
 * immediately" (or, worse, "wait forever").
 */
export function resolveHistorySummaryTimeoutMs(
  raw: string | undefined = process.env.HISTORY_SUMMARY_TIMEOUT_MS,
): number {
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return DEFAULT_HISTORY_SUMMARY_TIMEOUT_MS;
}

/** Thrown when the summariser outruns its budget. Caught by the caller. */
export class HistorySummaryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`history summariser exceeded ${timeoutMs}ms`);
    this.name = "HistorySummaryTimeoutError";
  }
}

/**
 * Run `work` with a deadline. The AbortSignal is handed to the work so a real
 * HTTP call is CANCELLED rather than left running to completion in the
 * background — abandoning it would keep spending on a result nobody reads.
 *
 * The timer is always cleared, so a fast success cannot leave a pending timer
 * holding the process (or a test runner) open.
 */
async function withDeadline<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new HistorySummaryTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Cosmos: read
// ---------------------------------------------------------------------------

/**
 * Read the thread's compaction row, or null when there is none.
 *
 * Returns null rather than an error envelope on failure. A missing row and an
 * unreadable row lead to the same behaviour — treat the thread as
 * un-compacted — so a caller has nothing useful to do with the distinction.
 * The cost of the false negative is one extra trim, not a wrong answer.
 */
export async function FindChatHistorySummary(
  threadId: string,
): Promise<ChatHistorySummaryModel | null> {
  try {
    const querySpec: SqlQuerySpec = {
      query:
        "SELECT * FROM root r WHERE r.type=@type AND r.threadId=@threadId AND r.userId=@userId AND r.isDeleted=@isDeleted",
      parameters: [
        { name: "@type", value: HISTORY_SUMMARY_ATTRIBUTE },
        { name: "@threadId", value: threadId },
        { name: "@userId", value: await userHashedId() },
        { name: "@isDeleted", value: false },
      ],
    };

    const { resources } = await HistoryContainer()
      .items.query<ChatHistorySummaryModel>(querySpec)
      .fetchAll();

    return resources[0] ?? null;
  } catch (e) {
    logWarn("history-summary: failed to read compaction row", {
      threadId,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cosmos: write
// ---------------------------------------------------------------------------

/** Upsert the thread's single compaction row. Returns false on failure. */
export async function UpsertChatHistorySummary(
  row: ChatHistorySummaryModel,
): Promise<boolean> {
  try {
    await HistoryContainer().items.upsert<ChatHistorySummaryModel>(row);
    return true;
  } catch (e) {
    logError("history-summary: failed to persist compaction row", {
      threadId: row.threadId,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Soft-delete the thread's compaction row.
 *
 * Called when a thread's messages are soft-deleted — a "delete from here"
 * rewind, or the whole thread going away. A summary that outlives the rows it
 * describes is worse than no summary: the model would keep citing content the
 * user deliberately removed, with nothing in the visible transcript to explain
 * where it came from. Clearing the watermark at the same time lets the budget
 * re-derive a cut from whatever is left.
 */
export async function SoftDeleteChatHistorySummary(
  threadId: string,
): Promise<void> {
  const existing = await FindChatHistorySummary(threadId);
  if (!existing) return;
  await UpsertChatHistorySummary({ ...existing, isDeleted: true });
}

// ---------------------------------------------------------------------------
// The model call
// ---------------------------------------------------------------------------

/** What the summariser produced, plus what it cost. */
export interface SummariserResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Function that turns a prompt pair into summary text. Injected by
 * `recordHistoryCompaction` so unit tests never reach a model; the default is
 * `callSummariserModel`.
 */
export type SummariserFn = (input: {
  systemPrompt: string;
  userPrompt: string;
  /** The model to call — a MODEL_CONFIGS key, not a bare deployment name. */
  modelId: ChatModel;
  /** Kept for logs and for the row's `model` field. */
  deployment: string;
  threadId: string;
  /**
   * Trips when the summariser has outrun its deadline. Forwarded to the
   * provider call so it is cancelled rather than abandoned. A fake in a test
   * may ignore it — the deadline is enforced by the caller either way.
   */
  signal?: AbortSignal;
}) => Promise<SummariserResult>;

/**
 * Default summariser: one non-streaming `generateText` through the provider
 * seam — the SAME path the chat route and the sub-agent take.
 *
 * ## Why not the legacy client
 *
 * This used to call `OpenAIV1Instance().chat.completions.create` against
 * `*.openai.azure.com` with an `api-version`. That surface answers **404
 * Resource not found** for the GPT-5.6 deployments, which live on
 * `/openai/v1`, so every trim failed and the UI blamed the feature flag. Two
 * ways to reach a model meant one of them could rot unnoticed; now there is
 * one, and it is the one the chat path exercises on every turn.
 *
 * ## The options, and why each is set
 *
 * - `maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS` (2,000) — the prompt asks for
 *   brevity, this enforces it. The summary is replayed in every later prompt
 *   of the thread, so its size is rent rather than a one-off.
 * - reasoning effort "low", and NOT "none". There is nothing to reason about
 *   here — compress the transcript in front of you — and reasoning tokens come
 *   out of the same 2,000, so a thinking summariser can deliberate its way
 *   into a truncated summary. "none" would be better still, and the 5.6 family
 *   declares it. But the picker only ever offers minimal/low/medium/high, so
 *   NO live call has ever sent "none" to these deployments: it is exactly the
 *   kind of unproven provider combination that produced the 404 above. "low"
 *   is what every 5.6 turn already sends. Revisit with a live check.
 * - `reasoningSummary` and `include: ["reasoning.encrypted_content"]` are
 *   dropped from the seam's options. They exist so the chat UI can render a
 *   thinking panel; nobody reads a summariser's reasoning, and asking for an
 *   encrypted reasoning blob we throw away is payload for nothing.
 * - `promptCacheKey: summary:<threadId>` — its own namespace. The summariser
 *   prefix (its instructions) has nothing in common with the thread's prompt
 *   prefix, so sharing the thread's key would only pollute it. Derived from
 *   the thread id, never from an email.
 * - `store: false` comes from the seam, as on every other call.
 */
async function callSummariserModel(input: {
  systemPrompt: string;
  userPrompt: string;
  modelId: ChatModel;
  deployment: string;
  threadId: string;
  signal?: AbortSignal;
}): Promise<SummariserResult> {
  const config = MODEL_CONFIGS[input.modelId];
  const resolved = resolveProvider({
    modelId: input.modelId,
    thread: { id: input.threadId, codeInterpreterContainerId: undefined },
    // A summariser has no tools. It reads a transcript and writes prose.
    toggles: { codeInterpreter: false, imageGeneration: false, webSearch: false },
    reasoning: {
      supported: config?.supportsReasoning ?? false,
      effort: "low",
    },
    promptCacheKey: `summary:${input.threadId}`,
  });

  // Keep the cache key, `store: false` and the cache options; drop the two
  // fields that only feed a thinking panel this call has no UI for.
  const providerOptions = { ...resolved.providerOptions };
  if (providerOptions.openai) {
    const { reasoningSummary: _summary, include: _include, ...rest } =
      providerOptions.openai;
    providerOptions.openai = rest;
  }

  const result = await generateText({
    model: resolved.model,
    instructions: input.systemPrompt,
    messages: [{ role: "user", content: input.userPrompt }],
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    providerOptions,
    abortSignal: input.signal,
  });

  return {
    text: result.text.trim(),
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
//
// NOT BILLED TO THE USER, on purpose, but MEASURED. The summariser's tokens
// never reach the budget service, so they land in neither the user's daily
// cost cap nor the usage figure the chat header shows: the user did not ask
// for this call — the budget did, to make their thread cheaper — so charging
// their quota for our own housekeeping would be wrong.
//
// They are still reported as the `historySummaryTokens` metric, because "not
// billed to the user" must not mean "invisible". A feature that spends money
// on the platform's behalf needs a number someone can look at, which is also
// how the 404 that made every trim fail would have been noticed sooner.

export interface RecordHistoryCompactionInput {
  threadId: string;
  /** Hashed user id — also the history container's partition key. */
  userId: string;
  /** The block the trim removed, oldest-first. */
  droppedMessages: readonly BudgetMessage[];
  /** Cosmos id of the newest dropped row: the new watermark. */
  coversThroughMessageId: string;
  /** The row being replaced, if the thread had already been compacted. */
  previous?: ChatHistorySummaryModel | null;
  /**
   * The thread's model. The summariser runs on it by default — the dropped
   * block is the block this model just had in context, and re-sending it to
   * another deployment pays for all of it again, cold.
   */
  selectedModel?: ChatModel | string;
  /** Test seam. Defaults to the real model call. */
  summarise?: SummariserFn;
}

/**
 * Record a compaction: advance the watermark and, when enabled, summarise the
 * block that was dropped.
 *
 * Called ONCE per compaction, which is once every few dozen turns rather than
 * once per turn — a compaction empties the eligible history, so the thread has
 * to grow all the way back to the budget before the next one. That is where
 * the hysteresis comes from; `planHistoryTrim` has no target and no ratio.
 *
 * The previous summary is folded into the new one rather than being kept
 * alongside it, so a thread never accumulates a chain of summaries and one row
 * always accounts for the entire compacted span.
 *
 * Returns the stored row, or null if even the watermark could not be written
 * (in which case the caller has still compacted this turn, and will
 * compact again next turn).
 */
export async function recordHistoryCompaction(
  input: RecordHistoryCompactionInput,
): Promise<ChatHistorySummaryModel | null> {
  const previousContent = input.previous?.content?.trim() || undefined;
  const previousCount = input.previous?.coversMessageCount ?? 0;

  let content = "";
  let model = "";
  // "off" until something is actually attempted. `droppedMessages` can be
  // empty on a watermark-only advance, which is not a summariser failure.
  let summaryOutcome: SummaryOutcome = "off";

  if (isHistorySummaryEnabled() && input.droppedMessages.length > 0) {
    const summarised = await summariseDroppedBlock({
      threadId: input.threadId,
      droppedMessages: input.droppedMessages,
      previousSummary: previousContent,
      ...(input.selectedModel ? { selectedModel: input.selectedModel } : {}),
      summarise: input.summarise,
    });
    summaryOutcome = summarised.outcome;
    if (summarised.outcome === "ok") {
      content = summarised.content;
      model = summarised.model;
    } else if (previousContent) {
      // The summariser did not produce anything, but an earlier summary
      // exists. It still correctly describes everything BEFORE this block, so
      // carry it forward verbatim rather than discarding context we already
      // paid for. The newly dropped block is the only thing lost — and the
      // outcome stays the failure it was, so the UI does not present a stale
      // summary as this block's.
      content = previousContent;
      model = input.previous?.model ?? "";
    }
  } else if (previousContent) {
    // Summarisation disabled, but this thread was compacted while it was on.
    // Keep the text; only the watermark moves.
    content = previousContent;
    model = input.previous?.model ?? "";
  }

  const row = buildHistorySummaryRow({
    threadId: input.threadId,
    userId: input.userId,
    content,
    coversThroughMessageId: input.coversThroughMessageId,
    coversMessageCount: previousCount + input.droppedMessages.length,
    model,
    estimatedTokens: estimateTextTokens(content),
    summaryOutcome,
  });

  const persisted = await UpsertChatHistorySummary(row);
  if (!persisted) return null;

  logInfo("history-summary: recorded history compaction", {
    threadId: input.threadId,
    coversThroughMessageId: row.coversThroughMessageId,
    coversMessageCount: row.coversMessageCount,
    droppedThisTrim: input.droppedMessages.length,
    summaryOutcome,
    model: row.model,
    estimatedTokens: row.estimatedTokens,
  });

  return row;
}

/**
 * Stamp the trimming turn's REAL token numbers onto the compaction row.
 *
 * A second pass, because `realTokensAfter` — the trimming request's own
 * `inputTokens` — does not exist until that request finishes, and the row is
 * written before the model is called. One extra upsert, on trimming turns
 * only, so the divider a reloaded page draws can carry the same provider
 * numbers the live notice ended on instead of falling back to nothing.
 *
 * Fails soft: the numbers are a nicety on a row whose real job (the watermark)
 * is already done, and this runs after the user has their answer.
 */
export async function recordHistoryCompactionRealUsage(input: {
  threadId: string;
  realTokensBefore?: number;
  realTokensAfter: number;
}): Promise<void> {
  try {
    const existing = await FindChatHistorySummary(input.threadId);
    if (!existing) return;
    await UpsertChatHistorySummary({
      ...existing,
      ...(typeof input.realTokensBefore === "number" && input.realTokensBefore > 0
        ? { realTokensBefore: input.realTokensBefore }
        : {}),
      realTokensAfter: input.realTokensAfter,
    });
  } catch (e) {
    logWarn("history-summary: could not record the trim's real token counts", {
      threadId: input.threadId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Run the summariser over one dropped block.
 *
 * Reports WHY rather than just whether: a missing deployment, a throwing call,
 * a timeout and an empty answer are four different problems, and a boolean
 * made them all look like "the feature is off" on screen. That is exactly how
 * a 404 on every trim went unnoticed.
 *
 * Every failure falls back to the same place: the plain trim. The watermark is
 * still written by the caller, so the trim still sticks and the prompt is
 * still cheap; what is lost is the summary text, which is what the feature
 * flag being off costs anyway. Nothing here throws — a summariser problem must
 * never fail the user's turn.
 */
async function summariseDroppedBlock(input: {
  threadId: string;
  droppedMessages: readonly BudgetMessage[];
  previousSummary?: string;
  selectedModel?: ChatModel | string;
  summarise?: SummariserFn;
}): Promise<{ content: string; model: string; outcome: SummaryOutcome }> {
  const chosen = resolveHistorySummaryModel(
    input.selectedModel ? { selectedModel: input.selectedModel } : undefined,
  );
  if (!chosen) {
    logWarn(
      "history-summary: enabled but no summariser model resolved; falling back to plain trimming",
      { threadId: input.threadId },
    );
    return { content: "", model: "", outcome: "no-deployment" };
  }
  const deployment = chosen.deploymentName;

  const fullPrompt = buildHistorySummaryPrompt({
    messages: input.droppedMessages,
    previousSummary: input.previousSummary,
  });
  const userPrompt =
    fullPrompt.length > MAX_SUMMARY_INPUT_CHARS
      ? fullPrompt.slice(fullPrompt.length - MAX_SUMMARY_INPUT_CHARS)
      : fullPrompt;

  const summarise = input.summarise ?? callSummariserModel;
  const timeoutMs = resolveHistorySummaryTimeoutMs();

  let raw: SummariserResult;
  try {
    // Bounded even for an injected fake: the deadline belongs to the request
    // path, not to whichever summariser happens to be wired in.
    raw = await withDeadline(timeoutMs, (signal) =>
      summarise({
        systemPrompt: HISTORY_SUMMARY_SYSTEM_PROMPT,
        userPrompt,
        modelId: chosen.modelId,
        deployment,
        threadId: input.threadId,
        signal,
      }),
    );
  } catch (e) {
    const timedOut = e instanceof HistorySummaryTimeoutError;
    logWarn(
      timedOut
        ? "history-summary: summariser timed out; falling back to plain trimming"
        : "history-summary: summariser call failed; falling back to plain trimming",
      {
        threadId: input.threadId,
        modelId: chosen.modelId,
        deployment,
        modelSource: chosen.source,
        droppedMessageCount: input.droppedMessages.length,
        timedOut,
        timeoutMs,
        error: e instanceof Error ? e.message : String(e),
      },
    );
    return {
      content: "",
      model: "",
      outcome: timedOut ? "timeout" : "failed",
    };
  }

  // Reported whatever the answer looked like: a call that burned tokens and
  // returned nothing still cost money, and that is the case most worth seeing.
  await reportSummariserUsage({
    threadId: input.threadId,
    modelId: chosen.modelId,
    inputTokens: raw.inputTokens ?? 0,
    outputTokens: raw.outputTokens ?? 0,
  });

  const content = raw.text?.trim() ?? "";
  if (content.length === 0) {
    logWarn(
      "history-summary: summariser returned nothing; falling back to plain trimming",
      { threadId: input.threadId, modelId: chosen.modelId, deployment },
    );
    return { content: "", model: "", outcome: "failed" };
  }

  logInfo("history-summary: summarised the dropped block", {
    threadId: input.threadId,
    modelId: chosen.modelId,
    deployment,
    modelSource: chosen.source,
    inputTokens: raw.inputTokens ?? 0,
    outputTokens: raw.outputTokens ?? 0,
    summaryChars: content.length,
  });

  return { content, model: chosen.modelId, outcome: "ok" };
}

/**
 * Emit the summariser's token usage as its own metric.
 *
 * Deliberately NOT the budget service: see the note above the orchestration
 * section. A metric failure must not turn a working summary into a failed one,
 * so this swallows its own errors.
 */
async function reportSummariserUsage(input: {
  threadId: string;
  modelId: ChatModel;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  try {
    await reportHistorySummaryTokens({
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      chatModel: input.modelId,
      threadId: input.threadId,
    });
  } catch (e) {
    logWarn("history-summary: reporting summariser usage failed", {
      threadId: input.threadId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
