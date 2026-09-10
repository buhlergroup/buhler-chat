import "server-only";

import {
  ChatModel,
  ChatIntent,
  MODEL_CONFIGS,
} from "@/features/chat-page/chat-services/models";
import { logWarn } from "./logger";

/**
 * Environment-driven configuration for the cost-control downgrade feature.
 *
 * Everything here is read from process.env so thresholds and downgrade
 * targets can be changed without code edits. All model ids are validated
 * against MODEL_CONFIGS; unknown/undeployed ids are dropped (fail-safe — a
 * misconfiguration disables a downgrade rather than crashing a chat).
 */

export interface BudgetConfig {
  /** Per-user daily cost cap in USD. 0 = disabled. */
  dailyUsd: number;
  /** Per-user rolling-7-day cost cap in USD. 0 = disabled. */
  weeklyUsd: number;
}

export interface DowngradeTargets {
  /**
   * Models eligible as automatic hard-cap targets, cheapest-first by output
   * price, restricted to those actually deployed. When a per-user budget cap
   * trips, the request is downgraded to the first entry that can serve it.
   */
  hardCapSet: ChatModel[];
  /** Per-intent downgrade target (only classes with a configured, deployed target). */
  intentByClass: Partial<Record<ChatIntent, ChatModel>>;
}

function parsePositiveNumber(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function getBudgetConfig(): BudgetConfig {
  return {
    dailyUsd: parsePositiveNumber(process.env.DOWNGRADE_DAILY_COST_USD),
    weeklyUsd: parsePositiveNumber(process.env.DOWNGRADE_WEEKLY_COST_USD),
  };
}

function isValidModel(id: string): id is ChatModel {
  return Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, id);
}

function isDeployed(id: ChatModel): boolean {
  return !!MODEL_CONFIGS[id]?.deploymentName;
}

/**
 * Resolve a single configured target id (env value) to a deployed ChatModel,
 * or undefined if unset/unknown/undeployed (logging the reason).
 */
function resolveConfiguredTarget(
  envVar: string,
  raw: string | undefined,
): ChatModel | undefined {
  const id = raw?.trim();
  if (!id) return undefined;
  if (!isValidModel(id)) {
    logWarn("downgrade-config: ignoring unknown model id", { envVar, id });
    return undefined;
  }
  if (!isDeployed(id)) {
    logWarn("downgrade-config: ignoring undeployed model id", { envVar, id });
    return undefined;
  }
  return id;
}

export function getDowngradeTargets(): DowngradeTargets {
  // Base eligible set: flagged hardCapEligible AND deployed.
  let hardCapSet = (Object.keys(MODEL_CONFIGS) as ChatModel[])
    .filter((id) => MODEL_CONFIGS[id].hardCapEligible && isDeployed(id))
    // Cheapest-first by output price, then by input price, then by model id.
    // Output price alone leaves ties (gpt-5.6-luna and DeepSeek-V4-Pro are both
    // 1.20/1M output), and a tie under Array.prototype.sort resolves by
    // MODEL_CONFIGS declaration order — so which model a capped user landed on
    // depended on the order of an object literal. The extra keys make the
    // ordering a property of the prices, not of the file.
    .sort((a, b) => {
      const pa = MODEL_CONFIGS[a].pricing;
      const pb = MODEL_CONFIGS[b].pricing;
      return (
        pa.outputPerMillion - pb.outputPerMillion ||
        pa.inputPerMillion - pb.inputPerMillion ||
        (a < b ? -1 : a > b ? 1 : 0)
      );
    });

  // Optional env allow-list constrains AND reorders the set (ops override).
  const allowList = process.env.DOWNGRADE_HARDCAP_MODELS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowList && allowList.length > 0) {
    const ordered: ChatModel[] = [];
    for (const raw of allowList) {
      const id = resolveConfiguredTarget("DOWNGRADE_HARDCAP_MODELS", raw);
      // Only keep ids that are also genuinely eligible; ops shouldn't be able
      // to designate a non-eligible model as a cap target by env alone.
      if (id && MODEL_CONFIGS[id].hardCapEligible && !ordered.includes(id)) {
        ordered.push(id);
      }
    }
    hardCapSet = ordered;
  }

  const intentByClass: Partial<Record<ChatIntent, ChatModel>> = {};
  const codingTarget = resolveConfiguredTarget(
    "DOWNGRADE_INTENT_CODING_MODEL",
    process.env.DOWNGRADE_INTENT_CODING_MODEL,
  );
  if (codingTarget) intentByClass.coding = codingTarget;

  // Other cheap-friendly classes share an optional default target. "creative"
  // and "general" are intentionally never auto-downgraded.
  const defaultTarget = resolveConfiguredTarget(
    "DOWNGRADE_INTENT_DEFAULT_MODEL",
    process.env.DOWNGRADE_INTENT_DEFAULT_MODEL,
  );
  if (defaultTarget) {
    intentByClass.translation = defaultTarget;
    intentByClass.summarization = defaultTarget;
    intentByClass.data_analysis = defaultTarget;
  }

  return { hardCapSet, intentByClass };
}
