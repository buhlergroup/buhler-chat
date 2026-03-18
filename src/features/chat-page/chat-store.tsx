"use client";
import { uniqueId } from "@/features/common/util";
import { showError } from "@/features/globals/global-message-store";
import { AI_NAME, NEW_CHAT_NAME } from "@/features/theme/theme-config";
import {
  ParsedEvent,
  ReconnectInterval,
  createParser,
} from "eventsource-parser";
import { FormEvent } from "react";
import { proxy, useSnapshot } from "valtio";
import { RevalidateCache } from "../common/navigation-helpers";
import { InputImageStore } from "../ui/chat/chat-input-area/input-image-store";
import { textToSpeechStore } from "./chat-input/speech/use-text-to-speech";
import { logDebug, logInfo, logWarn, logError } from "../common/services/logger";
import {
  AddExtensionToChatThread,
  RemoveExtensionFromChatThread,
  UpdateChatTitle,
  UpdateChatThreadSelectedModel,
  UpdateChatThreadReasoningEffort,
} from "./chat-services/chat-thread-service";
import {
  AzureChatCompletion,
  ChatMessageModel,
  ChatThreadModel,
  ChatModel,
  ReasoningEffort,
  AttachedFileModel,
  getDefaultModel as getDefaultModelFromAPI,
  MODEL_CONFIGS,
} from "./chat-services/models";
import { UpsertChatMessage } from "./chat-services/chat-message-service";
let abortController: AbortController = new AbortController();

type chatStatus = "idle" | "loading" | "file upload";
type chatPhase = 'idle' | 'submitted' | 'streaming' | 'error';

class ChatState {
  public messages: Array<ChatMessageModel> = [];
  public loading: chatStatus = "idle";
  public phase: chatPhase = 'idle';
  public input: string = "";
  public lastMessage: string = "";
  public autoScroll: boolean = true;
  public userName: string = "";
  public chatThreadId: string = "";
  public selectedModel: ChatModel = "gpt-5.4"; // Will be updated when available models are fetched
  public reasoningEffort: ReasoningEffort = "low";
  public webSearchEnabled: boolean = false;
  public imageGenerationEnabled: boolean = false;
  public companyContentEnabled: boolean = false;
  public codeInterpreterEnabled: boolean = false;
  public attachedFiles: Array<AttachedFileModel> = [];

  private chatThread: ChatThreadModel | undefined;
  private tempReasoningContent: string = "";
  private currentAssistantMessageId: string = "";
  public toolCallHistory: Record<string, Array<{ name: string; arguments: string; result?: string; timestamp: Date; callId?: string }>> = {};
  public toolCallInProgress: Record<string, string | null> = {};
  public reasoningMeta: Record<string, { start: number; elapsed: number; isStreaming: boolean }> = {};

  private addToMessages(message: ChatMessageModel) {
    const currentMessageIndex = this.messages.findIndex((el) => el.id === message.id);
    if (currentMessageIndex !== -1) {
      // Update existing message by replacing the entire object to ensure Valtio reactivity
      const currentMessage = this.messages[currentMessageIndex];
      this.messages[currentMessageIndex] = {
        ...currentMessage,
        content: message.content,
        ...(message.reasoningContent !== undefined && { reasoningContent: message.reasoningContent })
      };
    } else {
      this.messages.push(message);
    }
  }

  private removeMessage(id: string) {
    const index = this.messages.findIndex((el) => el.id === id);
    if (index > -1) {
      this.messages.splice(index, 1);
    }
  }

  public removeMessages(options?: {fromMessageId?: string}) {
    if (!options?.fromMessageId) {
      this.messages = [];
      return;
    }
    const index = this.messages.findIndex((el) => el.id === options.fromMessageId);
    if (index > -1 && index < this.messages.length - 1) {
      this.messages = this.messages.slice(0, index + 1);
    }
  }

  public updateLoading(value: chatStatus) {
    this.loading = value;
  }

  public updatePhase(value: chatPhase) {
    this.phase = value;
  }

