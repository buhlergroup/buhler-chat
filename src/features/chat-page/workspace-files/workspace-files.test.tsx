import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  uploadDocument: vi.fn(),
  showError: vi.fn(),
  showSuccess: vi.fn(),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn(() => ({ messages: [], status: "ready", sendMessage: vi.fn(), stop: vi.fn(), error: undefined })),
}));
vi.mock("@/features/chat-page/chat-services/copilot-runtime/workspace-upload-actions", () => ({
  UploadFileToAgentWorkspace: mocks.upload,
  RemoveWorkspaceFile: mocks.remove,
  ListWorkspaceFiles: mocks.list,
}));
vi.mock("@/features/chat-page/chat-services/chat-document-service", () => ({
  UploadChatDocument: mocks.uploadDocument,
}));
vi.mock("@/features/globals/global-message-store", () => ({
  showError: mocks.showError,
  showSuccess: mocks.showSuccess,
}));

import { ChatStoreProvider, useChatStore } from "../chat-store-context";
import type { ChatThreadModel } from "../chat-services/models";
import type { WorkspaceFileInfo, WorkspaceSummary } from "../chat-services/workspace-file-model";
import { fileStore } from "../chat-input/file/file-store";
import { WorkspaceUploadChips } from "./workspace-upload-chips";
import { WorkspaceFilesPanel } from "./workspace-files-panel";

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

const upload = (name: string, modified = "2026-01-01T00:00:00.000Z"): WorkspaceFileInfo => ({
  path: `uploads/${name}`,
  name,
  size: 2048,
  modified,
  group: "uploaded",
});

function CodeInterpreterIds() {
  const ciFiles = useChatStore((s) => s.attachedFiles.length);
  const count = useChatStore((s) => s.workspaceFileCount);
  return (
    <span data-testid="state">
      ci:{ciFiles} count:{count}
    </span>
  );
}

const renderChips = (summary: WorkspaceSummary) =>
  render(
    <ChatStoreProvider threadId="thread1" chatThread={thread}>
      <WorkspaceUploadChips threadId="thread1" summary={summary} />
      <WorkspaceFilesPanel threadId="thread1" />
      <CodeInterpreterIds />
    </ChatStoreProvider>,
  );

describe("workspace upload chips (Copilot path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileStore.loading = "idle";
  });

  it("shows the server's uploads as Uploaded chips with a file icon by extension", () => {
    renderChips({ uploads: [upload("data.xlsx"), upload("report.pdf")], fileCount: 5 });
    const chips = screen.getByTestId("workspace-upload-chips");
    expect(within(chips).getByText("data.xlsx")).toBeInTheDocument();
    expect(within(chips).getByText("report.pdf")).toBeInTheDocument();
    expect(within(chips).getAllByText("Uploaded")).toHaveLength(2);
    expect(chips.querySelector('[data-file-kind="spreadsheet"]')).not.toBeNull();
    expect(chips.querySelector('[data-file-kind="text"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Files of this chat" })).toHaveTextContent("Files (5)");
  });

  it("shows no chips for an empty workspace", () => {
    renderChips({ uploads: [], fileCount: 0 });
    expect(screen.queryByTestId("workspace-upload-chips")).toBeNull();
  });

  it("adds a chip at once after a handled upload, not as a code interpreter file", async () => {
    mocks.upload.mockResolvedValue({
      status: "OK",
      response: { handled: true, path: "/workspace/uploads/new.csv", size: 3, modified: "2026-02-01T00:00:00.000Z" },
    });
    renderChips({ uploads: [upload("old.pdf")], fileCount: 1 });

    const fd = new FormData();
    fd.append("file", new File(["a,b"], "new.csv"));
    await act(() => fileStore.onFileChange({ formData: fd, chatThreadId: "thread1" }));

    const chips = screen.getByTestId("workspace-upload-chips");
    expect(within(chips).getAllByText(/\.(csv|pdf)$/).map((n) => n.textContent)).toEqual(["new.csv", "old.pdf"]);
    expect(screen.getByTestId("state")).toHaveTextContent("ci:0 count:2");
    expect(mocks.uploadDocument).not.toHaveBeenCalled();
  });

  it("removes the chip on the cross and deletes the file on the server", async () => {
    mocks.remove.mockResolvedValue({ status: "OK", response: { removed: ["uploads/report.pdf", "uploads/report.pdf.md"] } });
    renderChips({ uploads: [upload("report.pdf"), upload("keep.txt")], fileCount: 4 });

    fireEvent.click(screen.getByRole("button", { name: "Remove report.pdf" }));

    expect(screen.queryByText("report.pdf")).toBeNull();
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("thread1", "uploads/report.pdf"));
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("count:2"));
    expect(screen.getByText("keep.txt")).toBeInTheDocument();
    expect(mocks.showError).not.toHaveBeenCalled();
  });

  it("puts the chip back and shows an error when the delete fails", async () => {
    mocks.remove.mockResolvedValue({ status: "ERROR", errors: [{ message: "The file could not be deleted." }] });
    renderChips({ uploads: [upload("report.pdf")], fileCount: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Remove report.pdf" }));

    await waitFor(() => expect(mocks.showError).toHaveBeenCalledWith(expect.stringContaining("report.pdf could not be deleted")));
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByTestId("state")).toHaveTextContent("count:1");
  });

  it("takes a new server list on a new render of the page", () => {
    const view = renderChips({ uploads: [upload("a.txt")], fileCount: 1 });
    view.rerender(
      <ChatStoreProvider threadId="thread1" chatThread={thread}>
        <WorkspaceUploadChips threadId="thread1" summary={{ uploads: [upload("b.txt")], fileCount: 2 }} />
        <WorkspaceFilesPanel threadId="thread1" />
        <CodeInterpreterIds />
      </ChatStoreProvider>,
    );
    expect(screen.queryByText("a.txt")).toBeNull();
    expect(screen.getByText("b.txt")).toBeInTheDocument();
  });
});

