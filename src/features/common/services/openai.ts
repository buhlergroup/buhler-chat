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
  } = {}
): AzureOpenAIAuthConfig => {
  const { apiKeyEnvVar, extraHeaders } = options;
  const envVar = apiKeyEnvVar ?? "AZURE_OPENAI_API_KEY";
  const apiKey = process.env[envVar];
  const headers = extraHeaders ? { ...extraHeaders } : undefined;

  if (apiKey) {
    const defaultHeaders = { "api-key": apiKey, ...(headers ?? {}) };
    return {
      apiKey,
      defaultHeaders,
    };
  }

  return {
    azureADTokenProvider: getAzureCognitiveServicesTokenProvider(),
    ...(headers ? { defaultHeaders: headers } : {}),
  };
};

export const OpenAIInstance = () => {
  const instanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  const deploymentName = process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION;

  if (!instanceName || !deploymentName || !apiVersion) {
    throw new Error(
      "Azure OpenAI Chat endpoint config is not set, check environment variables."
    );
  }

  const openai = new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig(),
    baseURL: `https://${instanceName}.openai.azure.com/openai/deployments/${deploymentName}`,
    apiVersion,
  });
  return openai;
};

// New v1 API instance for Responses API
export const OpenAIV1Instance = () => {
  const instanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION;

  if (!instanceName || !apiVersion) {
    throw new Error(
      "Azure OpenAI v1 endpoint config is not set, check environment variables."
    );
  }

  const openai = new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig(),
    baseURL: `https://${instanceName}.openai.azure.com/openai/v1/`,
    apiVersion,
    maxRetries: 5,
  });
  return openai;
};

export const OpenAIMiniInstance = () => {
  const instanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  const deploymentName = process.env.AZURE_OPENAI_API_MINI_DEPLOYMENT_NAME;
  const apiVersion = "2025-01-01-preview";

  if (!instanceName || !deploymentName) {
    throw new Error(
      "Azure OpenAI Mini endpoint config is not set, check environment variables."
    );
  }

  const endpoint = `https://${instanceName}.openai.azure.com`;

  const openai = new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig(),
    endpoint,
    deployment: deploymentName,
    apiVersion,
  });
  return openai;
};

export const OpenAIEmbeddingInstance = () => {
  const deploymentName = process.env.AZURE_OPENAI_API_EMBEDDINGS_DEPLOYMENT_NAME;
  const instanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  const apiVersion = "2025-01-01-preview";

  if (!deploymentName || !instanceName) {
    throw new Error(
      "Azure OpenAI Embeddings endpoint config is not set, check environment variables."
    );
  }

  const endpoint = `https://${instanceName}.openai.azure.com`;

  const openai = new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig(),
    endpoint,
    deployment: deploymentName,
    apiVersion,
  });
  return openai;
};

export const OpenAIVisionInstance = () => {
  const deploymentName = process.env.AZURE_OPENAI_VISION_API_DEPLOYMENT_NAME;
  const instanceName = process.env.AZURE_OPENAI_VISION_API_INSTANCE_NAME;
  const version = process.env.AZURE_OPENAI_VISION_API_VERSION;

  if (!deploymentName || !instanceName || !version) {
    throw new Error(
      "Azure OpenAI Vision environment config is not set, check environment variables."
    );
  }

  const openai = new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig({
      apiKeyEnvVar: "AZURE_OPENAI_VISION_API_KEY",
    }),
    baseURL: `https://${instanceName}.openai.azure.com/openai/deployments/${deploymentName}`,
    defaultQuery: {
      "api-version": version,
    },
    apiVersion: version,
  });
  return openai;
};

export const OpenAIReasoningInstance = () => {
  const deploymentName = process.env.AZURE_OPENAI_API_REASONING_DEPLOYMENT_NAME;
  const instanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;

  if (!deploymentName || !instanceName) {
    throw new Error(
      "Azure OpenAI Reasoning deployment config is not set, check environment variables."
    );
  }

  const openai = new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig(),
    baseURL: `https://${instanceName}.openai.azure.com/openai/deployments/${deploymentName}`,
    apiVersion: "2025-04-01-preview",
  });
  return openai;
};

// New v1 API instance for Reasoning models using Responses API
export const OpenAIV1ReasoningInstance = () => {
  const instanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
  const imageDeploymentName = process.env.AZURE_OPENAI_GPT_IMAGE_DEPLOYMENT_NAME;

  if (!instanceName || !apiVersion) {
    throw new Error(
      "Azure OpenAI API config is not set, check environment variables."
    );
  }

  const openai = new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig({
      extraHeaders: imageDeploymentName ? {
        "x-ms-oai-image-generation-deployment": imageDeploymentName,
        "api-version": "preview"
      } : undefined,
    }),
    baseURL: `https://${instanceName}.openai.azure.com/openai/v1/`,
    apiVersion,
    maxRetries: 5,
  });
  return openai;
};

// Image generation instance for v1 API
export const OpenAIV1ImageInstance = () => {
  const instanceName = process.env.AZURE_OPENAI_API_INSTANCE_NAME;
  const deploymentName = process.env.AZURE_OPENAI_GPT_IMAGE_DEPLOYMENT_NAME;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION;

  if (!instanceName || !deploymentName || !apiVersion) {
    throw new Error(
      "Azure OpenAI Image generation config is not set, check environment variables."
    );
  }

  const openai = new AzureOpenAI({
    ...buildAzureOpenAIAuthConfig({
      extraHeaders: {
        "x-ms-oai-image-generation-deployment": deploymentName,
      },
    }),
    baseURL: `https://${instanceName}.openai.azure.com/openai/v1/`,
    apiVersion,
    maxRetries: 5,
  });
  return openai;
};
