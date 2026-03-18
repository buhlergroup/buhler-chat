"use server";
import "server-only";

import { ResponseInputItem } from "openai/resources/responses/responses";
import { ChatThreadModel, MODEL_CONFIGS, ChatModel, DEFAULT_MODEL } from "../models";
import { FindPersonaByID } from "@/features/persona-page/persona-services/persona-service";
import { findOrCreateSubAgentThread } from "./sub-agent-thread-service";
import { FindTopChatMessagesForCurrentUser, CreateChatMessage } from "../chat-message-service";
import { mapOpenAIChatMessages } from "../utils";
import { getCurrentUser } from "@/features/auth-page/helpers";
import {
  getAvailableFunctions,
  executeFunction,
  registerDynamicFunction,
  getToolByName,
  buildSubAgentTool,
  FunctionCall,
} from "./function-registry";
import { FindAllExtensionForCurrentUserAndIds, FindSecureHeaderValue } from "@/features/extensions-page/extension-services/extension-service";
import { FindAllChatDocuments } from "../chat-document-service";
import { logInfo, logDebug, logError } from "@/features/common/services/logger";
import { CHAT_DEFAULT_SYSTEM_PROMPT } from "@/features/theme/theme-config";

const MAX_TOOL_TURNS = 10;

export interface SubConversationOptions {
  parentThread: ChatThreadModel;
  subAgentPersonaId: string;
  task: string;
  signal: AbortSignal;
  parentConversationInput: ResponseInputItem[];
  parentOpenaiInstance: any;
  parentRequestOptions: any;
  depth: number;
  maxDepth: number;
  headers?: Record<string, string>;
}

export interface SubConversationResult {
  agentName: string;
  agentId: string;
  model: string;
  response: string;
  summary: string;
  error?: boolean;
}

/**
 * Execute a full sub-conversation with tool access, thread persistence,
 * and the ability to query the parent agent.
 */