describe("workspace Files panel (Copilot path)", () => {
  beforeEach(() => vi.clearAllMocks());

  const created = (path: string, modified: string): WorkspaceFileInfo => ({
    path,
    name: path.split("/").pop()!,
    size: 10,
    modified,
    group: "created",
  });

  it("lists uploaded and created files with download links, and deletes one", async () => {
    mocks.list.mockResolvedValue({
      status: "OK",
      response: {
        files: [
          created("out/chart.png", "2026-01-03T00:00:00.000Z"),
          created("uploads/report.pdf.md", "2026-01-02T00:00:00.000Z"),
          upload("report.pdf"),
        ],
        total: 3,
        truncated: false,
      },
    });
    mocks.remove.mockResolvedValue({ status: "OK", response: { removed: ["out/chart.png"] } });
    renderChips({ uploads: [upload("report.pdf")], fileCount: 3 });

    fireEvent.click(screen.getByRole("button", { name: "Files of this chat" }));

    const uploaded = await screen.findByRole("region", { name: "Uploaded" });
    const createdGroup = screen.getByRole("region", { name: "Created" });
    expect(within(uploaded).getByText("report.pdf").closest("a")).toHaveAttribute(
      "href",
      "/api/workspace/file?t=thread1&p=uploads%2Freport.pdf",
    );
    expect(within(createdGroup).getAllByTestId("workspace-file-row").map((r) => within(r).getByRole("link").textContent)).toEqual([
      "chart.png",
      "report.pdf.md",
    ]);
    expect(mocks.list).toHaveBeenCalledWith("thread1");

    // The panel asks first; Cancel deletes nothing.
    fireEvent.click(within(createdGroup).getByRole("button", { name: "Delete out/chart.png" }));
    let confirm = await screen.findByTestId("workspace-file-delete-confirm");
    expect(confirm).toHaveTextContent("Delete out/chart.png from this chat?");
    expect(mocks.remove).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("workspace-file-delete-confirm")).toBeNull());
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(within(createdGroup).getByText("chart.png")).toBeInTheDocument();

    fireEvent.click(within(createdGroup).getByRole("button", { name: "Delete out/chart.png" }));
    confirm = await screen.findByTestId("workspace-file-delete-confirm");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(createdGroup).queryByText("chart.png")).toBeNull());
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith("thread1", "out/chart.png");
    expect(screen.getByTestId("state")).toHaveTextContent("count:2");
  });

  it("keeps the file in the panel and shows the error when the server keeps it", async () => {
    mocks.list.mockResolvedValue({
      status: "OK",
      response: { files: [created("out/indexed.txt", "2026-01-01T00:00:00.000Z")], total: 1, truncated: false },
    });
    mocks.remove.mockResolvedValue({
      status: "ERROR",
      errors: [{ message: "The search index entries of the file could not be deleted. The file is kept; try again." }],
    });
    renderChips({ uploads: [], fileCount: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Files of this chat" }));
    const createdGroup = await screen.findByRole("region", { name: "Created" });
    fireEvent.click(within(createdGroup).getByRole("button", { name: "Delete out/indexed.txt" }));
    fireEvent.click(within(await screen.findByTestId("workspace-file-delete-confirm")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.showError).toHaveBeenCalledWith(expect.stringContaining("The file is kept")));
    expect(within(createdGroup).getByText("indexed.txt")).toBeInTheDocument();
    expect(screen.getByTestId("state")).toHaveTextContent("count:1");
  });

  it("says when the list is cut", async () => {
    mocks.list.mockResolvedValue({
      status: "OK",
      response: { files: [created("out/a.txt", "2026-01-01T00:00:00.000Z")], total: 900, truncated: true },
    });
    renderChips({ uploads: [], fileCount: 900 });
    fireEvent.click(screen.getByRole("button", { name: "Files of this chat" }));
    expect(await screen.findByText("Shows the newest 1 of 900 files.")).toBeInTheDocument();
  });
});
