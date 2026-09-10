import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/features/common/services/logger", () => ({
  logWarn: vi.fn(),
}));

import { getBudgetConfig, getDowngradeTargets } from "../downgrade-config";
import { MODEL_CONFIGS } from "@/features/chat-page/chat-services/models";

// Models we toggle deployment names on during tests.
const FOUNDRY = ["DeepSeek-V4-Pro", "Kimi-K2.6"] as const;
const LUNA = "gpt-5.6-luna" as const;

const savedDeploy: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "DOWNGRADE_DAILY_COST_USD",
  "DOWNGRADE_WEEKLY_COST_USD",
  "DOWNGRADE_HARDCAP_MODELS",
  "DOWNGRADE_INTENT_CODING_MODEL",
  "DOWNGRADE_INTENT_DEFAULT_MODEL",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const id of [...FOUNDRY, LUNA]) {
    savedDeploy[id] = MODEL_CONFIGS[id].deploymentName;
  }
  // Make all three eligible models "deployed" by default.
  (MODEL_CONFIGS["DeepSeek-V4-Pro"] as any).deploymentName = "DeepSeek-V4-Pro";
  (MODEL_CONFIGS["Kimi-K2.6"] as any).deploymentName = "Kimi-K2.6-1";
  (MODEL_CONFIGS[LUNA] as any).deploymentName = "luna-deploy";
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const id of [...FOUNDRY, LUNA]) {
    (MODEL_CONFIGS[id] as any).deploymentName = savedDeploy[id];
  }
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("getBudgetConfig", () => {
  it("parses positive numbers", () => {
    process.env.DOWNGRADE_DAILY_COST_USD = "3";
    process.env.DOWNGRADE_WEEKLY_COST_USD = "7.5";
    expect(getBudgetConfig()).toEqual({ dailyUsd: 3, weeklyUsd: 7.5 });
  });

  it("treats unset / non-numeric / non-positive as 0 (disabled)", () => {
    expect(getBudgetConfig()).toEqual({ dailyUsd: 0, weeklyUsd: 0 });
    process.env.DOWNGRADE_DAILY_COST_USD = "abc";
    process.env.DOWNGRADE_WEEKLY_COST_USD = "-5";
    expect(getBudgetConfig()).toEqual({ dailyUsd: 0, weeklyUsd: 0 });
  });
});

describe("getDowngradeTargets — hardCapSet", () => {
  it("includes flagged+deployed models, sorted cheapest-first by output then input price", () => {
    // Output prices: luna 1.20 = DeepSeek 1.20 < Kimi 2.50. luna and DeepSeek
    // tie on output, so the input price breaks it: luna 0.20 < DeepSeek 0.30.
    const { hardCapSet } = getDowngradeTargets();
    expect(hardCapSet).toEqual(["gpt-5.6-luna", "DeepSeek-V4-Pro", "Kimi-K2.6"]);
  });

  it("orders ties by price, not by MODEL_CONFIGS declaration order", () => {
    // Regression guard: with output-price-only sorting this set depended on
    // the order of the MODEL_CONFIGS object literal.
    const { hardCapSet } = getDowngradeTargets();
    const priced = hardCapSet.map((id) => [
      MODEL_CONFIGS[id].pricing.outputPerMillion,
      MODEL_CONFIGS[id].pricing.inputPerMillion,
    ]);
    for (let i = 1; i < priced.length; i++) {
      const [prevOut, prevIn] = priced[i - 1];
      const [out, input] = priced[i];
      expect(prevOut < out || (prevOut === out && prevIn <= input)).toBe(true);
    }
  });

  it("excludes eligible models that are not deployed", () => {
    (MODEL_CONFIGS["DeepSeek-V4-Pro"] as any).deploymentName = undefined;
    const { hardCapSet } = getDowngradeTargets();
    expect(hardCapSet).toEqual(["gpt-5.6-luna", "Kimi-K2.6"]);
  });

  it("env allow-list constrains AND reorders the set", () => {
    process.env.DOWNGRADE_HARDCAP_MODELS = "gpt-5.6-luna,DeepSeek-V4-Pro";
    const { hardCapSet } = getDowngradeTargets();
    expect(hardCapSet).toEqual(["gpt-5.6-luna", "DeepSeek-V4-Pro"]);
  });

  it("drops unknown / ineligible ids from the allow-list", () => {
    // gpt-5.5 is a real model but NOT hardCapEligible → must be dropped.
    process.env.DOWNGRADE_HARDCAP_MODELS = "nope-model,gpt-5.5,Kimi-K2.6";
    const { hardCapSet } = getDowngradeTargets();
    expect(hardCapSet).toEqual(["Kimi-K2.6"]);
  });
});

describe("getDowngradeTargets — intentByClass", () => {
  it("maps coding to its configured target", () => {
    process.env.DOWNGRADE_INTENT_CODING_MODEL = "DeepSeek-V4-Pro";
    const { intentByClass } = getDowngradeTargets();
    expect(intentByClass.coding).toBe("DeepSeek-V4-Pro");
    expect(intentByClass.general).toBeUndefined();
    expect(intentByClass.creative).toBeUndefined();
  });

  it("applies the default target to the cheap-friendly classes only", () => {
    process.env.DOWNGRADE_INTENT_DEFAULT_MODEL = "Kimi-K2.6";
    const { intentByClass } = getDowngradeTargets();
    expect(intentByClass.translation).toBe("Kimi-K2.6");
    expect(intentByClass.summarization).toBe("Kimi-K2.6");
    expect(intentByClass.data_analysis).toBe("Kimi-K2.6");
    expect(intentByClass.creative).toBeUndefined();
    expect(intentByClass.general).toBeUndefined();
  });

  it("drops an unknown intent target id", () => {
    process.env.DOWNGRADE_INTENT_CODING_MODEL = "does-not-exist";
    const { intentByClass } = getDowngradeTargets();
    expect(intentByClass.coding).toBeUndefined();
  });

  it("drops an undeployed intent target id", () => {
    (MODEL_CONFIGS["DeepSeek-V4-Pro"] as any).deploymentName = undefined;
    process.env.DOWNGRADE_INTENT_CODING_MODEL = "DeepSeek-V4-Pro";
    const { intentByClass } = getDowngradeTargets();
    expect(intentByClass.coding).toBeUndefined();
  });
});
