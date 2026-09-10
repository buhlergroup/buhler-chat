import { NextRequest, NextResponse } from "next/server";
import { MODEL_CONFIGS, ChatModel, ModelConfig, DEFAULT_MODEL } from "@/features/chat-page/chat-services/models";
import { logError } from "@/features/common/services/logger";
import { userHashedId } from "@/features/auth-page/helpers";
import { CheckUserBudget } from "@/features/common/services/budget-service";

/**
 * API endpoint to get available models based on environment variables
 * This runs on the server side where environment variables are accessible
 */
export async function GET(request: NextRequest) {
  try {
    const availableModels: Record<string, ModelConfig> = {};

    Object.entries(MODEL_CONFIGS).forEach(([modelId, config]) => {
      // Downgrade-only models (e.g. Foundry targets) are not user-selectable.
      if (config.hiddenFromPicker) return;
      // Check if the deployment name environment variable is set and not empty
      if (config.deploymentName && config.deploymentName.trim() !== '') {
        availableModels[modelId] = config;
      }
    });

    const availableModelIds = Object.keys(availableModels) as ChatModel[];

    // Per-user budget state: when over budget the user may only use the
    // low-cost (hardCapEligible) models, so the rest are surfaced as disabled
    // (grayed + tooltip) in the picker. Fail-safe: on any error nothing is
    // disabled, so a budget-service hiccup never locks the picker.
    const disabledModels: Record<string, { reason: string }> = {};
    try {
      const budget = await CheckUserBudget(await userHashedId());
      if (budget.exceeded) {
        // Tooltip shows on the greyed (premium) model: explain why THIS model
        // is paused and that cheaper models still work. Daily resets at UTC
        // midnight; weekly is a rolling 7-day window.
        const reason =
          budget.window === "weekly"
            ? "Weekly usage limit reached — this model is paused until your recent usage drops below the limit. Lower-cost models are still available."
            : "Daily usage limit reached — this model is paused until midnight (UTC). Lower-cost models are still available.";
        for (const id of availableModelIds) {
          if (!availableModels[id].hardCapEligible) {
            disabledModels[id] = { reason };
          }
        }
      }
    } catch (err) {
      logError("models route: budget check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Prefer the configured DEFAULT_MODEL. The old code took
    // availableModelIds[0], i.e. whichever model happens to be declared first
    // in MODEL_CONFIGS — so the picker's default silently depended on object
    // key order and could disagree with the default the /api/chat route
    // actually uses. Only fall back to the first available id when the
    // configured default has no deployment in this environment.
    const defaultModel = availableModels[DEFAULT_MODEL]
      ? DEFAULT_MODEL
      : availableModelIds.length > 0
        ? availableModelIds[0]
        : DEFAULT_MODEL;
    return NextResponse.json({
      availableModels,
      availableModelIds,
      disabledModels,
      defaultModel,
      defaultReasoningEffort: MODEL_CONFIGS[defaultModel as ChatModel]?.defaultReasoningEffort || "low"
    });
  } catch (error) {
    logError("Error getting available models", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: "Failed to get available models" },
      { status: 500 }
    );
  }
}
