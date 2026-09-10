/**
 * AI SDK provider seam.
 *
 * Resolves a LanguageModelV4 from @ai-sdk/azure
 * for a given ChatModel, via the service-container DI registry.
 *
 * The old AzureOpenAI factories in openai.ts / openai.production.ts continue
 * to function in parallel until task-12 cutover removes them.
 */

import { createAzure } from "@ai-sdk/azure";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { getAzureAiFoundryTokenProvider } from "@/features/common/services/azure-default-credential";
import {
  register,
  resolve,
  has,
  SERVICE_KEYS,
} from "@/features/common/services/service-container";
import { getAzureCognitiveServicesTokenProvider } from "@/features/common/services/azure-default-credential";
import { MODEL_CONFIGS, type ChatModel } from "../models";

/** The shape stored under SERVICE_KEYS.aiProvider: a function that maps a
 *  deployment name to a LanguageModelV4. */
export type AiProviderFn = (deploymentName: string) => LanguageModelV4;

/** Same shape for the Foundry (OpenAI-compatible) provider. */
export type FoundryProviderFn = (deploymentName: string) => LanguageModelV4;

/** Same shape for the Anthropic (Azure /anthropic Messages API) provider. */
export type AnthropicProviderFn = (deploymentName: string) => LanguageModelV4;

/**
 * Returns the LanguageModelV4 for the given ChatModel by looking up the
 * deployment name in MODEL_CONFIGS and delegating to the registered aiProvider.
 */
export function resolveAzureModel(modelId: ChatModel): LanguageModelV4 {
  const config = MODEL_CONFIGS[modelId];
  if (!config) {
    throw new Error(`resolveAzureModel: unknown modelId "${modelId}"`);
  }
  const deploymentName = config.deploymentName;
  if (!deploymentName) {
    throw new Error(
      `resolveAzureModel: no deploymentName configured for model "${modelId}". ` +
        `Check the relevant AZURE_OPENAI_API_*_DEPLOYMENT_NAME env var.`,
    );
  }
  const provider = resolve<AiProviderFn>(SERVICE_KEYS.aiProvider);
  return provider(deploymentName);
}

/**
 * Production factory for the aiProvider service.
 *
 * Auth precedence (mirrors openai.production.ts):
 *   1. AZURE_OPENAI_API_KEY present → API-key auth (`api-key` header).
 *   2. Otherwise → Azure AD via DefaultAzureCredential; the token is fetched
 *      per-request through a custom `fetch` wrapper so that the SDK's
 *      `loadApiKey` call is satisfied by a non-empty placeholder while the
 *      real `Authorization: Bearer …` header overrides it at call time.
 *
 * @ai-sdk/azure config used:
 *   createAzure({ resourceName, apiKey?, apiVersion?, fetch? })
 *   provider(deploymentName) → LanguageModelV4
 */
export function createProductionAzureProvider(): AiProviderFn {
  const resourceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  const apiVersion =
    process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview";
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const imageDeploymentName =
    process.env.AZURE_OPENAI_GPT_IMAGE_DEPLOYMENT_NAME;

  if (!resourceName) {
    throw new Error(
      "createProductionAzureProvider: AZURE_OPENAI_API_INSTANCE_NAME is not set.",
    );
  }

  // Azure's built-in `image_generation` tool needs a deployment hint via
  // this header. Without it the Responses-API stream closes with
  // finishReason="error" and no useful body. Legacy openai.production.ts
  // set this header — the AI SDK migration regressed it.
  // https://ai-sdk.dev/providers/ai-sdk-providers/azure#image-generation
  const imageGenHeader: Record<string, string> | undefined =
    imageDeploymentName
      ? { "x-ms-oai-image-generation-deployment": imageDeploymentName }
      : undefined;

  if (apiKey) {
    // API-key path: straightforward.
    const azure = createAzure({
      resourceName,
      apiKey,
      apiVersion,
      headers: imageGenHeader,
    });
    return (deploymentName) => azure(deploymentName);
  }

  // Azure AD path.
  // @ai-sdk/azure v3 does not expose a token-provider parameter; instead we
  // supply a custom `fetch` wrapper that:
  //   1. Obtains a fresh Bearer token via DefaultAzureCredential.
  //   2. Removes the (empty-placeholder) `api-key` header.
  //   3. Injects `Authorization: Bearer <token>`.
  //
  // We pass apiKey=" " (a single space) so that loadApiKey() inside the SDK
  // does not throw "API key is missing" while still letting our fetch
  // wrapper replace authentication at runtime.
  const getToken = getAzureCognitiveServicesTokenProvider();

  const aadFetch: typeof fetch = async (input, init) => {
    const token = await getToken();
    const headers = new Headers(init?.headers);
    headers.delete("api-key");
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };

  const azure = createAzure({
    resourceName,
    apiKey: " ", // placeholder; replaced by aadFetch above
    apiVersion,
    fetch: aadFetch,
    headers: imageGenHeader,
  });

  return (deploymentName) => azure(deploymentName);
}

// Register production binding at module init (skipped if already registered,
// e.g. when e2e-fakes/register.ts has injected a test double first).
if (!has(SERVICE_KEYS.aiProvider)) {
  register(SERVICE_KEYS.aiProvider, createProductionAzureProvider);
}

