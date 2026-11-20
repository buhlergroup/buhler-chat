import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockDeletePersona } = vi.hoisted(() => ({
  mockDeletePersona: vi.fn().mockResolvedValue({ status: "OK" }),
}));

vi.mock("../persona-services/persona-service", () => ({
  DeletePersona: mockDeletePersona,
}));

const { mockUnpublishAgent } = vi.hoisted(() => ({
  mockUnpublishAgent: vi.fn().mockResolvedValue({ status: "OK" }),
}));

vi.mock("../persona-services/agent-trust-service", () => ({
  SetAgentTrustLevel: vi.fn().mockResolvedValue({ status: "OK" }),
  UnpublishAgent: mockUnpublishAgent,
}));

const { mockUpdatePersona } = vi.hoisted(() => ({
  mockUpdatePersona: vi.fn(),
}));

vi.mock("../persona-store", () => ({
  personaStore: {
    updatePersona: mockUpdatePersona,
  },
}));

const { mockRevalidateCache } = vi.hoisted(() => ({
  mockRevalidateCache: vi.fn(),
}));

vi.mock("@/features/common/navigation-helpers", () => ({
  RevalidateCache: mockRevalidateCache,
}));

vi.mock("@/features/chat-page/chat-menu/chat-menu-item", () => ({
  DropdownMenuItemWithIcon: ({ children, onClick }: any) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

import { PersonaCardContextMenu } from "./persona-card-context-menu";
import type { PersonaModel } from "../persona-services/models";

const persona: PersonaModel = {
  id: "p1",
  name: "TestPersona",
  description: "A test persona",
  personaMessage: "instructions",
  createdAt: new Date(),
  isPublished: false,
  type: "PERSONA",
  userId: "u1",
  extensionIds: [],
};

describe("persona-page.unit.components.004 — PersonaCardContextMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const openMenu = async () => {
    render(<PersonaCardContextMenu persona={persona} />);
    const trigger = screen.getByRole("button");
    await userEvent.click(trigger);
  };

  it("renders Edit and Delete options in the dropdown", async () => {
    await openMenu();
    expect(screen.getByText(/edit/i)).toBeInTheDocument();
    expect(screen.getByText(/delete/i)).toBeInTheDocument();
  });

  it("does NOT render a Publish option", () => {
    render(<PersonaCardContextMenu persona={persona} />);
    expect(screen.queryByText(/publish/i)).not.toBeInTheDocument();
  });

  it("clicking Edit calls personaStore.updatePersona with the persona", async () => {
    await openMenu();
    await userEvent.click(screen.getByText(/edit/i));
    expect(mockUpdatePersona).toHaveBeenCalledWith(persona);
  });

  // -- Delete: the app's dialog, not window.confirm --------------------------

  const askDelete = async () => {
    const confirmSpy = vi.fn();
    vi.stubGlobal("confirm", confirmSpy);
    await openMenu();
    await userEvent.click(screen.getByText(/delete/i));
    const dialog = await screen.findByTestId("persona-card-confirm");
    return { dialog, confirmSpy };
  };

  it("asks in the app's dialog with the agent name, never with window.confirm", async () => {
    const { dialog, confirmSpy } = await askDelete();
    expect(dialog).toHaveTextContent(
      'Delete the agent "TestPersona"? Its files, skills and folder links are removed from the agent. Chats that already used it stay.',
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mockDeletePersona).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("Delete in the dialog calls DeletePersona and RevalidateCache", async () => {
    const { dialog } = await askDelete();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(mockDeletePersona).toHaveBeenCalledWith("p1");
    });
    expect(mockRevalidateCache).toHaveBeenCalledWith({ page: "persona" });
    expect(mockRevalidateCache).toHaveBeenCalledWith({ page: "agent" });
    vi.unstubAllGlobals();
  });

  it("Cancel keeps the agent: no DeletePersona, no RevalidateCache", async () => {
    const { dialog } = await askDelete();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("persona-card-confirm")).not.toBeInTheDocument());
    expect(mockDeletePersona).not.toHaveBeenCalled();
    expect(mockRevalidateCache).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  const askUnpublish = async () => {
    const confirmSpy = vi.fn();
    vi.stubGlobal("confirm", confirmSpy);
    render(
      <PersonaCardContextMenu persona={{ ...persona, isPublished: true }} showOwnerActions={false} isVerifier />,
    );
    await userEvent.click(screen.getByRole("button"));
    await userEvent.click(screen.getByText("Unpublish agent"));
    const dialog = await screen.findByTestId("persona-card-confirm");
    return { dialog, confirmSpy };
  };

  it("Unpublish (governance) asks in the app's dialog; Cancel keeps it published", async () => {
    const { dialog, confirmSpy } = await askUnpublish();
    expect(dialog).toHaveTextContent('Unpublish the agent "TestPersona" for the whole organization?');
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("persona-card-confirm")).not.toBeInTheDocument());
    expect(mockUnpublishAgent).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("Unpublish in the dialog calls UnpublishAgent", async () => {
    const { dialog } = await askUnpublish();
    await userEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }));
    await waitFor(() => expect(mockUnpublishAgent).toHaveBeenCalledWith("p1"));
    vi.unstubAllGlobals();
  });
});
