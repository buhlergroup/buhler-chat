import "server-only";

import type { NamedProviderConfig, ProviderModelConfig } from "@microsoft/copilot-sdk";
import {
  getAzureAiFoundryTokenProvider,
  getAzureCognitiveServicesTokenProvider,
} from "@/features/common/services/azure-default-credential";
import { MODEL_CONFIGS, type ChatModel } from "../models";
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
  // Test knob: a small prompt limit makes the runtime compact early.
  const maxPromptTokens = Number(process.env.COPILOT_MAX_PROMPT_TOKENS) || undefined;
  for (const config of Object.values(MODEL_CONFIGS)) {
    const provider = copilotProviderFor(config);
    if (!provider || !names.has(provider) || !config.deploymentName) continue;
    models.push({
      id: config.id,
      provider,
      wireModel: config.deploymentName,
      name: config.name,
      maxContextWindowTokens: config.contextWindow,
      ...(maxPromptTokens ? { maxPromptTokens } : {}),
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
