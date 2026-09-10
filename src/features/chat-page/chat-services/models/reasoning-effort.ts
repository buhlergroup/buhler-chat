/**
 * reasoning-effort.ts
 *
 * Resolves the reasoning effort a turn runs at. Three inputs, in order:
 *
 *   1. an explicit user pick (the picker, or the effort pinned on the thread)
 *   2. the REASONING_EFFORT_OVERRIDES env map, per model id
 *   3. the model's own defaultReasoningEffort
 *
 * The env map exists so a deployment can dial a model up or down without a
 * code change — e.g. run the default model at "high" for a pilot group's
 * environment. Values are validated against the levels the model's provider
 * actually accepts (GPT-5.6 takes none/low/medium/high/xhigh/max, GPT-5.5
 * stops at xhigh); an invalid entry is dropped with a warning rather than
 * sent, because a level the model rejects is an HTTP 400 on every single turn.
 *
 * Pure and side-effect-free apart from the warning log, so both the chat
 * route and the sub-agent tool can share it.
 */

import { logWarn } from "@/features/common/services/logger";
import {
  clampReasoningEffort,
  DEFAULT_REASONING_EFFORT_LEVELS,
  MODEL_CONFIGS,
  type ChatModel,
  type ModelConfig,
  type ProviderReasoningEffort,
} from "../models";

export type ReasoningEffortOverrides = Partial<
  Record<ChatModel, ProviderReasoningEffort>
>;

/** Levels the given model's provider accepts. */
export function getSupportedReasoningEfforts(
  config: Pick<ModelConfig, "supportedReasoningEfforts"> | undefined,
): ReadonlyArray<ProviderReasoningEffort> {
  return config?.supportedReasoningEfforts ?? DEFAULT_REASONING_EFFORT_LEVELS;
}

/**
 * Parse REASONING_EFFORT_OVERRIDES. Shape: a JSON object of model id →
 * effort, e.g. {"gpt-5.6-terra":"high"}. Anything unparseable yields an empty
 * map; individual bad entries are skipped. Never throws.
 */
export function parseReasoningEffortOverrides(
  raw: string | undefined,
): ReasoningEffortOverrides {
  const value = raw?.trim();
  if (!value) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    logWarn("REASONING_EFFORT_OVERRIDES is not valid JSON — ignoring", {
      value,
    });
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    logWarn(
      "REASONING_EFFORT_OVERRIDES must be a JSON object of modelId → effort — ignoring",
      { value },
    );
    return {};
  }

  const overrides: ReasoningEffortOverrides = {};
  for (const [modelId, effort] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const config = Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, modelId)
      ? MODEL_CONFIGS[modelId as ChatModel]
      : undefined;
    if (!config) {
      logWarn("REASONING_EFFORT_OVERRIDES names an unknown model — skipping", {
        modelId,
      });
      continue;
    }
    const allowed = getSupportedReasoningEfforts(config);
    if (
      typeof effort !== "string" ||
      !allowed.includes(effort as ProviderReasoningEffort)
    ) {
      logWarn(
        "REASONING_EFFORT_OVERRIDES value is not an effort this model accepts — skipping",
        { modelId, effort, allowed },
      );
      continue;
    }
    overrides[modelId as ChatModel] = effort as ProviderReasoningEffort;
  }
  return overrides;
}

// Parsing happens once per distinct env value; the result is cached so a
// per-turn resolve is a map lookup rather than a JSON.parse plus validation.
let cachedRaw: string | undefined | symbol = Symbol("unset");
let cachedOverrides: ReasoningEffortOverrides = {};

export function getReasoningEffortOverrides(
  raw: string | undefined = process.env.REASONING_EFFORT_OVERRIDES,
): ReasoningEffortOverrides {
  if (cachedRaw !== raw) {
    cachedRaw = raw;
    cachedOverrides = parseReasoningEffortOverrides(raw);
  }
  return cachedOverrides;
}

/** Test seam: forget the memoised env parse. */
export function resetReasoningEffortOverridesCache(): void {
  cachedRaw = Symbol("unset");
  cachedOverrides = {};
}

export interface ResolveReasoningEffortArgs {
  modelId: ChatModel;
  /** The user's explicit pick for this turn, if any. Always wins. */
  userPick?: ProviderReasoningEffort;
  /** Overridable for tests; defaults to the parsed env map. */
  overrides?: ReasoningEffortOverrides;
}

/**
 * Effort for a turn: user pick → env override → model default → "low", then
 * clamped to what the model's provider actually accepts.
 *
 * The user pick USED to be passed through unvalidated, on the reasoning that
 * the picker only offers levels the UI supports and that rewriting someone's
 * explicit choice is worse than honouring it. Measurement settled that: no
 * GPT-5.5 or 5.6 deployment accepts "minimal", the picker offered it anyway,
 * and the value is pinned on the thread — so one click produced an HTTP 400
 * on every subsequent turn until the user found their way back. A clamp to
 * "low" is a small, visible-in-the-log demotion; the alternative is a dead
 * thread. The picker no longer offers it either
 * (`getPickableReasoningEfforts`); this is the backstop for values already
 * stored on a thread, and for a hand-built request body.
 */
export function resolveReasoningEffort({
  modelId,
  userPick,
  overrides = getReasoningEffortOverrides(),
}: ResolveReasoningEffortArgs): ProviderReasoningEffort {
  const wanted =
    userPick ??
    overrides[modelId] ??
    MODEL_CONFIGS[modelId]?.defaultReasoningEffort ??
    "low";

  const effort = clampReasoningEffort(modelId, wanted);
  if (effort !== wanted) {
    logWarn("reasoning-effort: level not supported by the model; using low", {
      modelId,
      requested: wanted,
      used: effort,
      supported: getSupportedReasoningEfforts(MODEL_CONFIGS[modelId]),
    });
  }
  return effort;
}
