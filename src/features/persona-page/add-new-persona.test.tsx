import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockUseSession } = vi.hoisted(() => ({
  mockUseSession: vi.fn().mockReturnValue({ data: { user: { isAdmin: false } } }),
}));

// Mock next-auth/react
vi.mock("next-auth/react", () => ({
  useSession: mockUseSession,
  SessionProvider: ({ children }: any) => children,
}));

// Use vi.hoisted so mockPersonaState is available inside the vi.mock factory
const { mockPersonaState } = vi.hoisted(() => ({
  mockPersonaState: {
    isOpened: true,
    persona: {
      id: "",
      name: "",
      description: "",
      personaMessage: "",
      isPublished: false,
      createdAt: new Date(),
      type: "PERSONA" as const,
      userId: "",
      extensionIds: [],
    },
  },
}));

vi.mock("./persona-store", () => ({
  personaStore: {
    updateOpened: vi.fn(),
  },
  usePersonaState: vi.fn().mockReturnValue(mockPersonaState),
  AddOrUpdatePersona: vi.fn().mockResolvedValue({ status: "OK", response: {} }),
}));

// Mock sub-components that pull in heavy dependencies
vi.mock("../chat-page/chat-header/extension-detail", () => ({
  ExtensionDetail: () => <div data-testid="extension-detail" />,
}));

// The Files section reports whether the agent's files need the code
// interpreter; the test decides the answer.
const { filesNeedCodeInterpreter, filesBusy } = vi.hoisted(() => ({
  filesNeedCodeInterpreter: { value: false },
  filesBusy: { value: false },
}));
vi.mock("./persona-files/persona-files", async () => {
  const React = await import("react");
  return {
    PersonaFiles: (props: any) => {
      React.useEffect(() => {
        props.onNeedsCodeInterpreterChange?.(filesNeedCodeInterpreter.value);
        props.onBusyChange?.(filesBusy.value);
      }, [props.personaId]);
      return <div data-testid="persona-files" data-persona-id={props.personaId} />;
    },
  };
});

vi.mock("./persona-access-group/persona-access-group", () => ({
  PersonaAccessGroup: (props: any) => (
    <div
      data-testid="persona-access-group"
      data-published={String(props.initialIsPublished)}
      data-trust={props.trustLevel ?? ""}
    />
  ),
}));

vi.mock("../chat-page/chat-services/models", async () => {
  const actual = await vi.importActual<any>("../chat-page/chat-services/models");
  return {
    ...actual,
    getAvailableModels: vi.fn().mockResolvedValue(actual.MODEL_CONFIGS),
  };
});

vi.mock("@/features/ui/advanced-loading-indicator", () => ({
  AdvancedLoadingIndicator: () => null,
}));

