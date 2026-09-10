import { ChatPage } from "@/features/chat-page/chat-page";
import { FindAllChatDocuments } from "@/features/chat-page/chat-services/chat-document-service";
import { FindAllChatMessagesForCurrentUser } from "@/features/chat-page/chat-services/chat-message-service";
import { FindChatThreadForCurrentUser } from "@/features/chat-page/chat-services/chat-thread-service";
import { FindChatHistorySummary } from "@/features/chat-page/chat-services/chat-api/history-summary-service";
import { threadCompactionMarker } from "@/features/chat-page/chat-services/chat-api/compaction-part";
import { FindAllExtensionForCurrentUserAndIds } from "@/features/extensions-page/extension-services/extension-service";
import { AI_NAME } from "@/features/theme/theme-config";
import { DisplayError } from "@/features/ui/error/display-error";

export const metadata = {
  title: AI_NAME,
  description: AI_NAME,
};

// Always re-render this route on each request so a thread whose background
// generation just persisted shows its new assistant message immediately,
// without waiting for the Next.js client-router cache to expire.
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface HomeParams {
  params: Promise<{
    id: string;
  }>;
}

export default async function Home(props: HomeParams) {
  const { id } = await props.params;
  // The compaction row rides along with the transcript reads: one
  // type-filtered query, and it fails soft (null) rather than blocking the
  // thread. It marks where the conversation the model sees begins, so the
  // divider survives a reload without a message row of its own. Display only
  // -- the prompt's own copy of the summary is assembled in thread-context.ts.
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
    <ChatPage
      messages={chatResponse.response}
      chatThread={chatThreadResponse.response}
      chatDocuments={docsResponse.response}
      extensions={extensionResponse.response}
      compactionMarker={threadCompactionMarker(historySummary)}
    />
  );
}
