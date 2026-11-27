import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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

/** jsdom's File has no text(). */
const readText = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(file, "utf-8");
  });

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

  it("Copilot path: a paste over the limit becomes a text file upload with a chip, a small paste stays text", async () => {
    const { UploadFileToAgentWorkspace } = await import(
      "@/features/chat-page/chat-services/copilot-runtime/workspace-upload-actions"
    );
    const upload = vi.mocked(UploadFileToAgentWorkspace);
    upload.mockImplementation(async (fd: FormData) => {
      const file = fd.get("file") as File;
      return {
        status: "OK",
        response: { handled: true, path: `/workspace/uploads/${file.name}`, size: file.size, modified: "2026-01-01T00:00:00.000Z" },
      };
    });
    render(<ChatPage {...pageProps} workspace={{ uploads: [], fileCount: 0, pastedTextLimitBytes: 100 }} />);
    const input = screen.getByPlaceholderText("Type your message...");
    const clipboard = (text: string) => ({ getData: (t: string) => (t === "text/plain" ? text : ""), items: [], files: [] });

    // At the limit: the browser pastes it as text.
    expect(fireEvent.paste(input, { clipboardData: clipboard("a".repeat(100)) })).toBe(true);
    expect(upload).not.toHaveBeenCalled();

    // Over the limit: no text paste, the same upload as a picked .txt file.
    const big = "ä".repeat(51);
    expect(fireEvent.paste(input, { clipboardData: clipboard(big) })).toBe(false);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const file = upload.mock.calls[0][0].get("file") as File;
    expect(file.name).toMatch(/^pasted-text-\d{8}-\d{6}\.txt$/);
    expect(await readText(file)).toBe(big);
    expect(upload.mock.calls[0][0].get("id")).toBe("thread1");
    await waitFor(() => expect(screen.getByTestId("workspace-upload-chips")).toHaveTextContent(file.name));
    expect(input).toHaveValue("");
  });

  it("AI SDK path: a big paste stays text", () => {
    render(<ChatPage {...pageProps} workspace={null} />);
    const input = screen.getByPlaceholderText("Type your message...");
    const clipboardData = { getData: (t: string) => (t === "text/plain" ? "a".repeat(100_000) : ""), items: [], files: [] };
    expect(fireEvent.paste(input, { clipboardData })).toBe(true);
  });

  it("AI SDK path: no chips and no Files button", () => {
    render(<ChatPage {...pageProps} workspace={null} />);
    expect(screen.queryByTestId("workspace-upload-chips")).toBeNull();
    expect(screen.queryByRole("button", { name: "Files of this chat" })).toBeNull();
    expect(screen.getByRole("button", { name: "Upload file" })).toBeInTheDocument();
  });

  it("Copilot path: the Web and Code toggles start as the server's defaults", () => {
    render(
      <ChatPage
        {...pageProps}
        workspace={{ uploads: [], fileCount: 0, webSearchDefault: true, runCodeDefault: true }}
      />,
    );
    expect(screen.getByRole("button", { name: "Web search" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Code interpreter" })).toHaveAttribute("aria-pressed", "true");
    // Image generation keeps its own default (no change).
    expect(screen.getByRole("button", { name: "Image generation" })).toBeInTheDocument();
  });

  it("AI SDK path: the Web and Code toggles start off", () => {
    render(<ChatPage {...pageProps} workspace={null} />);
    expect(screen.getByRole("button", { name: "Web search" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Code interpreter" })).toHaveAttribute("aria-pressed", "false");
  });
});
