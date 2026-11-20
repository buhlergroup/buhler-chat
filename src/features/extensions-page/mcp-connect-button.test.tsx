import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockStart, mockDisconnect } = vi.hoisted(() => ({
  mockStart: vi.fn(),
  mockDisconnect: vi.fn(),
}));

vi.mock("./extension-services/mcp/mcp-service", () => ({
  StartMcpOAuth: mockStart,
  DisconnectMcpOAuth: mockDisconnect,
}));
vi.mock("@/features/globals/global-message-store", () => ({ showError: vi.fn() }));

import { McpConnectButton } from "./mcp-connect-button";

const AUTH_URL = "https://login.example.test/authorize?state=s";

// Pinned: before signing in to an extension somebody else set up, the user
// sees where they sign in and which server receives their access.
describe("McpConnectButton — sign-in notice", () => {
  const originalLocation = window.location;
  let href = "";

  beforeEach(() => {
    vi.clearAllMocks();
    href = "";
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        pathname: "/chat/t1",
        get href() {
          return href;
        },
        set href(value: string) {
          href = value;
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  });

  it("shows both hosts and opens the sign-in page only after Continue", async () => {
    mockStart.mockResolvedValue({
      status: "OK",
      response: {
        authorizationUrl: AUTH_URL,
        connected: false,
        notice: { signInHost: "login.example.test", serverHost: "mcp.example.test" },
      },
    });
    render(<McpConnectButton extensionId="e1" extensionName="Tickets" personaId="agent-1" />);
    await userEvent.click(screen.getByRole("button", { name: /Connect Tickets/ }));

    const notice = await screen.findByTestId("mcp-sign-in-notice");
    expect(notice).toHaveTextContent("The agent owner set up Tickets.");
    expect(notice).toHaveTextContent("login.example.test");
    expect(notice).toHaveTextContent("mcp.example.test");
    expect(href).toBe("");

    await userEvent.click(screen.getByRole("button", { name: /Continue to sign-in/ }));
    expect(href).toBe(AUTH_URL);
  });

  it("Cancel keeps the user on the page", async () => {
    mockStart.mockResolvedValue({
      status: "OK",
      response: {
        authorizationUrl: AUTH_URL,
        connected: false,
        notice: { signInHost: "login.example.test", serverHost: "mcp.example.test" },
      },
    });
    render(<McpConnectButton extensionId="e1" extensionName="Tickets" />);
    await userEvent.click(screen.getByRole("button", { name: /Connect Tickets/ }));
    expect(await screen.findByTestId("mcp-sign-in-notice")).toHaveTextContent("The extension owner set up Tickets.");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("mcp-sign-in-notice")).not.toBeInTheDocument();
    expect(href).toBe("");
  });

  it("goes straight to the sign-in page for the owner (no notice)", async () => {
    mockStart.mockResolvedValue({ status: "OK", response: { authorizationUrl: AUTH_URL, connected: false } });
    render(<McpConnectButton extensionId="e1" extensionName="Tickets" />);
    await userEvent.click(screen.getByRole("button", { name: /Connect Tickets/ }));
    expect(href).toBe(AUTH_URL);
    expect(screen.queryByTestId("mcp-sign-in-notice")).not.toBeInTheDocument();
  });
});
