import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// The embed landing page with the REAL FindPersonaByID and canOpenPersona;
// only the stored agent, the session and the UI leaves are mocked.
const { stored, viewer } = vi.hoisted(() => ({
  stored: { persona: undefined as any },
  viewer: { userId: "viewer-hash", isAdmin: false },
}));

vi.mock("@/features/auth-page/helpers", () => ({
  userSession: vi.fn(async () => ({ name: "Viewer", email: "v@example.test" })),
  getCurrentUser: vi.fn(async () => ({ name: "Viewer", isAdmin: false })),
  userHashedId: vi.fn(async () => viewer.userId),
}));

vi.mock(
  "@/features/persona-page/persona-services/persona-access",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("@/features/persona-page/persona-services/persona-access")
    >();
    return {
      ...actual,
      findPersonaDocument: vi.fn(async (id: string) =>
        stored.persona?.id === id ? stored.persona : undefined
      ),
      currentPersonaViewer: vi.fn(async () => viewer),
    };
  }
);

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: vi.fn(),
  ConfigContainer: vi.fn(),
}));
vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));
vi.mock("@/features/persona-page/persona-services/access-group-service", () => ({
  AccessGroupById: vi.fn(async () => ({ status: "ERROR", errors: [{ message: "no" }] })),
  UserAccessGroups: vi.fn(async () => ({ status: "OK", response: [] })),
}));
vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("@/features/embed/embed-agent-card", () => ({
  EmbedAgentCard: ({ persona }: any) => <div data-testid="agent-card">{persona.name}</div>,
}));
vi.mock("@/features/embed/embed-frame", () => ({
  EmbedFrame: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/features/embed/embed-sign-in", () => ({
  EmbedSignIn: () => <div>sign in</div>,
}));

import EmbedAgentStart from "./page";

const agent = (overrides: Record<string, unknown> = {}) => ({
  id: "p-link",
  name: "Link Agent",
  description: "d",
  personaMessage: "m",
  userId: "owner-hash",
  isPublished: false,
  extensionIds: [],
  type: "PERSONA",
  createdAt: new Date(),
  ...overrides,
});

const renderPage = async (personaId: string) =>
  render(await EmbedAgentStart({ params: Promise.resolve({ personaId }) }));

beforeEach(() => {
  stored.persona = undefined;
});

// Pinned: a link to another user's agent works again (link access is on
// unless the owner turned it off).
describe("embed agent landing — link access", () => {
  it("renders the agent card for a link agent of another user (field not stored)", async () => {
    stored.persona = agent();
    await renderPage("p-link");
    expect(screen.getByTestId("agent-card")).toHaveTextContent("Link Agent");
  });

  it("renders 'Agent not found.' when the owner turned link access off", async () => {
    stored.persona = agent({ linkAccess: false });
    await renderPage("p-link");
    expect(screen.queryByTestId("agent-card")).not.toBeInTheDocument();
    expect(screen.getByText("Agent not found.")).toBeInTheDocument();
  });
});
