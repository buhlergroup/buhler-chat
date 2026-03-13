"use server";
import "server-only";

import { SimilaritySearch } from "../azure-ai-search/azure-ai-search";
import { CreateCitations, FormatCitations } from "../citation-service";
import { getCurrentUser, userHashedId } from "@/features/auth-page/helpers";
import { logInfo, logDebug, logError } from "@/features/common/services/logger";
import { AllowedPersonaDocumentIds } from "@/features/persona-page/persona-services/persona-documents-service";
import { ConversationContext } from "./conversation-manager";
import { FindPersonaByID, FindAllPersonaForCurrentUser } from "@/features/persona-page/persona-services/persona-service";
import { MODEL_CONFIGS, ChatModel } from "../models";

// Type definitions for function calling
export interface FunctionDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required: string[];
    additionalProperties: false;
  };
  strict: true;
}

export interface FunctionCall {
  name: string;
  arguments: Record<string, any>;
  call_id: string;
}

export interface FunctionResult {
  call_id: string;
  output: string;
}

// Function registry - maps function names to implementations
const functionRegistry = new Map<string, (args: any, context: any) => Promise<any>>();

// Helper function to register a function
export async function registerFunction(
  name: string, 
  implementation: (args: any, context: any) => Promise<any>
) {
  functionRegistry.set(name, implementation);
}

// Helper function to execute a function call
export async function executeFunction(
  functionCall: FunctionCall, 
  context: { conversationContext: ConversationContext; userMessage: string; signal: AbortSignal; headers?: Record<string, string> }
): Promise<FunctionResult> {
  const implementation = functionRegistry.get(functionCall.name);
  
  if (!implementation) {
    return {
      call_id: functionCall.call_id,
      output: JSON.stringify({ error: `Function ${functionCall.name} not found` })
    };
  }

  try {
    const result = await implementation(functionCall.arguments, context);
    return {
      call_id: functionCall.call_id,
      output: typeof result === 'string' ? result : JSON.stringify(result)
    };
  } catch (error) {
    return {
      call_id: functionCall.call_id,
      output: JSON.stringify({ error: `Function execution failed: ${error}` })
    };
  }
}

// Built-in function implementations

// RAG search function
async function searchDocuments(
  args: { query: string; top?: number; skip?: number }, 
  context: { conversationContext: ConversationContext; userMessage: string; documentIds?: string[]; signal: AbortSignal; headers?: Record<string, string> }
) {
  logInfo("Searching documents", { 
    queryLength: args.query?.length || 0,
    top: args.top || 10,
    skip: args.skip || 0,
    threadId: context.conversationContext.chatThread.id 
  });
  logDebug("Search query", { query: args.query });

  const top = args.top || 10;
  const skip = args.skip || 0;
  const userId = await userHashedId();

  // Check if we should create embeddings (default to true for backward compatibility)
  const shouldCreateEmbedding = context.headers?.['x-create-embedding'] !== 'false';

  const allowedPersonaDocumentIds = await AllowedPersonaDocumentIds(context.conversationContext.chatThread.personaDocumentIds || []) || [];

  // Build filter: user's thread docs plus allowed persona docs
  const baseFilter = `(user eq '${userId}' and chatThreadId eq '${context.conversationContext.chatThread.id}')`; 
  const personaClause = allowedPersonaDocumentIds.length > 0
    ? ` or search.in(personaDocumentId, '${allowedPersonaDocumentIds.join(',')}', ',')`
    : '';
  const filter = `${baseFilter}${personaClause}`;

  const documentResponse = await SimilaritySearch(
    args.query,
    top,
    filter,
    skip,
    shouldCreateEmbedding
  );

  if (documentResponse.status !== "OK") {
    logError("Document search failed", { errors: documentResponse.errors });
    return {
      query: args.query,
      documents: [],
      summary: `Search failed: ${documentResponse.errors?.[0]?.message || "Unknown error"}`,
      error: true
    };
  }
  
  logInfo("Document search completed", { 
    resultCount: documentResponse.response?.length || 0 
  });

  const withoutEmbedding = FormatCitations(documentResponse.response);
  const citationResponse = await CreateCitations(withoutEmbedding);

  const documents: Array<{
    id: string;
    content: string;
    metadata: string;
    relevanceScore?: number;
  }> = [];
  
  citationResponse.forEach((c, index) => {
    if (c.status === "OK") {
      documents.push({
        id: c.response.id,
        content: c.response.content.document.pageContent,
        metadata: c.response.content.document.metadata,
        relevanceScore: documentResponse.response[index]?.score || 0,
      });
    }
  });

  // Create a comprehensive response with context
  const contextText = documents
    .map((doc, index) => {
      return `[Document ${index + 1}] ${doc.metadata}\nContent: ${doc.content.substring(0, 500)}${doc.content.length > 500 ? '...' : ''}\n`;
    })
    .join('\n---\n');

  return {
    query: args.query,
    documents: documents,
    contextText: contextText,
    summary: `Found ${documents.length} relevant documents for: "${args.query}". Use the document content to provide detailed answers.`,
    documentCount: documents.length
  };
}

