import { describe, it, expect } from "vitest";
import { computeRequestUsage, computeTokenCostUsd } from "./usage-data";

const modelConfig = {
  id: "gpt-5.5",
  pricing: { inputPerMillion: 5, outputPerMillion: 30, cachedInputPerMillion: 0.5 },
  contextWindow: 1_000_000,
} as const;

describe("computeRequestUsage", () => {
  it("totals tokens and bills cached input at the cached rate", () => {
    const u = computeRequestUsage({
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 400,
      modelConfig,
    });
    expect(u.totalTokens).toBe(1200);
    // (600/1e6)*5 + (400/1e6)*0.5 + (200/1e6)*30 = 0.003 + 0.0002 + 0.006
    expect(u.costUsd).toBeCloseTo(0.0092, 6);
    expect(u.model).toBe("gpt-5.5");
  });

  it("computes context usage percent against the model window", () => {
    const u = computeRequestUsage({
      inputTokens: 250_000,
      outputTokens: 0,
      cachedTokens: 0,
      modelConfig,
    });
    expect(u.contextWindowSize).toBe(1_000_000);
    expect(u.contextUsagePercent).toBeCloseTo(25, 6);
  });

  it("never bills negative non-cached input when cached exceeds input", () => {
    const u = computeRequestUsage({
      inputTokens: 100,
      outputTokens: 0,
      cachedTokens: 500,
      modelConfig,
    });
    // nonCachedInput clamps to 0; cost is just the cached portion.
    expect(u.costUsd).toBeCloseTo((500 / 1_000_000) * 0.5, 9);
  });

  it("carries the cache-write count through to the metadata block", () => {
    const u = computeRequestUsage({
      inputTokens: 1000,
      outputTokens: 0,
      cachedTokens: 400,
      cacheWriteTokens: 300,
      modelConfig,
    });
    expect(u.cacheWriteTokens).toBe(300);
  });

  it("defaults the cache-write count to 0 when the caller omits it", () => {
    const u = computeRequestUsage({
      inputTokens: 1000,
      outputTokens: 0,
      cachedTokens: 0,
      modelConfig,
    });
    expect(u.cacheWriteTokens).toBe(0);
  });

  it("yields zero cost and percent when pricing/window are absent", () => {
    const u = computeRequestUsage({
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 0,
      modelConfig: { id: "x", pricing: undefined as never, contextWindow: 0 },
    });
    expect(u.costUsd).toBe(0);
    expect(u.contextUsagePercent).toBe(0);
    expect(u.totalTokens).toBe(150);
  });
});

describe("chat-page.unit.usage-data.steps — turn totals vs the last prompt", () => {
  // AI SDK 7 sums step usage over a turn ("When there are multiple steps, the
  // usage is the sum of all step usages"). That sum is what was BILLED. It is
  // not the size of the prompt, and the panel's context row and the history
  // budget both mean the prompt.
  const step = (input: number, output: number) => ({ input, output });

  it("chat-page.unit.usage-data.steps.001: a 3-step turn bills the sum and reports the last prompt", () => {
    // Three calls over one growing conversation: 30k, then 34k, then 35k. The
    // provider billed 99,000 input tokens; the biggest prompt it ever saw was
    // 35,000, and that last one is the only one still in context.
    const steps = [step(30_000, 200), step(34_000, 150), step(35_000, 400)];
    const turnInput = steps.reduce((n, x) => n + x.input, 0);
    const turnOutput = steps.reduce((n, x) => n + x.output, 0);
    const lastPromptTokens = steps[steps.length - 1].input;

    const u = computeRequestUsage({
      inputTokens: turnInput,
      outputTokens: turnOutput,
      cachedTokens: 60_000,
      cacheWriteTokens: 20_000,
      lastPromptTokens,
      stepCount: steps.length,
      modelConfig,
    });

    // TURN TOTALS: unchanged, and they bill the turn.
    expect(u.inputTokens).toBe(99_000);
    expect(u.outputTokens).toBe(750);
    expect(u.totalTokens).toBe(99_750);
    expect(u.stepCount).toBe(3);

    // LAST PROMPT: the context figure, ~1/3 of the roll-up.
    expect(u.lastPromptTokens).toBe(35_000);
    expect(u.contextUsagePercent).toBeCloseTo(3.5, 6);
    // The defect: the roll-up would have claimed 9.9 % of the window for a
    // conversation that never filled more than 3.5 % of it.
    expect((99_000 / 1_000_000) * 100).toBeCloseTo(9.9, 6);

    // Cost is billed off the totals, not off the last prompt.
    expect(u.costUsd).toBeCloseTo(
      computeTokenCostUsd({
        inputTokens: 99_000,
        outputTokens: 750,
        cachedTokens: 60_000,
        cacheWriteTokens: 20_000,
        pricing: modelConfig.pricing,
      }),
      12,
    );
  });

  it("chat-page.unit.usage-data.steps.002: a 1-step turn reports one number twice", () => {
    // The single-step case is where the two quantities coincide. Nothing about
    // a plain turn changes.
    const u = computeRequestUsage({
      inputTokens: 17_527,
      outputTokens: 400,
      cachedTokens: 12_400,
      cacheWriteTokens: 5_100,
      lastPromptTokens: 17_527,
      stepCount: 1,
      modelConfig,
    });
    expect(u.inputTokens).toBe(u.lastPromptTokens);
    expect(u.stepCount).toBe(1);
    expect(u.contextUsagePercent).toBeCloseTo(1.7527, 6);
  });

  it("chat-page.unit.usage-data.steps.003: falls back to the roll-up when no step usage reached it", () => {
    // A caller with no step information (an abort before the first step
    // finished, a sentinel row). The fallback is EXACT for one step and
    // overstates a multi-step turn, which is why it is a fallback.
    const u = computeRequestUsage({
      inputTokens: 17_527,
      outputTokens: 0,
      cachedTokens: 0,
      modelConfig,
    });
    expect(u.lastPromptTokens).toBe(17_527);
    expect(u.stepCount).toBe(1);
  });

  it("chat-page.unit.usage-data.steps.004: keeps the cache identity on the turn totals", () => {
    // reads + writes + plain = the turn's input total. It holds per step, and
    // sums are linear, so it holds for the roll-up — which is what the panel's
    // cache row shows, because those are cost facts about the whole turn.
    const u = computeRequestUsage({
      inputTokens: 99_000,
      outputTokens: 750,
      cachedTokens: 60_000,
      cacheWriteTokens: 20_000,
      lastPromptTokens: 35_000,
      stepCount: 3,
      modelConfig,
    });
    const plain = u.inputTokens - u.cachedTokens - u.cacheWriteTokens;
    expect(plain).toBe(19_000);
    expect(u.cachedTokens + u.cacheWriteTokens + plain).toBe(u.inputTokens);
  });

  it("chat-page.unit.usage-data.steps.005: ignores an unusable step count or prompt size (negative)", () => {
    for (const bad of [0, -1, Number.NaN]) {
      const u = computeRequestUsage({
        inputTokens: 1_000,
        outputTokens: 0,
        cachedTokens: 0,
        stepCount: bad,
        modelConfig,
      });
      expect(u.stepCount).toBe(1);
    }
    const nan = computeRequestUsage({
      inputTokens: 1_000,
      outputTokens: 0,
      cachedTokens: 0,
      lastPromptTokens: Number.NaN,
      modelConfig,
    });
    expect(nan.lastPromptTokens).toBe(1_000);
  });
});

