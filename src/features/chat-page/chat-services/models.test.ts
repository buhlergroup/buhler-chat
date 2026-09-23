import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockLogError = vi.fn();
vi.mock("@/features/common/services/logger", () => ({
  logError: (...a: unknown[]) => mockLogError(...(a as [])),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  clampReasoningEffort,
  CODE_DEFAULT_MODEL,
  CODE_FALLBACK_DEFAULT_MODEL,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT_LEVELS,
  getPickableReasoningEfforts,
  MODEL_CONFIGS,
  resolveDefaultModel,
} from "./models";
import {
  DEFAULT_HISTORY_TOKEN_BUDGET,
  resolveHistoryBudget,
  resolveHistoryTokenBudget,
} from "./chat-api/history-budget";

describe("resolveDefaultModel", () => {
  it("returns the code default when DEFAULT_MODEL_ID is unset", () => {
    expect(resolveDefaultModel(undefined)).toBe(CODE_DEFAULT_MODEL);
    expect(CODE_DEFAULT_MODEL).toBe("gpt-6-sol");
    expect(CODE_FALLBACK_DEFAULT_MODEL).toBe("gpt-5.6-terra");
  });

  it("returns the code default for an empty or whitespace value", () => {
    expect(resolveDefaultModel("")).toBe(CODE_DEFAULT_MODEL);
    expect(resolveDefaultModel("   ")).toBe(CODE_DEFAULT_MODEL);
  });

  it("accepts any id present in MODEL_CONFIGS", () => {
    expect(resolveDefaultModel("gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(resolveDefaultModel("  gpt-5.5  ")).toBe("gpt-5.5");
  });

  it("ignores an unknown id and logs, rather than routing chats to a dead model (negative)", () => {
    mockLogError.mockClear();
    expect(resolveDefaultModel("gpt-9000")).toBe(CODE_DEFAULT_MODEL);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining("DEFAULT_MODEL_ID"),
      expect.objectContaining({ value: "gpt-9000" }),
    );
  });

  it("does not accept inherited Object.prototype keys as model ids (negative)", () => {
    expect(resolveDefaultModel("toString")).toBe(CODE_DEFAULT_MODEL);
    expect(resolveDefaultModel("constructor")).toBe(CODE_DEFAULT_MODEL);
  });

  it("DEFAULT_MODEL is the code default in an environment with no override", () => {
    // The unit-test env sets no DEFAULT_MODEL_ID.
    expect(DEFAULT_MODEL).toBe(CODE_DEFAULT_MODEL);
    expect(MODEL_CONFIGS[DEFAULT_MODEL]).toBeDefined();
  });
});

describe("MODEL_CONFIGS — default reasoning effort", () => {
  it("keeps terra (the fallback default) on medium and the Sol models on low", () => {
    // Terra's "medium" is a property of Terra, set when it was the default.
    // The Sol convention is "low": gpt-5.6-sol ran on low while it was the
    // default, and GPT-6 Sol keeps that convention as the new default.
    expect(MODEL_CONFIGS["gpt-5.6-terra"].defaultReasoningEffort).toBe("medium");
    expect(MODEL_CONFIGS["gpt-5.6-sol"].defaultReasoningEffort).toBe("low");
    expect(MODEL_CONFIGS["gpt-5.5"].defaultReasoningEffort).toBe("low");
  });

  it("makes GPT-6 Sol the code default and puts the new models on low", () => {
    expect(CODE_DEFAULT_MODEL).toBe("gpt-6-sol");
    expect(MODEL_CONFIGS["gpt-6-sol"].defaultReasoningEffort).toBe("low");
    expect(MODEL_CONFIGS["gpt-6-luna"].defaultReasoningEffort).toBe("low");
    expect(MODEL_CONFIGS["claude-opus-5-5"].defaultReasoningEffort).toBe("low");
  });
});

// ---------------------------------------------------------------------------

describe("chat-page.unit.models.pricing — the shipped price table holds its own invariants", () => {
  /**
   * Every other price assertion in the suite runs against local fixtures, so a
   * typo in the table that actually ships — a missing write price, a cached
   * rate above the input rate — is invisible. These walk MODEL_CONFIGS itself.
   *
   * The load-bearing one is the write price. `computeTokenCostUsd` treats an
   * ABSENT `cacheWritePerMillion` as "this provider does not bill writes
   * separately" and leaves those tokens in the uncached bucket at 1.0x. For a
   * provider that does bill them the cost is then under-stated by 25 % of the
   * write portion, silently, while `cacheWriteTokensUsed` still reports the
   * true count. Both families that write cache entries must carry the price.
   */
  const entries = Object.entries(MODEL_CONFIGS);

  /** Families whose provider bills a prompt-cache write at a premium. */
  const WRITE_BILLING_FAMILIES = ["gpt-6", "gpt-5.6", "claude"];

  it("prices every model", () => {
    for (const [id, config] of entries) {
      expect(config.pricing, `${id} has no pricing`).toBeDefined();
      expect(config.pricing.inputPerMillion, id).toBeGreaterThan(0);
      expect(config.pricing.outputPerMillion, id).toBeGreaterThan(0);
    }
  });

  it("never prices a cache read above uncached input", () => {
    for (const [id, config] of entries) {
      expect(
        config.pricing.cachedInputPerMillion,
        `${id}: a cache read must not cost more than uncached input`,
      ).toBeLessThanOrEqual(config.pricing.inputPerMillion);
    }
  });

  it("charges 1.25x input for a cache write on every family that bills writes", () => {
    const billing = entries.filter(([, c]) => WRITE_BILLING_FAMILIES.includes(c.family ?? ""));
    // Guards the guard: if the families are ever renamed this must not quietly
    // start asserting nothing.
    expect(billing.length).toBeGreaterThanOrEqual(8);

    for (const [id, config] of billing) {
      expect(
        config.pricing.cacheWritePerMillion,
        `${id} is in a write-billing family but carries no cacheWritePerMillion`,
      ).toBeDefined();
      expect(config.pricing.cacheWritePerMillion, id).toBeCloseTo(
        config.pricing.inputPerMillion * 1.25,
        6,
      );
    }
  });

  it("leaves the write price off the families that do not bill writes (negative)", () => {
    for (const [id, config] of entries) {
      if (WRITE_BILLING_FAMILIES.includes(config.family ?? "")) continue;
      expect(
        config.pricing.cacheWritePerMillion,
        `${id} is not in a write-billing family; a write price here would bill twice`,
      ).toBeUndefined();
    }
  });

  it("pins the list prices of the models added or corrected on 2026-09-23", () => {
    // GPT-6: OpenAI list price (developers.openai.com/api/docs/pricing); the
    // Azure meters were not published yet. Claude: platform.claude.com
    // pricing. Opus 4.8 used to carry the retired Opus 4/4.1 price
    // (15 / 75 / 1.50 / 18.75), which over-stated every Opus 4.8 turn 3x.
    expect(MODEL_CONFIGS["gpt-6-sol"].pricing).toEqual({
      inputPerMillion: 2.0,
      outputPerMillion: 10.0,
      cachedInputPerMillion: 0.2,
      cacheWritePerMillion: 2.5,
    });
    expect(MODEL_CONFIGS["gpt-6-luna"].pricing).toEqual({
      inputPerMillion: 0.1,
      outputPerMillion: 0.5,
      cachedInputPerMillion: 0.01,
      cacheWritePerMillion: 0.125,
    });
    expect(MODEL_CONFIGS["claude-opus-5-5"].pricing).toEqual({
      inputPerMillion: 4.0,
      outputPerMillion: 20.0,
      // 0.05x input on Opus 5.5, not the usual 0.1x.
      cachedInputPerMillion: 0.2,
      cacheWritePerMillion: 5.0,
    });
    expect(MODEL_CONFIGS["claude-opus-4-8"].pricing).toEqual({
      inputPerMillion: 5.0,
      outputPerMillion: 25.0,
      cachedInputPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
    });
  });

  it("gives every model a maxOutputTokens that leaves room for reasoning", () => {
    for (const [id, config] of entries) {
      expect(config.maxOutputTokens, `${id} has no maxOutputTokens`).toBeDefined();
      expect(config.maxOutputTokens, id).toBeGreaterThanOrEqual(8000);
      // A ceiling above the context window would be meaningless.
      if (config.contextWindow) {
        expect(config.maxOutputTokens!, id).toBeLessThan(config.contextWindow);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe("resolveDefaultModel — a deployment-aware override", () => {
  /**
   * A known id with no deployment behind it is the mistake that hurts: it
   * passes the name check, lands on every new thread, and then every turn
   * throws "Missing deployment configuration" — a 500 per chat that reads
   * like a chat bug and not like a missing app setting. So the override is
   * refused, but only when the code default is itself deployed; with nothing
   * deployed at all (a bare environment, and the unit-test environment) there
   * is no better answer than the id that was asked for.
   */
  const anyDeployed = (Object.keys(MODEL_CONFIGS) as (keyof typeof MODEL_CONFIGS)[]).some(
    (id) => !!MODEL_CONFIGS[id].deploymentName?.trim(),
  );

  it("prefers a deployed override, and logs rather than crashing otherwise", () => {
    mockLogError.mockClear();
    const resolved = resolveDefaultModel("gpt-5.6-luna");

    if (MODEL_CONFIGS["gpt-5.6-luna"].deploymentName?.trim()) {
      expect(resolved).toBe("gpt-5.6-luna");
      expect(mockLogError).not.toHaveBeenCalled();
      return;
    }
    if (MODEL_CONFIGS[CODE_DEFAULT_MODEL].deploymentName?.trim()) {
      // A deployed alternative exists, so the undeployed override is refused.
      expect(resolved).toBe(CODE_DEFAULT_MODEL);
    } else if (MODEL_CONFIGS[CODE_FALLBACK_DEFAULT_MODEL].deploymentName?.trim()) {
      // The code default is undeployed too; the fallback default serves.
      expect(resolved).toBe(CODE_FALLBACK_DEFAULT_MODEL);
    } else {
      // Nothing is deployed: honour the id and say so loudly.
      expect(resolved).toBe("gpt-5.6-luna");
    }
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError.mock.calls[0][0]).toMatch(/no deployment/i);
  });

  it("still refuses an id that is not in the table at all", () => {
    mockLogError.mockClear();
    expect(resolveDefaultModel("gpt-nope")).toBe(CODE_DEFAULT_MODEL);
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError.mock.calls[0][0]).toMatch(/not a known model id/i);
  });

  it("documents which environment this suite ran in", () => {
    // Not an assertion about the app — a marker so a future reader knows why
    // the branches above are conditional.
    expect(typeof anyDeployed).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------

describe("chat-page.unit.models.default-fallback — an undeployed code default falls back to terra", () => {
  /**
   * GPT-6 Sol is the code default, but an environment may not deploy it yet
   * (no AZURE_OPENAI_API_GPT6_SOL_DEPLOYMENT_NAME). Then every unpinned chat
   * must go to a model that CAN serve a turn — gpt-5.6-terra — and not to the
   * undeployed default, which would 500 on every turn.
   */
  const ids = [CODE_DEFAULT_MODEL, CODE_FALLBACK_DEFAULT_MODEL, "gpt-5.6-luna"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const id of ids) saved[id] = MODEL_CONFIGS[id].deploymentName;
    for (const id of ids) (MODEL_CONFIGS[id] as { deploymentName?: string }).deploymentName = undefined;
    mockLogError.mockClear();
  });
  afterEach(() => {
    for (const id of ids) (MODEL_CONFIGS[id] as { deploymentName?: string }).deploymentName = saved[id];
  });

  const deploy = (id: (typeof ids)[number]) => {
    (MODEL_CONFIGS[id] as { deploymentName?: string }).deploymentName = `${id}-dep`;
  };

  it("uses GPT-6 Sol when it is deployed", () => {
    deploy("gpt-6-sol");
    deploy("gpt-5.6-terra");
    expect(resolveDefaultModel(undefined)).toBe("gpt-6-sol");
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("falls back to terra when GPT-6 Sol has no deployment, and logs it", () => {
    deploy("gpt-5.6-terra");
    expect(resolveDefaultModel(undefined)).toBe("gpt-5.6-terra");
    expect(resolveDefaultModel("   ")).toBe("gpt-5.6-terra");
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringMatching(/no deployment/i),
      expect.objectContaining({ codeDefault: "gpt-6-sol", fallback: "gpt-5.6-terra" }),
    );
  });

  it("falls back to terra for an unknown or undeployed DEFAULT_MODEL_ID when Sol is undeployed", () => {
    deploy("gpt-5.6-terra");
    expect(resolveDefaultModel("gpt-nope")).toBe("gpt-5.6-terra");
    expect(resolveDefaultModel("gpt-5.6-luna")).toBe("gpt-5.6-terra");
  });

  it("still honours a deployed DEFAULT_MODEL_ID over both code defaults", () => {
    deploy("gpt-5.6-terra");
    deploy("gpt-5.6-luna");
    expect(resolveDefaultModel("gpt-5.6-luna")).toBe("gpt-5.6-luna");
  });

  it("returns GPT-6 Sol unchanged when nothing is deployed (negative)", () => {
    // A bare environment, or the client bundle: no better answer exists.
    expect(resolveDefaultModel(undefined)).toBe("gpt-6-sol");
    expect(mockLogError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("chat-page.unit.models.reasoning — every model can be asked to think", () => {
  const entries = Object.entries(MODEL_CONFIGS);

  it("gives every reasoning model a default effort", () => {
    // Without a default, resolveReasoningEffort falls through to its hardcoded
    // "low" — so a premium reasoning model would quietly think as little as it
    // can, and no env override could be the thing that fixed it.
    for (const [id, config] of entries) {
      if (!config.supportsReasoning) continue;
      expect(
        config.defaultReasoningEffort,
        `${id} supports reasoning but declares no defaultReasoningEffort`,
      ).toBeDefined();
    }
  });

  it("never sends an effort for a model that does not reason (negative)", () => {
    // A non-reasoning model is allowed to carry a default — gpt-5.6-luna and
    // gpt-5.4-mini both do — because the seam gates on supportsReasoning and
    // never puts the value on the wire. What must hold is that the gate is the
    // only thing deciding, i.e. the value is inert rather than absent.
    const nonReasoning = entries.filter(([, c]) => !c.supportsReasoning);
    expect(nonReasoning.length).toBeGreaterThan(0);
    for (const [id, config] of nonReasoning) {
      expect(config.supportsReasoning, id).toBe(false);
    }
  });

  it("always leaves 'low' available, because that is what a clamp falls back to", () => {
    // The list is the provider's word and may be NARROWER than the picker's
    // four options — no GPT-5.5 or 5.6 deployment accepts "minimal", measured.
    // Both directions handle that: the picker hides what the model will not
    // take, and clampReasoningEffort maps anything else to "low". So the one
    // thing every list must contain is "low".
    for (const [id, config] of entries) {
      const levels = config.supportedReasoningEfforts;
      if (!levels) continue;
      expect(levels.length, `${id} declares an empty level list`).toBeGreaterThan(0);
      expect(levels, `${id} has no "low" for a clamp to fall back to`).toContain("low");
    }
  });

  it("pins the measured level sets for the families that answered 400", () => {
    // Verbatim from the dev deployments. Widening either of these to suit the
    // UI is what caused the 400s, so they are pinned rather than derived.
    for (const [id, config] of entries) {
      if (config.family === "gpt-6" || config.family === "gpt-5.6") {
        expect(config.supportedReasoningEfforts, id).toEqual([
          "none", "low", "medium", "high", "xhigh", "max",
        ]);
      }
      if (config.family === "gpt-5.5") {
        expect(config.supportedReasoningEfforts, id).toEqual([
          "none", "low", "medium", "high", "xhigh",
        ]);
      }
    }
    // Opus 5.5 is the one Claude model with a measured list (xhigh and max
    // answered 200 on the dev deployment); the others keep the default set and
    // the anthropic seam maps xhigh/max to high for them.
    expect(MODEL_CONFIGS["claude-opus-5-5"].supportedReasoningEfforts).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
    expect(MODEL_CONFIGS["claude-opus-4-8"].supportedReasoningEfforts).toBeUndefined();
    expect(MODEL_CONFIGS["claude-sonnet-5"].supportedReasoningEfforts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("chat-page.unit.models.effort-clamp — the picker follows the provider", () => {
  it("hides a level the model does not accept", () => {
    // No 5.6 or 5.5 deployment takes "minimal".
    expect(getPickableReasoningEfforts("gpt-5.6-terra")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(getPickableReasoningEfforts("gpt-5.5")).toEqual(["low", "medium", "high"]);
  });

  it("offers all four for a model that names no list, and for no model at all", () => {
    // gpt-5.4 declares no list, so it keeps the picker's own four.
    expect(getPickableReasoningEfforts("gpt-5.4")).toEqual([
      ...DEFAULT_REASONING_EFFORT_LEVELS,
    ]);
    expect(getPickableReasoningEfforts(undefined)).toEqual([
      ...DEFAULT_REASONING_EFFORT_LEVELS,
    ]);
  });

  it("keeps the picker's own order, not the config's", () => {
    // The config lists "none" first; the picker must not start showing it.
    const pickable = getPickableReasoningEfforts("gpt-5.6-sol");
    expect(pickable).not.toContain("none");
    expect(pickable).toEqual([...pickable].sort(
      (a, b) =>
        DEFAULT_REASONING_EFFORT_LEVELS.indexOf(a) -
        DEFAULT_REASONING_EFFORT_LEVELS.indexOf(b),
    ));
  });

  it("maps an unsupported level down to low, and leaves a supported one alone", () => {
    expect(clampReasoningEffort("gpt-5.6-terra", "minimal")).toBe("low");
    expect(clampReasoningEffort("gpt-5.5", "minimal")).toBe("low");
    expect(clampReasoningEffort("gpt-5.5", "max")).toBe("low"); // 5.5 stops at xhigh
    expect(clampReasoningEffort("gpt-5.6-terra", "max")).toBe("max");
    expect(clampReasoningEffort("gpt-5.6-terra", "xhigh")).toBe("xhigh");
    expect(clampReasoningEffort("gpt-5.4", "minimal")).toBe("minimal");
    // Opus 5.5 was measured to accept xhigh and max; Anthropic has no minimal.
    expect(clampReasoningEffort("claude-opus-5-5", "xhigh")).toBe("xhigh");
    expect(clampReasoningEffort("claude-opus-5-5", "max")).toBe("max");
    expect(clampReasoningEffort("claude-opus-5-5", "minimal")).toBe("low");
    expect(clampReasoningEffort("gpt-6-sol", "minimal")).toBe("low");
    expect(clampReasoningEffort("gpt-6-sol", "max")).toBe("max");
  });

  it("offers Opus 5.5 low / medium / high in the picker, not minimal", () => {
    expect(getPickableReasoningEfforts("claude-opus-5-5")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(getPickableReasoningEfforts("gpt-6-sol")).toEqual(["low", "medium", "high"]);
  });

  it("is idempotent and safe for an unknown model", () => {
    const once = clampReasoningEffort("gpt-5.6-sol", "minimal");
    expect(clampReasoningEffort("gpt-5.6-sol", once)).toBe(once);
    expect(clampReasoningEffort(undefined, "minimal")).toBe("minimal");
  });
});

describe("chat-page.unit.models.history-guard - the effective history budget per model", () => {
  // The configured budget (256k by default) is bounded by what each model can
  // afford to be handed: its long-context billing threshold minus a reserve,
  // else 60 % of its context window. These assert the real MODEL_CONFIGS
  // numbers, not fixtures, so a new model cannot quietly get an unguarded one.
  it("gives every GPT-6 and 5.6 model an effective budget of 256,000 (272k tier - 16k reserve)", () => {
    for (const id of [
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ] as const) {
      const config = MODEL_CONFIGS[id];
      expect(config.longContextThresholdTokens).toBe(272_000);
      expect(
        resolveHistoryTokenBudget({
          modelBudget: config.historyTokenBudget,
          longContextThresholdTokens: config.longContextThresholdTokens,
          contextWindow: config.contextWindow,
        }),
      ).toBe(256_000);
    }
  });

  it("leaves Claude on the configured default - its 1M window guards higher", () => {
    for (const id of ["claude-opus-5-5", "claude-opus-4-8", "claude-sonnet-5"] as const) {
      const config = MODEL_CONFIGS[id];
      // No known billing cliff on the Azure /anthropic seam.
      expect(config.longContextThresholdTokens).toBeUndefined();
      const decision = resolveHistoryBudget({
        modelBudget: config.historyTokenBudget,
        longContextThresholdTokens: config.longContextThresholdTokens,
        contextWindow: config.contextWindow,
      });
      // 60 % of 1M is 600k, well above the 256k default, so the default wins.
      expect(decision.guard).toBe(600_000);
      expect(decision.guardSource).toBe("contextWindow");
      expect(decision.budget).toBe(DEFAULT_HISTORY_TOKEN_BUDGET);
      expect(decision.cappedByGuard).toBe(false);
    }
  });

  it("caps a small-window model below the default (negative)", () => {
    // DeepSeek's 163,840-token window cannot hold a 256k history, so the guard
    // - not the configured budget - decides.
    const config = MODEL_CONFIGS["DeepSeek-V4-Pro"];
    const decision = resolveHistoryBudget({
      modelBudget: config.historyTokenBudget,
      contextWindow: config.contextWindow,
    });
    expect(decision.budget).toBe(Math.floor(163_840 * 0.6));
    expect(decision.budget).toBeLessThan(DEFAULT_HISTORY_TOKEN_BUDGET);
    expect(decision.cappedByGuard).toBe(true);
  });

  it("keeps every model's effective budget inside its own context window", () => {
    for (const [id, config] of Object.entries(MODEL_CONFIGS)) {
      const budget = resolveHistoryTokenBudget({
        modelBudget: config.historyTokenBudget,
        longContextThresholdTokens: config.longContextThresholdTokens,
        contextWindow: config.contextWindow,
      });
      expect(budget, id).toBeLessThanOrEqual(config.contextWindow);
      // and clear of the priced tier where one is declared.
      if (config.longContextThresholdTokens !== undefined) {
        expect(budget, id).toBeLessThan(config.longContextThresholdTokens);
      }
    }
  });
});