// Company content search function using Microsoft 365 Copilot Retrieval API
async function searchCompanyContent(
  args: { query: string; dataSource?: string; maxResults?: number },
  context: { conversationContext: ConversationContext; userMessage: string; signal: AbortSignal }
) {
  logInfo("Searching company content", {
    queryLength: args.query?.length || 0,
    dataSource: args.dataSource || "sharePoint",
    maxResults: args.maxResults || 10,
    threadId: context.conversationContext.chatThread.id
  });
  logDebug("Company content search query", { query: args.query });

  try {
    const user = await getCurrentUser();
    const token = user.token;
    
    if (!token) {
      logError("No access token available for company content search");
      return {
        query: args.query,
        results: [],
        summary: "Unable to search company content: No access token available. Please sign in again.",
        error: true
      };
    }

    // Log token info for debugging (first/last few chars only for security)
    logDebug("Company content search token check", {
      tokenLength: token.length,
      tokenPrefix: token.substring(0, 10) + "...",
      userEmail: user.email
    });

    const dataSource = args.dataSource || "sharePoint";
    const maxResults = Math.min(Math.max(args.maxResults || 10, 1), 25);

    // Call Microsoft Graph Copilot Retrieval API
    const response = await fetch("https://graph.microsoft.com/v1.0/copilot/retrieval", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        queryString: args.query.substring(0, 1500), // Limit to 1500 chars per API docs
        dataSource: dataSource,
        resourceMetadata: ["title", "author"],
        maximumNumberOfResults: maxResults,
      }),
      signal: context.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      logError("Company content search failed", { status: response.status, error: errorText });
      
      if (response.status === 401) {
        return {
          query: args.query,
          results: [],
          summary: "Company content search failed: Authorization expired. Please sign in again.",
          error: true
        };
      }
      
      if (response.status === 403) {
        return {
          query: args.query,
          results: [],
          summary: "Company content search failed: Insufficient permissions. The required permission for content search is Files.Read.All.",
          error: true
        };
      }

      return {
        query: args.query,
        results: [],
        summary: `Company content search failed: ${response.status} ${response.statusText}`,
        error: true
      };
    }

    const data = await response.json();
    const hits = data.retrievalHits || [];

    logInfo("Company content search completed", { resultCount: hits.length });

    // Format results for the AI
    const results = hits.map((hit: any, index: number) => {
      const title = hit.resourceMetadata?.title || extractTitleFromUrl(hit.webUrl);
      const author = hit.resourceMetadata?.author || "Unknown";
      const extracts = hit.extracts || [];
      
      return {
        index: index + 1,
        title: title,
        author: author,
        url: hit.webUrl,
        resourceType: hit.resourceType,
        sensitivityLabel: hit.sensitivityLabel?.displayName || null,
        content: extracts.map((e: any) => e.text).join("\n\n"),
        relevanceScores: extracts.map((e: any) => e.relevanceScore).filter(Boolean),
      };
    });

    // Create context text for the AI
    const contextText = results
      .map((r: any) => {
        return `[${r.index}] ${r.title} (by ${r.author})${r.sensitivityLabel ? ` [${r.sensitivityLabel}]` : ""}
Source: ${r.url}
Content:
${r.content}
`;
      })
      .join("\n---\n");

    return {
      query: args.query,
      dataSource: dataSource,
      results: results,
      contextText: contextText,
      summary: `Found ${results.length} relevant company documents for: "${args.query}". Use this content to ground your response and cite sources when relevant.`,
      resultCount: results.length
    };
  } catch (error) {
    logError("Company content search error", { error: error instanceof Error ? error.message : String(error) });
    return {
      query: args.query,
      results: [],
      summary: `Company content search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      error: true
    };
  }
}

// Helper to extract title from URL
function extractTitleFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split("/").filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1] || "Untitled";
    return decodeURIComponent(lastPart.replace(/\.[^/.]+$/, "").replace(/_/g, " "));
  } catch {
    return "Untitled";
  }
}

// Sub-agent calling function
async function callSubAgent(
  args: { agent_id: string; task: string },
  context: { conversationContext: ConversationContext; userMessage: string; signal: AbortSignal; headers?: Record<string, string> }
) {
  logInfo("Calling sub-agent", {
    agentId: args.agent_id,
    taskLength: args.task?.length || 0,
    threadId: context.conversationContext.chatThread.id,
  });

  // Validate the agent_id is in the allowed sub-agent list for this chat thread
  const allowedSubAgentIds = context.conversationContext.chatThread.subAgentIds || [];
  if (!allowedSubAgentIds.includes(args.agent_id)) {
    logError("Sub-agent call denied: agent not in allowed list", {
      requestedAgentId: args.agent_id,
      allowedIds: allowedSubAgentIds,
    });
    return {
      error: true,
      summary: `Agent "${args.agent_id}" is not configured as a sub-agent for this conversation. Available sub-agents are limited to those configured by the parent agent.`,
    };
  }

  // Verify user access to the target agent
  const personaResponse = await FindPersonaByID(args.agent_id);
  if (personaResponse.status !== "OK") {
    logError("Sub-agent not found or not accessible", {
      agentId: args.agent_id,
      status: personaResponse.status,
    });
    return {
      error: true,
      summary: `Agent "${args.agent_id}" was not found or you do not have access to it.`,
    };
  }

  const subAgent = personaResponse.response;

  // Determine which model to use for the sub-agent
  // Falls back to the model selected for the current chat thread, then to "gpt-4o"
  const subAgentModelId = (subAgent.selectedModel as ChatModel) ||
    context.conversationContext.chatThread.selectedModel ||
    "gpt-4o";
  const subAgentModelConfig = MODEL_CONFIGS[subAgentModelId];

  if (!subAgentModelConfig?.deploymentName) {
    logError("Sub-agent model not available", {
      agentId: args.agent_id,
      requestedModel: subAgentModelId,
    });
    return {
      error: true,
      summary: `The model "${subAgentModelId}" configured for agent "${subAgent.name}" is not available.`,
    };
  }

  try {
    const openaiInstance = subAgentModelConfig.getInstance();
    
    const requestOptions: any = {
      model: subAgentModelConfig.deploymentName,
      stream: false,
      store: false,
    };

    if (subAgentModelConfig.supportsReasoning) {
      requestOptions.reasoning = {
        effort: subAgentModelConfig.defaultReasoningEffort || "low",
        summary: "auto",
      };
    }

    const input = [
      {
        type: "message" as const,
        role: "system" as const,
        content: subAgent.personaMessage,
      },
      {
        type: "message" as const,
        role: "user" as const,
        content: args.task,
      },
    ];

    logDebug("Sub-agent request", {
      agentName: subAgent.name,
      model: subAgentModelConfig.deploymentName,
      taskPreview: args.task.substring(0, 200),
    });

    const response = await openaiInstance.responses.create({
      ...requestOptions,
      input,
    }, { signal: context.signal });

    // Extract text content from the response
    const outputText = response.output
      ?.filter((item: any) => item.type === "message")
      .flatMap((item: any) => item.content || [])
      .filter((content: any) => content.type === "output_text")
      .map((content: any) => content.text)
      .join("\n") || "";

    logInfo("Sub-agent call completed", {
      agentId: args.agent_id,
      agentName: subAgent.name,
      responseLength: outputText.length,
    });

    return {
      agentName: subAgent.name,
      agentId: args.agent_id,
      model: subAgentModelId,
      response: outputText,
      summary: `Agent "${subAgent.name}" responded successfully.`,
    };
  } catch (error) {
    logError("Sub-agent call failed", {
      agentId: args.agent_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      error: true,
      agentName: subAgent.name,
      summary: `Sub-agent "${subAgent.name}" failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

// Register built-in functions (will be called when needed)
async function ensureBuiltInFunctionsRegistered() {
  if (!functionRegistry.has("search_documents")) {
    await registerFunction("search_documents", searchDocuments);
  }
  if (!functionRegistry.has("search_company_content")) {
    await registerFunction("search_company_content", searchCompanyContent);
  }
  if (!functionRegistry.has("call_sub_agent")) {
    await registerFunction("call_sub_agent", callSubAgent);
  }
}

// Get all available function definitions
export async function getAvailableFunctions(): Promise<FunctionDefinition[]> {
  // Ensure built-in functions are registered
  await ensureBuiltInFunctionsRegistered();
  
  // No built-in function tools needed anymore - image_generation is handled as a tool type
  // and search_documents is added conditionally in chat-api-response.ts
  return [];
}

// Get a specific tool by name
export async function getToolByName(toolName: string): Promise<FunctionDefinition | null> {
  // Ensure built-in functions are registered
  await ensureBuiltInFunctionsRegistered();
  
  // Define all available tools (including those not in getAvailableFunctions)
  const allTools = [
    {
      type: "function" as const, 
      name: "search_documents",
      description: "Search through documents attached to the current chat to find relevant information. Use this when the user asks questions that might be answered by their documents. Iterate using top (max results) and skip (offset) to paginate until you gather enough context.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query to find relevant documents and information. Should be the raw question or a summarized version which is used for semantic search."
          },
          top: {
            type: ["number", "null"],
            description: "Maximum number of documents to return (default: 10). Use a higher number if the first page lacks sufficient context."
          },
          skip: {
            type: ["number", "null"],
            description: "Number of documents to skip (default: 0). Use to paginate (e.g., skip=10 with top=10 for the second page)."
          }  
        }
      },
      strict: true as const
    },
    {
      type: "function" as const,
      name: "search_company_content",
      description: "Search for relevant content from company SharePoint, OneDrive, and connected data sources. Use this tool when the user asks questions about company policies, internal documents, procedures, or any information that might be in corporate repositories. This searches across all content the user has access to.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language query to search for relevant company content. Should be a clear, concise question or topic (max 1500 characters)."
          },
          dataSource: {
            type: ["string", "null"],
            description: "The data source to search. Options: 'sharePoint' (SharePoint sites), 'oneDriveBusiness' (OneDrive for Business). Default: 'sharePoint'."
          },
          maxResults: {
            type: ["number", "null"],
            description: "Maximum number of results to return (1-25). Default: 10."
          }
        }
      },
      strict: true as const
    },
    {
      type: "function" as const,
      name: "call_sub_agent",
      description: "Delegate a task to a specialized sub-agent. Use this when a question or task is better handled by another agent with specific expertise. The sub-agent will process the task independently and return its response.",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "The unique identifier of the sub-agent to call."
          },
          task: {
            type: "string",
            description: "The task or question to delegate to the sub-agent. Be specific and provide all necessary context."
          }
        }
      },
      strict: true as const
    }
  ];

  const tool = allTools.find(t => t.name === toolName);
  if (tool) {
    return {
      ...tool,
      parameters: validateAndFixSchema(tool.parameters)
    };
  }
  
  return null;
}