  public   initChatSession({
    userName,
    messages,
    chatThread,
  }: {
    chatThread: ChatThreadModel;
    userName: string;
    messages: Array<ChatMessageModel>;
  }) {
    // Only initialize if this is a new chat thread
    const isNewThread = this.chatThreadId !== chatThread.id;
    
    logInfo("Chat Store: initChatSession", {
      isNewThread,
      currentThreadId: this.chatThreadId,
      newThreadId: chatThread.id,
      currentMessagesCount: this.messages.length,
      newMessagesCount: messages.length
    });

    if (isNewThread) {
      this.chatThread = chatThread;
      this.chatThreadId = chatThread.id;
      this.messages = messages;
      const threadModel = chatThread.selectedModel;
      this.selectedModel = (threadModel && MODEL_CONFIGS[threadModel]) ? threadModel : "gpt-5.4";
      this.toolCallHistory = {};
      this.tempReasoningContent = "";
      this.currentAssistantMessageId = "";
      
      // Reset tool states for new chat
      this.webSearchEnabled = false;
      this.imageGenerationEnabled = true;
      this.companyContentEnabled = false;
      this.codeInterpreterEnabled = false;
      
      // Load attached files from the chat thread
      this.attachedFiles = chatThread.attachedFiles || [];
      // Auto-enable code interpreter if there are code interpreter files
      if (this.attachedFiles.some(f => f.type === "code-interpreter")) {
        this.codeInterpreterEnabled = true;
      }
      
      const defaultEffort = MODEL_CONFIGS[this.selectedModel]?.defaultReasoningEffort || "low";
      if (chatThread.reasoningEffort) {
        this.reasoningEffort = chatThread.reasoningEffort;
      } else {
        this.reasoningEffort = defaultEffort;
      }

      // Restore tool call history from loaded messages
      messages.forEach(message => {
        if (message.toolCallHistory && message.toolCallHistory.length > 0) {
          this.toolCallHistory[message.id] = message.toolCallHistory;
          logDebug("Chat Store: Restored tool call history", {
            messageId: message.id,
            toolCallCount: message.toolCallHistory.length,
            toolNames: message.toolCallHistory.map(tc => tc.name)
          });
        }
      });
    }
    
    this.userName = userName;
    
    logDebug("Chat Store: Initialization complete", {
      totalMessages: this.messages.length,
      messagesWithToolCalls: Object.keys(this.toolCallHistory).length,
      toolCallHistory: this.toolCallHistory
    });
  }

  public async updateSelectedModel(model: ChatModel) {
    this.selectedModel = model;
    const defaultEffort = MODEL_CONFIGS[model]?.defaultReasoningEffort || "low";
    this.reasoningEffort = defaultEffort;

    // Automatically enable image generation if the model supports it
    if (MODEL_CONFIGS[model]?.supportsImageGeneration) {
      this.imageGenerationEnabled = true;
    } else {
      this.imageGenerationEnabled = false;
    }
    
    // Persist model selection to thread
    if (this.chatThreadId) {
      try {
        const response = await UpdateChatThreadSelectedModel(this.chatThreadId, model);
        if (response.status !== "OK") {
          showError("Failed to save model selection");
        }
        
        await UpdateChatThreadReasoningEffort(this.chatThreadId, defaultEffort);
      } catch (error) {
        showError("Failed to save model selection: " + error);
      }
    }
  }

  public getSelectedModel(): ChatModel {
    return this.selectedModel;
  }

  public async updateReasoningEffort(effort: ReasoningEffort) {
    this.reasoningEffort = effort;
    if (this.chatThreadId) {
      try {
        const response = await UpdateChatThreadReasoningEffort(this.chatThreadId, effort);
        if (response.status !== "OK") {
          showError("Failed to save reasoning effort");
        }
      } catch (error) {
        showError("Failed to save reasoning effort: " + error);
      }
    }
  }

  public getReasoningEffort(): ReasoningEffort {
    return this.reasoningEffort;
  }

  public toggleWebSearch(enabled: boolean) {
    this.webSearchEnabled = enabled;
    if (enabled && this.reasoningEffort === "minimal") {
      this.reasoningEffort = "low";
    }
  }

  public toggleImageGeneration(enabled: boolean) {
    this.imageGenerationEnabled = enabled;
    if (enabled && this.reasoningEffort === "minimal") {
      this.reasoningEffort = "low";
    }
  }

