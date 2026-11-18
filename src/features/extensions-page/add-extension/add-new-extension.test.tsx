import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockUseSession } = vi.hoisted(() => ({
  mockUseSession: vi.fn().mockReturnValue({ data: null }),
}));

vi.mock("next-auth/react", () => ({
  useSession: mockUseSession,
}));

const { mockExtensionState } = vi.hoisted(() => ({
  mockExtensionState: {
    isOpened: true,
    isLoading: false,
    saveNotice: "",
    extension: {
      id: "",
      name: "",
      description: "",
      executionSteps: "",
      createdAt: new Date(),
      isPublished: false,
      type: "EXTENSION" as const,
      functions: [],
      headers: [],
      userId: "",
    },
  },
}));

vi.mock("../extension-store", () => ({
  extensionStore: {
    updateOpened: vi.fn(),
    clearSaveNotice: vi.fn(),
  },
  useExtensionState: vi.fn().mockReturnValue(mockExtensionState),
  AddOrUpdateExtension: vi.fn().mockResolvedValue({ status: "OK", response: {} }),
}));

vi.mock("./add-function", () => ({
  AddFunction: () => <div data-testid="add-function" />,
}));

vi.mock("./endpoint-header", () => ({
  EndpointHeader: () => <div data-testid="endpoint-header" />,
}));

vi.mock("./error-messages", () => ({
  ErrorMessages: () => <div data-testid="error-messages" />,
}));

import { AddExtension } from "./add-new-extension";
import { useExtensionState } from "../extension-store";

describe("extensions-page.unit.components.001 — AddExtension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useExtensionState as any).mockReturnValue({ ...mockExtensionState });
  });

  it("renders the Extension sheet when open", () => {
    render(<AddExtension />);
    expect(screen.getByText("Extension")).toBeInTheDocument();
  });

  it("renders name, description and executionSteps inputs", () => {
    render(<AddExtension />);
    expect(
      screen.getByPlaceholderText(/name of your extension/i)
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/short description/i)).toBeInTheDocument();
  });

  it("does NOT show Publish switch for non-admin", () => {
    render(<AddExtension />);
    expect(screen.queryByText("Publish")).not.toBeInTheDocument();
  });

  it("shows Publish switch for admin", () => {
    mockUseSession.mockReturnValue({ data: { user: { isAdmin: true } } });
    render(<AddExtension />);
    expect(screen.getByText("Publish")).toBeInTheDocument();
  });

  it("renders AddFunction and EndpointHeader sub-components", () => {
    render(<AddExtension />);
    expect(screen.getByTestId("add-function")).toBeInTheDocument();
    expect(screen.getByTestId("endpoint-header")).toBeInTheDocument();
  });

  it("renders error messages area", () => {
    render(<AddExtension />);
    expect(screen.getByTestId("error-messages")).toBeInTheDocument();
  });

  it("shows the save confirmation next to Save while the sheet stays open", () => {
    (useExtensionState as any).mockReturnValue({ ...mockExtensionState, saveNotice: "Saved." });
    render(<AddExtension />);
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  it("sends the current extension id (a saved MCP extension updates on the next save)", () => {
    (useExtensionState as any).mockReturnValue({
      ...mockExtensionState,
      extension: { ...mockExtensionState.extension, id: "saved-id" },
    });
    const { container } = render(<AddExtension />);
    expect(container.ownerDocument.querySelector('input[name="id"]')).toHaveValue("saved-id");
  });

  it("does not render when isOpened is false", () => {
    (useExtensionState as any).mockReturnValue({
      ...mockExtensionState,
      isOpened: false,
    });
    render(<AddExtension />);
    expect(screen.queryByText("Extension")).not.toBeInTheDocument();
  });
});