// Build a call_sub_agent tool definition with validated accessible sub-agents
export async function buildSubAgentTool(
  subAgentIds: string[]
): Promise<FunctionDefinition | null> {
  if (!subAgentIds || subAgentIds.length === 0) {
    return null;
  }

  await ensureBuiltInFunctionsRegistered();

  // Verify user access to each sub-agent and build the description
  const accessibleAgents: Array<{ id: string; name: string; description: string }> = [];
  const allPersonasResponse = await FindAllPersonaForCurrentUser();

  if (allPersonasResponse.status !== "OK") {
    logError("Failed to fetch accessible personas for sub-agent validation");
    return null;
  }

  const accessiblePersonaIds = new Set(
    allPersonasResponse.response.map((p) => p.id)
  );

  for (const agentId of subAgentIds) {
    if (!accessiblePersonaIds.has(agentId)) {
      logInfo("Sub-agent not accessible to user, skipping", { agentId });
      continue;
    }

    const personaResponse = await FindPersonaByID(agentId);
    if (personaResponse.status === "OK") {
      accessibleAgents.push({
        id: personaResponse.response.id,
        name: personaResponse.response.name,
        description: personaResponse.response.description,
      });
    }
  }

  if (accessibleAgents.length === 0) {
    logInfo("No accessible sub-agents found");
    return null;
  }

  // Build a rich description that tells the AI about available sub-agents
  const agentList = accessibleAgents
    .map((a) => `- "${a.name}" (id: ${a.id}): ${a.description}`)
    .join("\n");

  const toolDescription = `Delegate a task to a specialized sub-agent. Use this when a question or task is better handled by another agent with specific expertise. The sub-agent will process the task independently and return its response.\n\nAvailable sub-agents:\n${agentList}`;

  const tool: FunctionDefinition = {
    type: "function",
    name: "call_sub_agent",
    description: toolDescription,
    parameters: validateAndFixSchema({
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: `The unique identifier of the sub-agent to call. Must be one of: ${accessibleAgents.map((a) => a.id).join(", ")}`,
        },
        task: {
          type: "string",
          description:
            "The task or question to delegate to the sub-agent. Be specific and provide all necessary context.",
        },
      },
    }),
    strict: true,
  };

  logInfo("Built sub-agent tool", {
    accessibleCount: accessibleAgents.length,
    agentNames: accessibleAgents.map((a) => a.name).join(", "),
  });

  return tool;
}

