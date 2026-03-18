"use server";
import "server-only";

import { uniqueId } from "@/features/common/util";
import { executeFunction, FunctionCall } from "./function-registry";
import { logInfo, logDebug, logError } from "@/features/common/services/logger";
import { ResponseInputItem } from "openai/resources/responses/responses";
import { ChatThreadModel } from "../models";

export interface ConversationContext {
  chatThread: ChatThreadModel;
  userMessage: string;
  signal: AbortSignal;
  openaiInstance: any;
  requestOptions: any;
  headers?: Record<string, string>;
  depth?: number;         // Current sub-agent nesting depth (0 = top-level)
  maxDepth?: number;      // Max allowed depth (default 3)
  conversationInput?: ResponseInputItem[]; // Current conversation input for ask_parent_agent
}

export interface ConversationState {
  conversationInput: ResponseInputItem[];
  context: ConversationContext;
  messageId?: string; // Consistent message ID across the entire conversation
}

/**
 * Create a new conversation state and start the initial stream
 */
export async function createConversationState(
  context: ConversationContext, 
  initialInput: ResponseInputItem[]
): Promise<ConversationState> {
  return {
    conversationInput: [...initialInput],
    context,
    messageId: uniqueId() // Generate a consistent message ID for the entire conversation
  };
}

/**
 * Start the initial conversation stream
 */
export async function startConversation(state: ConversationState) {
  logInfo("Starting initial conversation", {
    model: state.context.requestOptions.model,
    toolsCount: state.context.requestOptions.tools?.length || 0,
    hasStream: true
  });
  
  // Make the initial request with the conversation input
  return await state.context.openaiInstance.responses.create({
    ...state.context.requestOptions,
    input: state.conversationInput,
    stream: true,
  }, { signal: state.context.signal });
}

/**
 * Process a completed function call and update conversation
 */
export async function processFunctionCall(
  state: ConversationState,
  functionCall: {
    name: string;
    arguments: string;
    call_id: string;
  }
): Promise<{ 
  success: boolean; 
  result?: string; 
  error?: string; 
  updatedState: ConversationState;
}> {
  try {
    logInfo("Executing function", { 
      name: functionCall.name,
      callId: functionCall.call_id,
      argsLength: functionCall.arguments?.length || 0
    });
    logDebug("Function arguments", { arguments: functionCall.arguments });

    const parsedFunctionCall: FunctionCall = {
      name: functionCall.name,
      arguments: JSON.parse(functionCall.arguments),
      call_id: functionCall.call_id,
    };

    const result = await executeFunction(parsedFunctionCall, {
      conversationContext: {
        ...state.context,
        conversationInput: state.conversationInput,
      },
      userMessage: state.context.userMessage,
      signal: state.context.signal,
      headers: state.context.headers,
    });

    logInfo("Function execution completed", { 
      name: functionCall.name,
      success: true,
      outputLength: result.output?.length || 0
    });
    logDebug("Function result preview", { preview: result.output.substring(0, 200) + "..." });

    // Create updated conversation input
    const updatedConversationInput: ResponseInputItem[] = [
      ...state.conversationInput,
      {
        type: "function_call" as const,
        name: functionCall.name,
        arguments: functionCall.arguments,
        call_id: functionCall.call_id,
      },
      {
        type: "function_call_output" as const,
        call_id: functionCall.call_id,
        output: result.output,
      }
    ];

    const updatedState: ConversationState = {
      ...state,
      conversationInput: updatedConversationInput
    };

    return { success: true, result: result.output, updatedState };
  } catch (error) {
    logError("Function execution failed", { 
      functionName: functionCall.name,
      callId: functionCall.call_id,
      error: error instanceof Error ? error.message : String(error)
    });
    
    const errorMessage = `Function execution failed: ${error}`;
    
    // Create updated conversation input with error
    const updatedConversationInput: ResponseInputItem[] = [
      ...state.conversationInput,
      {
        type: "function_call" as const,
        name: functionCall.name,
        arguments: functionCall.arguments,
        call_id: functionCall.call_id,
      },
      {
        type: "function_call_output" as const,
        call_id: functionCall.call_id,
        output: JSON.stringify({ error: errorMessage }),
      }
    ];

    const updatedState: ConversationState = {
      ...state,
      conversationInput: updatedConversationInput
    };

    return { success: false, error: errorMessage, updatedState };
  }
}

/**
 * Continue the conversation with function results
 */
export async function continueConversation(state: ConversationState) {
  logInfo("Continuing conversation with function results", {
    inputLength: state.conversationInput?.length || 0,
    model: state.context.requestOptions.model
  });
  
  // Make a new request with the updated conversation
  return await state.context.openaiInstance.responses.create({
    ...state.context.requestOptions,
    input: state.conversationInput,
    stream: true,
  }, { signal: state.context.signal });
}

/**
 * Get current conversation input
 */
export async function getConversationInput(state: ConversationState): Promise<ResponseInputItem[]> {
  return [...state.conversationInput];
}
