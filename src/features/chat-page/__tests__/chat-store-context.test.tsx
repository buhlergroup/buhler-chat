/**
 * Tests for ChatStoreProvider / useChatStore / useChatSession context hooks.
 * @ai-sdk/react useChat is mocked to avoid network I/O.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../../features/common/services/openai", () => ({
  OpenAIV1Instance: vi.fn(),
  OpenAIV1ReasoningInstance: vi.fn(),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn(() => ({
    messages: [],
    status: "ready",
    sendMessage: vi.fn(),
    stop: vi.fn(),
    error: undefined,
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { ChatStoreProvider, useChatStore, useChatSession } from "../chat-store-context";
import type { ChatThreadModel } from "../chat-services/models";

const makeThread = (id: string): ChatThreadModel => ({
  id,
  name: `Thread ${id}`,
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
  selectedModel: "gpt-5.4-mini",
});

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

function ModelDisplay({ label }: { label: string }) {
  const model = useChatStore((s) => s.selectedModel);
  return <span data-testid={label}>{model}</span>;
}

function StatusDisplay({ label }: { label: string }) {
  const { status } = useChatSession();
  return <span data-testid={label}>{status}</span>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatStoreProvider", () => {
  it("exposes chatThread.selectedModel via useChatStore", () => {
    render(
      <ChatStoreProvider threadId="t1" chatThread={makeThread("t1")}>
        <ModelDisplay label="model" />
      </ChatStoreProvider>
    );
    expect(screen.getByTestId("model").textContent).toBe("gpt-5.4-mini");
  });

  it("exposes AI SDK status via useChatSession", () => {
    render(
      <ChatStoreProvider threadId="t1" chatThread={makeThread("t1")}>
        <StatusDisplay label="status" />
      </ChatStoreProvider>
    );
    expect(screen.getByTestId("status").textContent).toBe("ready");
  });

  it("two sibling providers with different threadIds maintain independent store state", () => {
    const threadA = makeThread("tA");
    const threadB = { ...makeThread("tB"), selectedModel: "gpt-5.5" as const };

    render(
      <>
        <ChatStoreProvider key="tA" threadId="tA" chatThread={threadA}>
          <ModelDisplay label="modelA" />
        </ChatStoreProvider>
        <ChatStoreProvider key="tB" threadId="tB" chatThread={threadB}>
          <ModelDisplay label="modelB" />
        </ChatStoreProvider>
      </>
    );

    expect(screen.getByTestId("modelA").textContent).toBe("gpt-5.4-mini");
    expect(screen.getByTestId("modelB").textContent).toBe("gpt-5.5");
  });

  it("throws if useChatStore is used outside provider", () => {
    // Suppress React error boundary noise
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Orphan() {
      useChatStore((s) => s.selectedModel);
      return null;
    }
    expect(() => render(<Orphan />)).toThrow("useChatContext must be used inside <ChatStoreProvider>");
    spy.mockRestore();
  });
});
