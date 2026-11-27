/**
 * Tests for createChatStore factory — verifies per-instance isolation.
 * No React rendering needed; exercises the Zustand vanilla store directly.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

// Stub server-only modules pulled in transitively by models.ts
vi.mock("../../../features/common/services/openai", () => ({
  OpenAIV1Instance: vi.fn(),
  OpenAIV1ReasoningInstance: vi.fn(),
}));

import { createChatStore } from "../chat-store-factory";
import type { ChatThreadModel } from "../chat-services/models";

const baseThread = (): ChatThreadModel => ({
  id: "thread-1",
  name: "Test Thread",
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
  selectedModel: "gpt-5.4",
});

describe("createChatStore — isolation", () => {
  it("creates two independent stores; initial states do not share references", () => {
    const storeA = createChatStore({ threadId: "A", chatThread: { ...baseThread(), id: "A" } });
    const storeB = createChatStore({ threadId: "B", chatThread: { ...baseThread(), id: "B" } });

    expect(storeA).not.toBe(storeB);
    expect(storeA.getState()).not.toBe(storeB.getState());
    // Both start with the same model from the thread fixture
    expect(storeA.getState().selectedModel).toBe("gpt-5.4");
    expect(storeB.getState().selectedModel).toBe("gpt-5.4");
  });

  it("mutating store A does not affect store B", () => {
    const storeA = createChatStore({ threadId: "A" });
    const storeB = createChatStore({ threadId: "B" });

    storeA.getState().setSelectedModel("gpt-5.4");
    expect(storeA.getState().selectedModel).toBe("gpt-5.4");
    // B should remain on the default model (unaffected)
    expect(storeB.getState().selectedModel).not.toBe("gpt-5.4");
  });

  it("setSelectedModel notifies subscribers on target store only", () => {
    const storeA = createChatStore({ threadId: "A" });
    const storeB = createChatStore({ threadId: "B" });

    const listenerA = vi.fn();
    const listenerB = vi.fn();
    storeA.subscribe(listenerA);
    storeB.subscribe(listenerB);

    storeA.getState().setSelectedModel("gpt-5.4");

    expect(listenerA).toHaveBeenCalledOnce();
    expect(listenerB).not.toHaveBeenCalled();
    expect(storeA.getState().selectedModel).toBe("gpt-5.4");
    expect(storeB.getState().selectedModel).not.toBe("gpt-5.4");
  });

  // Tool-call-history restoration was deleted with the dead Zustand subsystem
  // (architect review SERIOUS finding). Tool calls are rendered from
  // UIMessage.parts as DynamicToolUIPart, not from a Zustand cache.
});

describe("createChatStore — Web / Code toggle defaults", () => {
  it("Copilot path (defaults from the workspace summary): Web and Code start on", () => {
    const s = createChatStore({
      threadId: "A",
      chatThread: baseThread(),
      webSearchDefault: true,
      runCodeDefault: true,
    }).getState();
    expect(s.webSearchEnabled).toBe(true);
    expect(s.codeInterpreterEnabled).toBe(true);
  });

  it("without the summary (AI SDK path): Web and Code start off, as before", () => {
    const s = createChatStore({ threadId: "A", chatThread: baseThread() }).getState();
    expect(s.webSearchEnabled).toBe(false);
    expect(s.codeInterpreterEnabled).toBe(false);
  });

  it("an agent's explicit false wins over the default", () => {
    const s = createChatStore({
      threadId: "A",
      chatThread: { ...baseThread(), defaultTools: { webSearch: false, codeInterpreter: false } },
      webSearchDefault: true,
      runCodeDefault: true,
    }).getState();
    expect(s.webSearchEnabled).toBe(false);
    expect(s.codeInterpreterEnabled).toBe(false);
  });

  it("an agent's explicit true wins over a default off", () => {
    const s = createChatStore({
      threadId: "A",
      chatThread: { ...baseThread(), defaultTools: { webSearch: true, codeInterpreter: true } },
      webSearchDefault: false,
      runCodeDefault: false,
    }).getState();
    expect(s.webSearchEnabled).toBe(true);
    expect(s.codeInterpreterEnabled).toBe(true);
  });

  it("the Code toggle still starts on for a thread with code interpreter files", () => {
    const s = createChatStore({
      threadId: "A",
      chatThread: {
        ...baseThread(),
        attachedFiles: [{ id: "f1", name: "a.csv", type: "code-interpreter" } as never],
      },
    }).getState();
    expect(s.codeInterpreterEnabled).toBe(true);
  });

  it("the user's off stays off (the request then carries false)", () => {
    const store = createChatStore({ threadId: "A", webSearchDefault: true, runCodeDefault: true });
    store.getState().toggleWebSearch(false);
    store.getState().toggleCodeInterpreter(false);
    expect(store.getState().webSearchEnabled).toBe(false);
    expect(store.getState().codeInterpreterEnabled).toBe(false);
  });
});
