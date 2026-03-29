import { ChatCompletionMessage } from "openai/resources/chat/completions";
import {
  OpenAIV1Instance,
  OpenAIV1ReasoningInstance,
  OpenAIV1ImageInstance,
} from "@/features/common/services/openai";
import { logError } from "@/features/common/services/logger";

export const DEFAULT_MODEL: ChatModel = "gpt-5.4";

export const CHAT_DOCUMENT_ATTRIBUTE = "CHAT_DOCUMENT";
export const CHAT_THREAD_ATTRIBUTE = "CHAT_THREAD";
export const MESSAGE_ATTRIBUTE = "CHAT_MESSAGE";
export const CHAT_CITATION_ATTRIBUTE = "CHAT_CITATION";

export type ChatModel =
  | "gpt-5"
  | "gpt-5-pro"
  | "gpt-5.1"
  | "gpt-5.2"
  | "gpt-5.3-chat"
  | "gpt-5.4"
  | "gpt-5.4-mini"
  | "gpt-4o"
  | "gpt-4o-mini"
  | "gpt-4.1"
  | "gpt-4.1-mini"
  | "gpt-4.1-nano"
  | "gpt-image-1"
  | "o3"
  | "o3-pro"
  | "o4-mini"
  | "computer-use-preview";

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
}

export interface ModelConfig {
  id: ChatModel;
  name: string;
  description: string;
  getInstance: () => any;
  supportsReasoning: boolean;
  supportedSummarizers?: string[];
  supportsResponsesAPI: boolean;
  supportsImageGeneration?: boolean;
  supportsComputerUse?: boolean;
  deploymentName?: string;
  defaultReasoningEffort?: ReasoningEffort;
  pricing: ModelPricing;
  contextWindow: number;
  fallbackModel?: ChatModel;
  dailyTokenLimit?: number;
  dailyCostLimit?: number;
}

