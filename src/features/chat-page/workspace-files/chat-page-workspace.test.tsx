import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// The real ChatPage, with what needs a browser session or the network mocked.
vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn(() => ({ messages: [], status: "ready", sendMessage: vi.fn(), stop: vi.fn(), error: undefined })),
}));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null, status: "unauthenticated" }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/chat/thread1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/features/common/hooks/useProfilePicture", () => ({ useProfilePicture: () => undefined }));
vi.mock("@/features/chat-page/chat-header/chat-header", () => ({ ChatHeader: () => null }));
vi.mock("@/features/chat-page/chat-services/chat-thread-service", () => ({
  UpdateChatThreadSelectedModel: vi.fn(),
  UpdateChatThreadReasoningEffort: vi.fn(),
  RemoveAttachedFile: vi.fn(),
  SoftDeleteChatDocumentsForCurrentUser: vi.fn(),
}));
vi.mock("@/features/common/navigation-helpers", () => ({ RevalidateCache: vi.fn() }));
vi.mock("@/features/chat-page/chat-services/copilot-runtime/workspace-upload-actions", () => ({
  UploadFileToAgentWorkspace: vi.fn(),
  RemoveWorkspaceFile: vi.fn(),
  ListWorkspaceFiles: vi.fn(),
}));
vi.mock("@/features/chat-page/chat-services/chat-document-service", () => ({ UploadChatDocument: vi.fn() }));
vi.mock("@/features/chat-page/chat-services/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/chat-page/chat-services/models")>();
  return {
    ...actual,
    getModelAvailability: vi.fn(() => new Promise(() => undefined)),
  };
});

import { ChatPage } from "../chat-page";
import type { ChatThreadModel } from "../chat-services/models";
import { DEFAULT_MODEL } from "../chat-services/models";

const thread = {
  id: "thread1",
  name: "t",
  createdAt: new Date(),
  lastMessageAt: new Date(),
  userId: "u1",
  useName: "u1",
  isDeleted: false,
  bookmarked: false,
  personaMessage: "",
  personaMessageTitle: "",
  extension: [],
  type: "CHAT_THREAD",
} as ChatThreadModel;

const pageProps = {
  messages: [],
  chatThread: thread,
  chatDocuments: [],
  extensions: [],
  defaultModel: DEFAULT_MODEL,
};

describe("ChatPage: chat workspace chips and Files panel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Copilot path: renders the upload chips from the server list and the Files button", () => {
    render(
      <ChatPage
        {...pageProps}
        workspace={{
          uploads: [{ path: "uploads/plan.docx", name: "plan.docx", size: 10, modified: "2026-01-01T00:00:00.000Z", group: "uploaded" }],
          fileCount: 4,
        }}
      />,
    );
    expect(screen.getByTestId("workspace-upload-chips")).toHaveTextContent("plan.docxUploaded");
    expect(screen.getByRole("button", { name: "Files of this chat" })).toHaveTextContent("Files (4)");
  });

  it("AI SDK path: no chips and no Files button", () => {
    render(<ChatPage {...pageProps} workspace={null} />);
    expect(screen.queryByTestId("workspace-upload-chips")).toBeNull();
    expect(screen.queryByRole("button", { name: "Files of this chat" })).toBeNull();
    expect(screen.getByRole("button", { name: "Upload file" })).toBeInTheDocument();
  });
});
