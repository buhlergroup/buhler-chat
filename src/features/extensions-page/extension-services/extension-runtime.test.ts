import { describe, it, expect, vi } from "vitest";

vi.mock("@/features/common/services/cosmos", () => ({ HistoryContainer: vi.fn() }));
vi.mock("@/features/auth-page/helpers", () => ({ userHashedId: vi.fn() }));
vi.mock("@/features/persona-page/persona-services/access-group-service", () => ({
  AccessGroupById: vi.fn(),
}));
vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

import { logInfo } from "@/features/common/services/logger";
import {
  extensionIdsForAgentSave,
  resolveExtensionsForChat,
  usableExtensionIdsForAgent,
  type ResolveExtensionsDeps,
} from "./extension-runtime";
import type { SecretStore } from "./extension-secrets";
import type { ExtensionModel } from "./models";

const FAKE_SECRET = "fake-test-value";

const fakeStore = (values: Record<string, string>): SecretStore => ({
  get: vi.fn(async (name: string) => values[name]),
  set: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  removeTagged: vi.fn(async () => 0),
});

const mcpExtension = (overrides: Partial<ExtensionModel> = {}): ExtensionModel => ({
  id: "mcpExt0000000000000000000000000000001",
  name: "Market data",
  description: "d",
  executionSteps: "s",
  headers: [],
  functions: [],
  userId: "agent-owner",
  isPublished: false,
  createdAt: new Date(),
  type: "EXTENSION",
  kind: "mcp",
  mcp: {
    url: "https://mcp.example.com/mcp",
    transport: "auto",
    secrets: [
      { id: "sec-bearer", name: "MCP_TOKEN", value: "**********", placement: "bearer" },
      { id: "sec-query", name: "key", value: "**********", placement: "query", target: "api_key" },
      { id: "sec-header", name: "X_TEAM", value: "**********", placement: "header" },
      { id: "sec-plain", name: "X-MCP-Readonly", target: "X-MCP-Readonly", value: "**********", placement: "header" },
    ],
    toolAllowList: [],
    auth: "none",
  },
  ...overrides,
});

const deps = (over: Partial<ResolveExtensionsDeps> = {}): ResolveExtensionsDeps => ({
  userId: async () => "chat-user",
  findExtensions: async () => [mcpExtension()],
  findAgent: async () => ({
    id: "agent-1",
    userId: "agent-owner",
    isPublished: true,
    extensionIds: ["mcpExt0000000000000000000000000000001"],
  }),
  isGroupMember: async () => false,
  store: () =>
    fakeStore({
      "sec-bearer": FAKE_SECRET,
      "sec-query": "q-value",
      "sec-header": "h-value",
      "sec-plain": "true",
    }),
  ...over,
});

