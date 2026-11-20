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

vi.mock("./persona-documents/persona-documents", () => ({
  PersonaDocuments: () => <div data-testid="persona-documents" />,
}));

vi.mock("./persona-documents/code-interpreter-documents", () => ({
  CodeInterpreterDocuments: () => <div data-testid="ci-documents" />,
}));

vi.mock("./persona-access-group/persona-access-group", () => ({
  PersonaAccessGroup: (props: any) => (
    <div
      data-testid="persona-access-group"
      data-published={String(props.initialIsPublished)}
      data-trust={props.trustLevel ?? ""}
      data-link-access={String(props.initialLinkAccess)}
      data-persona-id={props.personaId ?? ""}
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
import { usePersonaState } from "./persona-store";

describe("persona-page.unit.components.001/002 — AddNewPersona", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (usePersonaState as any).mockReturnValue({ ...mockPersonaState });
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

  it("passes the stored link access and the agent id into the access section", () => {
    (usePersonaState as any).mockReturnValue({
      ...mockPersonaState,
      persona: { ...mockPersonaState.persona, id: "p-42", linkAccess: false },
    });
    render(<AddNewPersona extensions={[]} personas={[]} />);
    const access = screen.getByTestId("persona-access-group");
    expect(access.dataset.linkAccess).toBe("false");
    expect(access.dataset.personaId).toBe("p-42");
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
