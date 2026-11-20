import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../extension-services/mcp/mcp-service", () => ({
  DiscoverMcpTools: vi.fn(),
  DiscoverDraftMcpTools: vi.fn(),
  DisconnectMcpOAuth: vi.fn(),
  GetMcpConnections: vi.fn().mockResolvedValue({ status: "OK", response: [] }),
  StartMcpOAuth: vi.fn(),
}));

vi.mock("../extension-services/extension-service", () => ({
  CreateExtension: vi.fn(),
  UpdateExtension: vi.fn(),
}));

vi.mock("@/features/common/navigation-helpers", () => ({
  RevalidateCache: vi.fn(),
}));

// The section renders inside the extension sheet; outside it, a plain heading.
vi.mock("@/features/ui/sheet", () => ({
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { McpServerSection } from "./mcp-server";
import { SECRET_MASK, extensionStore } from "../extension-store";
import type { ExtensionModel } from "../extension-services/models";

const FAKE = "fake-test-value";

const savedExtension = (secrets: NonNullable<ExtensionModel["mcp"]>["secrets"]): ExtensionModel => ({
  id: "ext-1",
  name: "Market data",
  description: "d",
  executionSteps: "s",
  headers: [],
  functions: [],
  userId: "u",
  isPublished: false,
  createdAt: new Date(),
  type: "EXTENSION",
  kind: "mcp",
  mcp: { url: "https://mcp.example.com/mcp", transport: "auto", secrets, toolAllowList: [], auth: "none" },
});

describe("extensions-page.unit.components.002 — McpServerSection headers", () => {
  beforeEach(() => {
    act(() => extensionStore.newAndOpenSlider("mcp"));
  });

  it("has no paste field and shows a Headers section", () => {
    render(<McpServerSection />);
    expect(screen.queryByText(/paste connection details/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /fill in/i })).not.toBeInTheDocument();
    expect(screen.getByText("Headers")).toBeInTheDocument();
    expect(screen.getByText(/Values go to Azure Key Vault and are sent only to this server/)).toBeInTheDocument();
  });

  it("adds and removes header rows; new rows are plain headers", () => {
    render(<McpServerSection />);
    fireEvent.click(screen.getByRole("button", { name: /add header/i }));
    fireEvent.click(screen.getByRole("button", { name: /add header/i }));
    const values = screen.getAllByLabelText("Value");
    expect(values).toHaveLength(2);
    expect(values[0]).toHaveAttribute("placeholder", "Bearer <token>");
    expect(values[1]).toHaveAttribute("placeholder", "Value");

    fireEvent.change(screen.getAllByLabelText("Header name")[1], { target: { value: "X-MCP-Readonly" } });
    fireEvent.change(values[1], { target: { value: "true" } });
    expect(extensionStore.extension.mcp?.secrets[1]).toMatchObject({
      name: "X-MCP-Readonly",
      target: "X-MCP-Readonly",
      placement: "header",
      value: "true",
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove header X-MCP-Readonly" }));
    expect(screen.getAllByLabelText("Value")).toHaveLength(1);
    expect(extensionStore.extension.mcp?.secrets).toHaveLength(1);
  });

  it("never shows a saved value", () => {
    act(() =>
      extensionStore.openAndUpdate(
        savedExtension([{ id: "h", name: "X-Team", target: "X-Team", value: SECRET_MASK, placement: "header" }])
      )
    );
    render(<McpServerSection />);
    const value = screen.getByLabelText("Value");
    expect(value).toHaveValue("");
    expect(value).toHaveAttribute("placeholder", "Saved. Type to replace.");
    expect(screen.getByLabelText("Header name")).toHaveValue("X-Team");
  });

  it("shows a legacy bearer record as Authorization and turns it into a plain header on a new value", () => {
    act(() =>
      extensionStore.openAndUpdate(
        savedExtension([{ id: "b", name: "MCP_TOKEN", value: SECRET_MASK, placement: "bearer" }])
      )
    );
    render(<McpServerSection />);
    expect(screen.getByLabelText("Header name")).toHaveValue("Authorization");
    expect(screen.getByLabelText("Header name")).toHaveAttribute("readonly");
    expect(screen.getByText(/saved value is sent as Bearer <value>/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Value"), { target: { value: `Bearer ${FAKE}` } });
    expect(extensionStore.extension.mcp?.secrets[0]).toMatchObject({
      id: "b",
      name: "Authorization",
      target: "Authorization",
      placement: "header",
      value: `Bearer ${FAKE}`,
    });
    expect(screen.queryByText(/saved value is sent as Bearer <value>/)).not.toBeInTheDocument();

    // Clearing the new value keeps the saved one, sent as before.
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "" } });
    expect(extensionStore.extension.mcp?.secrets[0]).toMatchObject({
      name: "MCP_TOKEN",
      placement: "bearer",
      value: SECRET_MASK,
    });
  });

  it("shows a legacy query record read-only with a note", () => {
    act(() =>
      extensionStore.openAndUpdate(
        savedExtension([{ id: "q", name: "key", target: "api_key", value: SECRET_MASK, placement: "query" }])
      )
    );
    render(<McpServerSection />);
    expect(screen.getByLabelText("Header name")).toHaveValue("api_key");
    expect(screen.getByLabelText("Header name")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Value")).toHaveAttribute("readonly");
    expect(screen.getByText(/Sent as the query parameter api_key/)).toBeInTheDocument();
  });
});