export async function executeSubConversation(
  options: SubConversationOptions
): Promise<SubConversationResult> {
  const {
    parentThread,
    subAgentPersonaId,
    task,
    signal,
    parentConversationInput,
    parentOpenaiInstance,
    parentRequestOptions,
    depth,
    maxDepth,
    headers,
  } = options;

  // 1. Depth check
  if (depth >= maxDepth) {
    logError("Sub-agent nesting depth exceeded", { depth, maxDepth, subAgentPersonaId });
    return {
      agentName: "unknown",
      agentId: subAgentPersonaId,
      model: "unknown",
      response: "",
      summary: `Sub-agent nesting depth limit (${maxDepth}) exceeded. Cannot call deeper sub-agents.`,
      error: true,
    };
  }

  // 2. Load persona
  const personaResponse = await FindPersonaByID(subAgentPersonaId);
  if (personaResponse.status !== "OK") {
    logError("Sub-agent persona not found", { subAgentPersonaId });
    return {
      agentName: "unknown",
      agentId: subAgentPersonaId,
      model: "unknown",
      response: "",
      summary: `Agent "${subAgentPersonaId}" was not found or you do not have access to it.`,
      error: true,
    };
  }
  const persona = personaResponse.response;

  // 3. Find or create sub-agent thread
  const subThread = await findOrCreateSubAgentThread(
    parentThread.id,
    subAgentPersonaId,
    persona
  );

  // 4. Determine model
  const subAgentModelId = (persona.selectedModel as ChatModel) ||
    parentThread.selectedModel ||
    DEFAULT_MODEL;
  const subAgentModelConfig = MODEL_CONFIGS[subAgentModelId];

  if (!subAgentModelConfig?.deploymentName) {
    logError("Sub-agent model not available", { subAgentPersonaId, requestedModel: subAgentModelId });
    return {
      agentName: persona.name,
      agentId: subAgentPersonaId,
      model: subAgentModelId,
      response: "",
      summary: `The model "${subAgentModelId}" configured for agent "${persona.name}" is not available.`,
      error: true,
    };
  }

  try {
    const openaiInstance = subAgentModelConfig.getInstance();

    // 5. Build tools for sub-agent
    const tools: any[] = [];
    const extensionHeaders: Record<string, string> = {};

    await getAvailableFunctions();

    // Extensions
    if (subThread.extension && subThread.extension.length > 0) {
      const extensionResponse = await FindAllExtensionForCurrentUserAndIds(subThread.extension);
      if (extensionResponse.status === "OK") {
        const configuredExtensions = extensionResponse.response.filter(
          (ext) => subThread.extension.includes(ext.id)
        );
        for (const extension of configuredExtensions) {
          for (const functionDef of extension.functions) {
            try {
              const parsedFunction = JSON.parse(functionDef.code);
              const resolvedHeaders: Record<string, string> = {};
              for (const header of extension.headers) {
                const headerValueResponse = await FindSecureHeaderValue(header.id);
                if (headerValueResponse.status === "OK") {
                  resolvedHeaders[header.key] = headerValueResponse.response;
                  extensionHeaders[header.key] = headerValueResponse.response;
                }
              }
              const dynamicFunction = await registerDynamicFunction(
                parsedFunction.name,
                parsedFunction.description,
                parsedFunction.parameters,
                functionDef.endpoint,
                functionDef.endpointType,
                resolvedHeaders
              );
              tools.push(dynamicFunction);
            } catch (error) {
              logError("Failed to register sub-agent extension function", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      }
    }

    // search_documents if persona has documents
    const documentsResponse = await FindAllChatDocuments(subThread.id);
    const hasChatDocuments = documentsResponse.status === "OK" && documentsResponse.response.length > 0;
    const hasPersonaDocuments = (subThread.personaDocumentIds?.length || 0) > 0;
    const hasAnyDocuments = hasChatDocuments || hasPersonaDocuments;

    if (hasAnyDocuments) {
      const searchDocumentsTool = await getToolByName("search_documents");
      if (searchDocumentsTool) {
        tools.push(searchDocumentsTool);
      }
    }

    // call_sub_agent if sub-agents configured (nested, with depth+1)
    if (subThread.subAgentIds && subThread.subAgentIds.length > 0) {
      const subAgentTool = await buildSubAgentTool(subThread.subAgentIds);
      if (subAgentTool) {
        tools.push(subAgentTool);
      }
    }

    // ask_parent_agent tool
    const askParentAgentTool = {
      type: "function" as const,
      name: "ask_parent_agent",
      description:
        "IMPORTANT: You are a sub-agent. Call this tool IMMEDIATELY when the task references context you don't have — such as specific names, IPs, credentials, file paths, configurations, or any user-specific details. The parent agent has the full conversation history with the user and can provide these details. Do NOT guess or use placeholders. Do NOT ask the user in your text response — they cannot see it. This tool is your ONLY way to get missing context.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The question to ask the parent agent. Be specific about what information or context you need.",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
      strict: true as const,
    };
    tools.push(askParentAgentTool);

    // 6. Load thread history
    const historyResponse = await FindTopChatMessagesForCurrentUser(subThread.id);
    let history: ResponseInputItem[] = [];
    if (historyResponse.status === "OK") {
      const mapped = await mapOpenAIChatMessages(historyResponse.response);
      history = mapped.reverse();
    }

    // 7. Build system message with document hint and sub-agent instructions
    let documentHint = "";
    if (hasAnyDocuments) {
      documentHint = `\n\nDOCUMENT CONTEXT: You have documents available. You MUST call the search_documents tool with the user's question as the query before composing an answer. Iterate using top and skip to gather enough context.`;
    }

    const subAgentHint = `\n\nSUB-AGENT CONTEXT: You are operating as a sub-agent. The user cannot see your responses directly — only the parent agent can. You have an ask_parent_agent tool available. If the task references specific details you don't have (server names, IPs, database names, credentials, file paths, project-specific context, etc.), you MUST call ask_parent_agent to retrieve them BEFORE writing your response. Do not use placeholders or generic values when real values are expected.`;

    const systemMessage = `${CHAT_DEFAULT_SYSTEM_PROMPT}\n\nToday's Date: ${new Date().toLocaleDateString()}${documentHint}${subAgentHint}\n\n${subThread.personaMessage}`;

    // Build input
    const input: any[] = [
      {
        type: "message" as const,
        role: "system" as const,
        content: systemMessage,
      },
      ...history,
      {
        type: "message" as const,
        role: "user" as const,
        content: task,
      },
    ];

    // 8. Request options
    const requestOptions: any = {
      model: subAgentModelConfig.deploymentName,
      stream: false,
      store: false,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? "auto" : undefined,
    };

    if (subAgentModelConfig.supportsReasoning) {
      requestOptions.reasoning = {
        effort: subAgentModelConfig.defaultReasoningEffort || "low",
        summary: "auto",
      };
    }

    logInfo("Starting sub-conversation", {
      agentName: persona.name,
      agentId: subAgentPersonaId,
      model: subAgentModelConfig.deploymentName,
      depth,
      toolCount: tools.length,
      historyLength: history.length,
      taskPreview: task.substring(0, 200),
    });

    // 9. Tool loop (max MAX_TOOL_TURNS turns)
    let turns = 0;
    let finalText = "";

    while (turns < MAX_TOOL_TURNS) {
      const response = await openaiInstance.responses.create(
        { ...requestOptions, input },
        { signal }
      );

      const functionCalls = (response.output || []).filter(
        (item: any) => item.type === "function_call"
      );

      // Extract text output
      const textOutput = (response.output || [])
        .filter((item: any) => item.type === "message")
        .flatMap((item: any) => item.content || [])
        .filter((content: any) => content.type === "output_text")
        .map((content: any) => content.text)
        .join("\n");

      if (functionCalls.length === 0) {
        finalText = textOutput;
        break;
      }

      // Process function calls
      for (const fc of functionCalls) {
        let fcResult: string;

        if (fc.name === "ask_parent_agent") {
          // Handle ask_parent_agent
          fcResult = await executeAskParentAgent(
            fc.arguments,
            parentConversationInput,
            parentOpenaiInstance,
            parentRequestOptions,
            signal
          );
        } else if (fc.name === "call_sub_agent") {
          // Handle nested sub-agent calls
          const nestedArgs = typeof fc.arguments === "string"
            ? JSON.parse(fc.arguments)
            : fc.arguments;

          const nestedResult = await executeSubConversation({
            parentThread: subThread,
            subAgentPersonaId: nestedArgs.agent_id,
            task: nestedArgs.task,
            signal,
            parentConversationInput: input,
            parentOpenaiInstance: openaiInstance,
            parentRequestOptions: requestOptions,
            depth: depth + 1,
            maxDepth,
            headers: { ...headers, ...extensionHeaders },
          });

          fcResult = typeof nestedResult === "string"
            ? nestedResult
            : JSON.stringify(nestedResult);
        } else {
          // Execute other functions via the registry
          const parsedArgs = typeof fc.arguments === "string"
            ? JSON.parse(fc.arguments)
            : fc.arguments;

          const parsedFunctionCall: FunctionCall = {
            name: fc.name,
            arguments: parsedArgs,
            call_id: fc.call_id,
          };

          const result = await executeFunction(parsedFunctionCall, {
            conversationContext: {
              chatThread: subThread,
              userMessage: task,
              signal,
              openaiInstance,
              requestOptions,
              headers: { ...headers, ...extensionHeaders },
              depth,
              maxDepth,
              conversationInput: input,
            },
            userMessage: task,
            signal,
            headers: { ...headers, ...extensionHeaders },
          });

          fcResult = result.output;
        }

        // Append function_call + function_call_output to input
        input.push({
          type: "function_call" as const,
          name: fc.name,
          arguments: typeof fc.arguments === "string" ? fc.arguments : JSON.stringify(fc.arguments),
          call_id: fc.call_id,
        });
        input.push({
          type: "function_call_output" as const,
          call_id: fc.call_id,
          output: fcResult,
        });
      }

      turns++;
    }

    if (turns >= MAX_TOOL_TURNS && !finalText) {
      finalText = "[Sub-agent reached maximum tool call iterations without producing a final response]";
    }

    // 10. Save messages on sub-agent thread
    const user = await getCurrentUser();
    await CreateChatMessage({
      name: user.name,
      content: task,
      role: "user",
      chatThreadId: subThread.id,
    });

    await CreateChatMessage({
      name: persona.name,
      content: finalText,
      role: "assistant",
      chatThreadId: subThread.id,
    });

    logInfo("Sub-conversation completed", {
      agentName: persona.name,
      agentId: subAgentPersonaId,
      responseLength: finalText.length,
      toolTurns: turns,
      depth,
    });

    return {
      agentName: persona.name,
      agentId: subAgentPersonaId,
      model: subAgentModelId,
      response: finalText,
      summary: `Agent "${persona.name}" responded successfully.`,
    };
  } catch (error) {
    logError("Sub-conversation failed", {
      agentId: subAgentPersonaId,
      depth,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      agentName: persona.name,
      agentId: subAgentPersonaId,
      model: subAgentModelId,
      response: "",
      summary: `Sub-agent "${persona.name}" failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      error: true,
    };
  }
}

/**
 * Execute the ask_parent_agent tool: query the parent's model with the parent's
 * conversation context + the sub-agent's question, but with no tools (prevents recursion).
 */
async function executeAskParentAgent(
  argsRaw: string | Record<string, any>,
  parentConversationInput: ResponseInputItem[],
  parentOpenaiInstance: any,
  parentRequestOptions: any,
  signal: AbortSignal
): Promise<string> {
  const args = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw;
  const question = args.question;

  logInfo("ask_parent_agent called", { questionPreview: question?.substring(0, 200) });

  try {
    const input = [
      ...parentConversationInput,
      {
        type: "message" as const,
        role: "user" as const,
        content: `[Sub-agent question]: ${question}`,
      },
    ];

    const response = await parentOpenaiInstance.responses.create(
      {
        model: parentRequestOptions.model,
        input,
        stream: false,
        store: false,
        // No tools - prevents recursion
      },
      { signal }
    );

    const textOutput = (response.output || [])
      .filter((item: any) => item.type === "message")
      .flatMap((item: any) => item.content || [])
      .filter((content: any) => content.type === "output_text")
      .map((content: any) => content.text)
      .join("\n");

    logInfo("ask_parent_agent response received", { responseLength: textOutput.length });

    return textOutput || "[Parent agent did not provide a response]";
  } catch (error) {
    logError("ask_parent_agent failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return `[Error querying parent agent: ${error instanceof Error ? error.message : "Unknown error"}]`;
  }
}
