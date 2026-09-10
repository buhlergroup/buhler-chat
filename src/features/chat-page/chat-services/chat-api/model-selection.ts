"use server";
import "server-only";

/**
 * model-selection.ts
 *
 * Resolves the effective model + limits for a chat request.
 * Extracted from chat-api-response.ts (CheckLimits + fallback block).
 */

import { userHashedId } from "@/features/auth-page/helpers";
import { logError, logInfo } from "@/features/common/services/logger";
import { CheckLimits } from "@/features/common/services/usage-service";
import { CheckUserBudget } from "@/features/common/services/budget-service";
import { getDowngradeTargets } from "@/features/common/services/downgrade-config";
import {
  ChatModel,
  ChatThreadModel,
  DEFAULT_MODEL,
  MODEL_CONFIGS,
  ModelConfig,
  ProviderReasoningEffort,
  ReasoningEffort,
} from "../models";
import { resolveReasoningEffort } from "../models/reasoning-effort";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FallbackInfo {
  fellBack: true;
  /**
   * Why the downgrade happened:
   *   - "cap":     per-user daily/weekly cost budget exceeded (overrides pick)
   *   - "perModel": legacy per-model daily token/cost limit
   *   - "intent":   intent-based routing (only when no explicit pick)
   */
  reason: "cap" | "perModel" | "intent";
  originalModel: ChatModel;
  fallbackModel: ChatModel;
  message: string;
  limitType: "tokens" | "cost";
  currentUsage: number;
  limit: number;
}

export interface NoFallback {
  fellBack: false;
}

export type FallbackResult = FallbackInfo | NoFallback;

export interface ModelSelectionResult {
  modelDeployment: string;
  modelConfig: ModelConfig;
  fallbackInfo: FallbackResult;
  selectedModel: ChatModel;
  effectiveReasoningEffort?: ProviderReasoningEffort;
}

// ---------------------------------------------------------------------------
// resolveModelAndLimits
// ---------------------------------------------------------------------------

/**
 * Determines the effective model to use for a request:
 * 1. Picks the model from the payload or thread (falling back to DEFAULT_MODEL).
 * 2. Calls CheckLimits for the resolved user; if the daily limit is exceeded
 *    and a fallback model is configured, switches to the fallback.
 * 3. Returns the deployment name, full ModelConfig, fallback metadata, and
 *    the effective reasoning effort.
 *
 * Throws if no deploymentName is configured for the selected model.
 */
/**
 * Pick a hard-cap downgrade target from the configured eligible set.
 * The set is cheapest-first; when the turn wants Azure-Responses built-in
 * tools we prefer an eligible model that can host them (else the cheapest).
 * Returns undefined when no eligible+deployed target exists (caller fails safe).
 */
function pickHardCapTarget(opts: {
  preferResponsesAPI: boolean;
  requireVision: boolean;
}): ChatModel | undefined {
  const { hardCapSet } = getDowngradeTargets();
  // When the turn carries an image, only vision-capable targets are eligible.
  // The cheapest hard-cap target (Foundry DeepSeek) is text-only, so routing an
  // image turn there fails the request. Gating to vision-capable models means
  // an image turn downgrades to the cheapest model that can actually see it
  // (e.g. Kimi before gpt-5.4-mini). If none qualify we return undefined and
  // the caller fails safe (no downgrade) rather than break the turn.
  const candidates = opts.requireVision
    ? hardCapSet.filter((id) => MODEL_CONFIGS[id].capabilities?.includes("vision"))
    : hardCapSet;
  if (candidates.length === 0) return undefined;
  if (opts.preferResponsesAPI) {
    const responsesCapable = candidates.find(
      (id) => MODEL_CONFIGS[id].supportsResponsesAPI,
    );
    if (responsesCapable) return responsesCapable;
  }
  return candidates[0];
}