export const MODEL_CONFIGS: Record<ChatModel, ModelConfig> = {
  "gpt-5.4": {
    id: "gpt-5.4",
    name: "GPT-5.4",
    description: "Latest GPT-5.4 model with state-of-the-art capabilities",
    getInstance: () => OpenAIV1ReasoningInstance(),
    supportsReasoning: true,
    supportsResponsesAPI: true,
    supportsImageGeneration: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT54_DEPLOYMENT_NAME,
    defaultReasoningEffort: "low",
    pricing: { inputPerMillion: 2.00, outputPerMillion: 8.00, cachedInputPerMillion: 0.50 },
    contextWindow: 400000,
    fallbackModel: "gpt-5.2",
  },
  "gpt-5.2": {
    id: "gpt-5.2",
    name: "GPT-5.2",
    description: "Latest GPT-5.2 model with enhanced capabilities",
    getInstance: () => OpenAIV1ReasoningInstance(),
    supportsReasoning: true,
    supportsResponsesAPI: true,
    supportsImageGeneration: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT52_DEPLOYMENT_NAME,
    defaultReasoningEffort: "low",
    pricing: { inputPerMillion: 2.00, outputPerMillion: 8.00, cachedInputPerMillion: 0.50 },
    contextWindow: 1047576,
    fallbackModel: "gpt-4.1",
  },
  "gpt-5.1": {
    id: "gpt-5.1",
    name: "GPT-5.1",
    description: "GPT-5.1 model with strong general capabilities",
    getInstance: () => OpenAIV1ReasoningInstance(),
    supportsReasoning: true,
    supportsResponsesAPI: true,
    supportsImageGeneration: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT51_DEPLOYMENT_NAME,
    defaultReasoningEffort: "low",
    pricing: { inputPerMillion: 2.00, outputPerMillion: 8.00, cachedInputPerMillion: 0.50 },
    contextWindow: 1047576,
    fallbackModel: "gpt-4.1",
  },
  "gpt-5": {
    id: "gpt-5",
    name: "GPT-5",
    description: "GPT-5 base model with advanced capabilities",
    getInstance: () => OpenAIV1ReasoningInstance(),
    supportsReasoning: true,
    supportsResponsesAPI: true,
    supportsImageGeneration: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT5_DEPLOYMENT_NAME,
    defaultReasoningEffort: "low",
    pricing: { inputPerMillion: 2.00, outputPerMillion: 8.00, cachedInputPerMillion: 0.50 },
    contextWindow: 1047576,
    fallbackModel: "gpt-4.1",
  },
  "gpt-5.3-chat": {
    id: "gpt-5.3-chat",
    name: "GPT-5.3 Chat",
    description: "Latest GPT-5.3 Chat model optimized for conversational interactions",
    getInstance: () => OpenAIV1Instance(),
    supportsReasoning: true,
    supportsResponsesAPI: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT53_CHAT_DEPLOYMENT_NAME,
    defaultReasoningEffort: "medium",
    pricing: { inputPerMillion: 1.50, outputPerMillion: 6.00, cachedInputPerMillion: 0.375 },
    contextWindow: 1047576,
    fallbackModel: "gpt-4.1",
  },
  "gpt-5.4-mini": {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    description: "Fast and efficient GPT-5.4 model for everyday tasks",
    getInstance: () => OpenAIV1Instance(),
    supportsReasoning: false,
    supportsResponsesAPI: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT54_MINI_DEPLOYMENT_NAME,
    defaultReasoningEffort: "medium",
    pricing: { inputPerMillion: 0.40, outputPerMillion: 1.60, cachedInputPerMillion: 0.10 },
    contextWindow: 1047576,
  },
  "gpt-5-pro": {
    id: "gpt-5-pro",
    name: "GPT-5 Pro",
    description: "Premium GPT-5 model with enhanced performance and extended capabilities",
    getInstance: () => OpenAIV1ReasoningInstance(),
    supportsReasoning: true,
    supportsResponsesAPI: true,
    supportsImageGeneration: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT5_PRO_DEPLOYMENT_NAME,
    defaultReasoningEffort: "high",
    pricing: { inputPerMillion: 10.00, outputPerMillion: 30.00, cachedInputPerMillion: 2.50 },
    contextWindow: 1047576,
    fallbackModel: "gpt-5",
  },
  "gpt-4o": {
    id: "gpt-4o",
    name: "GPT-4o",
    description: "Most capable multimodal model, great for complex tasks",
    getInstance: () => OpenAIV1Instance(),
    supportsReasoning: false,
    supportsResponsesAPI: true,
    deploymentName: process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME,
    defaultReasoningEffort: "medium",
    pricing: { inputPerMillion: 2.50, outputPerMillion: 10.00, cachedInputPerMillion: 1.25 },
    contextWindow: 128000,
    fallbackModel: "gpt-4o-mini",
  },
  "gpt-4o-mini": {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    description: "Fast and efficient model for everyday tasks",
    getInstance: () => OpenAIV1Instance(),
    supportsReasoning: false,
    supportsResponsesAPI: true,
    deploymentName: process.env.AZURE_OPENAI_API_MINI_DEPLOYMENT_NAME,
    defaultReasoningEffort: "medium",
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.60, cachedInputPerMillion: 0.075 },
    contextWindow: 128000,
  },
  "gpt-4.1": {
    id: "gpt-4.1",
    name: "GPT-4.1",
    description: "Latest GPT-4.1 model with enhanced capabilities",
    getInstance: () => OpenAIV1Instance(),
    supportsReasoning: false,
    supportsResponsesAPI: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT41_DEPLOYMENT_NAME,
    defaultReasoningEffort: "medium",
    pricing: { inputPerMillion: 2.00, outputPerMillion: 8.00, cachedInputPerMillion: 0.50 },
    contextWindow: 1047576,
    fallbackModel: "gpt-4.1-mini",
  },
  "gpt-4.1-mini": {
    id: "gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    description: "Efficient version of GPT-4.1",
    getInstance: () => OpenAIV1Instance(),
    supportsReasoning: false,
    supportsResponsesAPI: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT41_MINI_DEPLOYMENT_NAME,
    defaultReasoningEffort: "medium",
    pricing: { inputPerMillion: 0.40, outputPerMillion: 1.60, cachedInputPerMillion: 0.10 },
    contextWindow: 1047576,
    fallbackModel: "gpt-4.1-nano",
  },
  "gpt-4.1-nano": {
    id: "gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    description: "Ultra-fast and lightweight GPT-4.1",
    getInstance: () => OpenAIV1Instance(),
    supportsReasoning: false,
    supportsResponsesAPI: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT41_NANO_DEPLOYMENT_NAME,
    defaultReasoningEffort: "medium",
    pricing: { inputPerMillion: 0.10, outputPerMillion: 0.40, cachedInputPerMillion: 0.025 },
    contextWindow: 1047576,
  },
  "gpt-image-1": {
    id: "gpt-image-1",
    name: "GPT Image 1",
    description: "Specialized model for image generation and editing",
    getInstance: () => OpenAIV1ImageInstance(),
    supportsReasoning: false,
    supportsResponsesAPI: true,
    supportsImageGeneration: true,
    deploymentName: process.env.AZURE_OPENAI_GPT_IMAGE_DEPLOYMENT_NAME,
    defaultReasoningEffort: "medium",
    pricing: { inputPerMillion: 5.00, outputPerMillion: 15.00, cachedInputPerMillion: 2.50 },
    contextWindow: 32000,
  },
  "o3": {
    id: "o3",
    name: "o3 Reasoning",
    description: "Advanced reasoning model with step-by-step thinking",
    getInstance: () => OpenAIV1ReasoningInstance(),
    supportsReasoning: true,
    supportsResponsesAPI: true,
    supportsImageGeneration: true,
    supportedSummarizers: ["detailed", "concise", "auto"],
    deploymentName: process.env.AZURE_OPENAI_API_O3_DEPLOYMENT_NAME,
    defaultReasoningEffort: "low",
    pricing: { inputPerMillion: 2.00, outputPerMillion: 8.00, cachedInputPerMillion: 0.50 },
    contextWindow: 200000,
    fallbackModel: "o4-mini",
  },
  "o3-pro": {
    id: "o3-pro",
    name: "o3-Pro",
    description: "Premium reasoning model with enhanced capabilities and detailed analysis",
    getInstance: () => OpenAIV1ReasoningInstance(),
    supportsReasoning: true,
    supportsResponsesAPI: true,
    supportsImageGeneration: true,
    supportedSummarizers: ["detailed", "concise", "auto"],
    deploymentName: process.env.AZURE_OPENAI_API_O3_PRO_DEPLOYMENT_NAME,
    defaultReasoningEffort: "low",
    pricing: { inputPerMillion: 20.00, outputPerMillion: 80.00, cachedInputPerMillion: 5.00 },
    contextWindow: 200000,
    fallbackModel: "o3",
  },
  "o4-mini": {
    id: "o4-mini",
    name: "o4-Mini",
    description: "Efficient reasoning model with detailed summaries",
    getInstance: () => OpenAIV1ReasoningInstance(),
    supportsReasoning: true,
    supportsResponsesAPI: true,
    supportsImageGeneration: true,
    supportedSummarizers: ["detailed", "concise", "auto"],
    deploymentName: process.env.AZURE_OPENAI_API_O4_MINI_DEPLOYMENT_NAME,
    defaultReasoningEffort: "low",
    pricing: { inputPerMillion: 1.10, outputPerMillion: 4.40, cachedInputPerMillion: 0.275 },
    contextWindow: 200000,
  },
  "computer-use-preview": {
    id: "computer-use-preview",
    name: "Computer Use Preview",
    description: "Experimental model with computer interaction capabilities",
    getInstance: () => OpenAIV1ReasoningInstance(),
    supportsReasoning: false,
    supportsResponsesAPI: true,
    supportsComputerUse: true,
    deploymentName: process.env.AZURE_OPENAI_API_COMPUTER_USE_DEPLOYMENT_NAME,
    defaultReasoningEffort: "medium",
    pricing: { inputPerMillion: 3.00, outputPerMillion: 12.00, cachedInputPerMillion: 0.75 },
    contextWindow: 128000,
  }
};

