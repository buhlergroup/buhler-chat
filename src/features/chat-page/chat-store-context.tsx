"use client";
/**
 * chat-store-context.tsx
 *
 * React context that pairs a per-tab Zustand store (createChatStore) with the
 * @ai-sdk/react useChat hook so every browser tab gets an independent store and
 * an independent AbortController.
 *
 * Mount at the route level with a stable `key` prop to ensure full isolation:
 *   <ChatStoreProvider key={threadId} threadId={threadId} ...>
 *
 * Transport: DefaultChatTransport with a custom fetch that converts the JSON
 * body into FormData matching the /api/chat route contract:
 *   - `content`: JSON.stringify({ id, message, selectedModel, ... })
 *   - `image-base64`: repeated fields for each base64 image
 *
 * Task 12 will delete the Valtio singleton in chat-store.tsx.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import { useChat as useAiSdkChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import {
  createChatStore,
  type ChatStore,
  type ChatStoreState,
} from "./chat-store-factory";
import { setActiveChatStore } from "./active-chat-store";
import type { ChatModel, ChatThreadModel, ReasoningEffort } from "./chat-services/models";
import type { ChatMessageMetadata } from "./chat-services/chat-api/usage-data";
import { notifyUsageChanged } from "@/features/main-menu/usage-events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The streaming interface exposed via context — a thin subset of what
 * @ai-sdk/react useChat returns. Consumers should call `sendMessage` and `stop`
 * through here rather than reaching for the AI SDK directly.
 */