/**
 * Returns the LanguageModelV4 for a Foundry-hosted ChatModel by looking up
 * its deployment name and delegating to the registered foundryProvider.
 */
export function resolveFoundryModel(modelId: ChatModel): LanguageModelV4 {
  const config = MODEL_CONFIGS[modelId];
  if (!config) {
    throw new Error(`resolveFoundryModel: unknown modelId "${modelId}"`);
  }
  const deploymentName = config.deploymentName;
  if (!deploymentName) {
    throw new Error(
      `resolveFoundryModel: no deploymentName configured for model "${modelId}". ` +
        `Check the relevant FOUNDRY_*_DEPLOYMENT_NAME env var.`,
    );
  }
  const provider = resolve<FoundryProviderFn>(SERVICE_KEYS.foundryProvider);
  return provider(deploymentName);
}

/**
 * Production factory for the foundryProvider service.
 *
 * The Bühler Azure AI Foundry endpoint is OpenAI-compatible, so we use
 * @ai-sdk/openai's `createOpenAI({ baseURL, apiKey })` pointed at its
 * `/openai/v1` base URL. Chat Completions only — no Responses-API tools or
 * reasoning options are sent (see provider-seam.ts foundry branch).
 *
 * Lazily validates env at first model resolution (not at registration) so a
 * deployment that never downgrades to Foundry doesn't require the env to be
 * set.
 */
export function createProductionFoundryProvider(): FoundryProviderFn {
  const baseURL = process.env.FOUNDRY_OPENAI_BASE_URL;
  const apiKey = process.env.FOUNDRY_API_KEY;
  if (!baseURL || !apiKey) {
    throw new Error(
      "createProductionFoundryProvider: FOUNDRY_OPENAI_BASE_URL and FOUNDRY_API_KEY must be set.",
    );
  }
  const provider = createOpenAI({ baseURL, apiKey });
  return (deploymentName) => provider(deploymentName);
}

if (!has(SERVICE_KEYS.foundryProvider)) {
  register(SERVICE_KEYS.foundryProvider, createProductionFoundryProvider);
}

/**
 * Returns the LanguageModelV4 for an Anthropic-hosted ChatModel (Azure
 * /anthropic surface) by deployment name, via the registered provider.
 */
export function resolveAnthropicModel(modelId: ChatModel): LanguageModelV4 {
  const config = MODEL_CONFIGS[modelId];
  if (!config) {
    throw new Error(`resolveAnthropicModel: unknown modelId "${modelId}"`);
  }
  const deploymentName = config.deploymentName;
  if (!deploymentName) {
    throw new Error(
      `resolveAnthropicModel: no deploymentName configured for model "${modelId}". ` +
        `Check the relevant AZURE_ANTHROPIC_*_DEPLOYMENT_NAME env var.`,
    );
  }
  const provider = resolve<AnthropicProviderFn>(SERVICE_KEYS.anthropicProvider);
  return provider(deploymentName);
}

/**
 * Production factory for the anthropicProvider service.
 *
 * Azure AI Foundry serves Claude via an Anthropic-native Messages API at
 * `https://<resource>.services.ai.azure.com/anthropic/v1`. @ai-sdk/anthropic's
 * `createAnthropic({ baseURL, apiKey })` speaks that protocol directly (x-api-key
 * + anthropic-version headers; POSTs to `${baseURL}/messages`).
 *
 * Resource defaults to AZURE_OPENAI_API_INSTANCE_NAME. Auth uses
 * AZURE_ANTHROPIC_API_KEY (x-api-key). Validated lazily at first resolution.
 */
export function createProductionAnthropicProvider(): AnthropicProviderFn {
  const resourceName =
    process.env.AZURE_ANTHROPIC_RESOURCE_NAME ??
    process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  if (!resourceName) {
    throw new Error(
      "createProductionAnthropicProvider: AZURE_ANTHROPIC_RESOURCE_NAME / AZURE_OPENAI_API_INSTANCE_NAME is not set.",
    );
  }
  const baseURL = `https://${resourceName}.services.ai.azure.com/anthropic/v1`;
  const apiKey = process.env.AZURE_ANTHROPIC_API_KEY;

  if (apiKey) {
    // API-key path → SDK sends it as `x-api-key`.
    const anthropic = createAnthropic({ baseURL, apiKey });
    return (deploymentName) => anthropic(deploymentName);
  }

  // Entra ID path. The Foundry data plane needs the ai.azure.com scope (the
  // cognitive-services scope is rejected with 401 here). Inject a fresh Bearer
  // token per request via a custom fetch; pass a placeholder apiKey so the
  // SDK's loadApiKey() check passes.
  const getToken = getAzureAiFoundryTokenProvider();
  const aadFetch: typeof fetch = async (input, init) => {
    const token = await getToken();
    const headers = new Headers(init?.headers);
    headers.delete("x-api-key");
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  const anthropic = createAnthropic({ baseURL, apiKey: " ", fetch: aadFetch });
  return (deploymentName) => anthropic(deploymentName);
}

if (!has(SERVICE_KEYS.anthropicProvider)) {
  register(SERVICE_KEYS.anthropicProvider, createProductionAnthropicProvider);
}
