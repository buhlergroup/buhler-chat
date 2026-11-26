import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

describe("main-menu.unit.components.004 — UserUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when fetch returns zero tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            daily: { totalTokens: 0, totalCostUsd: 0, models: {} },
            weekly: { totalTokens: 0, totalCostUsd: 0 },
          }),
          { status: 200 }
        )
      )
    );

    const { UserUsage } = await import("./user-usage");
    const { container } = render(<UserUsage />);

    await waitFor(() => {
      // Component returns null when no usage
      expect(container.firstChild).toBeNull();
    });
  });

  it("displays formatted token count when usage available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            daily: { totalTokens: 12345, totalCostUsd: 0.05, models: {} },
            weekly: { totalTokens: 0, totalCostUsd: 0 },
          }),
          { status: 200 }
        )
      )
    );

    const { UserUsage } = await import("./user-usage");
    render(<UserUsage />);

    await waitFor(() => {
      // 12345 formatted as "12.3k"
      expect(screen.getByText("12.3k")).toBeInTheDocument();
    });
  });

  it("renders nothing when fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network"))
    );

    const { UserUsage } = await import("./user-usage");
    const { container } = render(<UserUsage />);

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });
});

describe("UserUsage polling", () => {
  const okUsage = () =>
    new Response(JSON.stringify({ daily: { totalTokens: 1, totalCostUsd: 0, models: {} }, weekly: { totalTokens: 1, totalCostUsd: 0 } }), { status: 200 });
  const setVisibility = (state: "visible" | "hidden") =>
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("polls every 5 minutes while visible and not at all while hidden", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => okUsage());
    vi.stubGlobal("fetch", fetchMock);
    const { UserUsage, USAGE_POLL_MS } = await import("./user-usage");
    render(<UserUsage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes after a chat turn and when a stale tab becomes visible", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => okUsage());
    vi.stubGlobal("fetch", fetchMock);
    const { UserUsage } = await import("./user-usage");
    const { notifyUsageChanged } = await import("./usage-events");
    render(<UserUsage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    notifyUsageChanged();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });
});