/**
 * Fetches available models from the server API
 * This is necessary because environment variables are only accessible on the server side
 */
export async function getAvailableModels(): Promise<Record<ChatModel, ModelConfig>> {
  try {
    const response = await fetch('/api/models');
    if (!response.ok) {
      throw new Error('Failed to fetch available models');
    }
    const data = await response.json();
    return data.availableModels;
  } catch (error) {
    logError("Error fetching available models", { 
      error: error instanceof Error ? error.message : String(error) 
    });
    // Fallback to all models if API fails
    return MODEL_CONFIGS;
  }
}

/**
 * Fetches available model IDs from the server API
 */
export async function getAvailableModelIds(): Promise<ChatModel[]> {
  try {
    const response = await fetch('/api/models');
    if (!response.ok) {
      throw new Error('Failed to fetch available models');
    }
    const data = await response.json();
    return data.availableModelIds;
  } catch (error) {
    logError("Error fetching available model IDs", { 
      error: error instanceof Error ? error.message : String(error) 
    });
    // Fallback to all model IDs if API fails
    return Object.keys(MODEL_CONFIGS) as ChatModel[];
  }
}

/**
 * Fetches the default model from the server API
 */
export async function getDefaultModel(): Promise<ChatModel> {
  try {
    const response = await fetch('/api/models');
    if (!response.ok) {
      throw new Error('Failed to fetch default model');
    }
    const data = await response.json();
    return data.defaultModel;
  } catch (error) {
    logError("Error fetching default model", { 
      error: error instanceof Error ? error.message : String(error) 
    });
    return DEFAULT_MODEL;
  }
}

