import { NextRequest, NextResponse } from "next/server";
import { MODEL_CONFIGS, ChatModel, ModelConfig } from "@/features/chat-page/chat-services/models";
import { logError } from "@/features/common/services/logger";

/**
 * API endpoint to get available models based on environment variables
 * This runs on the server side where environment variables are accessible
 */
export async function GET(request: NextRequest) {
  try {
    const availableModels: Record<string, ModelConfig> = {};
    
    Object.entries(MODEL_CONFIGS).forEach(([modelId, config]) => {
      // Check if the deployment name environment variable is set and not empty
      if (config.deploymentName && config.deploymentName.trim() !== '') {
        availableModels[modelId] = config;
      }
    });
    
    const availableModelIds = Object.keys(availableModels) as ChatModel[];
    
    const defaultModel = availableModelIds.length > 0 ? availableModelIds[0] : "gpt-5.4";
    return NextResponse.json({
      availableModels,
      availableModelIds,
      defaultModel,
      defaultReasoningEffort: MODEL_CONFIGS[defaultModel as ChatModel]?.defaultReasoningEffort || "low"
    });
  } catch (error) {
    logError("Error getting available models", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: "Failed to get available models" },
      { status: 500 }
    );
  }
}