export interface ChatContextValue {
  /** Zustand store instance — use `useChatStore` hook for reactive reads. */
  store: ChatStore;
  /** Live AI SDK messages (reactive, from @ai-sdk/react). */
  messages: ReturnType<typeof useAiSdkChat>["messages"];
  /** Streaming status from @ai-sdk/react. */
  status: ReturnType<typeof useAiSdkChat>["status"];
  /**
   * Submit a new user message. Automatically stops any in-flight stream first
   * (preserving the "new submit aborts in-flight" semantic from the Valtio era).
   */
  sendMessage: ReturnType<typeof useAiSdkChat>["sendMessage"];
  /** Abort the current stream. */
  stop: ReturnType<typeof useAiSdkChat>["stop"];
  /** Propagate an error upward (e.g., from onError callback). */
  error: ReturnType<typeof useAiSdkChat>["error"];
  /** Set messages (used to pre-load from Cosmos history). */
  setMessages: ReturnType<typeof useAiSdkChat>["setMessages"];
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ChatContext = createContext<ChatContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ChatStoreProviderProps {
  threadId: string;
  /**
   * Pre-loaded history in AI SDK UIMessage format for the useChat hook.
   * Derived from the Cosmos messages via uiMessagesFromChatMessages.
   */
  initialAiMessages?: UIMessage[];
  userName?: string;
  chatThread?: ChatThreadModel;
  /** The Web / Code toggles' defaults (WorkspaceSummary); read once, when the store is made. */
  webSearchDefault?: boolean;
  runCodeDefault?: boolean;
  children: ReactNode;
}

/**
 * Extra fields injected into the transport body via prepareSendMessagesRequest.
 * The custom fetch handler reads them from the JSON body and builds FormData.
 */
interface TransportBodyExtras {
  /** Thread ID required by UserPrompt.id */
  _threadId: string;
  /** User message text */
  _message: string;
  selectedModel: ChatModel | undefined;
  reasoningEffort: ReasoningEffort | undefined;
  webSearchEnabled: boolean;
  imageGenerationEnabled: boolean;
  companyContentEnabled: boolean;
  codeInterpreterEnabled: boolean;
  codeInterpreterFileIds: string[];
  /** Base64 data URLs for images, collected from the AI SDK message parts */
  _images: string[];
}

/**
 * Formats a Date as ISO 8601 with the browser's local UTC offset
 * (e.g. "2026-05-29T19:40:00.123+02:00"). Unlike Date#toISOString (always UTC,
 * "Z"-suffixed), this preserves the user's local time + offset, sent via the
 * `x-client-datetime` header for the get_current_time tool.
 */
function localISOWithOffset(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMin = -d.getTimezoneOffset(); // positive east of UTC
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${String(d.getMilliseconds()).padStart(3, "0")}` +
    offset
  );
}

export function ChatStoreProvider({
  threadId,
  initialAiMessages,
  userName,
  chatThread,
  webSearchDefault,
  runCodeDefault,
  children,
}: ChatStoreProviderProps) {
  // Lazily create the store once per mount (React key handles resets).
  const storeRef = useRef<ChatStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createChatStore({
      threadId,
      userName,
      chatThread,
      webSearchDefault,
      runCodeDefault,
    });
  }
  const store = storeRef.current;

  /**
   * Custom fetch intercepts the DefaultChatTransport's JSON POST and rebuilds
   * it as FormData matching the /api/chat route contract.
   */
  const customFetch = useCallback<typeof globalThis.fetch>(
    async (input, init): Promise<Response> => {
      // DefaultChatTransport routes the reconnect GET
      // (prepareReconnectToStreamRequest → /api/chat/[id]/stream)
      // through this same fetch. GET requests can't carry a body, so
      // anything other than the JSON-bodied submit POST passes through
      // unchanged — without this short-circuit the browser throws
      // "Request with GET/HEAD method cannot have body" and the
      // reattach round-trip never reaches the server.
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "POST") {
        return fetch(input, init);
      }

      // The transport always JSON.stringify(body) — unwrap it.
      const rawBody =
        typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? {});

      const extras = rawBody as Partial<TransportBodyExtras>;

      const formData = new FormData();

      // Build the `content` JSON field the route expects.
      const content = JSON.stringify({
        id: extras._threadId ?? threadId,
        message: extras._message ?? "",
        selectedModel: extras.selectedModel,
        reasoningEffort: extras.reasoningEffort,
        webSearchEnabled: extras.webSearchEnabled ?? false,
        imageGenerationEnabled: extras.imageGenerationEnabled ?? false,
        companyContentEnabled: extras.companyContentEnabled ?? false,
        codeInterpreterEnabled: extras.codeInterpreterEnabled ?? false,
        codeInterpreterFileIds: extras.codeInterpreterFileIds ?? [],
      });
      formData.append("content", content);

      // Append images as repeated `image-base64` fields.
      for (const img of extras._images ?? []) {
        if (img && typeof img === "string") {
          formData.append("image-base64", img);
        }
      }

      // Strip Content-Type so the browser sets the correct multipart
      // boundary header itself. `Headers` handles all three HeadersInit
      // shapes (plain object, array of pairs, Headers instance) without
      // the cast the destructure form needed.
      const headers = new Headers(init?.headers);
      headers.delete("Content-Type");
      headers.delete("content-type");
      // The user's local datetime (ISO 8601 with UTC offset) so the server's
      // get_current_time tool can answer in their timezone, not the server's.
      headers.set("x-client-datetime", localISOWithOffset(new Date()));

      return fetch(input, {
        ...init,
        headers,
        body: formData,
      });
    },
    [threadId]
  );

  // Bind @ai-sdk/react useChat to this thread with the FormData transport.
  // Memo the transport so React doesn't replace it on every render — a fresh
  // transport instance resets the SDK's internal request state and triggers
  // "Cannot read properties of undefined (reading 'state')" inside sendMessage.
  const transport = useMemo(() => new DefaultChatTransport({
      api: "/api/chat",
      fetch: customFetch,
      // Reattach endpoint for useChat({ resume: true }) — keyed by
      // threadId so the client always knows where to ask. The server
      // returns 204 when there's no active publisher on the replica
      // (see /api/chat/[id]/stream/route.ts), at which point the SDK
      // renders the persisted messages and stops trying.
      prepareReconnectToStreamRequest: ({ id }) => ({
        api: `/api/chat/${id}/stream`,
        credentials: "include",
      }),
      prepareSendMessagesRequest: ({ messages, body, id }) => {
        // Extract the user message text from the last user message's text parts.
        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
        const messageText = lastUserMsg
          ? lastUserMsg.parts
              .filter((p) => p.type === "text")
              .map((p) => (p as { type: "text"; text: string }).text)
              .join("")
          : "";

        // Collect images from the last user message's file parts.
        const images = lastUserMsg
          ? lastUserMsg.parts
              .filter((p) => p.type === "file")
              .map((p) => (p as { type: "file"; url?: string }).url ?? "")
              .filter(Boolean)
          : [];

        // Read current store state at call time.
        const s = store.getState();

        const extras: TransportBodyExtras = {
          _threadId: id,
          _message: messageText,
          selectedModel: s.selectedModel,
          reasoningEffort: s.reasoningEffort,
          webSearchEnabled: s.webSearchEnabled,
          imageGenerationEnabled: s.imageGenerationEnabled,
          companyContentEnabled: s.companyContentEnabled,
          codeInterpreterEnabled: s.codeInterpreterEnabled,
          codeInterpreterFileIds: s.getCodeInterpreterFileIds(),
          _images: images,
        };

        return {
          body: { ...body, ...extras },
        };
      },
    }), [customFetch, threadId]);

  const chat = useAiSdkChat({
    id: threadId,
    messages: initialAiMessages,
    transport,
    // Batch streamed UI updates (~16 fps) instead of re-rendering on every
    // token. Fast streaming of large content (e.g. a generative-UI spec) drove
    // the auto-scroll Conversation into a resize→scroll→resize feedback loop
    // ("Maximum update depth"); throttling collapses the storm of updates.
    experimental_throttle: 60,
    // resume: true tells the SDK to call prepareReconnectToStreamRequest
    // on mount (i.e., whenever the user navigates back to this thread
    // while a stream is still in flight). The server replies 204 when
    // there's nothing to resume, so this is cheap-and-safe to leave on.
    resume: true,
    // Live token-usage: the route attaches the turn's usage to the assistant
    // message metadata (see toUIMessageStreamResponse messageMetadata). Feed
    // it into the store so the header updates every turn without a reload.
    // Thread running totals are accumulated client-side here (the per-request
    // block carries only this turn); a reload reconciles from persisted usage.
    onFinish: ({ message }) => {
      notifyUsageChanged();
      const usage = (message.metadata as ChatMessageMetadata | undefined)?.usage;
      if (!usage) return;
      const s = store.getState();
      const prev = s.lastUsageData;
      s.setUsageData({
        ...usage,
        threadTotalTokens: (prev?.threadTotalTokens ?? 0) + usage.totalTokens,
        threadTotalCostUsd: (prev?.threadTotalCostUsd ?? 0) + usage.costUsd,
      });
    },
  });

  /**
   * Wraps sendMessage so that any in-flight stream is stopped before a new one
   * starts. This preserves the abort-on-new-submit behaviour from the Valtio era
   * and ensures per-tab isolation (each tab has its own `chat` instance).
   */
  const sendMessage = useCallback<typeof chat.sendMessage>(
    (...args) => {
      chat.stop();
      return chat.sendMessage(...args);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chat.sendMessage, chat.stop]
  );

  // NOTE: do NOT call chat.stop() on unmount. When the user navigates to a
  // different thread mid-stream, we want the original request to keep
  // running so the assistant message lands in Cosmos via onFinish (the
  // route calls result.consumeStream() to guarantee this). Returning to
  // the original thread shows the persisted assistant message.

  // Bridge: while sub-components still write to the Valtio singleton
  // (file picker → attachedFiles, model picker → selectedModel, reasoning
  // selector → reasoningEffort), the transport reads from the per-thread
  // Zustand store at submit time. Without this mirror those writes are
  // invisible to the transport — most acutely: a user uploads a Code
  // Interpreter file (Valtio) then hits send, and the API call goes out
  // without the file id. Mirror the relevant fields here until task 12
  // finishes porting every consumer to Zustand.
  // Register this provider's store as the active one so module-singleton
  // consumers (file-store.ts, speech, input prompt) can write to it
  // directly — synchronously, before any submit reads from it. This
  // replaces the previous Valtio-subscribe bridge whose async diff-fire
  // ordering allowed a "user uploads file + clicks Send in same React
  // batch" race to drop the file id (architect2 SEV-1 B3).
  useEffect(() => {
    setActiveChatStore(store);
    return () => {
      setActiveChatStore(null);
    };
  }, [store]);

  // Sync fresh server-side messages into useChat when the route's
  // server-component re-renders (router.refresh() during background
  // generation). useChat only honors `initialMessages` at mount per `id`,
  // so without this sync the "Generating in background…" indicator stays
  // up until the user hard-refreshes. Skip while actively streaming to
  // avoid clobbering tokens that haven't been persisted yet.
  const initialMessagesRef = useRef(initialAiMessages);
  useEffect(() => {
    if (initialAiMessages === initialMessagesRef.current) return;
    initialMessagesRef.current = initialAiMessages;
    if (!initialAiMessages) return;
    if (chat.status === "streaming" || chat.status === "submitted") return;
    chat.setMessages(initialAiMessages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAiMessages, chat.status, chat.setMessages]);

  const value: ChatContextValue = {
    store,
    messages: chat.messages,
    status: chat.status,
    sendMessage,
    stop: chat.stop,
    error: chat.error,
    setMessages: chat.setMessages,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used inside <ChatStoreProvider>");
  }
  return ctx;
}

/**
 * Reactive selector over the Zustand store state.
 *
 * @example
 *   const model = useChatStore(s => s.selectedModel);
 */
export function useChatStore<T>(selector: (s: ChatStoreState) => T): T {
  const { store } = useChatContext();
  return useStore(store, selector);
}

/**
 * Returns the streaming interface: `{ messages, status, sendMessage, stop, error, setMessages }`.
 *
 * Named `useChatSession` to avoid shadowing the @ai-sdk/react `useChat` import
 * in files that need both.
 */
export function useChatSession(): Omit<ChatContextValue, "store"> {
  const { store: _store, ...rest } = useChatContext();
  return rest;
}
