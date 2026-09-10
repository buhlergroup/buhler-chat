/**
 * usage-data.ts
 *
 * Shared, side-effect-free computation of the per-request token-usage block
 * the chat header displays (token count, cost estimate, context-window %).
 *
 * Why this exists: the AI SDK v6 migration left the live usage wiring
 * dangling. The store action `setUsageData` was never called on the live
 * path, so the header's `lastUsageData` only ever reflected the value seeded
 * at page load — total tokens updated only after a reload, and per-request
 * input/output always showed 0. The route now ships this block to the client
 * via `toUIMessageStreamResponse({ messageMetadata })` and the chat session's
 * `onFinish` feeds it into the store, so the header updates every turn.
 *
 * The THREAD running totals (threadTotalTokens / threadTotalCostUsd) are NOT
 * computed here: the server-side Cosmos read-modify-write that owns them runs
 * in a different path (persist-assistant). The client merges this per-request
 * block onto the totals it already holds; a reload reconciles from the
 * persisted thread usage. Keeping this pure means it's identical across the
 * Azure (Responses) and Anthropic (Messages) providers — usage is normalised
 * to inputTokens/outputTokens by the SDK before it reaches us.
 */
import type { ModelConfig, ModelPricing } from "../models";

/**
 * Per-request usage block carried on assistant-message metadata.
 *
 * ## Two quantities, deliberately kept apart
 *
 * A turn can be several model calls (steps): the model asks for a tool, we run
 * it, the model is called again with the result. AI SDK 7 rolls the steps up —
 * "When there are multiple steps, the usage is the sum of all step usages"
 * (`StreamTextResult.totalUsage`, ai/dist/index.d.ts) — and that sum is the
 * BILLED figure, because every step really was a request to the provider.
 *
 * It is NOT the size of the prompt. A 3-step turn over a 34,000-token thread
 * bills ~102,000 input tokens and never sends more than ~35,000 in one prompt.
 * So this block carries both:
 *
 *   TURN TOTALS      inputTokens / outputTokens / cachedTokens /
 *                    cacheWriteTokens / totalTokens / costUsd
 *                    — summed over every step. Cost and the cache split are
 *                    facts about the whole turn.
 *   LAST-STEP PROMPT lastPromptTokens — the real `inputTokens` of the LAST
 *                    step, i.e. the size of the last prompt actually sent.
 *                    This is what the context row and the history budget mean
 *                    by "context".
 *
 * `stepCount` is carried with them so the UI can say why the totals exceed the
 * context size.
 */
export interface RequestUsageMetadata {
  /** TURN TOTAL: input tokens summed over every step of the turn. */
  inputTokens: number;
  /** TURN TOTAL: output tokens summed over every step of the turn. */
  outputTokens: number;
  /** TURN TOTAL: input tokens served from the prompt cache. */
  cachedTokens: number;
  /** TURN TOTAL: input tokens the provider wrote INTO the prompt cache. */
  cacheWriteTokens: number;
  /** TURN TOTAL: `inputTokens + outputTokens`. */
  totalTokens: number;
  /** TURN TOTAL: cost of every step of the turn. */
  costUsd: number;
  /**
   * LAST-STEP PROMPT SIZE: the real `inputTokens` of the turn's last step —
   * the size of the last prompt sent to the provider. Equal to `inputTokens`
   * on a single-step turn. This, not the roll-up, is what the context row
   * shows and what the history budget compares against.
   */
  lastPromptTokens: number;
  /** Model calls this turn made. 1 for a plain turn, >1 for a tool turn. */
  stepCount: number;
  contextWindowSize: number;
  /** Share of the context window the LAST PROMPT filled. */
  contextUsagePercent: number;
  model: string;
}

export interface TokenCostArgs {
  /** Total input tokens, INCLUDING the cached-read and cache-write portions. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the prompt cache (billed at the cached rate). */
  cachedTokens: number;
  /** Input tokens written into the prompt cache (billed at the write rate). */
  cacheWriteTokens?: number;
  pricing: ModelPricing | undefined;
}

