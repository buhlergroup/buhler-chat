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
  getMaxOutputTokensOverrides,
  parseMaxOutputTokensOverrides,
  resetMaxOutputTokensOverridesCache,
  resolveMaxOutputTokens,
} from "./max-output-tokens";
import { MODEL_CONFIGS } from "../models";

beforeEach(() => {
  mockLogWarn.mockClear();
  resetMaxOutputTokensOverridesCache();
});

describe("chat-page.unit.max-output.001 — parseMaxOutputTokensOverrides", () => {
  it("reads a well-formed map", () => {
    expect(
      parseMaxOutputTokensOverrides('{"gpt-5.6-terra":48000,"gpt-5.5":20000}'),
    ).toEqual({ "gpt-5.6-terra": 48000, "gpt-5.5": 20000 });
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("treats absent, blank and unparseable as no overrides", () => {
    expect(parseMaxOutputTokensOverrides(undefined)).toEqual({});
    expect(parseMaxOutputTokensOverrides("   ")).toEqual({});
    expect(mockLogWarn).not.toHaveBeenCalled(); // nothing to warn about

    expect(parseMaxOutputTokensOverrides("{not json")).toEqual({});
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-object shape (negative)", () => {
    expect(parseMaxOutputTokensOverrides("[48000]")).toEqual({});
    expect(parseMaxOutputTokensOverrides("null")).toEqual({});
    expect(parseMaxOutputTokensOverrides("48000")).toEqual({});
    expect(mockLogWarn).toHaveBeenCalledTimes(3);
  });

  it("skips an unknown model id (negative)", () => {
    expect(parseMaxOutputTokensOverrides('{"gpt-9000":48000}')).toEqual({});
    expect(mockLogWarn.mock.calls[0][0]).toMatch(/unknown model/i);
  });

  it("does not accept inherited Object.prototype keys as model ids (negative)", () => {
    // Without a hasOwnProperty guard, MODEL_CONFIGS["constructor"] is truthy.
    expect(parseMaxOutputTokensOverrides('{"constructor":48000}')).toEqual({});
    expect(parseMaxOutputTokensOverrides('{"toString":48000}')).toEqual({});
  });

  it("requires a POSITIVE INTEGER, not merely a number (negative)", () => {
    // 0 is not "no limit" — it is a request that may emit nothing. A fraction
    // is a 400 from the provider. A numeric string is a config typo.
    for (const raw of [
      '{"gpt-5.5":0}',
      '{"gpt-5.5":-1000}',
      '{"gpt-5.5":1000.5}',
      '{"gpt-5.5":"20000"}',
      '{"gpt-5.5":null}',
      '{"gpt-5.5":true}',
    ]) {
      mockLogWarn.mockClear();
      expect(parseMaxOutputTokensOverrides(raw), raw).toEqual({});
      expect(mockLogWarn.mock.calls[0][0], raw).toMatch(/positive integer/i);
    }
  });

  it("keeps the good entries when one is bad", () => {
    expect(
      parseMaxOutputTokensOverrides('{"gpt-5.5":20000,"gpt-9000":1,"gpt-5.4":-5}'),
    ).toEqual({ "gpt-5.5": 20000 });
  });
});

describe("chat-page.unit.max-output.002 — the env parse is memoised", () => {
  it("parses once per distinct value, not once per call", () => {
    getMaxOutputTokensOverrides("{bad");
    getMaxOutputTokensOverrides("{bad");
    getMaxOutputTokensOverrides("{bad");
    // One warning, so one parse.
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
  });

  it("re-parses when the value changes", () => {
    expect(getMaxOutputTokensOverrides('{"gpt-5.5":20000}')).toEqual({
      "gpt-5.5": 20000,
    });
    expect(getMaxOutputTokensOverrides('{"gpt-5.5":30000}')).toEqual({
      "gpt-5.5": 30000,
    });
  });

  it("does not confuse an unset cache with an undefined value", () => {
    // The cache sentinel is a Symbol, so it can never equal a real raw value.
    expect(getMaxOutputTokensOverrides(undefined)).toEqual({});
    expect(getMaxOutputTokensOverrides('{"gpt-5.5":20000}')).toEqual({
      "gpt-5.5": 20000,
    });
    expect(getMaxOutputTokensOverrides(undefined)).toEqual({});
  });
});

describe("chat-page.unit.max-output.003 — resolveMaxOutputTokens", () => {
  it("prefers the env override over the value the caller resolved", () => {
    expect(
      resolveMaxOutputTokens({
        modelId: "gpt-5.6-terra",
        modelValue: MODEL_CONFIGS["gpt-5.6-terra"].maxOutputTokens,
        overrides: { "gpt-5.6-terra": 48000 },
      }),
    ).toBe(48000);
  });

  it("falls back to the value the caller resolved", () => {
    expect(
      resolveMaxOutputTokens({
        modelId: "gpt-5.6-terra",
        modelValue: MODEL_CONFIGS["gpt-5.6-terra"].maxOutputTokens,
        overrides: {},
      }),
    ).toBe(32000);
  });

  it("uses the CALLER's value, not a fresh MODEL_CONFIGS lookup", () => {
    // The caller has the config for the effective model in hand. Looking it up
    // again here would make this a second source of truth for one decision —
    // the shape that produced the document-hint defect on this branch.
    expect(
      resolveMaxOutputTokens({
        modelId: "gpt-5.6-terra",
        modelValue: 12345,
        overrides: {},
      }),
    ).toBe(12345);
  });

  it("returns undefined when neither names a ceiling (negative)", () => {
    // undefined means "send no ceiling", so the provider default applies —
    // an unconfigured model must not inherit someone else's number.
    expect(
      resolveMaxOutputTokens({ modelId: "gpt-5.6-terra", overrides: {} }),
    ).toBeUndefined();
  });

  it("does not leak one model's override to another (negative)", () => {
    expect(
      resolveMaxOutputTokens({
        modelId: "gpt-5.6-sol",
        modelValue: 32000,
        overrides: { "gpt-5.6-terra": 48000 },
      }),
    ).toBe(32000);
  });
});

describe("chat-page.unit.max-output.004 — the shipped ceilings", () => {
  it("gives the reasoning-heavy families room for thinking AND an answer", () => {
    // Reasoning counts against this budget, so 16000 was measurably tight at
    // high effort: the thinking consumed it and the answer was cut off.
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"] as const) {
      expect(MODEL_CONFIGS[id].maxOutputTokens, id).toBe(32000);
    }
  });

  it("leaves Claude and the small models where they were", () => {
    // Claude's thinking is adaptive, so the cap is the bill guardrail rather
    // than the thinking budget; the small models are picked for speed.
    expect(MODEL_CONFIGS["claude-opus-4-8"].maxOutputTokens).toBe(16000);
    expect(MODEL_CONFIGS["claude-sonnet-5"].maxOutputTokens).toBe(16000);
    expect(MODEL_CONFIGS["gpt-5.4-mini"].maxOutputTokens).toBe(8000);
    expect(MODEL_CONFIGS["DeepSeek-V4-Pro"].maxOutputTokens).toBe(8000);
  });

  it("keeps every ceiling inside the model's context window", () => {
    for (const [id, config] of Object.entries(MODEL_CONFIGS)) {
      if (!config.maxOutputTokens || !config.contextWindow) continue;
      expect(config.maxOutputTokens, id).toBeLessThan(config.contextWindow);
    }
  });
});
