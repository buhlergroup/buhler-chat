import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockSelectorState } = vi.hoisted(() => ({
  mockSelectorState: { current: { lastUsageData: null as unknown } },
}));

vi.mock("../chat-store-context", () => ({
  useChatStore: (selector: (s: unknown) => unknown) =>
    selector(mockSelectorState.current as unknown),
}));

const useChat = {
  mockReturnValue: (state: { lastUsageData: unknown }) => {
    mockSelectorState.current = state;
  },
};

import { TokenUsageDisplay } from "./token-usage-display";

const makeUsage = (overrides = {}) => ({
  threadTotalTokens: 1500,
  threadTotalCostUsd: 0.02,
  inputTokens: 800,
  outputTokens: 200,
  cachedTokens: 0,
  contextWindowSize: 128000,
  contextUsagePercent: 0.625,
  costUsd: 0.005,
  ...overrides,
});

describe("chat-page.unit.components — TokenUsageDisplay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when lastUsageData is null", () => {
    useChat.mockReturnValue({ lastUsageData: null });
    const { container } = render(<TokenUsageDisplay />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a button with aria-label containing token count", () => {
    useChat.mockReturnValue({ lastUsageData: makeUsage() });
    render(<TokenUsageDisplay />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("aria-label")).toContain("1.5k");
  });

  it("shows cost when threadTotalCostUsd > 0", () => {
    useChat.mockReturnValue({ lastUsageData: makeUsage({ threadTotalCostUsd: 0.03 }) });
    render(<TokenUsageDisplay />);
    expect(screen.getByRole("button").textContent).toContain("$0.03");
  });

  it("hides cost section when threadTotalCostUsd is 0", () => {
    useChat.mockReturnValue({ lastUsageData: makeUsage({ threadTotalCostUsd: 0 }) });
    render(<TokenUsageDisplay />);
    expect(screen.getByRole("button").textContent).not.toContain("$");
  });

  it("uses M suffix for tokens >= 1,000,000", () => {
    useChat.mockReturnValue({
      lastUsageData: makeUsage({ threadTotalTokens: 2_500_000 }),
    });
    render(<TokenUsageDisplay />);
    expect(screen.getByRole("button").textContent).toContain("2.5M");
  });

  it("displays raw number for tokens < 1000", () => {
    useChat.mockReturnValue({
      lastUsageData: makeUsage({ threadTotalTokens: 42 }),
    });
    render(<TokenUsageDisplay />);
    expect(screen.getByRole("button").textContent).toContain("42");
  });

  it("applies red ring color class when context usage > 80%", () => {
    useChat.mockReturnValue({
      lastUsageData: makeUsage({
        contextWindowSize: 100,
        inputTokens: 90,
        contextUsagePercent: 90,
      }),
    });
    render(<TokenUsageDisplay />);
    // The svg element should carry the red class
    const svgParent = screen.getByRole("button");
    expect(svgParent.innerHTML).toContain("text-red-500");
  });

  it("applies yellow ring color class when context usage > 50% and <= 80%", () => {
    useChat.mockReturnValue({
      lastUsageData: makeUsage({
        contextWindowSize: 100,
        inputTokens: 60,
        contextUsagePercent: 60,
      }),
    });
    render(<TokenUsageDisplay />);
    expect(screen.getByRole("button").innerHTML).toContain("text-yellow-500");
  });

  it("applies default muted ring color when context usage <= 50%", () => {
    useChat.mockReturnValue({
      lastUsageData: makeUsage({
        contextWindowSize: 100,
        inputTokens: 30,
        contextUsagePercent: 30,
      }),
    });
    render(<TokenUsageDisplay />);
    expect(screen.getByRole("button").innerHTML).toContain("text-primary/60");
  });

  describe("the panel body — real numbers only", () => {
    // The panel quotes the provider for the last COMPLETED request. Nothing is
    // estimated and nothing is marked "~": a number that later disagrees with
    // the provider's own accounting is worse than one that is a turn old.
    async function openPanel(usage: Record<string, unknown>) {
      const { cleanup } = await import("@testing-library/react");
      cleanup();
      const userEvent = (await import("@testing-library/user-event")).default;
      useChat.mockReturnValue({ lastUsageData: makeUsage(usage) });
      render(<TokenUsageDisplay />);
      await userEvent.setup().click(screen.getByRole("button"));
    }

    it("labels the cumulative row as thread usage, not as a context size", async () => {
      // It used to say "Total tokens", which read like a context size and
      // invited a comparison with the context row — two different quantities.
      await openPanel({ threadTotalTokens: 120_573 });
      expect(screen.getByText("Thread usage so far")).toBeInTheDocument();
      expect(screen.getByText("120,573")).toBeInTheDocument();
      expect(screen.queryByText("Total tokens")).not.toBeInTheDocument();
    });

    it("splits the last request's input into reads, writes and plain", async () => {
      await openPanel({
        inputTokens: 17_527,
        cachedTokens: 12_400,
        cacheWriteTokens: 5_100,
      });
      // plain = 17,527 - 12,400 - 5,100 = 27
      expect(screen.getByTestId("cache-row").textContent).toContain(
        "reads 12,400 · writes 5,100 · plain 27",
      );
    });

    it("omits the writes segment when the persisted row never recorded it", async () => {
      // Rows written before cache writes were persisted: claiming "writes 0"
      // would be a fact we do not have.
      await openPanel({ inputTokens: 1_000, cachedTokens: 400 });
      const row = screen.getByTestId("cache-row").textContent ?? "";
      expect(row).toContain("reads 400");
      expect(row).not.toContain("writes");
      expect(row).toContain("plain 600");
    });

    it("shows the last prompt's real size against the window, with no '~'", async () => {
      await openPanel({
        inputTokens: 17_527,
        contextWindowSize: 1_050_000,
        contextUsagePercent: 1.669,
      });
      const row = screen.getByTestId("context-row").textContent ?? "";
      expect(row).toContain("Context (last prompt)");
      expect(row).toContain("17,527 of 1.1M");
      expect(row).toContain("1.7 %");
      expect(row).not.toContain("~");
    });

    it("chat-page.unit.usage-panel.002: labels the totals as all-steps and the context as the last prompt", async () => {
      // A 3-step tool turn: 99,000 billed input over a conversation whose last
      // prompt was 35,000. Both numbers are right and they look contradictory,
      // so the panel has to say which is which.
      await openPanel({
        inputTokens: 99_000,
        outputTokens: 750,
        cachedTokens: 60_000,
        cacheWriteTokens: 20_000,
        lastPromptTokens: 35_000,
        stepCount: 3,
        contextWindowSize: 1_050_000,
        contextUsagePercent: 3.333,
      });

      expect(screen.getByText("(last request, all steps)")).toBeInTheDocument();
      expect(screen.getByText("Input (all steps)")).toBeInTheDocument();
      expect(screen.getByText("99,000")).toBeInTheDocument();
      expect(screen.getByText("Output (all steps)")).toBeInTheDocument();
      expect(screen.getByText("Cache (all steps)")).toBeInTheDocument();

      // The context row quotes the LAST PROMPT, not the roll-up.
      const context = screen.getByTestId("context-row").textContent ?? "";
      expect(context).toContain("Context (last prompt)");
      expect(context).toContain("35,000 of 1.1M");
      expect(context).not.toContain("99,000");
    });

    it("chat-page.unit.usage-panel.003: shows the step count when the turn made more than one call", async () => {
      await openPanel({ inputTokens: 99_000, lastPromptTokens: 35_000, stepCount: 3 });
      expect(screen.getByTestId("step-count-row").textContent).toContain(
        "3 steps",
      );
      expect(screen.getByText("Model calls")).toBeInTheDocument();
    });

    it("chat-page.unit.usage-panel.004: hides the step count for a plain one-call turn (negative)", async () => {
      await openPanel({ inputTokens: 17_527, lastPromptTokens: 17_527, stepCount: 1 });
      expect(screen.queryByTestId("step-count-row")).not.toBeInTheDocument();
      // And with no stepCount at all — a thread seeded from persisted usage,
      // which does not record it.
      await openPanel({ inputTokens: 17_527, lastPromptTokens: 17_527 });
      expect(screen.queryByTestId("step-count-row")).not.toBeInTheDocument();
    });

    it("chat-page.unit.usage-panel.005: falls back to the turn total for a row written before lastPromptTokens", async () => {
      // Old persisted rows carry only the all-steps figure. Showing it is
      // better than showing nothing; it is exact for a single-step turn and
      // overstates a multi-step one.
      await openPanel({
        inputTokens: 17_527,
        contextWindowSize: 1_050_000,
        contextUsagePercent: 1.669,
      });
      const context = screen.getByTestId("context-row").textContent ?? "";
      expect(context).toContain("17,527 of 1.1M");
    });

    it("chat-page.unit.usage-panel.006: keeps reads + writes + plain equal to the turn's input total", async () => {
      await openPanel({
        inputTokens: 99_000,
        cachedTokens: 60_000,
        cacheWriteTokens: 20_000,
        lastPromptTokens: 35_000,
        stepCount: 3,
      });
      // plain = 99,000 - 60,000 - 20,000 = 19,000
      expect(screen.getByTestId("cache-row").textContent).toContain(
        "reads 60,000 · writes 20,000 · plain 19,000",
      );
    });

    it("never floors the plain bucket below zero (negative)", async () => {
      // A provider that reported overlapping buckets would otherwise put a
      // negative number on screen.
      await openPanel({
        inputTokens: 100,
        cachedTokens: 90,
        cacheWriteTokens: 90,
      });
      expect(screen.getByTestId("cache-row").textContent).toContain("plain 0");
    });
  });

  it("formats cost < 0.01 as '< $0.01'", () => {
    useChat.mockReturnValue({
      lastUsageData: makeUsage({ threadTotalCostUsd: 0.001 }),
    });
    render(<TokenUsageDisplay />);
    expect(screen.getByRole("button").textContent).toContain("< $0.01");
  });
});