describe("resolveExtensionsForChat", () => {
  it("gives a user of a published agent the agent's MCP extension with its secrets placed", async () => {
    const result = await resolveExtensionsForChat(
      { extensionIds: ["mcpExt0000000000000000000000000000001"], personaId: "agent-1" },
      deps()
    );
    expect(result).toHaveLength(1);
    const mcp = result[0].mcp!;
    expect(mcp.headers.Authorization).toBe(`Bearer ${FAKE_SECRET}`);
    expect(mcp.headers.X_TEAM).toBe("h-value");
    expect(mcp.headers["X-MCP-Readonly"]).toBe("true");
    expect(new URL(mcp.url).searchParams.get("api_key")).toBe("q-value");
    expect(mcp.authProvider).toBeUndefined();
  });

  it("sends a plain Authorization header row exactly as typed (no Bearer prefix added)", async () => {
    const ext = mcpExtension({
      userId: "chat-user",
      mcp: {
        ...mcpExtension().mcp!,
        secrets: [
          { id: "sec-auth", name: "Authorization", target: "Authorization", value: "**********", placement: "header" },
        ],
      },
    });
    const result = await resolveExtensionsForChat(
      { extensionIds: [ext.id] },
      deps({
        findExtensions: async () => [ext],
        store: () => fakeStore({ "sec-auth": `Token ${FAKE_SECRET}` }),
      })
    );
    expect(result[0].mcp?.headers).toEqual({ Authorization: `Token ${FAKE_SECRET}` });
    expect(result[0].mcp?.url).toBe("https://mcp.example.com/mcp");
  });

  it("gives nothing when the thread has no agent and the user does not own the extension", async () => {
    const result = await resolveExtensionsForChat(
      { extensionIds: ["mcpExt0000000000000000000000000000001"] },
      deps()
    );
    expect(result).toEqual([]);
  });

  it("gives nothing when the user cannot open the agent", async () => {
    const result = await resolveExtensionsForChat(
      { extensionIds: ["mcpExt0000000000000000000000000000001"], personaId: "agent-1" },
      deps({
        findAgent: async () => ({
          id: "agent-1",
          userId: "agent-owner",
          isPublished: false,
          accessGroup: { id: "g" },
          extensionIds: ["mcpExt0000000000000000000000000000001"],
        }),
      })
    );
    expect(result).toEqual([]);
  });

  // Pinned (temporary rule 4 "legacy"): an agent saved before the access rule
  // lists another user's private extension. A viewer who can open the agent
  // still gets it with its secrets (server side only), and the use is logged
  // with ids only.
  it("gives a viewer of the agent a legacy extension of another user and logs it by id", async () => {
    vi.mocked(logInfo).mockClear();
    const foreign = mcpExtension({ userId: "third-party" });
    const result = await resolveExtensionsForChat(
      { extensionIds: [foreign.id], personaId: "agent-1" },
      deps({ findExtensions: async () => [foreign] })
    );
    expect(result).toHaveLength(1);
    expect(result[0].extension.id).toBe(foreign.id);
    expect(result[0].mcp?.headers.Authorization).toBe(`Bearer ${FAKE_SECRET}`);
    expect(logInfo).toHaveBeenCalledWith(
      "resolveExtensionsForChat: legacy foreign extension on agent",
      { personaId: "agent-1", extensionId: foreign.id }
    );
    const logged = JSON.stringify(vi.mocked(logInfo).mock.calls);
    expect(logged).not.toContain(FAKE_SECRET);
    expect(logged).not.toContain(foreign.name);
  });

  it("gives no legacy extension to a user who cannot open the agent", async () => {
    const foreign = mcpExtension({ userId: "third-party" });
    const result = await resolveExtensionsForChat(
      { extensionIds: [foreign.id], personaId: "agent-1" },
      deps({
        findExtensions: async () => [foreign],
        findAgent: async () => ({
          id: "agent-1",
          userId: "agent-owner",
          isPublished: false,
          accessGroup: { id: "g" },
          extensionIds: [foreign.id],
        }),
      })
    );
    expect(result).toEqual([]);
  });

  it("does not touch Cosmos or Key Vault for a thread without extensions", async () => {
    const findExtensions = vi.fn();
    const result = await resolveExtensionsForChat({ extensionIds: [] }, deps({ findExtensions }));
    expect(result).toEqual([]);
    expect(findExtensions).not.toHaveBeenCalled();
  });

  it("adds an OAuth provider for an OAuth MCP server", async () => {
    const ext = mcpExtension({
      userId: "chat-user",
      mcp: { ...mcpExtension().mcp!, secrets: [], auth: "oauth", oauth: {} },
    });
    const result = await resolveExtensionsForChat(
      { extensionIds: [ext.id] },
      deps({ findExtensions: async () => [ext] })
    );
    expect(result[0].mcp?.authProvider).toBeDefined();
  });

  it("keeps HTTP extensions working with header secrets", async () => {
    const http: ExtensionModel = {
      ...mcpExtension({ userId: "chat-user" }),
      id: "http-1",
      kind: undefined,
      mcp: undefined,
      headers: [{ id: "hdr-1", key: "x-api-key", value: "**********" }],
    };
    const result = await resolveExtensionsForChat(
      { extensionIds: ["http-1"] },
      deps({ findExtensions: async () => [http], store: () => fakeStore({ "hdr-1": "v" }) })
    );
    expect(result[0].headerSecrets).toEqual({ "x-api-key": "v" });
    expect(result[0].mcp).toBeUndefined();
  });
});