vi.mock("@/features/common/services/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

import { AddNewPersona } from "./add-new-persona";
import { personaStore, usePersonaState } from "./persona-store";

describe("persona-page.unit.components.001/002 — AddNewPersona", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    filesNeedCodeInterpreter.value = false;
    filesBusy.value = false;
    (usePersonaState as any).mockReturnValue({ ...mockPersonaState });
  });

  it("stays open on Escape while a file action runs", async () => {
    filesBusy.value = true;
    render(<AddNewPersona extensions={[]} personas={[]} />);
    await userEvent.keyboard("{Escape}");
    expect(personaStore.updateOpened).not.toHaveBeenCalled();
  });

  it("closes on Escape when no file action runs", async () => {
    render(<AddNewPersona extensions={[]} personas={[]} />);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(personaStore.updateOpened).toHaveBeenCalledWith(false));
  });

  it("shows one Files section instead of the four old file sections (decision 1)", () => {
    (usePersonaState as any).mockReturnValue({
      ...mockPersonaState,
      persona: { ...mockPersonaState.persona, id: "p1" },
    });
    render(<AddNewPersona extensions={[]} personas={[]} />);
    expect(screen.getByTestId("persona-files").dataset.personaId).toBe("p1");
    expect(screen.queryByText("Agent Documents")).not.toBeInTheDocument();
    expect(screen.queryByText("Code Interpreter Documents")).not.toBeInTheDocument();
    expect(screen.queryByText("Skills")).not.toBeInTheDocument();
    expect(screen.queryByText("SharePoint files for the model")).not.toBeInTheDocument();
  });

  it("sends no file ids with the form (decision 8)", () => {
    const { container } = render(<AddNewPersona extensions={[]} personas={[]} />);
    const names = Array.from(container.ownerDocument.querySelectorAll("input[type=hidden]")).map(
      (i) => (i as HTMLInputElement).name,
    );
    expect(names).not.toContain("personaDocumentIds");
    expect(names).not.toContain("ciDocumentIds");
    expect(names).not.toContain("selectedSharePointDocumentIds");
    expect(names).not.toContain("selectedCIDocumentIds");
  });

  it("keeps the code interpreter on and locked while the files need it (decision 6)", async () => {
    filesNeedCodeInterpreter.value = true;
    (usePersonaState as any).mockReturnValue({
      ...mockPersonaState,
      persona: { ...mockPersonaState.persona, id: "p1", defaultTools: { codeInterpreter: false } },
    });
    render(<AddNewPersona extensions={[]} personas={[]} />);
    const box = screen.getByRole("checkbox", { name: "Code Interpreter" }) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    expect(box.disabled).toBe(true);
    expect(screen.getByText("The files of this agent need the code interpreter.")).toBeInTheDocument();
    const hidden = document.querySelector("input[name=defaultTools]") as HTMLInputElement;
    expect(JSON.parse(hidden.value)).toMatchObject({ codeInterpreter: true });
  });

  it("leaves the code interpreter free when no file needs it", () => {
    render(<AddNewPersona extensions={[]} personas={[]} />);
    const box = screen.getByRole("checkbox", { name: "Code Interpreter" }) as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(screen.queryByText("The files of this agent need the code interpreter.")).not.toBeInTheDocument();
  });

  it("the hidden id follows the agent in the store (the editor stays open after the first save)", () => {
    const { rerender } = render(<AddNewPersona extensions={[]} personas={[]} />);
    const id = () => (document.querySelector("input[name=id]") as HTMLInputElement).value;
    expect(id()).toBe("");
    (usePersonaState as any).mockReturnValue({
      ...mockPersonaState,
      persona: { ...mockPersonaState.persona, id: "new-id" },
    });
    rerender(<AddNewPersona extensions={[]} personas={[]} />);
    expect(id()).toBe("new-id");
  });

  it("renders the Agent sheet when isOpened is true", () => {
    render(<AddNewPersona extensions={[]} personas={[]} />);
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });

  it("shows Name and description fields", () => {
    render(<AddNewPersona extensions={[]} personas={[]} />);
    expect(screen.getByPlaceholderText(/name of your agent/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/short description/i)).toBeInTheDocument();
  });

  it("passes publish state into the access section (unpublished, no trust)", () => {
    render(<AddNewPersona extensions={[]} personas={[]} />);
    const access = screen.getByTestId("persona-access-group");
    expect(access.dataset.published).toBe("false");
    expect(access.dataset.trust).toBe("");
  });

  it("passes the legacy-verified trust level when published without trustLevel", () => {
    (usePersonaState as any).mockReturnValue({
      ...mockPersonaState,
      persona: { ...mockPersonaState.persona, isPublished: true },
    });
    render(<AddNewPersona extensions={[]} personas={[]} />);
    const access = screen.getByTestId("persona-access-group");
    // Published without a stored trustLevel = legacy admin publish → verified.
    expect(access.dataset.published).toBe("true");
    expect(access.dataset.trust).toBe("verified");
  });

  it("passes the community trust level for community-published agents", () => {
    (usePersonaState as any).mockReturnValue({
      ...mockPersonaState,
      persona: {
        ...mockPersonaState.persona,
        isPublished: true,
        trustLevel: "community",
      },
    });
    render(<AddNewPersona extensions={[]} personas={[]} />);
    expect(screen.getByTestId("persona-access-group").dataset.trust).toBe(
      "community"
    );
  });

  it("does not render the sheet when isOpened is false", () => {
    (usePersonaState as any).mockReturnValue({
      ...mockPersonaState,
      isOpened: false,
    });
    render(<AddNewPersona extensions={[]} personas={[]} />);
    // Sheet content should not be visible
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
  });
});
