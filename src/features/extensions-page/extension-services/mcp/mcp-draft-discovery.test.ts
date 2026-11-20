// @vitest-environment node
/**
 * Draft tool discovery: the form's connection, before a save. Fake values
 * only; no network (a fake session factory, and a literal loopback IP for
 * the SSRF guard check, which fails before any request).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetCurrentUser, mockEnsure, mockLogWarn, fakeStore, mockOpenSession } = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    mockGetCurrentUser: vi.fn(),
    mockEnsure: vi.fn(),
    mockLogWarn: vi.fn(),
    mockOpenSession: vi.fn(),
    fakeStore: {
      values,
      get: vi.fn(async (name: string) => values.get(name)),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      removeTagged: vi.fn(async () => 0),
    },
  };
});

vi.mock("@/features/auth-page/helpers", () => ({
  getCurrentUser: mockGetCurrentUser,
  userHashedId: vi.fn(async () => "owner-hash"),
}));
vi.mock("@/features/common/services/cosmos", () => ({ HistoryContainer: vi.fn() }));
vi.mock("@/features/persona-page/persona-services/access-group-service", () => ({ AccessGroupById: vi.fn() }));
vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logWarn: mockLogWarn,
  logError: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../extension-service", () => ({ EnsureExtensionOperation: mockEnsure }));
vi.mock("../extension-secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extension-secrets")>()),
  keyVaultSecretStore: () => fakeStore,
}));
vi.mock("./mcp-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-client")>()),
  openMcpSession: mockOpenSession,
}));

import { KEY_VAULT_MASK } from "../extension-secrets";
import type { ExtensionModel } from "../models";
import type { McpConnectionOptions, McpSession } from "./mcp-client";
import { discoverDraftMcpTools, type McpDraftInput } from "./mcp-draft-discovery";
import { DiscoverDraftMcpTools } from "./mcp-service";

const FAKE_TOKEN = "Bearer fake-draft-token";
const FAKE_SAVED = "fake-saved-value";
const URL_OK = "https://mcp.example.test/mcp";

const seen: McpConnectionOptions[] = [];
const fakeSession: McpSessionFactoryLike = async (options) => {
  seen.push(options);
  return {
    listTools: async () => ({
      tools: [
        { name: "get_price", description: "Price of a symbol", inputSchema: { type: "object" } },
        { name: "bad name!", description: "dropped by the sanitizer" },
      ],
    }),
    callTool: async () => ({}),
    close: async () => {},
  } satisfies McpSession;
};
type McpSessionFactoryLike = (options: McpConnectionOptions) => Promise<McpSession>;

const storedExtension = (): ExtensionModel => ({
  id: "ext1",
  name: "n",
  description: "d",
  executionSteps: "s",
  headers: [],
  functions: [],
  userId: "owner-hash",
  isPublished: false,
  createdAt: new Date(),
  type: "EXTENSION",
  kind: "mcp",
  mcp: {
    url: URL_OK,
    transport: "auto",
    secrets: [{ id: "row1", name: "X-Team", target: "X-Team", placement: "header", value: KEY_VAULT_MASK }],
    toolAllowList: [],
    auth: "none",
  },
});

const draft = (overrides: Partial<McpDraftInput> = {}): McpDraftInput => ({
  url: URL_OK,
  transport: "streamable-http",
  secrets: [{ id: "new1", name: "Authorization", target: "Authorization", placement: "header", value: FAKE_TOKEN }],
  ...overrides,
});

const deps = (loadEditable = vi.fn(async () => storedExtension() as ExtensionModel | undefined)) => ({
  loadEditable,
  store: fakeStore,
  openSession: fakeSession,
});

beforeEach(() => {
  seen.length = 0;
  fakeStore.values.clear();
  fakeStore.values.set("row1", FAKE_SAVED);
  mockOpenSession.mockImplementation(fakeSession);
});

describe("discoverDraftMcpTools", () => {
  it("lists the tools with typed header values; returns names, descriptions and schemas only", async () => {
    const result = await discoverDraftMcpTools(draft(), deps());
    expect(result).toEqual({
      status: "OK",
      response: [{ name: "get_price", description: "Price of a symbol", inputSchema: { type: "object" } }],
    });
    expect(seen[0]).toMatchObject({ url: URL_OK, transport: "streamable-http", headers: { Authorization: FAKE_TOKEN } });
    // The production fetch wrapper is passed in (guarded fetch), not global fetch.
    expect(typeof seen[0].fetch).toBe("function");
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });

  it("uses the saved Key Vault value for a masked row of the extension being edited", async () => {
    const load = vi.fn(async () => storedExtension() as ExtensionModel | undefined);
    const result = await discoverDraftMcpTools(
      draft({
        extensionId: "ext1",
        url: "https://mcp.example.test/v2/mcp",
        secrets: [
          { id: "row1", name: "X-Team-Renamed", target: "X-Team-Renamed", placement: "header", value: KEY_VAULT_MASK },
          { id: "new1", name: "X-Extra", target: "X-Extra", placement: "header", value: "fake-extra" },
        ],
      }),
      deps(load)
    );
    expect(result.status).toBe("OK");
    expect(load).toHaveBeenCalledWith("ext1");
    expect(fakeStore.get).toHaveBeenCalledWith("row1");
    expect(seen[0].url).toBe("https://mcp.example.test/v2/mcp");
    expect(seen[0].headers).toEqual({ "X-Team-Renamed": FAKE_SAVED, "X-Extra": "fake-extra" });
    expect(JSON.stringify(result)).not.toContain(FAKE_SAVED);
  });

  // Pinned: a saved value is used only for the origin it was saved for. With
  // another origin the row must be typed again, before any Key Vault read or
  // request.
  it("refuses a masked row when the URL origin changes", async () => {
    const result = await discoverDraftMcpTools(
      draft({
        extensionId: "ext1",
        url: "https://other.example.test/mcp",
        secrets: [{ id: "row1", name: "X-Team", target: "X-Team", placement: "header", value: KEY_VAULT_MASK }],
      }),
      deps()
    );
    expect(result).toEqual({
      status: "ERROR",
      errors: [{ message: "The server address changed. Enter the value for header X-Team again." }],
    });
    expect(fakeStore.get).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it("refuses a user who may not edit the extension, before any request", async () => {
    const result = await discoverDraftMcpTools(
      draft({
        extensionId: "ext1",
        secrets: [{ id: "row1", name: "X-Team", target: "X-Team", placement: "header", value: KEY_VAULT_MASK }],
      }),
      deps(vi.fn(async () => undefined))
    );
    expect(result.status).toBe("UNAUTHORIZED");
    expect(fakeStore.get).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it("never reads a masked row without a saved extension, or a row id the extension does not have", async () => {
    const noId = await discoverDraftMcpTools(
      draft({ secrets: [{ id: "row1", name: "X-Team", target: "X-Team", placement: "header", value: KEY_VAULT_MASK }] }),
      deps()
    );
    expect(noId.status).toBe("ERROR");
    const foreign = await discoverDraftMcpTools(
      draft({
        extensionId: "ext1",
        secrets: [{ id: "row-of-other-ext", name: "X-Other", target: "X-Other", placement: "header", value: KEY_VAULT_MASK }],
      }),
      deps()
    );
    expect(foreign.status).toBe("ERROR");
    expect(fakeStore.get).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it("applies the header rules of save", async () => {
    const reserved = await discoverDraftMcpTools(
      draft({ secrets: [{ id: "a", name: "Host", target: "Host", placement: "header", value: "fake" }] }),
      deps()
    );
    expect(reserved).toMatchObject({ status: "ERROR", errors: [{ message: expect.stringMatching(/sets Host itself/) }] });
    const duplicate = await discoverDraftMcpTools(
      draft({
        secrets: [
          { id: "a", name: "X-Key", target: "X-Key", placement: "header", value: "fake-1" },
          { id: "b", name: "x-key", target: "x-key", placement: "header", value: "fake-2" },
        ],
      }),
      deps()
    );
    expect(duplicate).toMatchObject({ status: "ERROR", errors: [{ message: expect.stringMatching(/once/) }] });
    const empty = await discoverDraftMcpTools(
      draft({ secrets: [{ id: "a", name: "X-Key", target: "X-Key", placement: "header", value: "" }] }),
      deps()
    );
    expect(empty).toMatchObject({ status: "ERROR", errors: [{ message: "Enter a value for header X-Key" }] });
    expect(seen).toHaveLength(0);
  });

  it("accepts https URLs only", async () => {
    const result = await discoverDraftMcpTools(draft({ url: "http://mcp.example.test/mcp" }), deps());
    expect(result).toMatchObject({ status: "ERROR", errors: [{ message: "Server URL must be a valid https URL" }] });
    expect(seen).toHaveLength(0);
  });

  it("goes through the extension SSRF guard: a loopback address is refused", async () => {
    const result = await discoverDraftMcpTools(draft({ url: "https://127.0.0.1/mcp", transport: "streamable-http" }), {
      loadEditable: vi.fn(),
      store: fakeStore,
      // the REAL session factory with the default guarded fetch
      openSession: (await vi.importActual<typeof import("./mcp-client")>("./mcp-client")).openMcpSession,
    });
    expect(result).toMatchObject({ status: "ERROR", errors: [{ message: "The MCP server address is not allowed." }] });
    // No header value in the log.
    expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain(FAKE_TOKEN);
  });
});

describe("DiscoverDraftMcpTools (server action)", () => {
  it("needs a signed-in user", async () => {
    mockGetCurrentUser.mockRejectedValueOnce(new Error("User not found"));
    const result = await DiscoverDraftMcpTools(draft());
    expect(result.status).toBe("UNAUTHORIZED");
    expect(seen).toHaveLength(0);
  });

  it("lists the tools for a signed-in user with typed values", async () => {
    mockGetCurrentUser.mockResolvedValueOnce({ email: "user@example.test", isAdmin: false });
    const result = await DiscoverDraftMcpTools(draft());
    expect(result).toMatchObject({ status: "OK", response: [{ name: "get_price" }] });
  });

  it("uses saved values only for whoever passes the edit check", async () => {
    mockGetCurrentUser.mockResolvedValue({ email: "user@example.test", isAdmin: false });
    const masked = draft({
      extensionId: "ext1",
      secrets: [{ id: "row1", name: "X-Team", target: "X-Team", placement: "header", value: KEY_VAULT_MASK }],
    });

    mockEnsure.mockResolvedValueOnce({ status: "UNAUTHORIZED", errors: [{ message: "Extension not found with id: ext1" }] });
    const refused = await DiscoverDraftMcpTools(masked);
    expect(refused.status).toBe("UNAUTHORIZED");
    expect(fakeStore.get).not.toHaveBeenCalled();

    mockEnsure.mockResolvedValueOnce({ status: "OK", response: storedExtension() });
    const allowed = await DiscoverDraftMcpTools(masked);
    expect(allowed.status).toBe("OK");
    expect(mockEnsure).toHaveBeenLastCalledWith("ext1");
    expect(seen.at(-1)?.headers).toEqual({ "X-Team": FAKE_SAVED });
  });
});
