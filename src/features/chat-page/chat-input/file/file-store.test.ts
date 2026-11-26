import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockShowError, mockAddImage, mockGetActiveChatStore } = vi.hoisted(() => ({
  mockShowError: vi.fn(),
  mockAddImage: vi.fn(),
  mockGetActiveChatStore: vi.fn(),
}));

vi.mock("@/features/globals/global-message-store", () => ({
  showError: mockShowError,
  showSuccess: vi.fn(),
}));

vi.mock("@/features/ui/chat/chat-input-area/input-image-store", () => ({
  InputImageStore: { AddImage: mockAddImage },
}));

vi.mock("../../active-chat-store", () => ({
  getActiveChatStore: mockGetActiveChatStore,
}));

vi.mock("../../chat-services/chat-document-service", () => ({
  CrackDocument: vi.fn(),
  CreateChatDocument: vi.fn(),
  IndexChatDocuments: vi.fn(),
}));

import { fileStore } from "./file-store";

function selectModel(selectedModel: string) {
  mockGetActiveChatStore.mockReturnValue({
    getState: () => ({ selectedModel, codeInterpreterEnabled: false, attachedFiles: [] }),
  });
}

async function attachImage() {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([137, 80, 78, 71])], "photo.png", { type: "image/png" }));
  await fileStore.onFileChange({ formData: fd, chatThreadId: "thread-1" });
}

describe("chat-page.unit.file-store.image-input — images need a model with vision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses an image for Kimi K2.6 and names the model", async () => {
    selectModel("Kimi-K2.6");

    await attachImage();

    expect(mockShowError).toHaveBeenCalledWith(expect.stringContaining("Kimi K2.6"));
    expect(fileStore.loading).toBe("idle");
    // FileReader is async; give it a turn to prove nothing was added.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockAddImage).not.toHaveBeenCalled();
  });

  it("attaches an image for a model with vision", async () => {
    selectModel("gpt-5.6-luna");

    await attachImage();

    await vi.waitFor(() => expect(mockAddImage).toHaveBeenCalledTimes(1));
    expect(mockAddImage.mock.calls[0][0]).toMatch(/^data:image\/png;base64,/);
    expect(mockShowError).not.toHaveBeenCalled();
  });
});