  public toggleCompanyContent(enabled: boolean) {
    this.companyContentEnabled = enabled;
    if (enabled && this.reasoningEffort === "minimal") {
      this.reasoningEffort = "low";
    }
  }

  public toggleCodeInterpreter(enabled: boolean) {
    this.codeInterpreterEnabled = enabled;
    if (enabled && this.reasoningEffort === "minimal") {
      this.reasoningEffort = "low";
    }
  }

  public setAttachedFiles(files: Array<AttachedFileModel>) {
    this.attachedFiles = files;
    logDebug("Chat Store: setAttachedFiles", { fileCount: files.length, files });
  }

  public addAttachedFile(file: AttachedFileModel) {
    // Use spread to create a new array reference for Valtio reactivity
    this.attachedFiles = [...this.attachedFiles, file];
    logDebug("Chat Store: addAttachedFile", { 
      addedFile: file, 
      totalFiles: this.attachedFiles.length,
      allFiles: this.attachedFiles 
    });
  }

  public removeAttachedFile(fileId: string) {
    this.attachedFiles = this.attachedFiles.filter(f => f.id !== fileId);
    logDebug("Chat Store: removeAttachedFile", { removedFileId: fileId, remainingFiles: this.attachedFiles.length });
  }

  public clearAttachedFiles() {
    this.attachedFiles = [];
    logDebug("Chat Store: clearAttachedFiles");
  }

  // Get only code interpreter files for the API
  public getCodeInterpreterFileIds(): string[] {
    return this.attachedFiles.filter(f => f.type === "code-interpreter").map(f => f.id);
  }

  public async AddExtensionToChatThread(extensionId: string) {
    this.loading = "loading";

    const response = await AddExtensionToChatThread({
      extensionId: extensionId,
      chatThreadId: this.chatThreadId,
    });
    RevalidateCache({
      page: "chat",
      type: "layout",
    });

    if (response.status !== "OK") {
      showError(response.errors[0].message);
    }

    this.loading = "idle";
  }

  public async RemoveExtensionFromChatThread(extensionId: string) {
    this.loading = "loading";

    const response = await RemoveExtensionFromChatThread({
      extensionId: extensionId,
      chatThreadId: this.chatThreadId,
    });

    RevalidateCache({
      page: "chat",
    });

    if (response.status !== "OK") {
      showError(response.errors[0].message);
    }

    this.loading = "idle";
  }

  public updateInput(value: string) {
    this.input = value;
  }

  public stopGeneratingMessages() {
    logInfo("Chat Store: stopGeneratingMessages called", {
      currentPhase: this.phase,
      currentLoading: this.loading
    });
    abortController.abort();
    this.loading = 'idle';
    this.phase = 'idle';
  }

  public updateAutoScroll(value: boolean) {
    this.autoScroll = value;
  }

  private reset() {
    this.input = "";
    InputImageStore.Reset();
  }

