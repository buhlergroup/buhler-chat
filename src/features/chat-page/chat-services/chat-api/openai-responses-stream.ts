import { AI_NAME } from "@/features/theme/theme-config";
import { uniqueId } from "@/features/common/util";
import { CreateChatMessage, UpsertChatMessage } from "../chat-message-service";
import { logDebug, logInfo, logError, logWarn } from "@/features/common/services/logger";
import {
  AzureChatCompletion,
  AzureChatCompletionAbort,
  AzureChatCompletionReasoning,
  AzureChatCompletionFunctionCall,
  AzureChatCompletionFunctionCallResult,
  ChatThreadModel,
  ChatMessageModel,
  MESSAGE_ATTRIBUTE,
} from "../models";
import { 
  reportCompletionTokens, 
  reportPromptTokens 
} from "@/features/common/services/chat-metrics-service";
import { userHashedId } from "@/features/auth-page/helpers";
import { 
  createConversationState, 
  processFunctionCall, 
  continueConversation,
  ConversationState 
} from "./conversation-manager";
import { Stream } from "openai/core/streaming";
import { Responses } from "openai/resources/responses/responses";

export const OpenAIResponsesStream = (props: {
  stream: Stream<Responses.ResponseStreamEvent>;
  chatThread: ChatThreadModel;
  conversationState?: ConversationState;
  onComplete?: () => Promise<void>;
  onContinue?: (updatedState: ConversationState) => Promise<void>;
}) => {
  const encoder = new TextEncoder();
  const { stream, chatThread, conversationState, onComplete, onContinue } = props;
  const codeInterpreterFileIdsSignature = (() => {
    const tools = conversationState?.context?.requestOptions?.tools;
    if (!Array.isArray(tools)) {
      return chatThread.codeInterpreterFileIdsSignature || "";
    }

    const codeInterpreterTool = tools.find((tool: any) => tool?.type === "code_interpreter");
    const fileIds = codeInterpreterTool?.container?.file_ids;

    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return chatThread.codeInterpreterFileIdsSignature || "";
    }

    return [...new Set(fileIds)].sort().join(",");
  })();

  // Helper function to save message (including tool call history)
  const saveMessage = async (
    messageId: string,
    content: string,
    reasoningContent: string,
    chatThread: ChatThreadModel,
    toolCallHistory?: Array<{ name: string; arguments: string; result?: string; timestamp: Date }>,
    reasoningState?: any
  ) => {
    
    const messageToSave: ChatMessageModel = {
      id: messageId,
      name: AI_NAME,
      content: content,
      role: "assistant",
      threadId: chatThread.id,
      reasoningContent: reasoningContent || undefined,
      createdAt: new Date(),
      isDeleted: false,
      userId: await userHashedId(),
      type: MESSAGE_ATTRIBUTE,
      toolCallHistory: toolCallHistory && toolCallHistory.length > 0 ? toolCallHistory : undefined,
      reasoningState: reasoningState || undefined,
    };
    
    await UpsertChatMessage(messageToSave);
    logDebug("Message saved", { 
      messageId, 
      contentLength: content.length,
      threadId: chatThread.id 
    });
  };

  // Helper function to handle response completion
  const handleResponseCompletion = async (
    event: any, 
    lastMessage: string, 
    reasoningContent: string, 
    reasoningSummaries: Record<number, string>, 
    messageId: string, 
    chatThread: ChatThreadModel, 
    controller: ReadableStreamDefaultController, 
    streamResponse: (event: string, value: string) => void,
    codeInterpreterFiles: Record<string, string> = {}
  ) => {
    logInfo("Response completion handler called", { 
      eventType: event.type,
      messageLength: lastMessage?.length || 0,
      hasReasoning: !!reasoningContent,
      codeInterpreterFilesCount: Object.keys(codeInterpreterFiles).length
    });
    
    // Initialize processedMessage - will be updated after annotation processing
    let processedMessage = lastMessage;
    
    // For response.completed events, the final content is already accumulated in lastMessage
    // The event.response.output contains the final structured output, but we've been
    // building the text content incrementally through delta events
    const encryptedReasoning = event.response?.output
      ?.find((item: any) => item.type === "reasoning");
    const messageOutput = event.response?.output?.find((item: any) => item.type === "message");
    const originalMessageId = messageOutput?.id || messageId;
    
    // Log the full response output for debugging
    logInfo("Response completion output structure", {
      outputCount: event.response?.output?.length || 0,
      outputTypes: event.response?.output?.map((o: any) => o.type),
      messageOutputContent: messageOutput?.content,
      hasAnnotations: messageOutput?.content?.some((c: any) => c.annotations?.length > 0)
    });
    
    // Process annotations from the message to extract file references
    // Code Interpreter files are cited in annotations of the message
    if (messageOutput?.content && Array.isArray(messageOutput.content)) {
      for (const contentPart of messageOutput.content) {
        if (contentPart.annotations && Array.isArray(contentPart.annotations)) {
          logInfo("Found annotations in message content", {
            annotationCount: contentPart.annotations.length,
            annotations: contentPart.annotations
          });
          
          for (const annotation of contentPart.annotations) {
            // Check for container_file_citation annotations (Code Interpreter files)
            if (annotation.type === "container_file_citation" && annotation.file_id && annotation.container_id) {
              logInfo("Found container_file_citation annotation", {
                fileId: annotation.file_id,
                filename: annotation.filename,
                containerId: annotation.container_id
              });
              
              // Download the file from the container and store it
              try {
                const { DownloadContainerFile } = await import("../code-interpreter-service");
                const { UploadImageToStore, GetImageUrl } = await import("../chat-image-service");
                
                const downloadResult = await DownloadContainerFile(
                  annotation.container_id,
                  annotation.file_id,
                  annotation.filename || "output"
                );
                
                if (downloadResult.status === "OK") {
                  const { data: fileBuffer, name: originalFileName, contentType } = downloadResult.response;
                  
                  const fileExtension = originalFileName.split(".").pop() || "bin";
                  const storedFileName = `code_interpreter_${uniqueId()}.${fileExtension}`;
                  
                  await UploadImageToStore(chatThread.id, storedFileName, fileBuffer, {
                    contentType,
                    originalFileName,
                  });
                  const fileUrl = await GetImageUrl(chatThread.id, storedFileName);
                  
                  // Store mapping for URL replacement - use the annotation's filename
                  const annotationFilename = annotation.filename || originalFileName;
                  codeInterpreterFiles[annotationFilename] = fileUrl;
                  
                  logInfo("Container file downloaded and stored", {
                    annotationFilename,
                    originalFileName,
                    storedFileName,
                    fileUrl
                  });
                } else {
                  logError("Container file download failed", {
                    fileId: annotation.file_id,
                    containerId: annotation.container_id,
                    errors: downloadResult.errors
                  });
                }
              } catch (error) {
                logError("Failed to download container file", {
                  error: error instanceof Error ? error.message : String(error),
                  fileId: annotation.file_id,
                  containerId: annotation.container_id
                });
              }
            }
            // Check for file_citation annotations (legacy/other types)
            else if (annotation.type === "file_citation" && annotation.file_id) {
              logInfo("Found file_citation annotation", {
                fileId: annotation.file_id,
                filename: annotation.filename,
                text: annotation.text
              });
              
              // Download the file and store it
              try {
                const { DownloadFileFromCodeInterpreter } = await import("../code-interpreter-service");
                const { UploadImageToStore, GetImageUrl } = await import("../chat-image-service");
                
                const downloadResult = await DownloadFileFromCodeInterpreter(annotation.file_id);
                
                if (downloadResult.status === "OK") {
                  const { data: fileBuffer, name: originalFileName, contentType } = downloadResult.response;
                  
                  const fileExtension = originalFileName.split(".").pop() || "bin";
                  const storedFileName = `code_interpreter_${uniqueId()}.${fileExtension}`;
                  
                  await UploadImageToStore(chatThread.id, storedFileName, fileBuffer, {
                    contentType,
                    originalFileName,
                  });
                  const fileUrl = await GetImageUrl(chatThread.id, storedFileName);
                  
                  // Store mapping for URL replacement
                  codeInterpreterFiles[originalFileName] = fileUrl;
                  
                  logInfo("Annotation file downloaded and stored", {
                    originalFileName,
                    storedFileName,
                    fileUrl
                  });
                }
              } catch (error) {
                logError("Failed to download annotation file", {
                  error: error instanceof Error ? error.message : String(error),
                  fileId: annotation.file_id
                });
              }
            } else if (annotation.type === "file_path" && annotation.file_id) {
              // Handle file_path annotations (for sandbox:// paths)
              logInfo("Found file_path annotation", {
                fileId: annotation.file_id,
                filePath: annotation.file_path,
                text: annotation.text
              });
              
              // Extract filename from the path
              const pathParts = (annotation.file_path || "").split("/");
              const filename = pathParts[pathParts.length - 1];
              
              // Download the file and store it
              try {
                const { DownloadFileFromCodeInterpreter } = await import("../code-interpreter-service");
                const { UploadImageToStore, GetImageUrl } = await import("../chat-image-service");
                
                const downloadResult = await DownloadFileFromCodeInterpreter(annotation.file_id);
                
                if (downloadResult.status === "OK") {
                  const { data: fileBuffer, name: originalFileName, contentType } = downloadResult.response;
                  
                  const fileExtension = originalFileName.split(".").pop() || "bin";
                  const storedFileName = `code_interpreter_${uniqueId()}.${fileExtension}`;
                  
                  await UploadImageToStore(chatThread.id, storedFileName, fileBuffer, {
                    contentType,
                    originalFileName,
                  });
                  const fileUrl = await GetImageUrl(chatThread.id, storedFileName);
                  
                  // Store mapping for URL replacement using both the filename and the full sandbox path
                  codeInterpreterFiles[originalFileName] = fileUrl;
                  if (filename) {
                    codeInterpreterFiles[filename] = fileUrl;
                  }
                  
                  logInfo("File path annotation file downloaded and stored", {
                    originalFileName,
                    filename,
                    storedFileName,
                    fileUrl
                  });
                }
              } catch (error) {
                logError("Failed to download file path annotation file", {
                  error: error instanceof Error ? error.message : String(error),
                  fileId: annotation.file_id
                });
              }
            }
          }
        }
      }
    }
    
    // Now replace sandbox URLs with the stored file URLs
    // Use direct string replacement based on the annotation mappings
    if (Object.keys(codeInterpreterFiles).length > 0) {
      for (const [filename, storedUrl] of Object.entries(codeInterpreterFiles)) {
        // Replace sandbox:// paths with stored URLs
        const sandboxPattern = `sandbox:/mnt/data/${filename}`;
        if (processedMessage.includes(sandboxPattern)) {
          processedMessage = processedMessage.split(sandboxPattern).join(storedUrl);
          logInfo("Replaced sandbox path with stored URL", { filename, storedUrl });
        }
      }
    }
    
    const finalReasoningContent = Object.keys(reasoningSummaries).length > 0 
      ? Object.values(reasoningSummaries).join('\n\n') 
      : reasoningContent;

    // Save message to database (use processedMessage with replaced URLs)
    await saveMessage(originalMessageId, processedMessage, finalReasoningContent, chatThread, undefined, encryptedReasoning);

    // Report token usage
    if (event.response?.usage) {
      const { input_tokens, output_tokens, total_tokens } = event.response.usage;
      logInfo("Token usage", { 
        inputTokens: input_tokens,
        outputTokens: output_tokens,
        totalTokens: total_tokens
      });
      
      await reportCompletionTokens(output_tokens, chatThread.selectedModel || "gpt-5.4", {
        personaMessageTitle: chatThread.personaMessageTitle,
        threadId: chatThread.id,
        messageId: originalMessageId,
        totalTokens: total_tokens,
        inputTokens: input_tokens
      });

      await reportPromptTokens(input_tokens, chatThread.selectedModel || "gpt-5.4", "user", {
        personaMessageTitle: chatThread.personaMessageTitle,
        threadId: chatThread.id,
        messageId: originalMessageId
      });
    }

    // Send final response and close (use processedMessage with replaced URLs)
    const finalResponse: AzureChatCompletion = {
      type: "finalContent",
      response: processedMessage,
    };
    logInfo("Sending finalContent event to frontend", {
      messageLength: processedMessage.length,
      responseType: finalResponse.type,
      responseData: JSON.stringify(finalResponse)
    });
    streamResponse(finalResponse.type, JSON.stringify(finalResponse));
    
    // Ensure the stream is flushed before closing by yielding to the event loop
    await Promise.resolve();
    
    // Add a longer delay to ensure the frontend has time to process the finalContent event
    logDebug("Waiting for frontend to process finalContent event");
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Signal completion
    if (onComplete) {
      await onComplete();
    }
    
    // Ensure the stream is fully flushed before closing
    logDebug("Flushing stream before closing");
    await new Promise(resolve => setTimeout(resolve, 100));
    
    logDebug("Closing stream controller");
    controller.close();
  };

  const readableStream = new ReadableStream({
    async start(controller) {

      const streamResponse = (event: string, value: string) => {
        if (controller.desiredSize !== null) {
          const eventData = `event: ${event} \n`;
          const dataData = `data: ${value} \n\n`;
          logDebug("Backend: Sending SSE event", {
            eventType: event,
            dataLength: value.length,
            dataPreview: value.substring(0, 200) + "..."
          });
          controller.enqueue(encoder.encode(eventData));
          controller.enqueue(encoder.encode(dataData));
        }
      };      
      
      let lastMessage = "";
      let reasoningContent = "";
      let reasoningSummaries: Record<number, string> = {};
      let messageSaved = false;
      let functionCalls: Record<number, any> = {}; // Track function calls per output index
      let toolCallHistory: Array<{ name: string; arguments: string; result?: string; timestamp: Date; call_id?: string }> = [];
      let currentConversationState = conversationState; // Use passed conversation state
      // Track Code Interpreter files: maps filename to stored URL
      let codeInterpreterFiles: Record<string, string> = {};
      // Use a consistent message ID across the entire conversation
      const messageId = conversationState?.messageId || uniqueId();
      logDebug("OpenAI Responses Stream: Using message ID", {
        messageId,
        hasConversationState: !!conversationState,
        conversationStateMessageId: conversationState?.messageId
      });

      try {
        for await (const event of stream) {
          // Log event type and basic info
          logDebug("SSE event", { eventType: event.type });

          switch (event.type) {
            case "response.created":
              logDebug("Response created");
              break;

            case "response.incomplete": {
              // The model ended the response early; capture the reason and surface to UI
              const reason = (event as any)?.response?.incomplete_details?.reason || (event as any)?.incomplete_details?.reason || "unknown";
              logWarn("Received response.incomplete", { reason });

              // Save any partial content we have so far
              if (lastMessage && !messageSaved) {
                try {
                  await saveMessage(messageId, lastMessage, reasoningContent, chatThread, toolCallHistory);
                  messageSaved = true;
                } catch (persistError) {
                  logWarn("Failed to persist partial message on incomplete", { error: persistError instanceof Error ? persistError.message : String(persistError) });
                }
              }

              // Map the reason to a short, user-friendly message
              const reasonMessageMap: Record<string, string> = {
                max_output_tokens: "The model reached the maximum output tokens limit.",
                content_filter: "The response was stopped by a content filter.",
                server_error: "The server encountered an error while generating the response.",
                rate_limit: "The request hit a rate limit.",
              };
              const userMessage = reasonMessageMap[reason] || `The response ended early (${reason}).`;

              const abortEvent: AzureChatCompletionAbort = {
                type: "abort",
                response: userMessage,
              };

              // Notify frontend and close the stream
              streamResponse(abortEvent.type, JSON.stringify(abortEvent));

              // Mark conversation as finished
              if (onComplete) {
                await onComplete();
              }

              // Ensure the stream is flushed before closing by yielding to the event loop
              await Promise.resolve();
              controller.close();
              return;
            }

            case "response.output_text.delta":
              // Handle text delta events
              if (event.delta) {
                const deltaContent = event.delta;
                lastMessage += deltaContent;

                const response: AzureChatCompletion = {
                  type: "content",
                  response: {
                    id: messageId,
                    choices: [{
                      message: {
                        content: deltaContent,
                        role: "assistant"
                      }
                    }]
                  },
                };
                streamResponse(response.type, JSON.stringify(response));
              }
              break;

            case "response.output_item.added":
              // Function call started
              if (event.item?.type === "function_call") {
                logInfo("Function call started", { functionName: event.item.name });
                functionCalls[event.output_index] = {
                  ...event.item,
                  arguments: ""
                };
                // Record a started tool call entry (without result yet)
                toolCallHistory.push({
                  name: event.item.name || "",
                  arguments: "",
                  timestamp: new Date(),
                  call_id: event.item.call_id
                });
                
                // Don't stream function call start - wait for completion
              } else if (event.item?.type === "image_generation_call") {
                logInfo("Image generation started", { outputIndex: event.output_index });
                functionCalls[event.output_index] = {
                  ...event.item
                };
              } else if (event.item?.type === "web_search_call") {
                logInfo("Web search started", { 
                  outputIndex: event.output_index
                });
                functionCalls[event.output_index] = {
                  ...event.item
                };
              } else if (event.item?.type === "code_interpreter_call") {
                logInfo("Code interpreter started", { 
                  outputIndex: event.output_index,
                  id: event.item.id
                });
                functionCalls[event.output_index] = {
                  ...event.item,
                  code: ""
                };
                // Record a started tool call entry for code interpreter
                toolCallHistory.push({
                  name: "code_interpreter",
                  arguments: "",
                  timestamp: new Date(),
                  call_id: event.item.id
                });
              }
              break;

            case "response.function_call_arguments.delta":
              // Accumulate function arguments
              const index = event.output_index;
              if (functionCalls[index]) {
                functionCalls[index].arguments += event.delta;
                
                // Don't stream function arguments delta - wait for completion
              }
              break;

            case "response.function_call_arguments.done":
              // Function call arguments complete - execute the function
              if (currentConversationState) {
                const completedCall = functionCalls[event.output_index];
                if (completedCall) {
                  // Update the last matching tool call entry with the final arguments
                  for (let i = toolCallHistory.length - 1; i >= 0; i--) {
                    if (!toolCallHistory[i].result && (!toolCallHistory[i].call_id || toolCallHistory[i].call_id === completedCall.call_id)) {
                      toolCallHistory[i].arguments = completedCall.arguments;
                      break;
                    }
                  }
                  // Stream function call info now that it's complete
                  const functionCallResponse: AzureChatCompletionFunctionCall = {
                    type: "functionCall",
                    response: {
                      name: completedCall.name,
                      arguments: completedCall.arguments,
                      call_id: completedCall.call_id,
                    } as any,
                  };
                  streamResponse(functionCallResponse.type, JSON.stringify(functionCallResponse));

                  const result = await processFunctionCall(currentConversationState, {
                    name: completedCall.name,
                    arguments: completedCall.arguments,
                    call_id: completedCall.call_id,
                  });

                  // Update the conversation state
                  currentConversationState = result.updatedState;

                  if (result.success) {
                    // Stream function result
                    const functionResultResponse: AzureChatCompletionFunctionCallResult = {
                      type: "functionCallResult",
                      response: result.result!,
                      // include call_id for client-side matching if needed
                      // @ts-ignore
                      call_id: completedCall.call_id,
                    };
                    streamResponse(functionResultResponse.type, JSON.stringify(functionResultResponse));

                    // Attach result to the last matching tool call entry
                    for (let i = toolCallHistory.length - 1; i >= 0; i--) {
                      if (!toolCallHistory[i].result && (!toolCallHistory[i].call_id || toolCallHistory[i].call_id === completedCall.call_id)) {
                        toolCallHistory[i].result = result.result!;
                        break;
                      }
                    }

                    // Persist tool call as a separate tool message for refresh resilience
                    try {
                      const toolMessage: ChatMessageModel = {
                        id: uniqueId(),
                        name: completedCall.name || "tool",
                        content: JSON.stringify({
                          name: completedCall.name,
                          arguments: completedCall.arguments,
                          result: result.result!,
                          call_id: completedCall.call_id,
                          parentAssistantMessageId: messageId,
                          timestamp: new Date().toISOString(),
                        }),
                        role: "tool",
                        threadId: chatThread.id,
                        createdAt: new Date(),
                        isDeleted: false,
                        userId: await userHashedId(),
                        type: MESSAGE_ATTRIBUTE,
                      };
                      await UpsertChatMessage(toolMessage);
                    } catch (persistError) {
                      logWarn("Failed to persist tool call message", { error: persistError instanceof Error ? persistError.message : String(persistError) });
                    }
                  } else {
                    // Stream function error
                    const functionErrorResponse: AzureChatCompletion = {
                      type: "error",
                      response: result.error!,
                    };
                    streamResponse(functionErrorResponse.type, JSON.stringify(functionErrorResponse));
                  }
                }
              }
              break;

            case "response.output_item.done":
              // Check if this was a function call completion
              if (event.item?.type === "function_call") {
                logInfo("Function call completed", { functionName: event.item.name });
                
                // If we have conversation state and function calls, signal continuation
                if (currentConversationState && Object.keys(functionCalls).length > 0) {
                  logInfo("Function calls complete, signaling for conversation continuation");
                  
                  // Signal that conversation should continue with updated state
                  if (onContinue) {
                    await onContinue(currentConversationState);
                  }
                  
                  // End this stream - the conversation manager will start a new one
                  controller.close();
                  return;
                }
              } else if (event.item?.type === "image_generation_call") {
                logInfo("Image generation completed", { outputIndex: event.output_index });
                // The result is in event.item.result as base64 string
                if (event.item?.result) {
                  try {
                    // Decode base64 image and upload to blob storage
                    const imageName = `${uniqueId()}.png`;
                    const { UploadImageToStore, GetImageUrl } = await import("../chat-image-service");
                    
                    await UploadImageToStore(
                      chatThread.id,
                      imageName,
                      Buffer.from(event.item.result, "base64"),
                      {
                        contentType: "image/png",
                        originalFileName: imageName,
                      }
                    );
                    
                    const imageUrl = await GetImageUrl(chatThread.id, imageName);
                    
                    // Add image markdown to the message
                    const imageMarkdown = `\n\n![Generated Image](${imageUrl})\n\n`;
                    lastMessage += imageMarkdown;
                    
                    // Stream the image as content
                    const response: AzureChatCompletion = {
                      type: "content",
                      response: {
                        id: messageId,
                        choices: [{
                          message: {
                            content: imageMarkdown,
                            role: "assistant"
                          }
                        }]
                      },
                    };
                    streamResponse(response.type, JSON.stringify(response));
                    
                    logInfo("Image uploaded and displayed", { imageName, imageUrl });
                  } catch (error) {
                    logError("Failed to process generated image", { 
                      error: error instanceof Error ? error.message : String(error) 
                    });
                  }
                }
              } else if (event.item?.type === "web_search_call") {
                logInfo("Web search completed", { 
                  outputIndex: event.output_index,
                  status: event.item?.status
                });
                // Web search results are embedded in the message content with citations
                // No additional processing needed - the model will reference the search results
              } else if (event.item?.type === "code_interpreter_call") {
                logInfo("Code interpreter completed", { 
                  outputIndex: event.output_index,
                  status: event.item?.status,
                  containerId: event.item?.container_id,
                  hasCode: !!event.item?.code,
                  outputCount: event.item?.outputs?.length || 0
                });

                // Save the container ID to the chat thread for reuse in subsequent requests
                if (event.item?.container_id) {
                  try {
                    const { UpdateChatThreadCodeInterpreterContainer } = await import("../chat-thread-service");
                    await UpdateChatThreadCodeInterpreterContainer(
                      chatThread.id,
                      event.item.container_id,
                      codeInterpreterFileIdsSignature
                    );
                    logInfo("Saved Code Interpreter container ID to chat thread", { 
                      containerId: event.item.container_id,
                      fileIdsSignature: codeInterpreterFileIdsSignature,
                      threadId: chatThread.id 
                    });
                  } catch (error) {
                    logError("Failed to save container ID", { 
                      error: error instanceof Error ? error.message : String(error) 
                    });
                  }
                }

                // Update the tool call history with the code that was executed
                for (let i = toolCallHistory.length - 1; i >= 0; i--) {
                  if (toolCallHistory[i].name === "code_interpreter" && !toolCallHistory[i].result) {
                    toolCallHistory[i].arguments = event.item?.code || "";
                    break;
                  }
                }

                // Process code interpreter outputs
                if (event.item?.outputs && Array.isArray(event.item.outputs)) {
                  let codeInterpreterOutput = "";
                  
                  logInfo("Processing Code Interpreter outputs", {
                    outputCount: event.item.outputs.length,
                    outputTypes: event.item.outputs.map((o: any) => ({ type: o.type, hasFileId: !!o.file_id, hasUrl: !!o.url, filename: o.filename }))
                  });
                  
                  for (const output of event.item.outputs) {
                    if (output.type === "logs" && output.logs) {
                      // Stream logs as code block
                      const logsContent = `\n\`\`\`\n${output.logs}\n\`\`\`\n`;
                      codeInterpreterOutput += logsContent;
                      lastMessage += logsContent;
                      
                      const logsResponse: AzureChatCompletion = {
                        type: "content",
                        response: {
                          id: messageId,
                          choices: [{
                            message: {
                              content: logsContent,
                              role: "assistant"
                            }
                          }]
                        },
                      };
                      streamResponse(logsResponse.type, JSON.stringify(logsResponse));
                    } else if ((output as any).type === "file" && (output as any).file_id) {
                      // Handle file outputs from Code Interpreter
                      // Download from OpenAI and upload to our blob storage
                      const fileOutput = output as any;
                      const fileId = fileOutput.file_id;
                      
                      logInfo("Found file output from Code Interpreter", {
                        fileId,
                        filename: fileOutput.filename,
                        outputType: fileOutput.type
                      });
                      
                      try {
                        const { DownloadFileFromCodeInterpreter } = await import("../code-interpreter-service");
                        const { UploadImageToStore, GetImageUrl } = await import("../chat-image-service");
                        
                        logInfo("Downloading file from OpenAI Files API", { fileId });
                        
                        // Download file from OpenAI Files API
                        const downloadResult = await DownloadFileFromCodeInterpreter(fileId);
                        
                        if (downloadResult.status === "OK") {
                          const { data: fileBuffer, name: originalFileName, contentType } = downloadResult.response;
                          
                          // Generate unique filename for storage
                          const fileExtension = originalFileName.split(".").pop() || "bin";
                          const storedFileName = `code_interpreter_${uniqueId()}.${fileExtension}`;
                          
                          // Upload to blob storage (same as images)
                          await UploadImageToStore(
                            chatThread.id,
                            storedFileName,
                            fileBuffer,
                            {
                              contentType,
                              originalFileName,
                            }
                          );
                          
                          // Get the URL for the stored file
                          const fileUrl = await GetImageUrl(chatThread.id, storedFileName);
                          
                          // Store the mapping from original filename to stored URL
                          // This allows us to replace sandbox:// URLs in the model's text
                          codeInterpreterFiles[originalFileName] = fileUrl;
                          
                          // Check if it's an image type - display inline
                          const isImage = contentType.startsWith("image/");
                          const fileMarkdown = isImage
                            ? `\n\n![${originalFileName}](${fileUrl})\n\n`
                            : `\n\n📎 [Download: ${originalFileName}](${fileUrl})\n\n`;
                          
                          codeInterpreterOutput += fileMarkdown;
                          lastMessage += fileMarkdown;
                          
                          // Stream the file link as content
                          const fileResponse: AzureChatCompletion = {
                            type: "content",
                            response: {
                              id: messageId,
                              choices: [{
                                message: {
                                  content: fileMarkdown,
                                  role: "assistant"
                                }
                              }]
                            },
                          };
                          streamResponse(fileResponse.type, JSON.stringify(fileResponse));
                          
                          logInfo("Code interpreter file downloaded and stored", { 
                            originalFileName, 
                            storedFileName,
                            fileId,
                            fileUrl,
                            contentType,
                            isImage,
                            mappingAdded: true
                          });
                        } else {
                          logError("Failed to download code interpreter file", { 
                            fileId, 
                            error: downloadResult.errors[0]?.message 
                          });
                        }
                      } catch (error) {
                        logError("Failed to process code interpreter file output", { 
                          error: error instanceof Error ? error.message : String(error),
                          fileId
                        });
                      }
                    } else if (output.type === "image" && output.url) {
                      try {
                        // Download the image from the URL and upload to blob storage
                        const imageName = `code_interpreter_${uniqueId()}.png`;
                        const { UploadImageToStore, GetImageUrl } = await import("../chat-image-service");
                        
                        // Fetch the image from the code interpreter URL
                        const imageResponse = await fetch(output.url);
                        if (imageResponse.ok) {
                          const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
                          
                          await UploadImageToStore(
                            chatThread.id,
                            imageName,
                            imageBuffer,
                            {
                              contentType: imageResponse.headers.get("content-type") || "image/png",
                              originalFileName: imageName,
                            }
                          );
                          
                          const imageUrl = await GetImageUrl(chatThread.id, imageName);
                          
                          // Add image markdown to the message
                          const imageMarkdown = `\n\n![Code Output](${imageUrl})\n\n`;
                          codeInterpreterOutput += imageMarkdown;
                          lastMessage += imageMarkdown;
                          
                          // Stream the image as content
                          const imgResponse: AzureChatCompletion = {
                            type: "content",
                            response: {
                              id: messageId,
                              choices: [{
                                message: {
                                  content: imageMarkdown,
                                  role: "assistant"
                                }
                              }]
                            },
                          };
                          streamResponse(imgResponse.type, JSON.stringify(imgResponse));
                          
                          logInfo("Code interpreter image uploaded", { imageName, imageUrl });
                        }
                      } catch (error) {
                        logError("Failed to process code interpreter image", { 
                          error: error instanceof Error ? error.message : String(error),
                          url: output.url
                        });
                      }
                    }
                  }

                  // Update tool call history with result
                  for (let i = toolCallHistory.length - 1; i >= 0; i--) {
                    if (toolCallHistory[i].name === "code_interpreter" && !toolCallHistory[i].result) {
                      toolCallHistory[i].result = codeInterpreterOutput || "Code executed successfully";
                      break;
                    }
                  }
                }
              }
              break;

            case "response.reasoning_summary_text.delta":
              if (event.delta) {
                const summaryIndex = event.summary_index || 0;
                reasoningSummaries[summaryIndex] = (reasoningSummaries[summaryIndex] || '') + event.delta;
                
                const reasoningResponse: AzureChatCompletionReasoning = {
                  type: "reasoning",
                  response: event.delta,
                };
                streamResponse(reasoningResponse.type, JSON.stringify(reasoningResponse));
                
                reasoningContent = Object.values(reasoningSummaries).join('\n\n');
              }
              break;

            case "response.image_generation_call.in_progress":
              logDebug("Image generation in progress", { outputIndex: event.output_index });
              break;

            case "response.image_generation_call.generating":
              logDebug("Image generation generating", { outputIndex: event.output_index });
              break;

            case "response.image_generation_call.partial_image":
              // Partial image data available during generation - could be used for progressive loading
              logDebug("Partial image received", { outputIndex: event.output_index });
              break;

            case "response.web_search_call.in_progress":
              logDebug("Web search in progress", { 
                outputIndex: event.output_index,
                action: (event as any).action?.type
              });
              break;

            case "response.web_search_call.completed":
              logDebug("Web search completed", { 
                outputIndex: event.output_index 
              });
              break;

            case "response.completed":
              logInfo("Received response.completed event", {
                codeInterpreterFilesCount: Object.keys(codeInterpreterFiles).length,
                filesMapped: Object.keys(codeInterpreterFiles)
              });
              await handleResponseCompletion(event, lastMessage, reasoningContent, reasoningSummaries, messageId, chatThread, controller, streamResponse, codeInterpreterFiles);
              return;

            case "error":
              logError("Stream error", { 
                errorMessage: (event as any).error?.message || "Unknown error" 
              });
              const errorResponse: AzureChatCompletion = {
                type: "error",
                response: (event as any).error?.message || "Unknown error occurred",
              };

              if (lastMessage && !messageSaved) {
                await saveMessage(messageId, lastMessage, reasoningContent, chatThread);
                messageSaved = true;
              }

              streamResponse(errorResponse.type, JSON.stringify(errorResponse));
              
              // Ensure the stream is flushed before closing by yielding to the event loop
              await Promise.resolve();
              
              controller.close();
              return;

            default:
              // Handle code interpreter events that might not be in TypeScript definitions
              const eventType = (event as any).type as string;
              if (eventType?.includes("code_interpreter_call")) {
                if (eventType.includes("in_progress") || eventType.includes("interpreting")) {
                  logDebug("Code interpreter in progress/interpreting", { 
                    outputIndex: (event as any).output_index 
                  });
                } else if (eventType.includes("code") && eventType.includes("delta")) {
                  // Accumulate code being written
                  const outputIndex = (event as any).output_index;
                  if (functionCalls[outputIndex]) {
                    functionCalls[outputIndex].code = (functionCalls[outputIndex].code || "") + ((event as any).delta || "");
                  }
                  logDebug("Code interpreter code delta", { 
                    outputIndex,
                    deltaLength: (event as any).delta?.length || 0
                  });
                } else if (eventType.includes("code") && eventType.includes("done")) {
                  logDebug("Code interpreter code complete", { 
                    outputIndex: (event as any).output_index,
                    codeLength: functionCalls[(event as any).output_index]?.code?.length || 0
                  });
                } else {
                  logDebug("Code interpreter event", { eventType, outputIndex: (event as any).output_index });
                }
              } else {
                // Log unknown events for debugging but don't treat them as errors
                // These might be informational events that don't need processing
                logDebug("Unhandled event", { eventType: event.type });
              }
              break;
          }
        }

        // Stream ended without completion event - send final content if available
        if (lastMessage && !messageSaved) {
          logInfo("Stream ended without completion event - sending final content", {
            codeInterpreterFilesCount: Object.keys(codeInterpreterFiles).length
          });
          
          // Replace sandbox:// URLs with stored file URLs using direct string replacement
          let processedMessage = lastMessage;
          if (Object.keys(codeInterpreterFiles).length > 0) {
            for (const [filename, storedUrl] of Object.entries(codeInterpreterFiles)) {
              const sandboxPattern = `sandbox:/mnt/data/${filename}`;
              if (processedMessage.includes(sandboxPattern)) {
                processedMessage = processedMessage.split(sandboxPattern).join(storedUrl);
              }
            }
          }
          
          await saveMessage(messageId, processedMessage, reasoningContent, chatThread, toolCallHistory);
          
          const finalResponse: AzureChatCompletion = {
            type: "finalContent",
            response: processedMessage,
          };
          logInfo("Sending finalContent event (fallback)", {
            messageLength: processedMessage.length,
            responseType: finalResponse.type
          });
          streamResponse(finalResponse.type, JSON.stringify(finalResponse));
          
          // Ensure the stream is flushed before closing by yielding to the event loop
          await Promise.resolve();
          
          // Add a small delay to ensure the frontend has time to process the finalContent event
          logDebug("Waiting for frontend to process finalContent event (fallback)");
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        controller.close();
      } catch (error) {
        logError("Stream processing error", { 
          error: error instanceof Error ? error.message : String(error) 
        });
        
        if (lastMessage && !messageSaved) {
          await saveMessage(messageId, lastMessage, reasoningContent, chatThread, toolCallHistory);
        }

        const errorResponse: AzureChatCompletion = {
          type: "error",
          response: error instanceof Error ? error.message : "Stream processing error",
        };
        streamResponse(errorResponse.type, JSON.stringify(errorResponse));
        
        // Ensure the stream is flushed before closing by yielding to the event loop
        await Promise.resolve();
        
        controller.close();
      }
    },
  });

  return readableStream;
};
