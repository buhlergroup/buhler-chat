"use client";
import { useEffect, useMemo, useRef, useState, memo, Component, type ReactNode } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useChatSession, useChatStore, ChatStoreProvider } from "@/features/chat-page/chat-store-context";
import {
  UpdateChatThreadSelectedModel,
  UpdateChatThreadReasoningEffort,
  RemoveAttachedFile,
} from "./chat-services/chat-thread-service";
import { showError } from "@/features/globals/global-message-store";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { RichResponse } from "@/components/ai-elements/rich-response";
import { Loader } from "@/components/ai-elements/loader";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "@/components/ai-elements/reasoning";
import { ToolPartView, isToolPart } from "./tool-part-view";
import { PromptInput, PromptInputTextarea, PromptInputToolbar, PromptInputTools, PromptInputButton, PromptInputSubmit, PromptInputModelSelect, PromptInputModelSelectTrigger, PromptInputModelSelectContent, PromptInputModelSelectItem, PromptInputModelSelectValue } from "@/components/ai-elements/prompt-input";
import type { ChatDocumentModel, ChatMessageModel, ChatThreadModel } from "./chat-services/models";
import { ExtensionModel } from "../extensions-page/extension-services/models";
import { ChatHeader } from "./chat-header/chat-header";
import { useProfilePicture } from "../common/hooks/useProfilePicture";
import { File, Paperclip, Copy, Check } from "lucide-react";
import { Actions, Action } from "@/components/ai-elements/actions";
import { fileStore, useFileStore } from "./chat-input/file/file-store";
import { Button } from "@/features/ui/button";
import { Trash2 } from "lucide-react";
import { SoftDeleteChatDocumentsForCurrentUser } from "./chat-services/chat-thread-service";
import { RevalidateCache } from "@/features/common/navigation-helpers";
import { InternetSearch } from "@/features/ui/chat/chat-input-area/internet-search";
import { ReasoningEffortSelector } from "./chat-input/reasoning-effort-selector";
import { MODEL_CONFIGS, DEFAULT_MODEL } from "./chat-services/models";
import { ToolToggles } from "./chat-input/tool-toggles";
import { InputImageStore, useInputImage } from "@/features/ui/chat/chat-input-area/input-image-store";
import Image from "next/image";
import { X, FileSpreadsheet } from "lucide-react";
import { ChatImageDisplay } from "./chat-image-display";
import type { UIMessage, FileUIPart } from "ai";
import { uiMessagesFromChatMessages } from "./chat-services/chat-api/message-adapter";
import { CompactionMarker, CompactionNotice } from "./compaction-notice";
import {
  compactionMarkerPlacement,
  isCompactionDataPart,
  type CompactionData,
  type ThreadCompactionMarker,
} from "./chat-services/chat-api/compaction-part";
import { useEmbedMode } from "@/features/embed/embed-mode-context";

interface ChatPageProps {
  messages: Array<ChatMessageModel>;
  chatThread: ChatThreadModel;
  chatDocuments: Array<ChatDocumentModel>;
  extensions: Array<ExtensionModel>;
  /**
   * The thread's persisted compaction row, if it has ever been trimmed. Read
   * once by the page and rendered as a divider at the watermark; it is display
   * only and never reaches the model — the prompt's copy of the summary is
   * assembled server-side in thread-context.ts.
   */
  compactionMarker?: ThreadCompactionMarker | null;
}

// ---------------------------------------------------------------------------
// Message rendering helpers
// ---------------------------------------------------------------------------