// Helper function to validate and fix function schemas for Azure OpenAI strict mode
function validateAndFixSchema(schema: any): any {
  if (typeof schema !== 'object' || schema === null) {
    return schema;
  }

  // Create a deep copy to avoid mutating the original
  const fixedSchema = JSON.parse(JSON.stringify(schema));

  // Ensure additionalProperties is set to false for all object types
  if (fixedSchema.type === 'object') {
    fixedSchema.additionalProperties = false;
    
    // Ensure all properties are marked as required for OpenAI compatibility
    if (fixedSchema.properties) {
      const propertyKeys = Object.keys(fixedSchema.properties);
      if (propertyKeys.length > 0) {
        fixedSchema.required = propertyKeys;
      }
      
      // Recursively fix nested properties
      for (const key in fixedSchema.properties) {
        fixedSchema.properties[key] = validateAndFixSchema(fixedSchema.properties[key]);
      }
    }
  }

  // Handle arrays
  if (fixedSchema.type === 'array' && fixedSchema.items) {
    fixedSchema.items = validateAndFixSchema(fixedSchema.items);
  }

  return fixedSchema;
}

// Add support for dynamic extensions
export async function registerDynamicFunction(
  name: string,
  description: string,
  parameters: any,
  endpoint: string,
  method: string = "POST",
  headers: Record<string, string> = {}
) {
  // Validate and fix the parameters schema to ensure it meets Azure OpenAI strict mode requirements
  const validatedParameters = validateAndFixSchema(parameters);
  
  logDebug("Registering dynamic function", { 
    name, 
    method, 
    endpoint: endpoint.substring(0, 50) + "...",
    hasHeaders: Object.keys(headers).length > 0 
  });
  
  const implementation = async (args: any, context: any) => {
    logDebug("Calling dynamic function", { 
      name, 
      argsKeys: Object.keys(args || {}),
      contextKeys: Object.keys(context || {}) 
    });

    // Merge headers from context with the function's headers
    const mergedHeaders = {
      ...headers,
      ...context.headers,
    };

    let url = endpoint;
    const requestInit: RequestInit = {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...mergedHeaders,
        'authorization': await userHashedId(), // Add user context
      },
      cache: "no-store",
    };

    // Handle query parameters
    if (args.query) {
      const queryParams = new URLSearchParams();
      for (const [key, value] of Object.entries(args.query)) {
        if(url.includes(key)) {
          url = url.replace(key, String(value));
        } else {
          queryParams.append(key, String(value));
        }
      }
      url += (url.includes('?') ? '&' : '?') + queryParams.toString();
    }

    // Handle body parameters
    if (args.body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      requestInit.body = JSON.stringify(args.body);
    }

    const response = await fetch(url, requestInit);

    if (!response.ok) {
      throw new Error(`API call failed: ${response.statusText}`);
    }    const result = await response.json();
    return result;
  };

  await registerFunction(name, implementation);

  return {
    type: "function" as const,
    name,
    description,
    parameters: validateAndFixSchema(parameters),
    strict: true
  };
}