describe("computeTokenCostUsd", () => {
  // GPT-5.6-shaped pricing: writes are surcharged at 1.25x uncached input.
  const solPricing = {
    inputPerMillion: 5,
    outputPerMillion: 30,
    cachedInputPerMillion: 0.5,
    cacheWritePerMillion: 6.25,
  };
  // Pre-5.6 pricing: no separate write price.
  const legacyPricing = {
    inputPerMillion: 5,
    outputPerMillion: 30,
    cachedInputPerMillion: 0.5,
  };

  it("splits input into uncached / cache-read / cache-write buckets", () => {
    const cost = computeTokenCostUsd({
      inputTokens: 10_000,
      outputTokens: 1_000,
      cachedTokens: 6_000,
      cacheWriteTokens: 3_000,
      pricing: solPricing,
    });
    // 1_000 uncached @5 + 6_000 read @0.5 + 3_000 write @6.25 + 1_000 out @30
    const expected =
      (1_000 / 1e6) * 5 + (6_000 / 1e6) * 0.5 + (3_000 / 1e6) * 6.25 + (1_000 / 1e6) * 30;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("costs a full cache write more than the same turn served from cache", () => {
    const write = computeTokenCostUsd({
      inputTokens: 10_000,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 10_000,
      pricing: solPricing,
    });
    const read = computeTokenCostUsd({
      inputTokens: 10_000,
      outputTokens: 0,
      cachedTokens: 10_000,
      cacheWriteTokens: 0,
      pricing: solPricing,
    });
    expect(write).toBeGreaterThan(read);
    // 1.25x the uncached input rate, i.e. 12.5x a cache read.
    expect(write / read).toBeCloseTo(12.5, 6);
  });

  it("ignores the write count for a model with no write price (negative)", () => {
    const withWrites = computeTokenCostUsd({
      inputTokens: 10_000,
      outputTokens: 0,
      cachedTokens: 2_000,
      cacheWriteTokens: 3_000,
      pricing: legacyPricing,
    });
    const withoutWrites = computeTokenCostUsd({
      inputTokens: 10_000,
      outputTokens: 0,
      cachedTokens: 2_000,
      pricing: legacyPricing,
    });
    expect(withWrites).toBe(withoutWrites);
  });

  it("clamps the uncached bucket at zero when cached + write exceed input", () => {
    const cost = computeTokenCostUsd({
      inputTokens: 1_000,
      outputTokens: 0,
      cachedTokens: 800,
      cacheWriteTokens: 800,
      pricing: solPricing,
    });
    expect(cost).toBeCloseTo((800 / 1e6) * 0.5 + (800 / 1e6) * 6.25, 12);
  });

  it("returns 0 when pricing is absent (negative)", () => {
    expect(
      computeTokenCostUsd({
        inputTokens: 10_000,
        outputTokens: 1_000,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        pricing: undefined,
      }),
    ).toBe(0);
  });
});
