import { AzureOpenAI } from "openai";
import { getAzureCognitiveServicesTokenProvider } from "./azure-default-credential";

type AzureOpenAIAuthConfig = {
  apiKey?: string;
  azureADTokenProvider?: () => Promise<string>;
  defaultHeaders?: Record<string, string>;
};

const buildAzureOpenAIAuthConfig = (
  options: {
    apiKeyEnvVar?: string;
    extraHeaders?: Record<string, string>;
  } = {},
): AzureOpenAIAuthConfig => {
  const { apiKeyEnvVar, extraHeaders } = options;
  const envVar = apiKeyEnvVar ?? "AZURE_OPENAI_API_KEY";
  const apiKey = process.env[envVar];
  const headers = extraHeaders ? { ...extraHeaders } : undefined;

  if (apiKey) {
    const defaultHeaders = { "api-key": apiKey, ...(headers ?? {}) };
    return { apiKey, defaultHeaders };
  }

  return {
    azureADTokenProvider: getAzureCognitiveServicesTokenProvider(),
    ...(headers ? { defaultHeaders: headers } : {}),
  };
};

export const createProductionOpenAIChat = (): AzureOpenAI => {
  const instanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  const deploymentName = process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
  if (!instanceName || !deploymentName || !apiVersion) {
    throw new Error("Azure OpenAI Chat endpoint config is not set, check environment variables.");
  }
  return new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig(),
    baseURL: `https://${instanceName}.openai.azure.com/openai/deployments/${deploymentName}`,
    apiVersion,
  });
};

export const createProductionOpenAIV1 = (): AzureOpenAI => {
  const instanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
  if (!instanceName || !apiVersion) {
    throw new Error("Azure OpenAI v1 endpoint config is not set, check environment variables.");
  }
  return new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig(),
    baseURL: `https://${instanceName}.openai.azure.com/openai/v1/`,
    apiVersion,
    maxRetries: 5,
  });
};

export const createProductionOpenAIMini = (): AzureOpenAI => {
  const instanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  const deploymentName = process.env.AZURE_OPENAI_API_MINI_DEPLOYMENT_NAME;
  const apiVersion = "2025-01-01-preview";
  if (!instanceName || !deploymentName) {
    throw new Error("Azure OpenAI Mini endpoint config is not set, check environment variables.");
  }
  return new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig(),
    endpoint: `https://${instanceName}.openai.azure.com`,
    deployment: deploymentName,
    apiVersion,
  });
};

export const createProductionOpenAIEmbedding = (): AzureOpenAI => {
  const deploymentName = process.env.AZURE_OPENAI_API_EMBEDDINGS_DEPLOYMENT_NAME;
  const instanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  const apiVersion = "2025-01-01-preview";
  if (!deploymentName || !instanceName) {
    throw new Error("Azure OpenAI Embeddings endpoint config is not set, check environment variables.");
  }
  return new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig(),
    endpoint: `https://${instanceName}.openai.azure.com`,
    deployment: deploymentName,
    apiVersion,
    // The client retries 408, 409, 429 and 5xx with backoff and honours
    // retry-after (default: 2 retries). A long document makes many calls in
    // a row and meets the rate limit, so it gets more retries; no other
    // retry loop runs on top of this one.
    maxRetries: 5,
  });
};

export const createProductionOpenAIVision = (): AzureOpenAI => {
  const deploymentName = process.env.AZURE_OPENAI_VISION_API_DEPLOYMENT_NAME;
  const instanceName = process.env.AZURE_OPENAI_VISION_API_INSTANCE_NAME;
  const version = process.env.AZURE_OPENAI_VISION_API_VERSION;
  if (!deploymentName || !instanceName || !version) {
    throw new Error("Azure OpenAI Vision environment config is not set, check environment variables.");
  }
  return new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig({ apiKeyEnvVar: "AZURE_OPENAI_VISION_API_KEY" }),
    baseURL: `https://${instanceName}.openai.azure.com/openai/deployments/${deploymentName}`,
    defaultQuery: { "api-version": version },
    apiVersion: version,
  });
};

export const createProductionOpenAIReasoning = (): AzureOpenAI => {
  const deploymentName = process.env.AZURE_OPENAI_API_REASONING_DEPLOYMENT_NAME;
  const instanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  if (!deploymentName || !instanceName) {
    throw new Error("Azure OpenAI Reasoning deployment config is not set, check environment variables.");
  }
  return new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig(),
    baseURL: `https://${instanceName}.openai.azure.com/openai/deployments/${deploymentName}`,
    apiVersion: "2025-04-01-preview",
  });
};

export const createProductionOpenAIV1Reasoning = (): AzureOpenAI => {
  const instanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
  const imageDeploymentName = process.env.AZURE_OPENAI_GPT_IMAGE_DEPLOYMENT_NAME;
  if (!instanceName || !apiVersion) {
    throw new Error("Azure OpenAI API config is not set, check environment variables.");
  }
  return new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig({
      extraHeaders: imageDeploymentName
        ? { "x-ms-oai-image-generation-deployment": imageDeploymentName, "api-version": "preview" }
        : undefined,
    }),
    baseURL: `https://${instanceName}.openai.azure.com/openai/v1/`,
    apiVersion,
    maxRetries: 5,
  });
};

export const createProductionOpenAIV1Image = (): AzureOpenAI => {
  const instanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  const deploymentName = process.env.AZURE_OPENAI_GPT_IMAGE_DEPLOYMENT_NAME;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
  if (!instanceName || !deploymentName || !apiVersion) {
    throw new Error("Azure OpenAI Image generation config is not set, check environment variables.");
  }
  return new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig({
      extraHeaders: { "x-ms-oai-image-generation-deployment": deploymentName },
    }),
    baseURL: `https://${instanceName}.openai.azure.com/openai/v1/`,
    apiVersion,
    maxRetries: 5,
  });
};
