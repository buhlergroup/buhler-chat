import { describe, it, expect } from "vitest";
import { configForUsageModel, turnCostUsd, turnUsageByModel } from "./usage-cost";
import { MODEL_CONFIGS } from "../models";

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

describe("turn usage per model (usage rows and metrics)", () => {
  const turn = (configs as Record<string, never>).main;

  it("one entry per model id, the turn model first, each at its own price", () => {
    const usage = {
      inputTokens: 3_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      // The runtime names a model with its provider; a tool's call uses the plain id.
      byModel: { fast: bucket(1_000_000), "azure/main": bucket(1_000_000), "openai/fast": bucket(1_000_000) },
    };
    const entries = turnUsageByModel(usage, turn, configs);
    expect(entries.map((e) => e.model)).toEqual(["main", "fast"]);
    expect(entries[0]).toMatchObject({ inputTokens: 1_000_000, cachedTokens: 0 });
    expect(entries[0].costUsd).toBeCloseTo(10, 10);
    expect(entries[1].inputTokens).toBe(2_000_000);
    expect(entries[1].costUsd).toBeCloseTo(2, 10);
    // The entries add up to the turn cost.
    expect(entries.reduce((s, e) => s + e.costUsd, 0)).toBeCloseTo(turnCostUsd(usage, turn, configs), 10);
  });

  it("an unknown model counts as the turn model; a turn without tokens still has the turn model (negative)", () => {
    const entries = turnUsageByModel(
      { inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, byModel: { unknown: bucket(1_000_000), main: bucket(1_000_000) } },
      turn,
      configs,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ model: "main", inputTokens: 2_000_000 });
    expect(entries[0].costUsd).toBeCloseTo(20, 10);
    expect(turnUsageByModel({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, byModel: {} }, turn, configs)).toEqual([
      { model: "main", inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    ]);
  });

  it("prices a web_search call on GPT-6 Luna at GPT-6 Luna's price, not the chat model's", () => {
    const luna = MODEL_CONFIGS["gpt-6-luna"];
    const chat = MODEL_CONFIGS["gpt-5.6-luna"];
    const half = { inputTokens: 500_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 };
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      byModel: { "openai/gpt-5.6-luna": half, "gpt-6-luna": half },
    };
    const [main, tool] = turnUsageByModel(usage, chat, MODEL_CONFIGS);
    expect(main.model).toBe("gpt-5.6-luna");
    expect(main.costUsd).toBeCloseTo(0.5 * chat.pricing.inputPerMillion + 0.5 * chat.pricing.outputPerMillion, 10);
    expect(tool.model).toBe("gpt-6-luna");
    expect(tool.costUsd).toBeCloseTo(0.5 * luna.pricing.inputPerMillion + 0.5 * luna.pricing.outputPerMillion, 10);
    expect(tool.costUsd).toBeLessThan(main.costUsd);
  });
});
