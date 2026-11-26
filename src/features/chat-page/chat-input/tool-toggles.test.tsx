import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Hoisted spies + a tiny state hook so the mock can re-render between cases.
const {
  mockToggleWebSearch,
  mockToggleImageGeneration,
  mockToggleCompanyContent,
  mockToggleCodeInterpreter,
  storeState,
  sessionState,
} = vi.hoisted(() => ({
  mockToggleWebSearch: vi.fn(),
  mockToggleImageGeneration: vi.fn(),
  mockToggleCompanyContent: vi.fn(),
  mockToggleCodeInterpreter: vi.fn(),
  storeState: {
    webSearchEnabled: false,
    imageGenerationEnabled: false,
    companyContentEnabled: false,
    codeInterpreterEnabled: false,
  },
  sessionState: { status: "ready" as "ready" | "streaming" | "submitted" },
}));

vi.mock("../chat-store-context", () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      ...storeState,
      toggleWebSearch: mockToggleWebSearch,
      toggleImageGeneration: mockToggleImageGeneration,
      toggleCompanyContent: mockToggleCompanyContent,
      toggleCodeInterpreter: mockToggleCodeInterpreter,
    }),
  useChatSession: () => sessionState,
}));

vi.mock("@/ui/lib", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

import { ToolToggles } from "./tool-toggles";

function setStore(partial: Partial<typeof storeState>) {
  Object.assign(storeState, {
    webSearchEnabled: false,
    imageGenerationEnabled: false,
    companyContentEnabled: false,
    codeInterpreterEnabled: false,
    ...partial,
  });
}

function setLoading(loading: boolean) {
  sessionState.status = loading ? "streaming" : "ready";
}

describe("chat-page.unit.components.004 — ToolToggles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStore({});
    setLoading(false);
  });

  it("renders all four tool toggle buttons", () => {
    render(<ToolToggles />);
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });

  it("clicking the web-search button calls toggleWebSearch(true)", async () => {
    render(<ToolToggles />);
    await userEvent.click(screen.getAllByRole("button")[0]);
    expect(mockToggleWebSearch).toHaveBeenCalledWith(true);
  });

  it("when webSearchEnabled=true, clicking the web-search button calls toggleWebSearch(false)", async () => {
    setStore({ webSearchEnabled: true });
    render(<ToolToggles />);
    await userEvent.click(screen.getAllByRole("button")[0]);
    expect(mockToggleWebSearch).toHaveBeenCalledWith(false);
  });

  it("buttons are disabled when status indicates streaming", () => {
    setLoading(true);
    render(<ToolToggles />);
    screen.getAllByRole("button").forEach((btn) => expect(btn).toBeDisabled());
  });

  it("clicking the image-generation button calls toggleImageGeneration(true)", async () => {
    render(<ToolToggles />);
    await userEvent.click(screen.getAllByRole("button")[1]);
    expect(mockToggleImageGeneration).toHaveBeenCalledWith(true);
  });

  it("when imageGenerationEnabled=true, clicking the image-generation button calls toggleImageGeneration(false)", async () => {
    setStore({ imageGenerationEnabled: true });
    render(<ToolToggles />);
    await userEvent.click(screen.getAllByRole("button")[1]);
    expect(mockToggleImageGeneration).toHaveBeenCalledWith(false);
  });

  it("clicking the company-content button calls toggleCompanyContent(true)", async () => {
    render(<ToolToggles />);
    await userEvent.click(screen.getAllByRole("button")[2]);
    expect(mockToggleCompanyContent).toHaveBeenCalledWith(true);
  });

  it("when companyContentEnabled=true, clicking the company-content button calls toggleCompanyContent(false)", async () => {
    setStore({ companyContentEnabled: true });
    render(<ToolToggles />);
    await userEvent.click(screen.getAllByRole("button")[2]);
    expect(mockToggleCompanyContent).toHaveBeenCalledWith(false);
  });

  it("clicking the code-interpreter button calls toggleCodeInterpreter(true)", async () => {
    render(<ToolToggles />);
    await userEvent.click(screen.getAllByRole("button")[3]);
    expect(mockToggleCodeInterpreter).toHaveBeenCalledWith(true);
  });

  it("when codeInterpreterEnabled=true, clicking the code-interpreter button calls toggleCodeInterpreter(false)", async () => {
    setStore({ codeInterpreterEnabled: true });
    render(<ToolToggles />);
    await userEvent.click(screen.getAllByRole("button")[3]);
    expect(mockToggleCodeInterpreter).toHaveBeenCalledWith(false);
  });

  it("each toggle has an accessible name and reports its state", () => {
    setStore({ codeInterpreterEnabled: true });
    render(<ToolToggles />);
    expect(screen.getByRole("button", { name: "Web search" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Image generation" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Company content" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Code interpreter" })).toHaveAttribute("aria-pressed", "true");
  });
});