function getMessageText(m: UIMessage): string {
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function getReasoningText(m: UIMessage): string {
  return m.parts
    .filter((p) => p.type === "reasoning")
    .map((p) => (p as { type: "reasoning"; text: string }).text)
    .join("\n\n");
}

function getImageUrls(m: UIMessage): string[] {
  return m.parts
    .filter((p) => p.type === "file")
    .map((p) => (p as { type: "file"; url: string }).url)
    .filter(Boolean);
}

function getToolParts(m: UIMessage) {
  return m.parts.filter(isToolPart);
}

/**
 * `data-compaction` parts on this message. Written by /api/chat on the turn
 * whose history was trimmed, so the user is told at the moment it happens.
 * The AI SDK keeps data parts on the streaming message and reconciles repeat
 * writes by part id, so there is at most one per turn.
 */
function getCompactionData(m: UIMessage): CompactionData[] {
  return m.parts
    .filter(isCompactionDataPart)
    .map((p) => p.data)
    .filter((d): d is CompactionData => Boolean(d));
}

/**
 * Per-message error boundary. Keeps a single message that fails to render
 * (e.g. a malformed generative-UI spec) from taking down the whole chat, and
 * logs the React component stack to aid diagnosis.
 */
class MessageErrorBoundary extends Component<{ children: ReactNode; mid: string }, { err: boolean }> {
  state = { err: false };
  static getDerivedStateFromError() {
    return { err: true };
  }
  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // eslint-disable-next-line no-console
    console.error("chat message render error", this.props.mid, error?.message, info?.componentStack);
  }
  render() {
    if (this.state.err) {
      return (
        <div className="p-2 text-xs text-muted-foreground">
          This message couldn&apos;t be displayed.
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// ChatMessages — rendered from AI SDK UIMessage stream
// ---------------------------------------------------------------------------

const ChatMessages = memo(function ChatMessages({
  profilePicture,
  compactionMarker,
}: {
  profilePicture?: string | null;
  compactionMarker?: ThreadCompactionMarker | null;
}) {
  const { messages, status, error } = useChatSession();
  const setInputText = useChatStore((s) => s.setInputText);
  // Where the persisted compaction divider goes. Recomputed only when the
  // transcript or the marker changes; it walks the message list once.
  const markerPlacement = useMemo(
    () =>
      compactionMarkerPlacement({
        marker: compactionMarker,
        messages: messages.filter(
          (m) => m.role === "user" || m.role === "assistant",
        ),
      }),
    [compactionMarker, messages],
  );
  const [copiedMap, setCopiedMap] = useState<Record<string, boolean>>({});
  const isStreaming = status === "streaming" || status === "submitted";
  const router = useRouter();

  // Background-generation indicator: when the last persisted/streamed
  // message is a user turn (no assistant reply yet) AND we're not actively
  // streaming in this tab, the LLM is still running on the server (from
  // a previous tab or before navigation). Poll the route every 3 s so the
  // assistant message appears as soon as it lands in Cosmos.
  //
  // Polling is BOUNDED to 60 s so a stranded turn (onFinish failed,
  // content-filter empty finish, or process recycled mid-stream) does
  // not hammer Cosmos forever (architect2 SEV-1 B2). After the cap the
  // pill transitions to a manual-retry hint.
  const lastRole = messages.length > 0 ? messages[messages.length - 1]!.role : null;
  const generatingInBackground = lastRole === "user" && !isStreaming;
  const POLL_CAP_MS = 60_000;
  const POLL_INTERVAL_MS = 3_000;
  const [pollExhausted, setPollExhausted] = useState(false);
  useEffect(() => {
    if (!generatingInBackground) {
      setPollExhausted(false);
      return;
    }
    setPollExhausted(false);
    const interval = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    const cap = setTimeout(() => {
      clearInterval(interval);
      setPollExhausted(true);
    }, POLL_CAP_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(cap);
    };
  }, [generatingInBackground, router]);

  // Sidebar title refresh: the thread title is generated fire-and-forget on
  // the server right AFTER the first turn's stream closes (route.ts onFinish
  // → UpdateChatTitle), so at the moment the client sees status flip to
  // "ready" the Cosmos write usually hasn't landed yet. Refresh the route
  // (layout included — that's where the chat menu lives) shortly after the
  // first turn completes so the generated name replaces "New chat" without
  // a manual page reload. Two staggered refreshes cover slow title
  // generations; subsequent turns don't re-title, so this only fires once.
  const userTurnCount = messages.filter((m) => m.role === "user").length;
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const wasStreaming =
      prevStatusRef.current === "streaming" ||
      prevStatusRef.current === "submitted";
    prevStatusRef.current = status;
    if (!wasStreaming || status !== "ready" || userTurnCount !== 1) return;
    const early = setTimeout(() => router.refresh(), 1_500);
    const late = setTimeout(() => router.refresh(), 5_000);
    return () => {
      clearTimeout(early);
      clearTimeout(late);
    };
  }, [status, userTurnCount, router]);

  return (
    <Conversation>
      <ConversationContent className="max-w-4xl mx-auto w-full">
        {messages.length === 0 && !isStreaming && (
          <div className="flex flex-col items-center justify-center py-20 px-4 text-center">
            <p className="text-lg text-muted-foreground mb-6">How can I help you today?</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg w-full">
              {["Summarize a document for me", "Help me write an email", "Explain a technical concept", "Analyze data or a report"].map((prompt) => (
                <button
                  key={prompt}
                  className="text-left text-sm px-4 py-3 rounded-lg border border-border/50 hover:border-border hover:bg-accent/40 transition-colors text-muted-foreground"
                  onClick={() => { setInputText(prompt); }}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m, idx, arr) => {
            const role = m.role as "user" | "assistant";
            const avatarSrc = role === "user"
              ? (profilePicture || "/user-icon.png")
              : "/ai-icon.png";

            const text = getMessageText(m);
            const reasoningText = role === "assistant" ? getReasoningText(m) : "";
            const imageUrls = role === "user" ? getImageUrls(m) : [];
            const toolParts = role === "assistant" ? getToolParts(m) : [];
            const compactionData = role === "assistant" ? getCompactionData(m) : [];

            // The persisted marker sits directly after the newest row the
            // summary covers — see compactionMarkerPlacement, which also
            // derives how many turns it stands for.
            const isWatermarkMessage =
              markerPlacement?.afterMessageId === m.id;

            // Reasoning panel state: while the assistant turn is still
            // streaming AND its last part is reasoning, the model is actively
            // thinking — the Reasoning component times this live and renders
            // "Thinking..." → "Thought for Ns". For an already-persisted turn
            // we surface the server-measured duration carried on message
            // metadata (set in the /api/chat onChunk timer, round-tripped via
            // message-adapter) so the timer survives a reload.
            const isLastMessage = idx === arr.length - 1;
            const isReasoningStreaming =
              isLastMessage && isStreaming && m.parts.at(-1)?.type === "reasoning";
            const reasoningDurationMs = (
              m.metadata as { reasoningDurationMs?: number } | undefined
            )?.reasoningDurationMs;
            const reasoningDurationSec =
              reasoningDurationMs && reasoningDurationMs > 0
                ? Math.max(1, Math.round(reasoningDurationMs / 1000))
                : undefined;

            return (
              <div className="flex flex-col gap-4" key={m.id}>
                {compactionData.map((data, i) => (
                  <CompactionNotice data={data} key={`compaction-${i}`} />
                ))}
                <MessageErrorBoundary mid={m.id}>
                <Message key={m.id} from={role}>
                  <div className="flex flex-col gap-0.5 w-full">
                    <MessageContent>
                      {/* Images (user messages) */}
                      {imageUrls.length > 0 && (
                        <div className="mb-4 flex flex-wrap gap-2">
                          {imageUrls.map((imgUrl, imgIdx) => (
                            <div key={imgIdx} className="w-[240px] max-w-full">
                              <ChatImageDisplay imageUrl={imgUrl} className="w-full rounded-lg" />
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Reasoning block */}
                      {reasoningText && role === "assistant" && (
                        <Reasoning
                          isStreaming={isReasoningStreaming}
                          defaultOpen={isReasoningStreaming}
                          {...(reasoningDurationSec !== undefined
                            ? { duration: reasoningDurationSec }
                            : {})}
                        >
                          <ReasoningTrigger />
                          <ReasoningContent>{reasoningText}</ReasoningContent>
                        </Reasoning>
                      )}

                      {/* Tool calls */}
                      {toolParts.length > 0 && role === "assistant" && (
                        <div className="space-y-3 mb-4">
                          {toolParts.map((part, i) => (
                            <ToolPartView key={i} part={part} index={i} />
                          ))}
                        </div>
                      )}

                      {/* Message text */}
                      {(role === "assistant" || role === "user") && (
                        <RichResponse
                          content={text}
                          streaming={isLastMessage && isStreaming}
                        />
                      )}
                    </MessageContent>

                    {(role === "assistant" || role === "user") && (
                      <div className="flex group-[.is-user]:justify-end group-[.is-assistant]:justify-start px-0.5">
                        <Actions className="opacity-0 transition group-hover:opacity-100">
                          <Action
                            aria-label="Copy message"
                            tooltip="Copy"
                            onClick={() => {
                              navigator.clipboard.writeText(text).then(() => {
                                setCopiedMap((prev) => ({ ...prev, [m.id]: true }));
                                setTimeout(() => setCopiedMap((prev) => ({ ...prev, [m.id]: false })), 1500);
                              });
                            }}
                            className="size-7"
                          >
                            {copiedMap[m.id] ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                          </Action>
                        </Actions>
                      </div>
                    )}
                  </div>
                </Message>
                </MessageErrorBoundary>
                {isWatermarkMessage && markerPlacement && (
                  <CompactionMarker
                    trimmedTurns={markerPlacement.trimmedTurns}
                    {...(compactionMarker?.summaryText
                      ? { summaryText: compactionMarker.summaryText }
                      : {})}
                    {...(compactionMarker?.summaryModel
                      ? { summaryModel: compactionMarker.summaryModel }
                      : {})}
                    {...(typeof compactionMarker?.realTokensBefore === "number"
                      ? { realTokensBefore: compactionMarker.realTokensBefore }
                      : {})}
                    {...(typeof compactionMarker?.realTokensAfter === "number"
                      ? { realTokensAfter: compactionMarker.realTokensAfter }
                      : {})}
                  />
                )}
              </div>
            );
          })}

        {isStreaming && (
          <div className="py-4 justify-self-center"><Loader /></div>
        )}

        {generatingInBackground && !pollExhausted && (
          <div className="flex items-center gap-3 py-4 px-4 mx-auto max-w-fit rounded-full bg-muted/60 text-muted-foreground text-sm">
            <Loader />
            <span>Still working on a reply…</span>
          </div>
        )}

        {generatingInBackground && pollExhausted && (
          <div className="flex items-center gap-3 py-4 px-4 mx-auto max-w-md rounded-md bg-muted/60 text-muted-foreground text-sm">
            <span>
              The reply is taking longer than expected. You can keep waiting,
              or send your message again.
            </span>
            <button
              type="button"
              onClick={() => router.refresh()}
              className="ml-auto underline underline-offset-2 hover:no-underline"
            >
              Check again
            </button>
          </div>
        )}

        {/*
          Surface AI SDK errors (network/transport, 4xx from the route,
          aborted streams). Without this, rate-limit 429s, body-size 413s,
          Origin 403s and image-validation 400s would be invisible to the
          user (architect2 SEV-1 B6).
        */}
        {error && (
          <div className="flex items-center gap-3 py-4 px-4 mx-auto max-w-md rounded-md bg-destructive/10 border border-destructive/30 text-foreground text-sm">
            <span>
              {error instanceof Error ? error.message : String(error)}
            </span>
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
});

// ---------------------------------------------------------------------------
// Inner chat page — must be inside ChatStoreProvider
// ---------------------------------------------------------------------------

const ChatPageInner = (props: ChatPageProps) => {
  const { data: session } = useSession();
  const profilePicture = useProfilePicture(session?.user?.accessToken);

  // In embed mode the EmbedFrame supplies its own compact header, so the full
  // ChatHeader (model/persona switcher, extension drawer, reset, token usage)
  // is suppressed. EmbedModeProvider only wraps the /embed routes, so this is
  // a no-op in the normal app.
  const { isEmbed } = useEmbedMode();

  // Per-thread state from Zustand (seeded from chatThread at provider mount).
  const input = useChatStore((s) => s.inputText);
  const setInputText = useChatStore((s) => s.setInputText);
  const chatThreadId = useChatStore((s) => s.threadId);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const reasoningEffort = useChatStore((s) => s.reasoningEffort);
  const setReasoningEffort = useChatStore((s) => s.setReasoningEffort);
  const attachedFiles = useChatStore((s) => s.attachedFiles);
  const removeAttachedFile = useChatStore((s) => s.removeAttachedFile);
  const { uploadButtonLabel, loading: fileLoading } = useFileStore();
  const loading: "idle" | "file upload" = fileLoading;
  const { base64Images, previewImages } = useInputImage();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // New AI SDK session — used for submit/stop/messages.
  const { sendMessage, stop, status } = useChatSession();

  const isStreaming = status === "streaming" || status === "submitted";

  const effectiveModel = selectedModel && MODEL_CONFIGS[selectedModel] ? selectedModel : DEFAULT_MODEL;

  const internetSearch = useMemo(
    () => props.extensions.find((e) => e.name === "Bing Search"),
    [props.extensions]
  );

  const handleDocumentsDeletion = async () => {
    if (props.chatDocuments.length === 0) return;
    const threadId = props.chatDocuments[0].chatThreadId;
    await SoftDeleteChatDocumentsForCurrentUser(threadId);
    RevalidateCache({ page: "chat", type: "layout" });
  };

  const fileToDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
        } else {
          reject(new Error("Unexpected file reader result"));
        }
      };
      reader.readAsDataURL(file);
    });

  const attachImageFromFile = async (file: File) => {
    const dataUrl = await fileToDataUrl(file);
    InputImageStore.AddImage(dataUrl);
  };

  const uploadFile = async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    await fileStore.onFileChange({ formData: fd, chatThreadId });
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboard = e.clipboardData;
    if (!clipboard) return;

    const hasMeaningfulText = (() => {
      const plain = clipboard.getData("text/plain");
      if (plain && plain.trim().length > 0) return true;
      const html = clipboard.getData("text/html");
      if (!html) return false;
      const textFromHtml = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      return textFromHtml.length > 0;
    })();

    const files: File[] = [];

    if (clipboard.items && clipboard.items.length > 0) {
      for (const item of Array.from(clipboard.items)) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length === 0 && clipboard.files && clipboard.files.length > 0) {
      for (const file of Array.from(clipboard.files)) {
        files.push(file);
      }
    }

    if (files.length === 0) return;

    if (hasMeaningfulText) return;

    e.preventDefault();

    const images = files.filter((f) => f.type?.startsWith("image/"));
    if (images.length > 0) {
      for (const img of images) {
        await attachImageFromFile(img);
      }
      return;
    }

    await uploadFile(files[0]);
  };

  const handleDragOver = (e: React.DragEvent<HTMLTextAreaElement>) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLTextAreaElement>) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    e.preventDefault();

    const files = Array.from(dt.files ?? []);
    if (files.length === 0) return;

    const images = files.filter((f) => f.type?.startsWith("image/"));
    if (images.length > 0) {
      for (const img of images) {
        await attachImageFromFile(img);
      }
      return;
    }

    await uploadFile(files[0]);
  };

  /**
   * Submit handler: delegates to AI SDK sendMessage instead of the old Valtio
   * legacy submit path. Images are passed as FileUIPart so the transport
   * can forward them as `image-base64` FormData fields.
   */
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;

    // Build FileUIPart[] from base64 images stored in InputImageStore.
    const fileParts: FileUIPart[] = base64Images
      .filter(Boolean)
      .map((url) => ({ type: "file", url, mediaType: "image/*" }));

    setInputText("");
    InputImageStore.Reset();

    sendMessage({ text, files: fileParts.length > 0 ? fileParts : undefined });
  };

  return (
    <main className="flex flex-1 relative flex-col px-3 gap-3 overflow-hidden">
      {!isEmbed && (
        <ChatHeader
          chatThread={props.chatThread}
          chatDocuments={props.chatDocuments}
          extensions={props.extensions}
        />
      )}

      <ChatMessages
        profilePicture={profilePicture}
        compactionMarker={props.compactionMarker}
      />

      <div className="sticky bottom-3 max-w-4xl mx-auto w-full">
        {/* Fade gradient above input to indicate scrollable content */}
        <div className="pointer-events-none h-8 -mb-0 bg-gradient-to-t from-background to-transparent -translate-y-full" />
        <PromptInput onSubmit={handleSubmit}>
          {/* Attachments preview */}
          {previewImages.length > 0 && (
            <div className="flex flex-wrap gap-2 m-2">
              {previewImages.map((img, idx) => (
                <div key={idx} className="relative overflow-hidden rounded-md w-[60px] h-[60px] border">
                  <Image src={img} alt={`Preview ${idx + 1}`} fill={true} className="object-cover" />
                  <button
                    className="absolute right-1 top-1 bg-background/80 rounded-full p-1 hover:bg-background"
                    onClick={() => InputImageStore.RemoveImage(idx)}
                    type="button"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Attached Files (Code Interpreter files) */}
          {attachedFiles.filter((f) => f.type === "code-interpreter").length > 0 && (
            <div className="flex flex-wrap gap-2 p-2">
              {attachedFiles
                .filter((f) => f.type === "code-interpreter")
                .map((file) => (
                  <div
                    key={file.id}
                    className="relative group flex items-center gap-2 bg-muted border rounded-lg px-3 py-2 pr-8"
                  >
                    <FileSpreadsheet className="h-4 w-4 text-green-600" />
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm font-medium truncate max-w-[150px]" title={file.name}>
                        {file.name}
                      </span>
                      <span className="text-xs text-muted-foreground">Code Interpreter</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-background border shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={async () => {
                        removeAttachedFile(file.id);
                        await RemoveAttachedFile(chatThreadId, file.id);
                      }}
                      type="button"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
            </div>
          )}

          {props.chatDocuments.length > 0 && (
            <div className="flex flex-wrap gap-2 p-2">
              {props.chatDocuments.map((doc, i) => (
                <div
                  key={i}
                  className="px-2 py-1 gap-2 rounded border bg-background text-xs flex items-center h-7"
                >
                  <File size={12} />
                  <span className="truncate max-w-[200px]">{doc.name}</span>
                </div>
              ))}
              <Button
                variant="outline"
                size="icon"
                className="h-7"
                onClick={handleDocumentsDeletion}
                type="button"
              >
                <Trash2 size={12} />
              </Button>
            </div>
          )}

          <PromptInputTextarea
            value={input}
            onChange={(e) => setInputText(e.currentTarget.value)}
            placeholder="Type your message..."
            onPaste={handlePaste}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          />
          <PromptInputToolbar>
            <PromptInputTools className="pl-2">
              {internetSearch && (
                <InternetSearch
                  extension={internetSearch}
                  threadExtensions={props.chatThread.extension || []}
                />
              )}
              <PromptInputButton
                aria-label="Upload file"
                onClick={() => fileInputRef.current?.click()}
                disabled={loading === "file upload"}
              >
                <Paperclip className="size-4" />
                {uploadButtonLabel ? (
                  <span className="truncate max-w-[140px]">
                    {uploadButtonLabel.length > 18
                      ? uploadButtonLabel.slice(0, 15) + "…"
                      : uploadButtonLabel}
                  </span>
                ) : (
                  "File"
                )}
              </PromptInputButton>
              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const fd = new FormData();
                  fd.append("file", file);
                  await fileStore.onFileChange({ formData: fd, chatThreadId });
                  e.target.value = "";
                }}
              />
              <ToolToggles />
              <ReasoningEffortSelector
                value={reasoningEffort}
                onChange={async (effort) => {
                  setReasoningEffort(effort);
                  try {
                    await UpdateChatThreadReasoningEffort(chatThreadId, effort);
                  } catch (err) {
                    showError("Failed to save reasoning effort: " + err);
                  }
                }}
                disabled={isStreaming}
                showReasoningModelsOnly={MODEL_CONFIGS[effectiveModel]?.supportsReasoning}
                modelId={effectiveModel}
              />
              <PromptInputModelSelect
                value={effectiveModel}
                onValueChange={async (v) => {
                  const model = v as typeof effectiveModel;
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
                }}
              >
                <PromptInputModelSelectTrigger className="h-8 px-2 text-xs">
                  <PromptInputModelSelectValue placeholder="Model" />
                </PromptInputModelSelectTrigger>
                <PromptInputModelSelectContent>
                  {(Object.keys(MODEL_CONFIGS) as Array<keyof typeof MODEL_CONFIGS>).map((m) => (
                    <PromptInputModelSelectItem key={m} value={m}>
                      {MODEL_CONFIGS[m].name}
                    </PromptInputModelSelectItem>
                  ))}
                </PromptInputModelSelectContent>
              </PromptInputModelSelect>
            </PromptInputTools>
            <div className="flex items-center gap-2 pr-2">
              {isStreaming ? (
                <PromptInputSubmit
                  status="streaming"
                  aria-label="Stop generating"
                  onClick={(e) => {
                    e.preventDefault();
                    // Fire-and-forget: ask the server to abort the
                    // upstream streamText (so we stop burning tokens
                    // and the partial assistant turn lands in Cosmos
                    // via onAbort/onFinish). Then disconnect locally.
                    // The button is idempotent — a second click while
                    // the abort is unwinding returns 200 from the
                    // server with aborted=false.
                    void fetch(`/api/chat/${chatThreadId}/stop`, {
                      method: "POST",
                    });
                    stop();
                  }}
                />
              ) : (
                <PromptInputSubmit status="ready" />
              )}
            </div>
          </PromptInputToolbar>
        </PromptInput>
      </div>
    </main>
  );
};

// ---------------------------------------------------------------------------
// Public component — wraps inner page in ChatStoreProvider
// ---------------------------------------------------------------------------

export const ChatPage = (props: ChatPageProps) => {
  // Convert Cosmos messages to UIMessages for the AI SDK initial state.
  // IMPORTANT: depend on `props.messages` itself, not just the thread id —
  // when router.refresh() picks up a background-persisted assistant turn,
  // props.messages is a fresh array. Memoising on id alone would return
  // the stale cached UIMessage[] and the "Generating in background…"
  // pill would stay up forever.
  const initialAiMessages = useMemo(
    () => uiMessagesFromChatMessages(props.messages),
    [props.messages]
  );

  return (
    <ChatStoreProvider
      key={props.chatThread.id}
      threadId={props.chatThread.id}
      chatThread={props.chatThread}
      initialAiMessages={initialAiMessages}
    >
      <ChatPageInner {...props} />
    </ChatStoreProvider>
  );
};
