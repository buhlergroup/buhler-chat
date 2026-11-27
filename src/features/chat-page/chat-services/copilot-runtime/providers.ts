import "server-only";

import type { NamedProviderConfig, ProviderModelConfig } from "@microsoft/copilot-sdk";
import {
  getAzureAiFoundryTokenProvider,
  getAzureCognitiveServicesTokenProvider,
} from "@/features/common/services/azure-default-credential";
import { MODEL_CONFIGS, type ChatModel } from "../models";
import { resolveHistoryBudget } from "../chat-api/history-budget";
import { copilotProviderFor } from "./runtime-flag";

/**
 * BYOK provider wiring for the Copilot runtime. Same endpoints, deployments
 * and auth as the AI SDK path (models/provider.ts):
 *
 *   azure      Azure OpenAI, Responses API, https://<instance>.openai.azure.com.
 *              AZURE_OPENAI_API_KEY when set, else an Entra bearer token
 *              (cognitive services scope) from the app's DefaultAzureCredential.
 *   anthropic  Claude on Azure AI Foundry, https://<resource>.services.ai.azure.com/anthropic.
 *              AZURE_ANTHROPIC_API_KEY when set, else an Entra bearer token
 *              (ai.azure.com scope).
 *
 * The runtime calls the token callback before each model request and caches
 * nothing; getBearerTokenProvider caches and refreshes.
 *
 * Foundry Chat Completions models are not wired on this path (PoC scope).
 */
export const AZURE_PROVIDER = "azure";
export const ANTHROPIC_PROVIDER = "anthropic";

let cognitiveTokens: (() => Promise<string>) | undefined;
let foundryTokens: (() => Promise<string>) | undefined;

function azureProvider(): NamedProviderConfig | undefined {
  const instance = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  if (!instance) return undefined;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  return {
    name: AZURE_PROVIDER,
    type: "azure",
    wireApi: "responses",
    baseUrl: `https://${instance}.openai.azure.com`,
    ...(apiKey
      ? { apiKey }
      : {
          bearerTokenProvider: async () => {
            cognitiveTokens ??= getAzureCognitiveServicesTokenProvider();
            return cognitiveTokens();
          },
        }),
  };
}

function anthropicProvider(): NamedProviderConfig | undefined {
  const resource =
    process.env.AZURE_ANTHROPIC_RESOURCE_NAME ?? process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  if (!resource) return undefined;
  // COPILOT_ANTHROPIC_FORCE_ENTRA=true ignores the key, to prove the token path.
  const apiKey =
    process.env.COPILOT_ANTHROPIC_FORCE_ENTRA === "true"
      ? undefined
      : process.env.AZURE_ANTHROPIC_API_KEY;
  return {
    name: ANTHROPIC_PROVIDER,
    type: "anthropic",
    baseUrl: `https://${resource}.services.ai.azure.com/anthropic`,
    ...(apiKey
      ? { apiKey }
      : {
          bearerTokenProvider: async () => {
            foundryTokens ??= getAzureAiFoundryTokenProvider();
            return foundryTokens();
          },
        }),
  };
}

/** Session-wide selection id of a model: `<provider>/<model id>`. */
export function copilotModelSelectionId(modelId: ChatModel): string {
  const config = MODEL_CONFIGS[modelId];
  const provider = config ? copilotProviderFor(config) : undefined;
  if (!config || !provider) {
    throw new Error(`Model "${modelId}" is not available on the Copilot runtime path`);
  }
  return `${provider}/${config.id}`;
}

/** Input budget of a model: context window minus the output reserve. */
export function copilotPromptLimit(config: { contextWindow: number; maxOutputTokens?: number }): number {
  const limit = config.contextWindow - (config.maxOutputTokens ?? 0);
  return limit > 0 ? limit : config.contextWindow;
}

/**
 * maxPromptTokens of a model on the Copilot path: the history budget
 * (resolveHistoryBudget, the same setting the AI SDK path trims history to),
 * never more than the model's input limit (copilotPromptLimit).
 *
 * The runtime compacts at COMPACTION_THRESHOLD of this number and does not
 * send a larger prompt, so a thread stays below the long-context billing
 * threshold of a model that has one (GPT models bill input 2x above it).
 *
 * COPILOT_MAX_PROMPT_TOKENS is a test knob only (the smoke script sets a small
 * value to force an early compaction); when set, it wins.
 */
export function copilotMaxPromptTokens(
  config: {
    contextWindow: number;
    maxOutputTokens?: number;
    longContextThresholdTokens?: number;
    historyTokenBudget?: number;
  },
  env: Record<string, string | undefined> = process.env,
): number {
  const override = Number(env.COPILOT_MAX_PROMPT_TOKENS);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  const { budget } = resolveHistoryBudget({
    modelBudget: config.historyTokenBudget,
    envBudget: env.HISTORY_TOKEN_BUDGET,
    longContextThresholdTokens: config.longContextThresholdTokens,
    contextWindow: config.contextWindow,
    envReserve: env.HISTORY_LONG_CONTEXT_RESERVE,
  });
  return Math.min(budget, copilotPromptLimit(config));
}

/** Providers and models for a session. Every deployed model is selectable, so a thread can switch models. */
export function buildCopilotInference(): {
  providers: NamedProviderConfig[];
  models: ProviderModelConfig[];
} {
  const providers = [azureProvider(), anthropicProvider()].filter(
    (p): p is NamedProviderConfig => p !== undefined,
  );
  const names = new Set(providers.map((p) => p.name));
  const models: ProviderModelConfig[] = [];
  for (const config of Object.values(MODEL_CONFIGS)) {
    const provider = copilotProviderFor(config);
    if (!provider || !names.has(provider) || !config.deploymentName) continue;
    models.push({
      id: config.id,
      provider,
      wireModel: config.deploymentName,
      name: config.name,
      maxContextWindowTokens: config.contextWindow,
      // The runtime compacts relative to this limit (thresholds in
      // copilot-session.ts), so it is the history budget, not the context
      // window: see copilotMaxPromptTokens.
      maxPromptTokens: copilotMaxPromptTokens(config),
      ...(config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {}),
      capabilities: {
        supports: {
          toolCalls: true,
          vision: (config.capabilities ?? []).includes("vision"),
          reasoningEffort: config.supportsReasoning,
        },
      },
    });
  }
  return { providers, models };
}