describe("usableExtensionIdsForAgent (CreatePersonaChat)", () => {
  const ext = (id: string, userId: string, isPublished = false): ExtensionModel => ({
    ...mcpExtension({ userId, isPublished }),
    id,
  });
  const agent = {
    id: "agent-1",
    userId: "agent-owner",
    isPublished: true,
    extensionIds: ["own-by-owner", "third-private", "third-published", "deleted"],
  };
  const findExtensions = async () => [
    ext("own-by-owner", "agent-owner"),
    ext("third-private", "someone-else"),
    ext("third-published", "someone-else", true),
  ];

  it("keeps the agent's extensions the chatting user may use, in the agent's order (legacy included)", async () => {
    const ids = await usableExtensionIdsForAgent(agent, "chat-user", {
      findExtensions,
      isGroupMember: async () => false,
    });
    // "third-private" is on the stored agent: rule 4 "legacy".
    expect(ids).toEqual(["own-by-owner", "third-private", "third-published"]);
  });

  it("drops the agent-granted and legacy ones when the user cannot open the agent", async () => {
    const ids = await usableExtensionIdsForAgent(
      { ...agent, accessGroup: { id: "g" } },
      "chat-user",
      { findExtensions, isGroupMember: async () => false }
    );
    expect(ids).toEqual(["third-published"]);
  });

  it("does not query Cosmos for an agent without extensions", async () => {
    const find = vi.fn();
    expect(
      await usableExtensionIdsForAgent({ ...agent, extensionIds: [] }, "chat-user", {
        findExtensions: find,
        isGroupMember: async () => false,
      })
    ).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});

describe("extensionIdsForAgentSave (CreatePersona, UpsertPersona)", () => {
  const ext = (id: string, userId: string, isPublished = false): ExtensionModel => ({
    ...mcpExtension({ userId, isPublished }),
    id,
  });
  const findExtensions = vi.fn(async (ids: readonly string[]) =>
    [
      ext("own", "agent-owner"),
      ext("published", "someone-else", true),
      ext("foreign-old", "someone-else"),
      ext("foreign-new", "someone-else"),
      ext("admin-own", "admin-user"),
    ].filter((e) => ids.includes(e.id))
  );

  it("keeps a foreign extension that is already on the stored agent", async () => {
    const { kept, refused } = await extensionIdsForAgentSave(
      {
        requestedIds: ["foreign-old", "own"],
        storedIds: ["foreign-old"],
        agentOwnerId: "agent-owner",
        agentId: "agent-1",
      },
      { findExtensions }
    );
    expect(kept).toEqual(["foreign-old", "own"]);
    expect(refused).toEqual([]);
  });

  it("refuses a NEW unpublished extension of another user", async () => {
    const { kept, refused } = await extensionIdsForAgentSave(
      {
        requestedIds: ["own", "foreign-new", "published"],
        storedIds: ["own"],
        agentOwnerId: "agent-owner",
        agentId: "agent-1",
      },
      { findExtensions }
    );
    expect(kept).toEqual(["own", "published"]);
    expect(refused).toEqual(["foreign-new"]);
  });

  it("treats nothing as legacy for a new agent and refuses unknown ids", async () => {
    const { kept, refused } = await extensionIdsForAgentSave(
      {
        requestedIds: ["foreign-old", "own", "deleted", "own"],
        storedIds: [],
        agentOwnerId: "agent-owner",
      },
      { findExtensions }
    );
    expect(kept).toEqual(["own"]);
    expect(refused).toEqual(["foreign-old", "deleted"]);
  });

  it("checks new ids against the agent owner, not an admin who saves", async () => {
    // An admin's own private extension would become a legacy attachment that
    // serves the admin's secrets to every viewer of the agent.
    const { kept, refused } = await extensionIdsForAgentSave(
      { requestedIds: ["admin-own"], storedIds: [], agentOwnerId: "agent-owner", agentId: "agent-1" },
      { findExtensions }
    );
    expect(kept).toEqual([]);
    expect(refused).toEqual(["admin-own"]);
  });

  it("does not query Cosmos when no id is new", async () => {
    findExtensions.mockClear();
    const { kept } = await extensionIdsForAgentSave(
      { requestedIds: ["foreign-old"], storedIds: ["foreign-old", "own"], agentOwnerId: "agent-owner" },
      { findExtensions }
    );
    expect(kept).toEqual(["foreign-old"]);
    expect(findExtensions).not.toHaveBeenCalled();
  });
});
