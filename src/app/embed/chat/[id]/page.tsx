import { userSession } from "@/features/auth-page/helpers";
import { ChatPage } from "@/features/chat-page/chat-page";
import { FindAllChatDocuments } from "@/features/chat-page/chat-services/chat-document-service";
import { FindAllChatMessagesForCurrentUser } from "@/features/chat-page/chat-services/chat-message-service";
import { FindChatThreadForCurrentUser } from "@/features/chat-page/chat-services/chat-thread-service";
import { FindChatHistorySummary } from "@/features/chat-page/chat-services/chat-api/history-summary-service";
import { threadCompactionMarker } from "@/features/chat-page/chat-services/chat-api/compaction-part";
import { EmbedFrame } from "@/features/embed/embed-frame";
import { EmbedSignIn } from "@/features/embed/embed-sign-in";
import { FindAllExtensionForCurrentUserAndIds } from "@/features/extensions-page/extension-services/extension-service";
import { AI_NAME } from "@/features/theme/theme-config";
import { DisplayError } from "@/features/ui/error/display-error";

export const metadata = {
  title: AI_NAME,
  description: AI_NAME,
};

// Match the full-app chat route: always re-render so a background-persisted
// assistant turn shows up immediately.
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface EmbedChatParams {
  params: Promise<{ id: string }>;
}

/**
 * Embedded chat view. Reuses the exact data-fetching of the full-app
 * /chat/[id] route so behaviour stays identical, wraps <ChatPage /> in an
 * EmbedFrame (compact header + "Open in full app"), and relies on the
 * EmbedModeProvider in app/embed/layout.tsx to strip non-essential chrome.
 */
export default async function EmbedChat(props: EmbedChatParams) {
  const { id } = await props.params;

  const user = await userSession();
  if (!user) {
    return <EmbedSignIn />;
  }

  // Same reads as /chat/[id], including the compaction row: an embedded
  // thread is trimmed by the same budget, so it needs the same divider.
  const [chatResponse, chatThreadResponse, docsResponse, historySummary] =
    await Promise.all([
      FindAllChatMessagesForCurrentUser(id),
      FindChatThreadForCurrentUser(id),
      FindAllChatDocuments(id),
      FindChatHistorySummary(id),
    ]);

  if (docsResponse.status !== "OK") {
    return <DisplayError errors={docsResponse.errors} />;
  }

  if (chatResponse.status !== "OK") {
    return <DisplayError errors={chatResponse.errors} />;
  }

  if (chatThreadResponse.status !== "OK") {
    return <DisplayError errors={chatThreadResponse.errors} />;
  }

  const extensionResponse = await FindAllExtensionForCurrentUserAndIds(
    chatThreadResponse.response.extension
  );

  if (extensionResponse.status !== "OK") {
    return <DisplayError errors={extensionResponse.errors} />;
  }

  return (
    <EmbedFrame
      title={chatThreadResponse.response.name || AI_NAME}
      fullAppHref={`/chat/${id}`}
    >
      <ChatPage
        messages={chatResponse.response}
        chatThread={chatThreadResponse.response}
        chatDocuments={docsResponse.response}
        extensions={extensionResponse.response}
        compactionMarker={threadCompactionMarker(historySummary)}
      />
    </EmbedFrame>
  );
}