export async function resolveModelAndLimits(
  payload: {
    selectedModel?: ChatModel;
    reasoningEffort?: ReasoningEffort;
    webSearchEnabled?: boolean;
    imageGenerationEnabled?: boolean;
    codeInterpreterEnabled?: boolean;
    /** Images attached to THIS turn — gates the cap downgrade to vision-capable
     *  targets so an image turn never lands on a text-only model. */
    multimodalImages?: string[];
  },
  thread: ChatThreadModel
): Promise<ModelSelectionResult> {
  let selectedModel: ChatModel =
    payload.selectedModel ?? thread.selectedModel ?? DEFAULT_MODEL;
  let modelConfig = MODEL_CONFIGS[selectedModel];

  // An explicit pick is the user choosing a model this turn, or having
  // previously pinned a non-default model on the thread. Cap overrides it;
  // intent routing respects it.
  const explicitPick =
    !!payload.selectedModel ||
    (!!thread.selectedModel && thread.selectedModel !== DEFAULT_MODEL);

  let fallbackInfo: FallbackResult = { fellBack: false };
  try {
    const userId = await userHashedId();

    // (1) Per-user budget cap — highest precedence, OVERRIDES an explicit pick.
    const budget = await CheckUserBudget(userId);
    if (budget.exceeded) {
      const wantsBuiltInTools = !!(
        (payload.codeInterpreterEnabled ?? thread.defaultTools?.codeInterpreter) ||
        (payload.imageGenerationEnabled ?? thread.defaultTools?.imageGeneration) ||
        (payload.webSearchEnabled ?? thread.defaultTools?.webSearch)
      );
      const requireVision = (payload.multimodalImages?.length ?? 0) > 0;
      const target = pickHardCapTarget({ preferResponsesAPI: wantsBuiltInTools, requireVision });
      const targetConfig = target ? MODEL_CONFIGS[target] : undefined;
      if (target && targetConfig?.deploymentName && target !== selectedModel) {
        fallbackInfo = {
          fellBack: true,
          reason: "cap",
          originalModel: selectedModel,
          fallbackModel: target,
          message:
            budget.window === "weekly"
              ? `Rolling 7-day cost budget reached. Using ${targetConfig.name} until your usage from the last 7 days drops below the cap.`
              : `Daily cost budget reached. Using ${targetConfig.name} until it resets.`,
          limitType: "cost",
          currentUsage: budget.currentUsd ?? 0,
          limit: budget.limitUsd ?? 0,
        } satisfies FallbackInfo;
        logInfo("Budget cap exceeded, downgrading", {
          userId,
          window: budget.window,
          originalModel: selectedModel,
          fallbackModel: target,
        });
        selectedModel = target;
        modelConfig = targetConfig;
      }
    }

    // (2) Legacy per-model daily limit fallback — only if not already capped.
    if (!fallbackInfo.fellBack) {
      const limitCheck = await CheckLimits(userId, selectedModel);
      if (limitCheck.exceeded && limitCheck.fallbackModel) {
        const fallbackConfig = MODEL_CONFIGS[limitCheck.fallbackModel];
        if (fallbackConfig?.deploymentName) {
          fallbackInfo = {
            fellBack: true,
            reason: "perModel",
            originalModel: selectedModel,
            fallbackModel: limitCheck.fallbackModel,
            message: `Daily ${limitCheck.limitType} limit reached for ${selectedModel}. Using ${limitCheck.fallbackModel} instead.`,
            limitType: limitCheck.limitType!,
            currentUsage: limitCheck.currentUsage!,
            limit: limitCheck.limit!,
          } satisfies FallbackInfo;
          logInfo("Limit exceeded, falling back", {
            originalModel: selectedModel,
            fallbackModel: limitCheck.fallbackModel,
          });
          selectedModel = limitCheck.fallbackModel;
          modelConfig = fallbackConfig;
        }
      }
    }

    // (3) Intent-based downgrade — only when the user has NOT explicitly picked
    // a model and nothing higher-precedence already downgraded this turn.
    if (!fallbackInfo.fellBack && !explicitPick && thread.intent) {
      const target = getDowngradeTargets().intentByClass[thread.intent];
      const targetConfig = target ? MODEL_CONFIGS[target] : undefined;
      if (target && targetConfig?.deploymentName && target !== selectedModel) {
        fallbackInfo = {
          fellBack: true,
          reason: "intent",
          originalModel: selectedModel,
          fallbackModel: target,
          message: `This looks like a ${thread.intent} chat — routed to ${targetConfig.name} to save cost. Pick a model to override.`,
          limitType: "cost",
          currentUsage: 0,
          limit: 0,
        } satisfies FallbackInfo;
        logInfo("Intent downgrade applied", {
          userId,
          intent: thread.intent,
          originalModel: selectedModel,
          fallbackModel: target,
        });
        selectedModel = target;
        modelConfig = targetConfig;
      }
    }
  } catch (err) {
    logError("Failed to check limits", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!modelConfig?.deploymentName) {
    logError("Missing deployment configuration", {
      selectedModel,
      availableModels: Object.keys(MODEL_CONFIGS),
    });
    throw Object.assign(
      new Error(
        `Missing deployment configuration for model ${selectedModel}`
      ),
      { status: 500 }
    );
  }

  // Effort is resolved AFTER the model is final: user pick → the
  // REASONING_EFFORT_OVERRIDES env map for THIS model → the model's default.
  // Resolving it earlier meant a downgraded turn ran at the effort configured
  // for the model that did not run.
  const reasoningEffort = resolveReasoningEffort({
    modelId: selectedModel,
    userPick: payload.reasoningEffort,
  });

  return {
    modelDeployment: modelConfig.deploymentName,
    modelConfig,
    fallbackInfo,
    selectedModel,
    effectiveReasoningEffort: reasoningEffort,
  };
}
