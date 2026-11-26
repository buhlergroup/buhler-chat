import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Graph client mock ────────────────────────────────────────────────────────
const mockGraphPost = vi.fn();
vi.mock("@/features/common/services/microsoft-graph-client", () => ({
  getGraphClient: vi.fn(() => ({
    api: vi.fn(() => ({ post: mockGraphPost })),
  })),
}));

// ── auth helpers mock ────────────────────────────────────────────────────────
const mockGetCurrentUser = vi.fn();
vi.mock("@/features/auth-page/helpers", () => ({
  getCurrentUser: (...args: any[]) => mockGetCurrentUser(...args),
  userHashedId: async () => "verifier-hash",
}));

// ── Cosmos mock ──────────────────────────────────────────────────────────────
const mockQueryFetchAll = vi.fn();
const mockPatch = vi.fn();
let lastItemArgs: [string, string] | null = null;

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: vi.fn(() => ({
    items: {
      query: vi.fn(() => ({ fetchAll: mockQueryFetchAll })),
    },
    item: (id: string, pk: string) => {
      lastItemArgs = [id, pk];
      return { patch: mockPatch };
    },
  })),
}));

vi.mock("@/features/common/navigation-helpers", () => ({
  RevalidateCache: vi.fn(),
}));

vi.mock("@/features/common/services/logger", () => ({
  logError: vi.fn(),
}));

import {
  IsAgentVerifier,
  SetAgentTrustLevel,
  UnpublishAgent,
} from "./agent-trust-service";

const GROUP_ID = "11111111-2222-3333-4444-555555555555";

const graphUser = () => ({
  name: "U",
  email: "u@buhlergroup.com",
  isAdmin: false,
  isLocalDevUser: false,
  token: "graph-token",
});

const seedPersonaDoc = (overrides: Record<string, any> = {}) => ({
  id: "p1",
  userId: "owner-hash",
  name: "Agent",
  description: "d",
  personaMessage: "m",
  isPublished: true,
  type: "PERSONA",
  createdAt: new Date(),
  extensionIds: [],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  lastItemArgs = null;
  vi.stubEnv("AGENT_VERIFIER_GROUP_ID", GROUP_ID);
  mockGetCurrentUser.mockResolvedValue(graphUser());
  mockGraphPost.mockResolvedValue({ value: [GROUP_ID] });
  mockQueryFetchAll.mockResolvedValue({ resources: [seedPersonaDoc()] });
  mockPatch.mockImplementation(async (ops: any[]) => ({
    resource: { ...seedPersonaDoc(), _patched: ops },
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("persona.unit.agent-trust — IsAgentVerifier", () => {
  it("trust.001: false when AGENT_VERIFIER_GROUP_ID is unset (fail closed)", async () => {
    vi.stubEnv("AGENT_VERIFIER_GROUP_ID", "");
    await expect(IsAgentVerifier()).resolves.toBe(false);
    expect(mockGraphPost).not.toHaveBeenCalled();
  });

  it("trust.002: true for local-dev users without hitting Graph", async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...graphUser(),
      isLocalDevUser: true,
    });
    await expect(IsAgentVerifier()).resolves.toBe(true);
    expect(mockGraphPost).not.toHaveBeenCalled();
  });

  it("trust.003: true when checkMemberGroups returns the group", async () => {
    await expect(IsAgentVerifier()).resolves.toBe(true);
    expect(mockGraphPost).toHaveBeenCalledWith({ groupIds: [GROUP_ID] });
  });

  it("trust.004: false when the group is not in the response", async () => {
    mockGraphPost.mockResolvedValue({ value: [] });
    await expect(IsAgentVerifier()).resolves.toBe(false);
  });

  it("trust.005: false on Graph errors (fail closed)", async () => {
    mockGraphPost.mockRejectedValue(new Error("graph down"));
    await expect(IsAgentVerifier()).resolves.toBe(false);
  });

  it("trust.006: false when the user has no token", async () => {
    mockGetCurrentUser.mockResolvedValue({ ...graphUser(), token: "" });
    await expect(IsAgentVerifier()).resolves.toBe(false);
    expect(mockGraphPost).not.toHaveBeenCalled();
  });
});

describe("persona.unit.agent-trust — SetAgentTrustLevel", () => {
  it("trust.007: UNAUTHORIZED for non-members; nothing written", async () => {
    mockGraphPost.mockResolvedValue({ value: [] });
    const result = await SetAgentTrustLevel("p1", "verified");
    expect(result.status).toBe("UNAUTHORIZED");
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("trust.008: patches /trustLevel on the owner's partition", async () => {
    const result = await SetAgentTrustLevel("p1", "verified");
    expect(result.status).toBe("OK");
    expect(lastItemArgs).toEqual(["p1", "owner-hash"]);
    expect(mockPatch).toHaveBeenCalledWith([
      { op: "set", path: "/trustLevel", value: "verified" },
    ]);
  });

  it("trust.009: NOT_FOUND when the agent does not exist", async () => {
    mockQueryFetchAll.mockResolvedValue({ resources: [] });
    const result = await SetAgentTrustLevel("missing", "verified");
    expect(result.status).toBe("NOT_FOUND");
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

describe("persona.unit.agent-trust — answer without editor-only fields", () => {
  it("trust.011: a verifier who cannot edit the agent gets no file or sub-agent ids", async () => {
    mockPatch.mockImplementation(async () => ({
      resource: seedPersonaDoc({
        personaDocumentIds: ["doc-1"],
        codeInterpreterDocumentIds: ["ci-1"],
        subAgentIds: ["sub-1"],
      }),
    }));
    for (const result of [await SetAgentTrustLevel("p1", "verified"), await UnpublishAgent("p1")]) {
      expect(result.status).toBe("OK");
      const response = (result as { response: Record<string, unknown> }).response;
      expect(response.name).toBe("Agent");
      expect(response).not.toHaveProperty("personaDocumentIds");
      expect(response).not.toHaveProperty("codeInterpreterDocumentIds");
      expect(response).not.toHaveProperty("subAgentIds");
    }
  });
});

describe("persona.unit.agent-trust — UnpublishAgent", () => {
  it("trust.010: unpublish stamps community (blocks legacy auto-verify)", async () => {
    const result = await UnpublishAgent("p1");
    expect(result.status).toBe("OK");
    expect(mockPatch).toHaveBeenCalledWith([
      { op: "set", path: "/isPublished", value: false },
      { op: "set", path: "/trustLevel", value: "community" },
    ]);
  });

  it("trust.011: UNAUTHORIZED for non-members", async () => {
    mockGraphPost.mockResolvedValue({ value: [] });
    const result = await UnpublishAgent("p1");
    expect(result.status).toBe("UNAUTHORIZED");
    expect(mockPatch).not.toHaveBeenCalled();
  });
});
