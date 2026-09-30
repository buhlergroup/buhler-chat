"use client";
import { ExtensionModel } from "@/features/extensions-page/extension-services/models";
import { CHAT_DEFAULT_PERSONA } from "@/features/theme/theme-config";
import { VenetianMask } from "lucide-react";
import { FC, useCallback } from "react";
import { ChatDocumentModel, ChatThreadModel, ChatModel, MODEL_CONFIGS } from "../chat-services/models";
import { useChatStore, useChatSession } from "../chat-store-context";
import {
  UpdateChatThreadSelectedModel,
  UpdateChatThreadReasoningEffort,
} from "../chat-services/chat-thread-service";
import { showError } from "@/features/globals/global-message-store";
import { DocumentDetail } from "./document-detail";
import { ExtensionDetail } from "./extension-detail";
import { ModelSelector } from "./model-selector";
import { PersonaDetail } from "./persona-detail";
import { MobileHeader } from "@/features/ui/mobile-header";
import { ChatReset } from "./chat-reset";
import { TokenUsageDisplay } from "./token-usage-display";

interface Props {
  chatThread: ChatThreadModel;
  chatDocuments: Array<ChatDocumentModel>;
  extensions: Array<ExtensionModel>;
  onModelSelected?: () => void;
}

export const ChatHeader: FC<Props> = (props) => {
  const chatThreadId = props.chatThread.id;
  const onModelSelected = props.onModelSelected;
  const selectedModel = useChatStore((s) => s.selectedModel);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  // The model the last turn actually ran on; differs from selectedModel when a
  // budget cap / intent downgrade kicked in. Drives the selector's live label.
  const effectiveModel = useChatStore((s) => s.lastUsageData?.model) as
    | ChatModel
    | undefined;
  const { messages, status } = useChatSession();
  const loading = status === "streaming" || status === "submitted";

  const handleModelChange = useCallback(
    async (model: ChatModel) => {
      onModelSelected?.();
      setSelectedModel(model);
      try {
        const r = await UpdateChatThreadSelectedModel(chatThreadId, model);
        if (r.status !== "OK") showError("Failed to save model selection");
        const defaultEffort =
          MODEL_CONFIGS[model]?.defaultReasoningEffort ?? "low";
        await UpdateChatThreadReasoningEffort(chatThreadId, defaultEffort);
      } catch (err) {
        showError("Failed to save model selection: " + err);
      }
    },
    [chatThreadId, onModelSelected, setSelectedModel],
  );

  const persona =
    props.chatThread.personaMessageTitle === "" ||
    props.chatThread.personaMessageTitle === undefined
      ? CHAT_DEFAULT_PERSONA
      : props.chatThread.personaMessageTitle;

  return (
    <>
      {/* Mobile header with hamburger menu */}
      <MobileHeader>
        <div className="flex items-center gap-2">
          {/* Model selector */}
          <div className="shrink-0">
            <ModelSelector
              selectedModel={selectedModel}
              effectiveModel={effectiveModel}
              onModelChange={handleModelChange}
              disabled={loading}
            />
          </div>

          {/* Chat thread info - can shrink but not disappear */}
          <div className="flex flex-col min-w-[80px] max-w-[200px]">
            <span className="truncate text-sm">
              {props.chatThread.name}
            </span>
          </div>
          <TokenUsageDisplay />
          <ChatReset chatThreadId={props.chatThread.id} disabled={!messages.length} />

          {/* Extension detail */}
          <ExtensionDetail
            disabled={props.chatDocuments.length !== 0}
            extensions={props.extensions}
            installedExtensionIds={props.chatThread.extension}
            chatThreadId={props.chatThread.id}
            parent={"chat"}
          />
        </div>
      </MobileHeader>

      {/* Desktop header */}
      <div className="bg-background border-b hidden md:flex items-center py-2 px-3 overflow-x-auto scrollbar-none">
        <div className="flex items-center w-full max-w-4xl mx-auto">
          {/* Main content area */}
          <div className="flex items-center gap-2">
            {/* Model selector */}
            <div className="shrink-0">
              <ModelSelector
                selectedModel={selectedModel}
                onModelChange={handleModelChange}
                disabled={loading}
              />
            </div>

            {/* Chat thread info - shrinks first, scrolls if needed */}
            <div className="flex flex-col min-w-[100px] flex-1">
              <span className="truncate text-base">
                {props.chatThread.name}
              </span>
              <span className="text-sm text-muted-foreground flex gap-1 items-center">
                <VenetianMask size={14} className="shrink-0" />
                <span className="truncate">{persona}</span>
              </span>
            </div>
            <TokenUsageDisplay />
            <ChatReset chatThreadId={props.chatThread.id} disabled={!messages.length} />

            {/* Action buttons */}
            <div className="flex gap-1 shrink-0">
              {/* Hide persona and document details on smaller screens */}
              <div className="hidden lg:flex gap-1">
                <PersonaDetail chatThread={props.chatThread}/>
                <DocumentDetail chatDocuments={props.chatDocuments} />
              </div>
              {/* Extension detail - always visible */}
              <ExtensionDetail
                disabled={props.chatDocuments.length !== 0}
                extensions={props.extensions}
                installedExtensionIds={props.chatThread.extension}
                chatThreadId={props.chatThread.id}
                parent={"chat"}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
