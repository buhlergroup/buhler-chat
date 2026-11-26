"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Loader } from "@/components/ai-elements/loader";
import { DisplayError } from "@/features/ui/error/display-error";
import { ChatPage } from "./chat-page";
import { ResetChatThread } from "./chat-services/chat-thread-service";
import type { ChatDocumentModel, ChatMessageModel } from "./chat-services/models";

type TemporaryChatPageProps = ComponentProps<typeof ChatPage> & {
  /**
   * True when the server found content from an earlier visit in the user's
   * temporary thread. It is read once, when the page mounts.
   */
  resetOnEntry: boolean;
};

const NO_MESSAGES: ChatMessageModel[] = [];
const NO_DOCUMENTS: ChatDocumentModel[] = [];
const NO_WORKSPACE = { uploads: [], fileCount: 0 };

/**
 * The temporary chat starts empty each time the user enters the page.
 *
 * The reset runs here, once per mount, and not in the server page. The server
 * page renders again on every router.refresh() (the title refresh after the
 * first turn, the background-generation poll) and after server actions that
 * revalidate a chat path. A reset in the server render wiped
 * the conversation the user was reading at each of those refreshes.
 */
export const TemporaryChatPage = (props: TemporaryChatPageProps) => {
  const { resetOnEntry, ...pageProps } = props;
  const threadId = pageProps.chatThread.id;

  // The server props of the first render still hold the earlier visit's
  // content. Until a later server render replaces them, show an empty chat.
  // Messages and documents come from the same server render, so the messages
  // array identity tells whether the props are still the entry render's.
  const entryMessages = useRef(pageProps.messages);
  const [state, setState] = useState<"resetting" | "ready" | "error">(() =>
    resetOnEntry ? "resetting" : "ready",
  );
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!resetOnEntry) return;
    let cancelled = false;
    ResetChatThread(threadId)
      .then((response) => {
        if (cancelled) return;
        if (response.status === "OK") {
          setState("ready");
        } else {
          setErrorMessage(response.errors[0]?.message ?? "Could not start a temporary chat.");
          setState("error");
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setState("error");
      });
    return () => {
      cancelled = true;
    };
    // Once per mount: a later server render with resetOnEntry=true is the
    // conversation of this visit, not content to delete.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === "error") {
    return <DisplayError errors={[{ message: errorMessage }]} />;
  }

  if (state === "resetting") {
    return (
      <div className="flex flex-1 items-center justify-center" aria-busy="true">
        <Loader />
      </div>
    );
  }

  const showsEntryContent =
    resetOnEntry && pageProps.messages === entryMessages.current;

  return (
    <ChatPage
      {...pageProps}
      messages={showsEntryContent ? NO_MESSAGES : pageProps.messages}
      chatDocuments={showsEntryContent ? NO_DOCUMENTS : pageProps.chatDocuments}
      workspace={showsEntryContent && pageProps.workspace ? NO_WORKSPACE : pageProps.workspace}
    />
  );
};
