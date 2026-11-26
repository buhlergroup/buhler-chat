import { describe, it, expect } from "vitest";
import { configForUsageModel, turnCostUsd } from "./usage-cost";

const price = (inputPerMillion: number) => ({ inputPerMillion, outputPerMillion: 0, cachedInputPerMillion: 0 });
const configs = { main: { id: "main", pricing: price(10) }, fast: { id: "fast", pricing: price(1) } } as never;
const bucket = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 });

describe("turn cost per model", () => {
  it("prices each model's tokens at its own price", () => {
    const usage = { inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, byModel: { main: bucket(1_000_000), "azure/fast": bucket(1_000_000) } };
    expect(turnCostUsd(usage, (configs as Record<string, never>).main, configs)).toBeCloseTo(11, 10);
  });
  it("falls back to the turn model without a breakdown or for an unknown model", () => {
    const turn = (configs as Record<string, never>).main;
    expect(turnCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, byModel: {} }, turn, configs)).toBeCloseTo(10, 10);
    expect(turnCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, byModel: { other: bucket(1_000_000) } }, turn, configs)).toBeCloseTo(10, 10);
    expect(configForUsageModel("anthropic/fast", configs)?.id).toBe("fast");
  });
});