/**
 * Checks if a specific model is available by fetching from server API
 */
export async function isModelAvailable(modelId: ChatModel): Promise<boolean> {
  try {
    const availableModels = await getAvailableModels();
    return !!availableModels[modelId];
  } catch (error) {
    logError("Error checking model availability", { 
      modelId,
      error: error instanceof Error ? error.message : String(error) 
    });
    // Fallback to checking if model exists in config
    return !!MODEL_CONFIGS[modelId];
  }
}

export interface ChatMessageModel {
  id: string;
  createdAt: Date;
  isDeleted: boolean;
  threadId: string;
  userId: string;
  content: string;
  role: ChatRole;
  name: string;
  multiModalImage?: string;
  multiModalImages?: string[];
  reasoningContent?: string;
  toolCallHistory?: Array<{ name: string; arguments: string; result?: string; timestamp: Date }>;
  type: typeof MESSAGE_ATTRIBUTE;
  reasoningState?: any;
}

export type ChatRole = "system" | "user" | "assistant" | "function" | "tool" | "reasoning";

export type AttachedFileType = "code-interpreter" | "search-indexed";

export interface AttachedFileModel {
  id: string;
  name: string;
  type: AttachedFileType;
  uploadedAt?: Date;
}

export interface ThreadUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCostUsd: number;
  lastUpdated: string;
}

export interface DefaultTools {
  webSearch?: boolean;
  imageGeneration?: boolean;
  companyContent?: boolean;
  codeInterpreter?: boolean;
}

export interface ChatThreadModel {
  id: string;
  name: string;
  createdAt: Date;
  lastMessageAt: Date;
  userId: string;
  useName: string;
  isDeleted: boolean;
  bookmarked: boolean;
  personaMessage: string;
  personaMessageTitle: string;
  extension: string[];
  type: typeof CHAT_THREAD_ATTRIBUTE;
  personaDocumentIds: string[];
  selectedModel?: ChatModel;
  reasoningEffort?: ReasoningEffort;
  isTemporary?: boolean;
  codeInterpreterContainerId?: string;
  codeInterpreterFileIdsSignature?: string;
  attachedFiles?: Array<AttachedFileModel>;
  subAgentIds?: string[];
  usage?: ThreadUsage;
  defaultTools?: DefaultTools;
}

