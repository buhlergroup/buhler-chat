/**
 * Prices a Copilot turn per model: the main agent, its sub-agents and the
 * tools' own model calls can run on different models, and each model's
 * tokens are billed at its own price.
 */
import type { ModelUsageIncrement } from "@/features/common/services/usage-models";
import { computeTokenCostUsd } from "../chat-api/usage-data";
import type { ModelConfig } from "../models";
import type { TurnUsage, UsageBucket } from "./event-mapper";

type PricedConfig = Pick<ModelConfig, "id" | "pricing">;

/** The model config a runtime usage event names (`<model id>` or `<provider>/<model id>`). */
export function configForUsageModel(
  model: string,
  configs: Readonly<Record<string, PricedConfig>>,
): PricedConfig | undefined {
  const id = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  return configs[id] ?? Object.values(configs).find((c) => c.id === id);
}

const bucketCost = (b: UsageBucket, config: PricedConfig) =>
  computeTokenCostUsd({
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    cachedTokens: b.cacheReadTokens,
    cacheWriteTokens: b.cacheWriteTokens,
    pricing: config.pricing,
  });

type TurnTokens = Pick<TurnUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "byModel">;

/**
 * The turn per model, for the usage rows and metrics: one entry per model id
 * (MODEL_CONFIGS id) with its tokens and its cost at its own price. Tokens of
 * a model without a config (or without a breakdown) count as the turn
 * model's. The turn model comes first and is always there, also for a turn
 * without tokens.
 */
export function turnUsageByModel(
  usage: TurnTokens,
  turnModel: PricedConfig,
  configs: Readonly<Record<string, PricedConfig>>,
): ModelUsageIncrement[] {
  const entries = new Map<string, ModelUsageIncrement>([
    [turnModel.id, { model: turnModel.id, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 }],
  ]);
  const buckets: Array<[string | undefined, UsageBucket]> = Object.entries(usage.byModel ?? {});
  if (buckets.length === 0) buckets.push([undefined, { ...usage, calls: 0 }]);
  for (const [model, bucket] of buckets) {
    const config = (model !== undefined ? configForUsageModel(model, configs) : undefined) ?? turnModel;
    const entry = entries.get(config.id) ?? { model: config.id, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    entry.inputTokens += bucket.inputTokens;
    entry.outputTokens += bucket.outputTokens;
    entry.cachedTokens += bucket.cacheReadTokens;
    entry.cacheWriteTokens = (entry.cacheWriteTokens ?? 0) + bucket.cacheWriteTokens;
    entry.costUsd += bucketCost(bucket, config);
    entries.set(config.id, entry);
  }
  return [...entries.values()];
}

/**
 * Turn cost: each model's tokens at that model's price; tokens of a model
 * without a config (or without a breakdown) at the turn model's price.
 */
export function turnCostUsd(
  usage: TurnTokens,
  turnModel: PricedConfig,
  configs: Readonly<Record<string, PricedConfig>>,
): number {
  return turnUsageByModel(usage, turnModel, configs).reduce((sum, e) => sum + e.costUsd, 0);
}
