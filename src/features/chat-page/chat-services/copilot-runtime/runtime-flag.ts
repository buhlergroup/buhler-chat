/**
 * Agent runtime switch for /api/chat. `AGENT_RUNTIME=copilot` runs the turn on
 * the Copilot runtime (copilot-runtime/); anything else, or nothing, keeps the
 * AI SDK loop.
 */
export type AgentRuntime = "ai-sdk" | "copilot";

export function getAgentRuntime(env: Record<string, string | undefined> = process.env): AgentRuntime {
  return env.AGENT_RUNTIME?.trim().toLowerCase() === "copilot" ? "copilot" : "ai-sdk";
}

/** Provider of a model on the Copilot path, or undefined when the path cannot serve it. */
export function copilotProviderFor(config: {
  provider?: string;
  supportsResponsesAPI: boolean;
  deploymentName?: string;
}): "azure" | "anthropic" | undefined {
  if (!config.deploymentName) return undefined;
  const provider = config.provider ?? "azure";
  if (provider === "azure" && config.supportsResponsesAPI) return "azure";
  if (provider === "anthropic") return "anthropic";
  return undefined;
}
