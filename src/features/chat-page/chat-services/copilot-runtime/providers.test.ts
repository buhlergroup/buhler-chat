// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/features/common/services/azure-default-credential", () => ({
  getAzureAiFoundryTokenProvider: vi.fn(),
  getAzureCognitiveServicesTokenProvider: vi.fn(),
}));

import { copilotMaxPromptTokens, copilotPromptLimit } from "./providers";
import { MODEL_CONFIGS } from "../models";

const gpt = MODEL_CONFIGS["gpt-6.2-sol"];
const claude = MODEL_CONFIGS["claude-opus-5-5"];
const deepseek = MODEL_CONFIGS["DeepSeek-V4-Pro"];

describe("copilotMaxPromptTokens (the runtime compacts relative to it)", () => {
  it("is the history budget, not the context window", () => {
    // 272k long-context threshold - 16k reserve = 256k = the default budget.
    expect(copilotMaxPromptTokens(gpt, {})).toBe(256_000);
    expect(copilotMaxPromptTokens(gpt, {})).toBeLessThan(gpt.longContextThresholdTokens!);
    expect(copilotPromptLimit(gpt)).toBe(1_018_000);
  });

  it("a Claude model gets the default budget (the 60 % context window guard does not bite)", () => {
    expect(claude.longContextThresholdTokens).toBeUndefined();
    expect(copilotMaxPromptTokens(claude, {})).toBe(256_000);
  });

  it("a small context window: 60 % of it", () => {
    expect(copilotMaxPromptTokens(deepseek, {})).toBe(98_304);
  });

  it("HISTORY_TOKEN_BUDGET lowers every model", () => {
    const env = { HISTORY_TOKEN_BUDGET: "100000" };
    expect(copilotMaxPromptTokens(gpt, env)).toBe(100_000);
    expect(copilotMaxPromptTokens(claude, env)).toBe(100_000);
    expect(copilotMaxPromptTokens(deepseek, env)).toBe(98_304);
  });

  it("HISTORY_TOKEN_BUDGET cannot lift a prompt over the long-context threshold", () => {
    expect(copilotMaxPromptTokens(gpt, { HISTORY_TOKEN_BUDGET: "900000" })).toBe(256_000);
  });

  it("never more than the model's input limit", () => {
    const tiny = { contextWindow: 10_000, maxOutputTokens: 8_000, historyTokenBudget: 9_000 };
    // The 60 % guard gives 6,000; the input limit is 2,000.
    expect(copilotMaxPromptTokens(tiny, {})).toBe(2_000);
  });

  it("the smoke test knob COPILOT_MAX_PROMPT_TOKENS still wins", () => {
    expect(copilotMaxPromptTokens(gpt, { COPILOT_MAX_PROMPT_TOKENS: "12000" })).toBe(12_000);
    expect(copilotMaxPromptTokens(deepseek, { COPILOT_MAX_PROMPT_TOKENS: "6000", HISTORY_TOKEN_BUDGET: "100000" })).toBe(6_000);
    expect(copilotMaxPromptTokens(gpt, { COPILOT_MAX_PROMPT_TOKENS: "nonsense" })).toBe(256_000);
  });
});

describe("buildCopilotInference", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("gives each deployed model its history budget as maxPromptTokens", async () => {
    vi.stubEnv("AZURE_OPENAI_API_INSTANCE_NAME", "example");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "test-key");
    vi.stubEnv("AZURE_ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("AZURE_OPENAI_API_GPT62_SOL_DEPLOYMENT_NAME", "gpt62");
    vi.stubEnv("AZURE_ANTHROPIC_OPUS55_DEPLOYMENT_NAME", "opus55");
    vi.stubEnv("HISTORY_TOKEN_BUDGET", "");
    vi.stubEnv("COPILOT_MAX_PROMPT_TOKENS", "");
    vi.resetModules();
    const { buildCopilotInference } = await import("./providers");
    const models = Object.fromEntries(buildCopilotInference().models.map((m) => [m.id, m]));
    expect(models["gpt-6.2-sol"].maxPromptTokens).toBe(256_000);
    expect(models["gpt-6.2-sol"].maxContextWindowTokens).toBe(1_050_000);
    expect(models["claude-opus-5-5"].maxPromptTokens).toBe(256_000);

    vi.stubEnv("HISTORY_TOKEN_BUDGET", "100000");
    const lowered = buildCopilotInference().models;
    expect(lowered.map((m) => m.maxPromptTokens)).toEqual(lowered.map(() => 100_000));
  });
});
