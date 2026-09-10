/**
 * max-output-tokens.ts
 *
 * Resolves the ceiling on the tokens a turn may emit. Two inputs, in order:
 *
 *   1. the MAX_OUTPUT_TOKENS_OVERRIDES env map, per model id
 *   2. the `maxOutputTokens` on the config the CALLER resolved — passed in,
 *      not looked up here; see ResolveMaxOutputTokensArgs for why
 *
 * ## Why this is a ceiling worth thinking about
 *
 * It is not a context limit — the 5.6 family holds ~1M tokens of input. It is
 * the guardrail against a single runaway turn: a model that loops, or that
 * writes a 200-page answer, bills every one of those tokens at the output
 * rate, which is six times the input rate.
 *
 * The subtlety is that REASONING TOKENS COUNT AGAINST IT. On the Responses API
 * the ceiling covers reasoning plus the visible answer; on Anthropic's
 * Messages API `max_tokens` covers thinking plus the answer. So at effort
 * "high" and above a turn can spend most of its budget thinking and then get
 * cut off mid-sentence — the provider returns `finishReason: "length"` and the
 * user sees a truncated reply. The values here leave room for both, and the
 * chat path surfaces `"length"` rather than letting a truncation pass as a
 * complete answer.
 *
 * ## Why an env override
 *
 * The right ceiling is a cost decision, not a code decision, and it differs
 * per environment: a pilot group doing long-form work needs more headroom than
 * a general deployment. Same shape as REASONING_EFFORT_OVERRIDES so there is
 * one thing to learn.
 */

import { logWarn } from "@/features/common/services/logger";
import { MODEL_CONFIGS, type ChatModel } from "../models";

export type MaxOutputTokensOverrides = Partial<Record<ChatModel, number>>;

/**
 * Parse MAX_OUTPUT_TOKENS_OVERRIDES. Shape: a JSON object of model id →
 * token count, e.g. {"gpt-5.6-terra":48000}. Anything unparseable yields an
 * empty map; individual bad entries are skipped. Never throws.
 *
 * A value has to be a positive integer. Zero, a negative, a fraction, a
 * numeric string and Infinity are all rejected rather than coerced: passing
 * `maxOutputTokens: 0` to the provider is not "no limit", it is a request that
 * can emit nothing, and a fraction is a 400.
 */
export function parseMaxOutputTokensOverrides(
  raw: string | undefined,
): MaxOutputTokensOverrides {
  const value = raw?.trim();
  if (!value) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    logWarn("MAX_OUTPUT_TOKENS_OVERRIDES is not valid JSON — ignoring", { value });
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    logWarn(
      "MAX_OUTPUT_TOKENS_OVERRIDES must be a JSON object of modelId → token count — ignoring",
      { value },
    );
    return {};
  }

  const overrides: MaxOutputTokensOverrides = {};
  for (const [modelId, limit] of Object.entries(parsed as Record<string, unknown>)) {
    // hasOwnProperty, so "__proto__" and "constructor" cannot resolve to
    // something off Object.prototype and pass as a model.
    if (!Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, modelId)) {
      logWarn("MAX_OUTPUT_TOKENS_OVERRIDES names an unknown model — skipping", {
        modelId,
      });
      continue;
    }
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit <= 0
    ) {
      logWarn(
        "MAX_OUTPUT_TOKENS_OVERRIDES value is not a positive integer — skipping",
        { modelId, limit },
      );
      continue;
    }
    overrides[modelId as ChatModel] = limit;
  }
  return overrides;
}

// Parsing happens once per distinct env value; the result is cached so a
// per-turn resolve is a map lookup rather than a JSON.parse plus validation.
let cachedRaw: string | undefined | symbol = Symbol("unset");
let cachedOverrides: MaxOutputTokensOverrides = {};

export function getMaxOutputTokensOverrides(
  raw: string | undefined = process.env.MAX_OUTPUT_TOKENS_OVERRIDES,
): MaxOutputTokensOverrides {
  if (cachedRaw !== raw) {
    cachedRaw = raw;
    cachedOverrides = parseMaxOutputTokensOverrides(raw);
  }
  return cachedOverrides;
}

/** Test seam: forget the memoised env parse. */
export function resetMaxOutputTokensOverridesCache(): void {
  cachedRaw = Symbol("unset");
  cachedOverrides = {};
}

export interface ResolveMaxOutputTokensArgs {
  /** The model that will actually run the turn — the override map's key. */
  modelId: ChatModel;
  /**
   * The ceiling from the config the CALLER already resolved, i.e.
   * `modelConfig.maxOutputTokens`.
   *
   * Passed in rather than looked up here on purpose. The caller has the config
   * for the effective model in hand, and re-deriving it from MODEL_CONFIGS
   * would make this a second source of truth for the same decision — the very
   * pattern that produced the document-hint defect earlier in this branch,
   * where one place read the thread's model and another read the effective
   * one. `resolveHistoryTokenBudget` takes its `modelBudget` the same way.
   */
  modelValue?: number;
  /** Overridable for tests; defaults to the parsed env map. */
  overrides?: MaxOutputTokensOverrides;
}

/**
 * The ceiling for a turn: env override → the value the caller's config names.
 *
 * Returns undefined when neither names one, which the AI SDK reads as "no
 * ceiling" — the provider default applies. That is the pre-existing behaviour
 * for a model config that sets nothing, so an unconfigured model is not
 * silently capped at someone else's number.
 *
 * One resolver, called from both the chat route and the sub-agent tool, so the
 * two cannot drift the way they did when each read `modelConfig` directly.
 */
export function resolveMaxOutputTokens({
  modelId,
  modelValue,
  overrides = getMaxOutputTokensOverrides(),
}: ResolveMaxOutputTokensArgs): number | undefined {
  return overrides[modelId] ?? modelValue;
}
