import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockLogWarn = vi.fn();
vi.mock("@/features/common/services/logger", () => ({
  logWarn: (...a: unknown[]) => mockLogWarn(...(a as [])),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  getReasoningEffortOverrides,
  getSupportedReasoningEfforts,
  parseReasoningEffortOverrides,
  resetReasoningEffortOverridesCache,
  resolveReasoningEffort,
} from "./reasoning-effort";
import { MODEL_CONFIGS } from "../models";

beforeEach(() => {
  mockLogWarn.mockClear();
  resetReasoningEffortOverridesCache();
});

describe("getSupportedReasoningEfforts", () => {
  it("reports the GPT-5.6 levels including xhigh and max, and NOT minimal", () => {
    // Measured: gpt-5.6-terra answers 400 for "minimal". The list is the
    // provider's word — the picker and the clamp follow it, not the reverse.
    expect(getSupportedReasoningEfforts(MODEL_CONFIGS["gpt-5.6-terra"])).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("stops at xhigh for gpt-5.5", () => {
    const levels = getSupportedReasoningEfforts(MODEL_CONFIGS["gpt-5.5"]);
    expect(levels).toContain("xhigh");
    expect(levels).not.toContain("max");
  });

  it("falls back to the picker's own levels for a model that names none", () => {
    expect(getSupportedReasoningEfforts(MODEL_CONFIGS["gpt-5.4"])).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(getSupportedReasoningEfforts(undefined)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("parseReasoningEffortOverrides", () => {
  it("returns an empty map for an unset or blank value", () => {
    expect(parseReasoningEffortOverrides(undefined)).toEqual({});
    expect(parseReasoningEffortOverrides("   ")).toEqual({});
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("accepts a level the model supports", () => {
    expect(
      parseReasoningEffortOverrides('{"gpt-5.6-terra":"high"}'),
    ).toEqual({ "gpt-5.6-terra": "high" });
  });

  it("accepts the 5.6-only levels for a 5.6 model", () => {
    expect(parseReasoningEffortOverrides('{"gpt-5.6-sol":"max"}')).toEqual({
      "gpt-5.6-sol": "max",
    });
  });

  it("drops a level the model does not accept and warns (negative)", () => {
    // "max" exists on 5.6 but NOT on 5.5 — sending it would 400 every turn.
    expect(parseReasoningEffortOverrides('{"gpt-5.5":"max"}')).toEqual({});
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("not an effort this model accepts"),
      expect.objectContaining({ modelId: "gpt-5.5", effort: "max" }),
    );
  });

  it("drops an unknown model id and warns (negative)", () => {
    expect(parseReasoningEffortOverrides('{"gpt-9000":"high"}')).toEqual({});
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("unknown model"),
      expect.objectContaining({ modelId: "gpt-9000" }),
    );
  });

  it("drops a non-string value and warns (negative)", () => {
    expect(parseReasoningEffortOverrides('{"gpt-5.6-terra":3}')).toEqual({});
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it("ignores malformed JSON and warns (negative)", () => {
    expect(parseReasoningEffortOverrides("{not json")).toEqual({});
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("not valid JSON"),
      expect.anything(),
    );
  });

  it("ignores a JSON array or null and warns (negative)", () => {
    expect(parseReasoningEffortOverrides("[]")).toEqual({});
    expect(parseReasoningEffortOverrides("null")).toEqual({});
    expect(mockLogWarn).toHaveBeenCalledTimes(2);
  });

  it("keeps the valid entries of a partly invalid map", () => {
    expect(
      parseReasoningEffortOverrides(
        '{"gpt-5.6-terra":"high","gpt-5.5":"max","nope":"low"}',
      ),
    ).toEqual({ "gpt-5.6-terra": "high" });
  });
});

describe("resolveReasoningEffort — resolution order", () => {
  it("prefers an explicit user pick over both the override and the default", () => {
    // The pick has to be a level the model accepts, or the clamp is what the
    // assertion measures instead of the precedence. "low" is deliberately the
    // opposite direction from the "high" override, so a precedence regression
    // cannot hide behind the clamp's own fallback value.
    expect(
      resolveReasoningEffort({
        modelId: "gpt-5.6-terra",
        userPick: "xhigh",
        overrides: { "gpt-5.6-terra": "high" },
      }),
    ).toBe("xhigh");
  });

  it("prefers the env override over the model default", () => {
    expect(
      resolveReasoningEffort({
        modelId: "gpt-5.6-terra",
        overrides: { "gpt-5.6-terra": "xhigh" },
      }),
    ).toBe("xhigh");
  });

  it("falls back to the model default with no pick and no override", () => {
    expect(resolveReasoningEffort({ modelId: "gpt-5.6-terra", overrides: {} })).toBe(
      "medium",
    );
    expect(resolveReasoningEffort({ modelId: "gpt-5.6-sol", overrides: {} })).toBe(
      "low",
    );
    expect(resolveReasoningEffort({ modelId: "gpt-5.6-luna", overrides: {} })).toBe(
      "low",
    );
  });

  it("an override for a DIFFERENT model does not leak (negative)", () => {
    expect(
      resolveReasoningEffort({
        modelId: "gpt-5.6-sol",
        overrides: { "gpt-5.6-terra": "max" },
      }),
    ).toBe("low");
  });

  it("falls back to low for a model with no configured default", () => {
    // grok-4.3 does not reason, so it names no default. Every model that DOES
    // reason must declare one — pinned by chat-page.unit.models.reasoning.
    expect(MODEL_CONFIGS["grok-4.3"].defaultReasoningEffort).toBeUndefined();
    expect(
      resolveReasoningEffort({ modelId: "grok-4.3", overrides: {} }),
    ).toBe("low");
  });

  it("uses the model's own default for a Claude thread", () => {
    // Claude declared no default, so it ran at the hardcoded fallback. The
    // default is now explicit and deliberately the SAME value, so this change
    // set does not move Claude's cost; REASONING_EFFORT_OVERRIDES raises it.
    expect(MODEL_CONFIGS["claude-opus-4-8"].defaultReasoningEffort).toBe("low");
    expect(
      resolveReasoningEffort({ modelId: "claude-opus-4-8", overrides: {} }),
    ).toBe("low");
    expect(
      resolveReasoningEffort({ modelId: "claude-sonnet-5", overrides: {} }),
    ).toBe("low");
  });

  it("clamps a user pick the model does not accept, and says so", () => {
    // The pick is stored on the thread, so passing "minimal" through meant a
    // 400 on every later turn, not just the one the user clicked.
    expect(
      resolveReasoningEffort({
        modelId: "gpt-5.6-terra",
        userPick: "minimal",
        overrides: {},
      }),
    ).toBe("low");
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn.mock.calls[0][0]).toMatch(/not supported by the model/i);
  });

  it("clamps a level that exists on a newer family (negative)", () => {
    // "max" is a 5.6 level; 5.5 stops at xhigh.
    expect(
      resolveReasoningEffort({ modelId: "gpt-5.5", userPick: "max", overrides: {} }),
    ).toBe("low");
  });

  it("leaves a supported pick alone and logs nothing", () => {
    expect(
      resolveReasoningEffort({
        modelId: "gpt-5.6-terra",
        userPick: "xhigh",
        overrides: {},
      }),
    ).toBe("xhigh");
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("still honours a model that has no list at all", () => {
    // gpt-5.4 declares none, so the picker's four apply and "minimal" stands.
    expect(
      resolveReasoningEffort({ modelId: "gpt-5.4", userPick: "minimal", overrides: {} }),
    ).toBe("minimal");
    expect(mockLogWarn).not.toHaveBeenCalled();
  });
});

describe("getReasoningEffortOverrides — env parsing is memoised per value", () => {
  it("re-parses when the raw value changes and caches when it does not", () => {
    expect(getReasoningEffortOverrides('{"gpt-5.6-terra":"high"}')).toEqual({
      "gpt-5.6-terra": "high",
    });
    // Same string → served from cache, so no second warn on a bad entry.
    expect(getReasoningEffortOverrides('{"gpt-5.6-terra":"high"}')).toEqual({
      "gpt-5.6-terra": "high",
    });
    expect(getReasoningEffortOverrides('{"gpt-5.6-sol":"max"}')).toEqual({
      "gpt-5.6-sol": "max",
    });
  });
});
