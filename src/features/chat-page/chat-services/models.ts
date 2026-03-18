import { ChatCompletionMessage } from "openai/resources/chat/completions";
import {
  OpenAIV1Instance,
  OpenAIV1ReasoningInstance,
} from "@/features/common/services/openai";
import { logError } from "@/features/common/services/logger";

export const CHAT_DOCUMENT_ATTRIBUTE = "CHAT_DOCUMENT";
export const CHAT_THREAD_ATTRIBUTE = "CHAT_THREAD";
export const MESSAGE_ATTRIBUTE = "CHAT_MESSAGE";
export const CHAT_CITATION_ATTRIBUTE = "CHAT_CITATION";

export type ChatModel =
  | "gpt-5.2"
  | "gpt-5.3-chat"
  | "gpt-5.4"
  | "gpt-5.4-mini";

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
}

export const MODEL_CONFIGS: Record<ChatModel, ModelConfig> = {
  "gpt-5.2": {
    id: "gpt-5.2",
    name: "GPT-5.2",
    description: "Latest GPT-5.2 model with enhanced capabilities",
    getInstance: () => OpenAIV1ReasoningInstance(),
    supportsReasoning: true,
    supportsResponsesAPI: true,
    supportsImageGeneration: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT52_DEPLOYMENT_NAME,
    defaultReasoningEffort: "low"
  },
  "gpt-5.3-chat": {
    id: "gpt-5.3-chat",
    name: "GPT-5.3 Chat",
    description: "Latest GPT-5.3 Chat model optimized for conversational interactions",
    getInstance: () => OpenAIV1Instance(),
    supportsReasoning: true,
    supportsResponsesAPI: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT53_CHAT_DEPLOYMENT_NAME,
    defaultReasoningEffort: "medium"
  },
  "gpt-5.4": {
    id: "gpt-5.4",
    name: "GPT-5.4",
    description: "Latest GPT-5.4 model with advanced capabilities",
    getInstance: () => OpenAIV1ReasoningInstance(),
    supportsReasoning: true,
    supportsResponsesAPI: true,
    supportsImageGeneration: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT54_DEPLOYMENT_NAME,
    defaultReasoningEffort: "low"
  },
  "gpt-5.4-mini": {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    description: "Fast and efficient GPT-5.4 model for everyday tasks",
    getInstance: () => OpenAIV1Instance(),
    supportsReasoning: false,
    supportsResponsesAPI: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT54_MINI_DEPLOYMENT_NAME,
    defaultReasoningEffort: "medium"
  },
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
    // Fallback to gpt-5.4 if API fails
    return "gpt-5.4";
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

export type AzureChatCompletion =
  | AzureChatCompletionError
  | AzureChatCompletionFunctionCall
  | AzureChatCompletionFunctionCallResult
  | AzureChatCompletionContent
  | AzureChatCompletionFinalContent
  | AzureChatCompletionAbort
  | AzureChatCompletionReasoning;

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