export interface UserPrompt {
  id: string; // thread id
  message: string;
  // Back-compat: single image
  multimodalImage?: string;
  // Preferred: multiple images
  multimodalImages?: string[];
  selectedModel?: ChatModel;
  reasoningEffort?: ReasoningEffort;
  webSearchEnabled?: boolean;
  imageGenerationEnabled?: boolean;
  companyContentEnabled?: boolean;
  codeInterpreterEnabled?: boolean;
  codeInterpreterFileIds?: string[];
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface ChatDocumentModel {
  id: string;
  name: string;
  chatThreadId: string;
  userId: string;
  isDeleted: boolean;
  createdAt: Date;
  type: typeof CHAT_DOCUMENT_ATTRIBUTE;
}

export interface ToolsInterface {
  name: string;
  description: string;
  parameters: any;
}

export type MenuItemsGroupName = "Bookmarked" | "Past 7 days" | "Previous";

export type MenuItemsGroup = {
  groupName: MenuItemsGroupName;
} & ChatThreadModel;

export type ChatCitationModel = {
  id: string;
  content: any;
  userId: string;
  type: typeof CHAT_CITATION_ATTRIBUTE;
};

export type AzureChatCompletionFunctionCall = {
  type: "functionCall";
  response: ChatCompletionMessage.FunctionCall;
};

export type AzureChatCompletionFunctionCallResult = {
  type: "functionCallResult";
  response: string;
};

export type AzureChatCompletionContent = {
  type: "content";
  response: any; // This will be the streaming snapshot from OpenAI
};

export type AzureChatCompletionFinalContent = {
  type: "finalContent";
  response: string;
};

export type AzureChatCompletionError = {
  type: "error";
  response: string;
};

export type AzureChatCompletionAbort = {
  type: "abort";
  response: string;
};

export type AzureChatCompletionReasoning = {
  type: "reasoning";
  response: string;
};

export interface UsageDataResponse {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
  threadTotalCostUsd: number;
  threadTotalTokens: number;
  contextWindowSize: number;
  contextUsagePercent: number;
  model: string;
}

export type AzureChatCompletionUsageData = {
  type: "usageData";
  response: UsageDataResponse;
};

export type AzureChatCompletionUsageWarning = {
  type: "usageWarning";
  response: {
    message: string;
    originalModel: string;
    fallbackModel: string;
    limitType: "tokens" | "cost";
    currentUsage: number;
    limit: number;
  };
};

export type AzureChatCompletion =
  | AzureChatCompletionError
  | AzureChatCompletionFunctionCall
  | AzureChatCompletionFunctionCallResult
  | AzureChatCompletionContent
  | AzureChatCompletionFinalContent
  | AzureChatCompletionAbort
  | AzureChatCompletionReasoning
  | AzureChatCompletionUsageData
  | AzureChatCompletionUsageWarning;

// https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/read?view=doc-intel-4.0.0&tabs=sample-code#input-requirements-v4
export enum SupportedFileExtensionsDocumentIntellicence {
  JPEG = "JPEG",
  JPG = "JPG",
  PNG = "PNG",
  BMP = "BMP",
  TIFF = "TIFF",
  HEIF = "HEIF",
  DOCX = "DOCX",
  XLSX = "XLSX",
  PPTX = "PPTX",
  HTML = "HTML",
  PDF = "PDF",
}

// https://platform.openai.com/docs/guides/images?api-mode=responses#image-input-requirements
export enum SupportedFileExtensionsInputImages{
  JPEG = "JPEG",
  JPG = "JPG",
  PNG = "PNG",
  WEBP = "WEBP"
}

export enum SupportedFileExtensionsTextFiles {
  TXT = "TXT",
  LOG = "LOG",
  CSV = "CSV",
  MD = "MD",
  RTF = "RTF",
  HTML = "HTML",
  HTM = "HTM",
  CSS = "CSS",
  JS = "JS",
  JSON = "JSON",
  XML = "XML",
  YML = "YML",
  YAML = "YAML",
  PHP = "PHP",
  PY = "PY",
  JAVA = "JAVA",
  C = "C",
  H = "H",
  CPP = "CPP",
  HPP = "HPP",
  TS = "TS",
  SQL = "SQL",
  INI = "INI",
  CONF = "CONF",
  ENV = "ENV",
  TEX = "TEX",
  SH = "SH",
  BAT = "BAT",
  PS1 = "PS1",
  GITIGNORE = "GITIGNORE",
  GRADLE = "GRADLE",
  GROOVY = "GROOVY",
  MAKEFILE = "MAKEFILE",
  MK = "MK",
  PLIST = "PLIST",
  TOML = "TOML",
  RC = "RC",
}
