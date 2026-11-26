import { describe, it, expect } from "vitest";

import { copilotProviderFor, getAgentRuntime } from "./runtime-flag";

describe("getAgentRuntime", () => {
  it("defaults to the AI SDK loop", () => {
    expect(getAgentRuntime({})).toBe("ai-sdk");
    expect(getAgentRuntime({ AGENT_RUNTIME: "" })).toBe("ai-sdk");
    expect(getAgentRuntime({ AGENT_RUNTIME: "ai-sdk" })).toBe("ai-sdk");
    expect(getAgentRuntime({ AGENT_RUNTIME: "something-else" })).toBe("ai-sdk");
  });

  it("selects the Copilot runtime only for AGENT_RUNTIME=copilot", () => {
    expect(getAgentRuntime({ AGENT_RUNTIME: "copilot" })).toBe("copilot");
    expect(getAgentRuntime({ AGENT_RUNTIME: " Copilot " })).toBe("copilot");
  });
});

describe("copilotProviderFor", () => {
  it("serves Responses-API Azure models and Anthropic models with a deployment", () => {
    expect(copilotProviderFor({ supportsResponsesAPI: true, deploymentName: "d" })).toBe("azure");
    expect(copilotProviderFor({ provider: "anthropic", supportsResponsesAPI: false, deploymentName: "d" })).toBe("anthropic");
  });

  it("leaves other models on the AI SDK path", () => {
    expect(copilotProviderFor({ provider: "foundry", supportsResponsesAPI: false, deploymentName: "d" })).toBeUndefined();
    expect(copilotProviderFor({ supportsResponsesAPI: false, deploymentName: "d" })).toBeUndefined();
    expect(copilotProviderFor({ supportsResponsesAPI: true })).toBeUndefined();
  });
});