/**
 * The one cost formula. Every caller (live usage metadata, the persisted
 * thread rollup, the sub-agent tool) routes through here so a price-table
 * change can never land in one place and not the others.
 *
 *   (input − cached − write) x input + cached x cachedInput
 *     + write x cacheWrite + output x output
 *
 * `cacheWritePerMillion` is absent on models that don't surcharge cache
 * writes (gpt-5.5 and older, and the Foundry models). For those the write
 * token count is treated as zero, which leaves those tokens in the
 * uncached-input bucket at the normal input rate — that is exactly how the
 * provider bills them. GPT-5.6 and Anthropic both pull them out into a
 * separately-priced bucket (1.25x uncached input).
 *
 * NOTE on the clamp below: the buckets are assumed DISJOINT and contained in
 * `inputTokens`, which is what both provider adapters guarantee at the pinned
 * SDK versions (@ai-sdk/openai reports cacheRead/cacheWrite as subsets of the
 * total; @ai-sdk/anthropic re-totals input + cacheCreation + cacheRead). A
 * provider that ever reported overlapping buckets would be over-billed here
 * rather than under-billed — deliberate, since a negative bucket would
 * under-state the cost silently.
 */
export function computeTokenCostUsd({
  inputTokens,
  outputTokens,
  cachedTokens,
  cacheWriteTokens = 0,
  pricing,
}: TokenCostArgs): number {
  if (!pricing) return 0;
  const writeTokens =
    pricing.cacheWritePerMillion !== undefined ? cacheWriteTokens : 0;
  const nonCachedInput = Math.max(inputTokens - cachedTokens - writeTokens, 0);
  return (
    (nonCachedInput / 1_000_000) * pricing.inputPerMillion +
    (cachedTokens / 1_000_000) * pricing.cachedInputPerMillion +
    (writeTokens / 1_000_000) * (pricing.cacheWritePerMillion ?? 0) +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

/** Metadata attached to streamed assistant messages. */
export interface ChatMessageMetadata {
  usage?: RequestUsageMetadata;
}

export interface ComputeRequestUsageArgs {
  /** TURN TOTAL, summed over every step. Bills the turn. */
  inputTokens: number;
  /** TURN TOTAL, summed over every step. */
  outputTokens: number;
  /** TURN TOTAL, summed over every step. */
  cachedTokens: number;
  /** TURN TOTAL, summed over every step. */
  cacheWriteTokens?: number;
  /**
   * The LAST step's own `inputTokens` — the size of the last prompt sent.
   *
   * Omitted means "the caller has no step information", and then the turn
   * total stands in. That fallback is exact for a single-step turn and
   * OVERSTATES a multi-step one by roughly the number of steps, which is the
   * defect this field exists to remove; supply it whenever step usage is
   * reachable.
   */
  lastPromptTokens?: number;
  /** Model calls the turn made. Defaults to 1 when the caller cannot say. */
  stepCount?: number;
  modelConfig: Pick<ModelConfig, "id" | "pricing" | "contextWindow">;
}

/**
 * Compute the per-request usage block from raw token counts. Cost comes from
 * the shared computeTokenCostUsd so this block and the persisted thread
 * rollup can never disagree.
 *
 * Cost is billed off the TURN TOTALS; the context share is measured off the
 * LAST-STEP PROMPT SIZE. Mixing the two is what made a 3-step tool turn report
 * three prompts' worth of context for one prompt.
 */
export function computeRequestUsage({
  inputTokens,
  outputTokens,
  cachedTokens,
  cacheWriteTokens = 0,
  lastPromptTokens,
  stepCount,
  modelConfig,
}: ComputeRequestUsageArgs): RequestUsageMetadata {
  const costUsd = computeTokenCostUsd({
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheWriteTokens,
    pricing: modelConfig.pricing,
  });

  // No step information: the roll-up is the best number available, and it is
  // the RIGHT number whenever the turn had exactly one step.
  const promptTokens =
    typeof lastPromptTokens === "number" && Number.isFinite(lastPromptTokens)
      ? lastPromptTokens
      : inputTokens;

  const contextWindowSize = modelConfig.contextWindow ?? 0;
  const contextUsagePercent =
    contextWindowSize > 0 ? (promptTokens / contextWindowSize) * 100 : 0;

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    lastPromptTokens: promptTokens,
    stepCount:
      typeof stepCount === "number" && Number.isFinite(stepCount) && stepCount > 0
        ? stepCount
        : 1,
    contextWindowSize,
    contextUsagePercent,
    model: modelConfig.id,
  };
}