  private async chat(formData: FormData) {
    this.updateAutoScroll(true);
    this.loading = "loading";
    this.phase = 'submitted';
    this.currentAssistantMessageId = "";
    this.tempReasoningContent = "";
    this.toolCallHistory = {};
    this.toolCallInProgress = {};

    const multimodalImages = formData
      .getAll("image-base64")
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    const multimodalImage = multimodalImages[0] || "";

    const newUserMessage: ChatMessageModel = {
      id: uniqueId(),
      role: "user",
      content: this.input,
      name: this.userName,
      multiModalImage: multimodalImage,
      multiModalImages: multimodalImages,
      createdAt: new Date(),
      isDeleted: false,
      threadId: this.chatThreadId,
      type: "CHAT_MESSAGE",
      userId: "",
    };

    logInfo("Chat Store: Adding user message", {
      messageId: newUserMessage.id,
      content: newUserMessage.content,
      threadId: newUserMessage.threadId
    });

    this.messages.push(newUserMessage);
    this.reset();

    const controller = new AbortController();
    abortController = controller;

    try {
      if (this.chatThreadId === "" || this.chatThreadId === undefined) {
        showError("Chat thread ID is empty");
        return;
      }

      const response = await fetch("/api/chat", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorMessage = await response.text();
        showError(errorMessage);
        this.loading = "idle";
        this.phase = 'idle';
        return;
      }

      if (response.body) {
        const parser = this.createStreamParser(newUserMessage);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let done = false;
        while (!done) {
          const { value, done: doneReading } = await reader.read();
          done = doneReading;

                  const chunkValue = decoder.decode(value);
        logDebug("Chat Store: Processing chunk", { 
          chunkLength: chunkValue.length,
          chunkPreview: chunkValue.substring(0, 200) + "...",
          isDone: doneReading
        });
        parser.feed(chunkValue);
        }
        logDebug("Chat Store: Stream ended", {
          timestamp: new Date().toISOString(),
          lastMessageLength: this.lastMessage?.length || 0,
          currentAssistantMessageId: this.currentAssistantMessageId,
          messagesCount: this.messages.length
        });
        
        // If we have a last message but no finalContent event was received, 
        // treat this as completion
        if (this.lastMessage && this.currentAssistantMessageId && this.loading === "loading") {
          logInfo("Chat Store: Stream ended without finalContent event, treating as completion");
          
          // Find the existing assistant message and ensure it has the final content
          const existingMessageIndex = this.messages.findIndex(m => m.id === this.currentAssistantMessageId && m.role === "assistant");
          if (existingMessageIndex !== -1) {
            // Clean up any remaining tool call progress indicators
            const existingMessage = this.messages[existingMessageIndex];
            const finalContent = this.lastMessage.replace(/🔧 \*\*Tool Call\*\*: [^\n]*\n\n\*\*Arguments\*\*:\n\`\`\`json\n[\s\S]*?\n\`\`\`\n\n⏳ Executing\.\.\./g, "").replace(/✅ \*\*Completed\*\*/g, "");
            this.messages[existingMessageIndex] = {
              ...existingMessage,
              content: finalContent
            };
          }
          
          this.loading = "idle";
          this.completed(this.lastMessage);
          this.updateTitle();
          this.currentAssistantMessageId = "";
        } else {
          this.loading = "idle";
        }
      }
    } catch (error) {
      showError("" + error);
      this.loading = "idle";
      this.phase = 'idle';
    }
  }

  private async updateTitle() {
    if (this.chatThread && this.chatThread.name === NEW_CHAT_NAME) {
      // Fire-and-forget: update title asynchronously without blocking the UI
      setTimeout(async () => {
        try {
          await UpdateChatTitle(this.chatThreadId, this.messages[0].content);
          RevalidateCache({
            page: "chat",
            type: "layout",
          });
        } catch (error) {
          logError("Failed to update chat title", { error: error instanceof Error ? error.message : String(error) });
          // Don't show error to user since this is non-critical
        }
      }, 0);
    }
  }

  private completed(message: string) {
    textToSpeechStore.speak(message);
  }

  public async submitChat(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (this.input === "" || this.loading !== "idle") {
      return;
    }

    // get form data from e
    const formData = new FormData(e.currentTarget);

    const body = JSON.stringify({
      id: this.chatThreadId,
      message: this.input,
      selectedModel: this.selectedModel,
      reasoningEffort: this.reasoningEffort,
      webSearchEnabled: this.webSearchEnabled,
      imageGenerationEnabled: this.imageGenerationEnabled,
      companyContentEnabled: this.companyContentEnabled,
      codeInterpreterEnabled: this.codeInterpreterEnabled,
      codeInterpreterFileIds: this.getCodeInterpreterFileIds(),
    });
    formData.append("content", body);

    this.chat(formData);
    
    // Note: Don't clear attached files after submission - they persist with the thread
  }

  private createStreamParser(newUserMessage: ChatMessageModel) {
    return createParser((event: ParsedEvent | ReconnectInterval) => {
      logDebug("Chat Store: Parser received event", {
        eventType: event.type,
        eventName: event.type === "event" ? event.event : undefined,
        dataLength: event.type === "event" ? event.data?.length || 0 : 0
      });
      
      if (event.type === "event") {
        logDebug("Chat Store: Received event", { 
          dataLength: event.data?.length || 0,
          eventType: event.type,
          eventName: event.event,
          eventData: event.data?.substring(0, 200) + "..." // Log first 200 chars of data
        });
        try {
          const responseType = JSON.parse(event.data) as AzureChatCompletion;
          
          logDebug("Chat Store: Parsed response", { 
            type: responseType.type,
            hasContent: !!responseType.response,
            responseType: typeof responseType.type,
            responseKeys: Object.keys(responseType)
          });

          switch (responseType.type) {

            case "content":
              const contentChunk = responseType.response.choices?.[0]?.message?.content || "";
              if (this.phase === 'submitted') {
                this.phase = 'streaming';
              }
              
              logInfo("Chat Store: Received content event", {
                contentLength: contentChunk.length,
                messageId: this.currentAssistantMessageId,
                tempReasoningContentLength: this.tempReasoningContent?.length || 0,
                responseMessageId: responseType.response.id
              });
              
              // Use consistent message ID for all chunks of the same response
              if (!this.currentAssistantMessageId) {
                this.currentAssistantMessageId = responseType.response.id || uniqueId();
                logDebug("Chat Store: Created new assistant message ID", {
                  messageId: this.currentAssistantMessageId
                });
              }
              
              // Find existing assistant message or create new one
              const existingMessageIndex = this.messages.findIndex(m => m.id === this.currentAssistantMessageId && m.role === "assistant");
              
              if (existingMessageIndex !== -1) {
                // Accumulate content chunks by replacing the entire message object
                const existingMessage = this.messages[existingMessageIndex];
                // No need to clean up tool call indicators since they're shown in loading overlay
                const updatedContent = existingMessage.content + contentChunk;
                this.messages[existingMessageIndex] = {
                  ...existingMessage,
                  content: updatedContent
                };
                this.lastMessage = updatedContent;
              } else {
                // Create new message for first chunk
                const mappedContent: ChatMessageModel = {
                  id: this.currentAssistantMessageId,
                  content: contentChunk,
                  name: AI_NAME,
                  role: "assistant",
                  createdAt: new Date(),
                  isDeleted: false,
                  threadId: this.chatThreadId,
                  type: "CHAT_MESSAGE",
                  userId: "",
                  multiModalImage: "",
                  reasoningContent: this.tempReasoningContent || undefined,
                };

                this.addToMessages(mappedContent);
                this.lastMessage = mappedContent.content;
                
                // Clear temporary reasoning content since we've created the message
                this.tempReasoningContent = "";
              }
              break;
            case "abort":
              // Show the reason to the user and stop loading
              if ((responseType as any)?.response) {
                showError((responseType as any).response);
              }
              this.loading = "idle";
              this.phase = 'error';
              break;
            case "error":
              showError(responseType.response);
              this.loading = "idle";
              this.phase = 'error';
              break;
            case "reasoning":
              logInfo("Chat Store: Received reasoning event", { 
                contentLength: responseType.response?.length || 0,
                messageId: this.currentAssistantMessageId,
                tempReasoningContentLength: this.tempReasoningContent?.length || 0
              });
              
              // Ensure we have a consistent message ID for reasoning content
              if (!this.currentAssistantMessageId) {
                this.currentAssistantMessageId = uniqueId();
              }

              // Initialize reasoning meta (start timer) if first reasoning token for this message
              if (!this.reasoningMeta[this.currentAssistantMessageId]) {
                this.reasoningMeta[this.currentAssistantMessageId] = {
                  start: Date.now(),
                  elapsed: 0,
                  isStreaming: true
                };
              }
              
              // Try to find existing assistant message
              const targetMessageIndex = this.messages.findIndex(m => m.id === this.currentAssistantMessageId && m.role === "assistant");
              
              if (targetMessageIndex !== -1) {
                logDebug("Chat Store: Updating existing assistant message with reasoning");
                // Update the message in a way that triggers Valtio reactivity
                const targetMessage = this.messages[targetMessageIndex];
                const updatedReasoningContent = (targetMessage.reasoningContent || "") + responseType.response;
                
                // Create a new message object to ensure Valtio detects the change
                this.messages[targetMessageIndex] = {
                  ...targetMessage,
                  reasoningContent: updatedReasoningContent
                };
              } else {
                logDebug("Chat Store: Creating assistant message for reasoning display");
                // Create an assistant message immediately to show reasoning in real-time
                const reasoningMessage: ChatMessageModel = {
                  id: this.currentAssistantMessageId,
                  content: "", // Empty content initially
                  name: AI_NAME,
                  role: "assistant",
                  createdAt: new Date(),
                  isDeleted: false,
                  threadId: this.chatThreadId,
                  type: "CHAT_MESSAGE",
                  userId: "",
                  multiModalImage: "",
                  reasoningContent: (this.tempReasoningContent || "") + responseType.response,
                };

                this.addToMessages(reasoningMessage);
                
                // Clear temp reasoning content since we've created the message
                this.tempReasoningContent = "";
              }
              break;
            case "functionCall":
              logInfo("Chat Store: Received function call event", {
                functionName: (responseType as any).response?.name,
                arguments: (responseType as any).response?.arguments,
                callId: (responseType as any).response?.call_id,
                messageId: this.currentAssistantMessageId,
                responseType: responseType.type,
                hasResponse: !!(responseType as any).response
              });
              
              // Ensure we have a consistent message ID
              if (!this.currentAssistantMessageId) {
                this.currentAssistantMessageId = uniqueId();
              }
              
              // Add tool call to history (for wrench icon)
              this.addToolCall(
                this.currentAssistantMessageId,
                (responseType as any).response.name,
                (responseType as any).response.arguments,
                (responseType as any).response.call_id
              );
              
              // Mark tool call as in progress
              this.toolCallInProgress[this.currentAssistantMessageId] = (responseType as any).response.name;
              
              // Note: currentToolCall UI removed
              break;
            case "functionCallResult":
              logInfo("Chat Store: Received function call result", {
                resultLength: responseType.response?.length || 0,
                messageId: this.currentAssistantMessageId,
                responseType: responseType.type,
                hasResponse: !!responseType.response
              });
              
              // Complete the tool call
              this.completeToolCall(
                this.currentAssistantMessageId,
                responseType.response,
                (responseType as any).call_id
              );
              
              // Create a visible tool message in the chat timeline
              try {
                const calls = this.toolCallHistory[this.currentAssistantMessageId] || [];
                const callId = (responseType as any).call_id as string | undefined;
                let matched = calls.length > 0 ? calls[calls.length - 1] : undefined;
                if (callId) {
                  const idx = calls.findIndex(c => c.callId === callId);
                  if (idx !== -1) matched = calls[idx];
                }
                const toolName = matched?.name || "tool";
                const toolArgs = matched?.arguments || "";
                const toolContent = JSON.stringify({ name: toolName, arguments: toolArgs, result: responseType.response });
                const toolMessage: ChatMessageModel = {
                  id: uniqueId(),
                  content: toolContent,
                  name: toolName,
                  role: "tool",
                  createdAt: new Date(),
                  isDeleted: false,
                  threadId: this.chatThreadId,
                  type: "CHAT_MESSAGE",
                  userId: "",
                };
                this.addToMessages(toolMessage);
              } catch (e) {
                logWarn("Chat Store: Failed to append tool message", { error: e instanceof Error ? e.message : String(e) });
              }

              // Clear in-progress indicator
              this.toolCallInProgress[this.currentAssistantMessageId] = null;
              
              // Note: currentToolCall UI removed
              break;
            case "finalContent":
              // The finalContent event signals that streaming is complete
              logInfo("Chat Store: Processing finalContent event", {
                lastMessageLength: this.lastMessage?.length || 0,
                currentAssistantMessageId: this.currentAssistantMessageId,
                messagesCount: this.messages.length,
                responseContent: responseType.response,
                hasLastMessage: !!this.lastMessage,
                hasCurrentAssistantMessageId: !!this.currentAssistantMessageId,
                timestamp: new Date().toISOString()
              });
              
              const finalResponseText = (responseType as any).response || '';

              // Ensure the final message is properly displayed in the UI
              if (this.lastMessage && this.currentAssistantMessageId) {
                // Find the existing assistant message and ensure it has the final content
                const existingMessageIndex = this.messages.findIndex(m => m.id === this.currentAssistantMessageId && m.role === "assistant");
                
                logDebug("Chat Store: Looking for existing assistant message", {
                  messageId: this.currentAssistantMessageId,
                  existingMessageIndex,
                  totalMessages: this.messages.length
                });
                
                if (existingMessageIndex !== -1) {
                  // Update the message with the final content to ensure UI reflects the complete response
                  const existingMessage = this.messages[existingMessageIndex];
                  // Clean up any remaining tool call progress indicators
                  let finalContent = this.lastMessage.replace(/🔧 \*\*Tool Call\*\*: [^\n]*\n\n\*\*Arguments\*\*:\n\`\`\`json\n[\s\S]*?\n\`\`\`\n\n⏳ Executing\.\.\./g, "").replace(/✅ \*\*Completed\*\*/g, "");
                  
                  // If finalContent event has a longer / different body (e.g. no incremental chunks were sent), prefer it
                  if (finalResponseText && (finalResponseText.length > finalContent.length || finalContent.length === 0)) {
                    finalContent = finalResponseText;
                    this.lastMessage = finalResponseText;
                  }

                  // Get tool call history for this message
                  const toolCallHistory = this.toolCallHistory[this.currentAssistantMessageId] || [];
                  
                  logDebug("Chat Store: Preparing to save tool call history", {
                    messageId: this.currentAssistantMessageId,
                    toolCallCount: toolCallHistory.length,
                    hasToolCalls: toolCallHistory.length > 0,
                    toolCallHistory: toolCallHistory
                  });
                  
                  const updatedMessage = {
                    ...existingMessage,
                    content: finalContent,
                    toolCallHistory: toolCallHistory.length > 0 ? toolCallHistory : undefined
                  };
                  
                  this.messages[existingMessageIndex] = updatedMessage;
                  
                  // Save to database with tool call history
                  if (toolCallHistory.length > 0) {
                    logInfo("Chat Store: Saving tool call history to database", {
                      messageId: this.currentAssistantMessageId,
                      toolCallCount: toolCallHistory.length
                    });
                    UpsertChatMessage(updatedMessage).catch(error => {
                      logError("Failed to save tool call history", { 
                        messageId: this.currentAssistantMessageId,
                        error: error.message 
                      });
                    });
                  } else {
                    logDebug("Chat Store: No tool calls to save", {
                      messageId: this.currentAssistantMessageId
                    });
                  }
                  
                  logDebug("Chat Store: Updated final message content", {
                    messageId: this.currentAssistantMessageId,
                    contentLength: finalContent.length,
                    toolCallCount: toolCallHistory.length
                  });
                } else {
                  logWarn("Chat Store: No existing assistant message found for final content", {
                    messageId: this.currentAssistantMessageId,
                    availableMessageIds: this.messages.map(m => ({ id: m.id, role: m.role }))
                  });
                  // If we *only* received a finalContent event (no prior content events), create the assistant message now
                  if (finalResponseText) {
                    const newAssistantMsg: ChatMessageModel = {
                      id: this.currentAssistantMessageId || uniqueId(),
                      content: finalResponseText,
                      name: AI_NAME,
                      role: 'assistant',
                      createdAt: new Date(),
                      isDeleted: false,
                      threadId: this.chatThreadId,
                      type: 'CHAT_MESSAGE',
                      userId: '',
                    };
                    this.addToMessages(newAssistantMsg);
                    this.lastMessage = finalResponseText;
                  }
                }
              } else {
                logWarn("Chat Store: Missing lastMessage or currentAssistantMessageId", {
                  hasLastMessage: !!this.lastMessage,
                  hasCurrentAssistantMessageId: !!this.currentAssistantMessageId
                });
                // Fallback: create message directly from finalContent if nothing streamed
                if (finalResponseText) {
                  const finalId = this.currentAssistantMessageId || uniqueId();
                  const newAssistantMsg: ChatMessageModel = {
                    id: finalId,
                    content: finalResponseText,
                    name: AI_NAME,
                    role: 'assistant',
                    createdAt: new Date(),
                    isDeleted: false,
                    threadId: this.chatThreadId,
                    type: 'CHAT_MESSAGE',
                    userId: '',
                  };
                  this.addToMessages(newAssistantMsg);
                  this.currentAssistantMessageId = finalId;
                  this.lastMessage = finalResponseText;
                }
              }
              
              // Set loading to idle and complete the conversation
              logInfo("Chat Store: Setting loading to idle and completing conversation");
              this.loading = "idle";
              this.phase = 'idle';
              this.completed(this.lastMessage);
              
              // Update title asynchronously (non-blocking)
              this.updateTitle();
              
              // Reset the current assistant message ID for the next conversation
              // Do this last to avoid any race conditions
              logInfo("Chat Store: Resetting currentAssistantMessageId for next conversation");
              // Stop reasoning timer if active
              if (this.currentAssistantMessageId && this.reasoningMeta[this.currentAssistantMessageId]) {
                const meta = this.reasoningMeta[this.currentAssistantMessageId];
                if (meta.isStreaming) {
                  meta.elapsed = Math.ceil((Date.now() - meta.start) / 1000);
                  meta.isStreaming = false;
                }
              }
              this.currentAssistantMessageId = "";
              // Note: currentToolCall UI removed
              break;
            default:
              // Handle informational events that don't require UI updates
              const eventType = (responseType as any).type;
              if (eventType === "response.in_progress" ||
                  eventType === "response.reasoning_summary_part.added" ||
                  eventType === "response.reasoning_summary_text.done" ||
                  eventType === "response.reasoning_summary_part.done" ||
                  eventType === "response.content_part.added" ||
                  eventType === "response.output_text.done" ||
                  eventType === "response.content_part.done") {
                logDebug("Chat Store: Received informational event", {
                  eventType: eventType,
                  hasResponse: !!(responseType as any).response
                });
                // These are informational events that don't require UI updates
                // They're handled by the backend stream processor
                break;
              }
              
              logWarn("Chat Store: Unhandled response type", {
                type: eventType,
                hasResponse: !!(responseType as any).response,
                responseData: (responseType as any).response
              });
              break;
          }
        } catch (error) {
          logError("Chat Store: Error parsing event data", { 
            error: error instanceof Error ? error.message : String(error),
            eventDataLength: event.data?.length || 0 
          });
          showError("Error parsing response data");
        }
      }
    });
  }

  // --- Tool call tracking methods ---
  public addToolCall(messageId: string, name: string, args: string, callId?: string) {
    if (!this.toolCallHistory[messageId]) this.toolCallHistory[messageId] = [];
    this.toolCallHistory[messageId].push({ name, arguments: args, timestamp: new Date(), callId });
    this.toolCallInProgress[messageId] = name;
    
    logDebug("Chat Store: Added tool call", {
      messageId,
      toolName: name,
      totalToolCalls: this.toolCallHistory[messageId].length,
      args: args.substring(0, 100) + "..."
    });
  }
  public completeToolCall(messageId: string, result: string, callId?: string) {
    const calls = this.toolCallHistory[messageId];
    if (calls && calls.length > 0) {
      if (callId) {
        const idx = calls.findIndex(c => c.callId === callId && c.result === undefined);
        if (idx !== -1) {
          calls[idx].result = result;
        } else {
          calls[calls.length - 1].result = result;
        }
      } else {
        calls[calls.length - 1].result = result;
      }
    }
    this.toolCallInProgress[messageId] = null;
    
    logDebug("Chat Store: Completed tool call", {
      messageId,
      totalToolCalls: calls?.length || 0,
      resultLength: result?.length || 0
    });
  }
  public getToolCallHistoryForMessage(messageId: string) {
    return this.toolCallHistory[messageId] || [];
  }
  public isToolCallInProgress(messageId: string) {
    return !!this.toolCallInProgress[messageId];
  }
}

export const chatStore = proxy(new ChatState());

export const useChat = () => {
  return useSnapshot(chatStore, { sync: true });
};

// Debug hook to access tool call history
export const useToolCallHistory = (messageId: string) => {
  const snapshot = useSnapshot(chatStore, { sync: true });
  const toolCallHistory = snapshot.toolCallHistory[messageId] || [];
  
  logDebug("useToolCallHistory called", {
    messageId,
    toolCallCount: toolCallHistory.length,
    toolCallHistory: toolCallHistory,
    allToolCallHistory: snapshot.toolCallHistory
  });
  
  return toolCallHistory;
};

// Hook removed: current tool call overlay no longer used
export const useReasoningMeta = (messageId: string) => {
  const snapshot = useSnapshot(chatStore, { sync: true });
  return snapshot.reasoningMeta[messageId] || { start: 0, elapsed: 0, isStreaming: false };
};
