import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockAccessGroupById } = vi.hoisted(() => ({
  mockAccessGroupById: vi.fn(),
}));

vi.mock("../persona-services/access-group-service", () => ({
  AccessGroupById: mockAccessGroupById,
  UserAccessGroups: vi.fn().mockResolvedValue({ status: "OK", response: [] }),
}));

vi.mock("@/features/auth-page/logout-on-session-expired", () => ({
  logoutOnSessionExpired: vi.fn().mockReturnValue(false),
}));

vi.mock("./persona-access-group-selector", () => ({
  PersonaAccessGroupSelector: ({
    onSelectGroup,
    selectedAccessGroupId,
    disabled,
  }: any) => (
    <button
      data-testid="group-selector"
      data-selected={selectedAccessGroupId}
      disabled={disabled}
      onClick={() =>
        onSelectGroup({ id: "g99", name: "Test Group", description: "tg" })
      }
    >
      Select Group
    </button>
  ),
}));

vi.mock("@/features/ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <div>{children}</div>,
  TooltipProvider: ({ children }: any) => <>{children}</>,
}));

import { PersonaAccessGroup } from "./persona-access-group";

const defaultProps = {
  initialSelectedGroup: null,
  initialIsPublished: false,
  trustLevel: null,
};

describe("persona-page.unit.components.008 — PersonaAccessGroup", () => {
  beforeEach(() => vi.clearAllMocks());

  // ── No initial group ──────────────────────────────────────────────────────

  it("renders 'Only you can access this agent' when no group and unpublished", () => {
    render(<PersonaAccessGroup {...defaultProps} />);
    expect(
      screen.getByDisplayValue("Only you can access this agent")
    ).toBeInTheDocument();
  });

  it("Trash button is disabled when no group selected", () => {
    render(<PersonaAccessGroup {...defaultProps} />);
    const buttons = screen.getAllByRole("button");
    const trashBtn = buttons.find((b) => b.hasAttribute("disabled"));
    expect(trashBtn).toBeDefined();
  });

  it("hidden accessGroupId input is empty when no group selected", () => {
    const { container } = render(<PersonaAccessGroup {...defaultProps} />);
    const hidden = container.querySelector<HTMLInputElement>(
      'input[name="accessGroupId"]'
    );
    expect(hidden?.value).toBe("");
  });

  // ── With initial group ────────────────────────────────────────────────────

  it("fetches group details and shows group name when initialSelectedGroup is provided", async () => {
    mockAccessGroupById.mockResolvedValue({
      status: "OK",
      response: { id: "g1", name: "Finance", description: "" },
    });
    render(
      <PersonaAccessGroup {...defaultProps} initialSelectedGroup="g1" />
    );
    await waitFor(() => {
      expect(screen.getByDisplayValue("Finance")).toBeInTheDocument();
    });
    expect(mockAccessGroupById).toHaveBeenCalledWith("g1");
  });

  it("falls back to no group when fetch returns error", async () => {
    mockAccessGroupById.mockResolvedValue({
      status: "ERROR",
      errors: [{ message: "not found" }],
    });
    render(
      <PersonaAccessGroup {...defaultProps} initialSelectedGroup="g-bad" />
    );
    await waitFor(() => {
      expect(
        screen.getByDisplayValue("Only you can access this agent")
      ).toBeInTheDocument();
    });
  });

  // ── Selecting a group via selector ────────────────────────────────────────

  it("shows the newly selected group name after selector fires onSelectGroup", async () => {
    render(<PersonaAccessGroup {...defaultProps} />);
    await userEvent.click(screen.getByTestId("group-selector"));
    await waitFor(() => {
      expect(screen.getByDisplayValue("Test Group")).toBeInTheDocument();
    });
  });

  it("clears group when Trash button is clicked", async () => {
    render(<PersonaAccessGroup {...defaultProps} />);
    await userEvent.click(screen.getByTestId("group-selector"));
    await waitFor(() => screen.getByDisplayValue("Test Group"));

    const trashButtons = screen
      .getAllByRole("button")
      .filter(
        (b) =>
          !b.hasAttribute("disabled") &&
          b !== screen.getByTestId("group-selector")
      );
    await userEvent.click(trashButtons[0]);
    await waitFor(() => {
      expect(
        screen.getByDisplayValue("Only you can access this agent")
      ).toBeInTheDocument();
    });
  });

  // ── Publishing ────────────────────────────────────────────────────────────

  it("shows the published summary and disables group controls when published", () => {
    render(
      <PersonaAccessGroup
        {...defaultProps}
        initialIsPublished
        trustLevel="community"
      />
    );
    expect(
      screen.getByDisplayValue("Published — everyone can use this agent")
    ).toBeInTheDocument();
    // Publish switch is on; group selector and trash are deactivated.
    expect(screen.getByRole("switch")).toBeChecked();
    expect(screen.getByTestId("group-selector")).toBeDisabled();
    expect(screen.getByText("Community")).toBeInTheDocument();
  });

  it("toggling the publish switch updates summary and re-enables the selector", async () => {
    render(<PersonaAccessGroup {...defaultProps} />);
    const publishSwitch = screen.getByRole("switch");
    expect(publishSwitch).not.toBeChecked();

    await userEvent.click(publishSwitch);
    expect(
      screen.getByDisplayValue("Published — everyone can use this agent")
    ).toBeInTheDocument();
    expect(screen.getByTestId("group-selector")).toBeDisabled();

    await userEvent.click(publishSwitch);
    expect(
      screen.getByDisplayValue("Only you can access this agent")
    ).toBeInTheDocument();
    expect(screen.getByTestId("group-selector")).not.toBeDisabled();
  });

  it("publish switch has an accessible name", () => {
    render(<PersonaAccessGroup {...defaultProps} />);
    expect(
      screen.getByRole("switch", { name: "Publish to the whole organization" })
    ).toBeInTheDocument();
  });
});

// Pinned: the agent owner learns that sharing an agent shares the stored
// credentials of its extensions, as soon as the agent is shared or published.
describe("PersonaAccessGroup — shared notice", () => {
  const notice = <div data-testid="shared-notice">stored credentials</div>;

  it("hides the notice while only the owner can use the agent", () => {
    render(<PersonaAccessGroup {...defaultProps} sharedNotice={notice} />);
    expect(screen.queryByTestId("shared-notice")).not.toBeInTheDocument();
  });

  it("shows the notice when the owner turns on publishing", async () => {
    render(<PersonaAccessGroup {...defaultProps} sharedNotice={notice} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(screen.getByTestId("shared-notice")).toBeInTheDocument();
  });

  it("shows the notice when the owner selects a group", async () => {
    render(<PersonaAccessGroup {...defaultProps} sharedNotice={notice} />);
    await userEvent.click(screen.getByTestId("group-selector"));
    expect(screen.getByTestId("shared-notice")).toBeInTheDocument();
  });

  it("shows the notice for an agent that is already published", () => {
    render(<PersonaAccessGroup {...defaultProps} initialIsPublished sharedNotice={notice} />);
    expect(screen.getByTestId("shared-notice")).toBeInTheDocument();
  });
});
