import { userHashedId } from "@/features/auth-page/helpers";
import { TemporaryChatPage } from "@/features/chat-page/temporary-chat-page";
import { DEFAULT_MODEL } from "@/features/chat-page/chat-services/models";
import { FindAllChatDocuments } from "@/features/chat-page/chat-services/chat-document-service";
import { FindAllChatMessagesForCurrentUser } from "@/features/chat-page/chat-services/chat-message-service";
import {
  CreateChatThread,
  FindChatThreadForCurrentUser,
} from "@/features/chat-page/chat-services/chat-thread-service";
import { FindAllExtensionForCurrentUserAndIds } from "@/features/extensions-page/extension-services/extension-service";
import { AI_NAME, TEMPORARY_CHAT_NAME } from "@/features/theme/theme-config";
import { DisplayError } from "@/features/ui/error/display-error";

export const metadata = {
  title: AI_NAME,
  description: AI_NAME,
};

interface HomeParams {
  params: Promise<{
    id: string;
  }>;
}

export default async function Home(props: HomeParams) {
  const userIdAsChatThreadId = await userHashedId();
  let [chatResponse, chatThreadResponse, docsResponse] = await Promise.all([
    FindAllChatMessagesForCurrentUser(userIdAsChatThreadId),
    FindChatThreadForCurrentUser(userIdAsChatThreadId),
    FindAllChatDocuments(userIdAsChatThreadId),
  ]);

  // Do not reset the thread here. This render runs again on every
  // router.refresh() and on every server action that revalidates the chat
  // layout, also after the first turn; a reset here deleted the conversation
  // the user was reading. TemporaryChatPage resets once, when the page mounts.
  if (chatThreadResponse.status === "NOT_FOUND") {
    chatThreadResponse = await CreateChatThread({ name: TEMPORARY_CHAT_NAME, temporary: true });
  }

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
    <TemporaryChatPage
      resetOnEntry={chatResponse.response.length > 0}
      messages={chatResponse.response}
      chatThread={chatThreadResponse.response}
      chatDocuments={docsResponse.response}
      extensions={extensionResponse.response}
      defaultModel={DEFAULT_MODEL}
    />
  );
}
