/**
 * Prices a Copilot turn per model: the main agent and its sub-agents can run
 * on different models, and each model's tokens are billed at its own price.
 */
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

/**
 * Turn cost: each model's tokens at that model's price; tokens of a model
 * without a config (or without a breakdown) at the turn model's price.
 */
export function turnCostUsd(
  usage: Pick<TurnUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "byModel">,
  turnModel: PricedConfig,
  configs: Readonly<Record<string, PricedConfig>>,
): number {
  const models = Object.entries(usage.byModel ?? {});
  if (models.length === 0) {
    return bucketCost({ ...usage, calls: 0 }, turnModel);
  }
  return models.reduce((sum, [model, bucket]) => sum + bucketCost(bucket, configForUsageModel(model, configs) ?? turnModel), 0);
}
