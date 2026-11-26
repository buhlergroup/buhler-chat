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
