import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { mockResetChatThread } = vi.hoisted(() => ({
  mockResetChatThread: vi.fn(),
}));

vi.mock("./chat-services/chat-thread-service", () => ({
  ResetChatThread: mockResetChatThread,
}));

// The real ChatPage needs the chat store, the AI SDK and a session. These
// tests only check what the temporary page hands to it.
vi.mock("./chat-page", () => ({
  ChatPage: (props: { messages: unknown[]; chatDocuments: unknown[]; workspace?: unknown }) => (
    <div data-testid="chat-page" data-workspace={JSON.stringify(props.workspace ?? null)}>
      {props.messages.length} messages, {props.chatDocuments.length} documents
    </div>
  ),
}));

import { TemporaryChatPage } from "./temporary-chat-page";

const thread = { id: "temp-thread", isTemporary: true } as never;

const pageProps = (messages: unknown[], chatDocuments: unknown[] = []) => ({
  chatThread: thread,
  messages: messages as never[],
  chatDocuments: chatDocuments as never[],
  extensions: [],
  defaultModel: "gpt-5.5" as never,
});

describe("chat-page.unit.components — TemporaryChatPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResetChatThread.mockResolvedValue({ status: "OK", response: thread });
  });

  it("deletes content of an earlier visit once on entry and shows an empty chat", async () => {
    render(
      <TemporaryChatPage
        resetOnEntry
        {...pageProps([{ id: "old-1" }, { id: "old-2" }], [{ id: "old-doc" }])}
      />,
    );

    expect(screen.queryByTestId("chat-page")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("chat-page")).toHaveTextContent("0 messages, 0 documents"),
    );
    expect(mockResetChatThread).toHaveBeenCalledTimes(1);
    expect(mockResetChatThread).toHaveBeenCalledWith("temp-thread");
  });

  it("keeps the conversation of this visit when the server page renders again", async () => {
    const { rerender } = render(
      <TemporaryChatPage resetOnEntry {...pageProps([{ id: "old-1" }])} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-page")).toHaveTextContent("0 messages"),
    );

    // router.refresh() after the first turn (title refresh): the server now
    // finds the new turn and again reports content in the thread.
    rerender(
      <TemporaryChatPage
        resetOnEntry
        {...pageProps([{ id: "user-1" }, { id: "assistant-1" }], [{ id: "doc-1" }])}
      />,
    );

    expect(screen.getByTestId("chat-page")).toHaveTextContent("2 messages, 1 documents");
    expect(mockResetChatThread).toHaveBeenCalledTimes(1);
  });

  it("does not reset an empty thread and renders it at once", () => {
    render(<TemporaryChatPage resetOnEntry={false} {...pageProps([])} />);

    expect(screen.getByTestId("chat-page")).toHaveTextContent("0 messages");
    expect(mockResetChatThread).not.toHaveBeenCalled();
  });

  it("the entry render hides earlier uploads but keeps the paste limit and the Web / Code defaults", async () => {
    const workspace = {
      uploads: [{ path: "uploads/old.pdf", name: "old.pdf", modified: "2026-01-01T00:00:00.000Z", group: "uploaded" }],
      fileCount: 1,
      pastedTextLimitBytes: 100,
      webSearchDefault: true,
      runCodeDefault: true,
    };
    render(<TemporaryChatPage resetOnEntry {...pageProps([{ id: "old-1" }])} workspace={workspace as never} />);

    const page = await screen.findByTestId("chat-page");
    expect(JSON.parse(page.getAttribute("data-workspace") ?? "null")).toEqual({
      uploads: [],
      fileCount: 0,
      pastedTextLimitBytes: 100,
      webSearchDefault: true,
      runCodeDefault: true,
    });
  });

  it("shows an error when the reset fails", async () => {
    mockResetChatThread.mockResolvedValue({
      status: "ERROR",
      errors: [{ message: "reset failed" }],
    });

    render(<TemporaryChatPage resetOnEntry {...pageProps([{ id: "old-1" }])} />);

    expect(await screen.findByText("reset failed")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-page")).toBeNull();
  });
});
