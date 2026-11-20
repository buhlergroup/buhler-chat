import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { setSession, adminSession, defaultSession } from "@/__tests__/helpers/session-mock";

const hashEmail = (e: string) => createHash("sha256").update(e).digest("hex");
const USER_HASH = hashEmail(defaultSession!.user.email);

// ── Cosmos mock ───────────────────────────────────────────────────────────────
let historyItems: any[] = [];

const historyContainer = {
  items: {
    create: vi.fn(async (doc: any) => ({ resource: { ...doc } })),
    upsert: vi.fn(async (doc: any) => ({ resource: { ...doc } })),
    query: vi.fn((_q: any) => ({
      fetchAll: async () => ({ resources: historyItems }),
    })),
  },
  item: vi.fn((id: string, _pk?: string) => ({
    read: vi.fn(async () => ({ resource: historyItems.find((i: any) => i.id === id) })),
    delete: vi.fn(async () => {
      const idx = historyItems.findIndex((i: any) => i.id === id);
      if (idx >= 0) historyItems.splice(idx, 1);
      return { resource: undefined };
    }),
  })),
};

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => historyContainer,
  ConfigContainer: () => historyContainer,
}));

// ── auth-api mock ────────────────────────────────────────────────────────────
vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));

// ── Key Vault mock ───────────────────────────────────────────────────────────
const mockKvSetSecret = vi.fn();
const mockKvGetSecret = vi.fn();
const mockKvBeginDeleteSecret = vi.fn();
const mockKvList = vi.fn((): Array<{ name: string; tags?: Record<string, string> }> => []);

vi.mock("@azure/keyvault-secrets", () => ({
  SecretClient: vi.fn().mockImplementation(function () {
    return {
      setSecret: mockKvSetSecret,
      getSecret: mockKvGetSecret,
      beginDeleteSecret: mockKvBeginDeleteSecret,
      listPropertiesOfSecrets: () =>
        (async function* () {
          yield* mockKvList();
        })(),
    };
  }),
}));

vi.mock("@/features/common/services/azure-default-credential", () => ({
  getAzureDefaultCredential: vi.fn(() => ({})),
}));

// ── chat-thread-service ───────────────────────────────────────────────────────
vi.mock("@/features/chat-page/chat-services/chat-thread-write", () => ({
  saveChatThread: vi.fn(async (payload: any) => ({ status: "OK", response: { ...payload } })),
}));

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

const mockDiscover = vi.fn();
vi.mock("./mcp/mcp-discovery", () => ({
  discoverMcpTools: (...a: unknown[]) => mockDiscover(...a),
}));

import {
  FindMissingExtensionIds,
  CreateExtension,
  FindExtensionByID,
  EnsureExtensionOperation,
  DeleteExtension,
  UpdateExtension,
  FindAllExtensionForCurrentUser,
  FindAllExtensionForCurrentUserAndIds,
  CreateChatWithExtension,
  GetExtensionCredentialInfo,
} from "./extension-service";

import { saveChatThread as UpsertChatThread } from "@/features/chat-page/chat-services/chat-thread-write";

// ── helpers ──────────────────────────────────────────────────────────────────
const validFunction = () => ({
  id: "client-1",
  functionName: "myFunction",
  code: JSON.stringify({ name: "myFunction", description: "test" }),
  endpoint: "https://api.example.com/fn",
  endpointType: "GET" as const,
  isOpen: false,
});

const validHeader = () => ({
  id: "client-h-1",
  key: "X-Api-Key",
  value: "real-secret",
});

const validExtensionInput = () => ({
  id: "ext-1",
  name: "My Extension",
  description: "Desc",
  executionSteps: "Steps",
  isPublished: false,
  userId: USER_HASH,
  createdAt: new Date(),
  type: "EXTENSION" as const,
  functions: [validFunction()],
  headers: [validHeader()],
});

const seedExtension = (overrides: Record<string, any> = {}) => {
  const doc = {
    id: "ext-seed",
    name: "Seed Extension",
    description: "desc",
    executionSteps: "steps",
    isPublished: false,
    userId: USER_HASH,
    createdAt: new Date(),
    type: "EXTENSION" as const,
    functions: [validFunction()],
    headers: [{ ...validHeader(), value: "**********" }],
    ...overrides,
  };
  historyItems.push(doc);
  return doc;
};

beforeEach(() => {
  historyItems.length = 0;
  vi.clearAllMocks();
  setSession(defaultSession);

  historyContainer.items.create.mockImplementation(async (doc: any) => ({ resource: { ...doc } }));
  historyContainer.items.upsert.mockImplementation(async (doc: any) => ({ resource: { ...doc } }));
  historyContainer.items.query.mockImplementation((_q: any) => ({
    fetchAll: async () => ({ resources: historyItems }),
  }));
  historyContainer.item.mockImplementation((id: string, _pk?: string) => ({
    read: vi.fn(async () => ({ resource: historyItems.find((i: any) => i.id === id) })),
    delete: vi.fn(async () => {
      const idx = historyItems.findIndex((i: any) => i.id === id);
      if (idx >= 0) historyItems.splice(idx, 1);
      return { resource: undefined };
    }),
  }));

  vi.mocked(UpsertChatThread).mockImplementation(async (payload: any) => ({
    status: "OK",
    response: { ...payload },
  }));

  // reset KV mocks
  mockKvSetSecret.mockImplementation(async (name: string, value: string) => ({ name, value }));
  mockKvGetSecret.mockImplementation(async (name: string) => ({ name, value: "" }));
  mockKvBeginDeleteSecret.mockImplementation(async (name: string) => ({ pollUntilDone: async () => undefined }));
});

describe("extension-service.ts", () => {
  // 001 – CreateExtension forces isPublished=false for non-admin
  it("001 CreateExtension forces isPublished=false for non-admin", async () => {
    await setSession(defaultSession);
    const result = await CreateExtension({ ...validExtensionInput(), isPublished: true });
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.isPublished).toBe(false);
    }
  });

  // 002 – CreateExtension regenerates header/function ids
  it("002 CreateExtension regenerates header/function ids", async () => {
    const result = await CreateExtension(validExtensionInput());
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.headers[0].id).not.toBe("client-h-1");
      expect(result.response.functions[0].id).not.toBe("client-1");
      expect(result.response.headers[0].id).toHaveLength(36);
      expect(result.response.functions[0].id).toHaveLength(36);
    }
  });

  // 003 – CreateExtension writes header values to Key Vault and masks them
  it("003 CreateExtension writes header value to KV and masks it", async () => {
    const result = await CreateExtension(validExtensionInput());
    expect(result.status).toBe("OK");

    expect(mockKvSetSecret).toHaveBeenCalledTimes(1);
    const [, secretValue] = mockKvSetSecret.mock.calls[0];
    expect(secretValue).toBe("real-secret");

    if (result.status === "OK") {
      expect(result.response.headers[0].value).toBe("**********");
    }
  });

  // 004 – CreateExtension skips KV write if value already masked
  it("004 CreateExtension skips KV write if value already masked", async () => {
    const input = validExtensionInput();
    input.headers[0].value = "**********";
    const result = await CreateExtension(input);
    expect(result.status).toBe("OK");
    expect(mockKvSetSecret).not.toHaveBeenCalled();
  });

  // 005 – CreateExtension validation fails when function code not JSON
  it("005 CreateExtension validation fails when function code not JSON", async () => {
    const input = validExtensionInput();
    input.functions[0].code = "not json";
    const result = await CreateExtension(input);
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors[0].message).toMatch(/Error validating function schema/);
    }
  });

  // 006 – CreateExtension rejects functions with no 'name' in JSON
  it("006 CreateExtension rejects functions with no name in JSON", async () => {
    const input = validExtensionInput();
    input.functions[0].code = JSON.stringify({ description: "x" });
    const result = await CreateExtension(input);
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors[0].message).toBe("Function JSON must contain a 'name' field.");
    }
  });

  // 007 – CreateExtension rejects functionName containing spaces
  it("007 CreateExtension rejects functionName with spaces", async () => {
    const input = validExtensionInput();
    input.functions[0].functionName = "my fn";
    const result = await CreateExtension(input);
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors[0].message).toMatch(/cannot contain spaces/);
    }
  });

  // 008 – CreateExtension rejects duplicate function names
  it("008 CreateExtension rejects duplicate function names", async () => {
    const input = validExtensionInput();
    input.functions = [validFunction(), { ...validFunction(), id: "fn-2" }];
    const result = await CreateExtension(input);
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors[0].message).toMatch(/already used/);
    }
  });

  // 009 – CreateExtension requires at least one function
  it("009 CreateExtension requires at least one function", async () => {
    const input = validExtensionInput();
    input.functions = [];
    const result = await CreateExtension(input);
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors[0].message).toMatch(/At least one function is required/);
    }
  });

  // 010 – FindExtensionByID returns NOT_FOUND when missing
  it("010 FindExtensionByID returns NOT_FOUND when missing", async () => {
    const result = await FindExtensionByID("nonexistent");
    expect(result.status).toBe("NOT_FOUND");
  });

  // 011 – EnsureExtensionOperation rejects non-owner non-admin
  it("011 EnsureExtensionOperation rejects non-owner non-admin", async () => {
    await setSession(defaultSession);
    seedExtension({ id: "ext-other", userId: "other-hash" });
    const result = await EnsureExtensionOperation("ext-other");
    expect(result.status).toBe("UNAUTHORIZED");
  });

  // 012 – secret reads are no longer a server action (a browser could call it)
  it("012 extension-service exports no secret reader", async () => {
    const mod = await import("./extension-service");
    expect("FindSecureHeaderValue" in mod).toBe(false);
  });

  // 013 – readExtensionSecret (server-only module) returns the Key Vault value
  it("013 readExtensionSecret returns the value, undefined when empty", async () => {
    const { readExtensionSecret } = await import("./extension-secrets");
    mockKvGetSecret.mockResolvedValueOnce({ name: "h1", value: "shh" });
    expect(await readExtensionSecret("h1")).toBe("shh");
    mockKvGetSecret.mockResolvedValueOnce({ name: "h1", value: "" });
    expect(await readExtensionSecret("h1")).toBeUndefined();
  });

  // 014 – DeleteExtension deletes secrets and the doc
  it("014 DeleteExtension deletes secrets and the doc", async () => {
    seedExtension({ id: "ext-del", headers: [{ id: "hdr-1", key: "X-Key", value: "**********" }] });

    const deleteSpy = vi.fn().mockResolvedValue({ resource: undefined });
    historyContainer.item.mockImplementationOnce((_id: string) => ({
      read: vi.fn().mockResolvedValue({ resource: historyItems.find((i: any) => i.id === _id) }),
      delete: deleteSpy,
    }));

    await DeleteExtension("ext-del");

    expect(mockKvBeginDeleteSecret).toHaveBeenCalledWith("hdr-1");
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  // 015 – UpdateExtension preserves existing isPublished for non-admin
  it("015 UpdateExtension preserves existing isPublished for non-admin", async () => {
    await setSession(defaultSession);
    const ext = seedExtension({ id: "ext-upd", isPublished: true });

    const result = await UpdateExtension({ ...ext, isPublished: false });
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.isPublished).toBe(true);
    }
  });

  // 016 – FindAllExtensionForCurrentUser SQL scoping
  it("016 FindAllExtensionForCurrentUser SQL scoping", async () => {
    let capturedSpec: any;
    historyContainer.items.query.mockImplementationOnce((q: any) => {
      capturedSpec = q;
      return { fetchAll: async () => ({ resources: [] }) };
    });

    await FindAllExtensionForCurrentUser();

    expect(capturedSpec).toBeDefined();
    const userParam = capturedSpec.parameters.find((p: any) => p.name === "@userId");
    expect(userParam?.value).toBe(USER_HASH);
    const publishedParam = capturedSpec.parameters.find((p: any) => p.name === "@isPublished");
    expect(publishedParam?.value).toBe(true);
    expect(capturedSpec.query).toContain("r.isPublished=@isPublished");
    expect(capturedSpec.query).toContain("r.userId=@userId");
  });

  // 017 – FindAllExtensionForCurrentUserAndIds adds ARRAY_CONTAINS predicate
  it("017 FindAllExtensionForCurrentUserAndIds adds ARRAY_CONTAINS predicate", async () => {
    let capturedSpec: any;
    historyContainer.items.query.mockImplementationOnce((q: any) => {
      capturedSpec = q;
      return { fetchAll: async () => ({ resources: [] }) };
    });

    await FindAllExtensionForCurrentUserAndIds(["e1", "e2"]);

    expect(capturedSpec).toBeDefined();
    expect(capturedSpec.query).toMatch(/ARRAY_CONTAINS/);
    const idsParam = capturedSpec.parameters.find((p: any) => p.name === "@ids");
    expect(idsParam?.value).toEqual(["e1", "e2"]);
  });

  // 018 – CreateChatWithExtension attaches extension id to new thread
  it("018 CreateChatWithExtension attaches extension id to new thread", async () => {
    seedExtension({ id: "e1" });

    await CreateChatWithExtension("e1");

    expect(UpsertChatThread).toHaveBeenCalled();
    const callArg = vi.mocked(UpsertChatThread).mock.calls[0][0] as any;
    expect(callArg.extension).toEqual(["e1"]);
  });

  // 018b – another user's private extension: same answer as an unknown id
  it("018b CreateChatWithExtension denies another user's private extension", async () => {
    seedExtension({ id: "e-private", userId: "other-hash", isPublished: false });

    const result = await CreateChatWithExtension("e-private");

    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors[0].message).toBe("Extension not found with id: e-private");
    }
    expect(UpsertChatThread).not.toHaveBeenCalled();
  });

  // 018c – a published extension of another user is allowed
  it("018c CreateChatWithExtension allows a published extension of another user", async () => {
    seedExtension({ id: "e-pub", userId: "other-hash", isPublished: true });

    const result = await CreateChatWithExtension("e-pub");

    expect(result.status).toBe("OK");
    expect(UpsertChatThread).toHaveBeenCalled();
  });

  // 019 – CreateChatWithExtension surfaces FindExtensionByID error
  it("019 CreateChatWithExtension surfaces FindExtensionByID NOT_FOUND", async () => {
    const result = await CreateChatWithExtension("missing-ext");
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  // ── Remote MCP + sharing (edit / delete stay with the owner) ──────────────
  describe("owner-only management", () => {
    // A user who reaches the extension through a shared or published agent
    // is just "not the owner" here: the service has no agent path at all.
    it("020 a non-owner (e.g. user of a shared agent) cannot delete the extension or its secrets", async () => {
      seedExtension({ id: "ext-shared", userId: "agent-owner-hash", headers: [{ id: "hdr-x", key: "k", value: "**********" }] });
      const result = await DeleteExtension("ext-shared");
      expect(result.status).toBe("UNAUTHORIZED");
      expect(mockKvBeginDeleteSecret).not.toHaveBeenCalled();
      expect(historyItems).toHaveLength(1);
    });

    it("021 a non-owner cannot update the extension", async () => {
      const ext = seedExtension({ id: "ext-shared", userId: "agent-owner-hash" });
      const result = await UpdateExtension({ ...ext, name: "taken over" });
      expect(result.status).toBe("UNAUTHORIZED");
      expect(historyContainer.items.upsert).not.toHaveBeenCalled();
    });

    it("022 a non-owner gets NOT_FOUND for a private extension by id (no config leak)", async () => {
      seedExtension({ id: "ext-private", userId: "agent-owner-hash" });
      expect((await FindExtensionByID("ext-private")).status).toBe("NOT_FOUND");
    });

    it("023 chat display list shows only name and description of extensions of others", async () => {
      seedExtension({
        id: "ext-agent",
        userId: "agent-owner-hash",
        kind: "mcp",
        functions: [],
        mcp: {
          url: "https://mcp.example.com/mcp",
          transport: "auto",
          secrets: [{ id: "s1", name: "TOKEN", value: "**********", placement: "bearer" }],
          toolAllowList: [],
          auth: "none",
        },
      });
      const result = await FindAllExtensionForCurrentUserAndIds(["ext-agent"]);
      expect(result.status).toBe("OK");
      if (result.status === "OK") {
        const view = result.response[0];
        expect(view.name).toBe("Seed Extension");
        expect(view.mcp).toBeUndefined();
        expect(view.headers).toEqual([]);
        expect(view.functions).toEqual([]);
      }
    });

    it("024 update refuses another extension's header id sent with the mask", async () => {
      const ext = seedExtension({ id: "ext-own" });
      const result = await UpdateExtension({
        ...ext,
        headers: [{ id: "victim-kv-id", key: "X-Steal", value: "**********" }],
      });
      expect(result.status).toBe("ERROR");
      expect(mockKvSetSecret).not.toHaveBeenCalled();
    });
  });

  describe("Remote MCP extensions", () => {
    const mcpInput = () => ({
      ...validExtensionInput(),
      functions: [],
      headers: [],
      kind: "mcp" as const,
      mcp: {
        url: "https://mcp.example.com/mcp",
        transport: "auto" as const,
        secrets: [
          {
            id: "client",
            name: "Authorization",
            target: "Authorization",
            value: "fake-test-value",
            placement: "header" as "bearer" | "header" | "query",
          },
        ],
        toolAllowList: [],
        auth: "none" as "none" | "oauth",
      },
    });

    it("030 create stores the secret in Key Vault, keeps the mask, and stores discovered tools", async () => {
      mockDiscover.mockResolvedValueOnce({ ok: true, tools: [{ name: "get_price" }] });
      const result = await CreateExtension(mcpInput());
      expect(result.status).toBe("OK");
      expect(mockKvSetSecret).toHaveBeenCalledWith(expect.any(String), "fake-test-value");
      if (result.status === "OK") {
        expect(result.response.mcp?.secrets[0].value).toBe("**********");
        expect(result.response.mcp?.tools).toEqual([{ name: "get_price" }]);
        expect(JSON.stringify(result.response)).not.toContain("fake-test-value");
      }
    });

    it("031 create keeps the extension when discovery fails", async () => {
      mockDiscover.mockResolvedValueOnce({ ok: false, error: "The MCP server request failed." });
      const result = await CreateExtension(mcpInput());
      expect(result.status).toBe("OK");
      if (result.status === "OK") expect(result.response.mcp?.tools).toBeUndefined();
    });

    it("032 create refuses a non-https server URL", async () => {
      const input = mcpInput();
      input.mcp.url = "http://mcp.example.com/mcp";
      const result = await CreateExtension(input);
      expect(result.status).toBe("ERROR");
      expect(mockKvSetSecret).not.toHaveBeenCalled();
    });

    it("033 delete removes MCP secrets, the client registration and every user's sign-in", async () => {
      mockKvList.mockReturnValueOnce([
        { name: "mcp-tok-userA", tags: { mcpExtension: "mcpdel" } },
        { name: "mcp-tok-userB", tags: { mcpExtension: "mcpdel" } },
        { name: "mcp-tok-other", tags: { mcpExtension: "another-ext" } },
        { name: "plain-header" },
      ]);
      seedExtension({
        id: "mcpdel",
        kind: "mcp",
        headers: [],
        functions: [],
        mcp: { ...mcpInput().mcp, secrets: [{ id: "s1", name: "T", value: "**********", placement: "bearer" }], auth: "oauth" },
      });
      await DeleteExtension("mcpdel");
      const deleted = mockKvBeginDeleteSecret.mock.calls.map((c) => c[0]);
      expect(deleted).toEqual(
        expect.arrayContaining(["s1", "mcpdel-mcp-oauth-client", "mcp-tok-userA", "mcp-tok-userB"])
      );
      expect(deleted).not.toContain("mcp-tok-other");
      expect(deleted).not.toContain("plain-header");
    });

    it("035 delete still succeeds when the per-user sign-ins cannot be listed (best effort)", async () => {
      mockKvList.mockImplementationOnce(() => {
        throw new Error("Forbidden: list");
      });
      seedExtension({
        id: "mcpdel2",
        kind: "mcp",
        headers: [],
        functions: [],
        mcp: { ...mcpInput().mcp, secrets: [], auth: "oauth" },
      });
      const deleteSpy = vi.fn().mockResolvedValue({ resource: { id: "mcpdel2" } });
      historyContainer.item.mockImplementationOnce(() => ({ read: vi.fn(), delete: deleteSpy }));
      const result = await DeleteExtension("mcpdel2");
      expect(result.status).toBe("OK");
      expect(deleteSpy).toHaveBeenCalled();
    });

    it("036 create refuses duplicate header names (case-insensitive) and stores nothing", async () => {
      const input = mcpInput();
      input.mcp.secrets.push({ ...input.mcp.secrets[0], id: "c2", name: "authorization", target: "authorization" });
      const result = await CreateExtension(input);
      expect(result.status).toBe("ERROR");
      if (result.status === "ERROR") {
        expect(result.errors[0].message).toBe("Use each header name once: authorization");
        expect(JSON.stringify(result.errors)).not.toContain("fake-test-value");
      }
      expect(mockKvSetSecret).not.toHaveBeenCalled();
    });

    it("037 create refuses a header the transport sets itself", async () => {
      const input = mcpInput();
      input.mcp.secrets[0] = { ...input.mcp.secrets[0], name: "Mcp-Session-Id", target: "Mcp-Session-Id" };
      const result = await CreateExtension(input);
      expect(result.status).toBe("ERROR");
      expect(mockKvSetSecret).not.toHaveBeenCalled();
    });

    it("038 create refuses an Authorization header with OAuth sign-in", async () => {
      const input = mcpInput();
      input.mcp.auth = "oauth";
      const result = await CreateExtension(input);
      expect(result.status).toBe("ERROR");
      if (result.status === "ERROR") {
        expect(result.errors[0].message).toMatch(/OAuth sign-in sets the Authorization header/);
      }
      expect(mockKvSetSecret).not.toHaveBeenCalled();
    });

    it("039 create refuses a new legacy bearer row", async () => {
      const input = mcpInput();
      input.mcp.secrets[0] = { ...input.mcp.secrets[0], name: "MCP_TOKEN", target: "", placement: "bearer" };
      const result = await CreateExtension(input);
      expect(result.status).toBe("ERROR");
      expect(mockKvSetSecret).not.toHaveBeenCalled();
    });

    it("034 FindMissingExtensionIds lists ids that no longer exist", async () => {
      historyContainer.items.query.mockImplementationOnce((_q: any) => ({
        fetchAll: async () => ({ resources: ["still-here"] }),
      }));
      const result = await FindMissingExtensionIds(["still-here", "deleted-one"]);
      expect(result).toEqual({ status: "OK", response: ["deleted-one"] });
    });
  });
});

// Pinned: the browser learns only booleans about stored credentials, and
// only for extensions the user may use.
describe("GetExtensionCredentialInfo", () => {
  it("answers with booleans for usable extensions and leaves out the others", async () => {
    seedExtension({
      id: "pubmcp",
      userId: "other-user",
      isPublished: true,
      functions: [],
      headers: [],
      kind: "mcp",
      mcp: {
        url: "https://mcp.example.com/mcp",
        transport: "auto",
        secrets: [{ id: "kv-row-1", name: "X-Hidden-Key", target: "X-Hidden-Key", placement: "header", value: "**********" }],
        toolAllowList: [],
        auth: "none",
      },
    });
    seedExtension({ id: "ownhttp" });
    seedExtension({ id: "privother", userId: "other-user", isPublished: false });

    const result = await GetExtensionCredentialInfo(["pubmcp", "ownhttp", "privother"]);
    expect(result).toEqual({
      status: "OK",
      response: [
        { id: "pubmcp", usesStoredSecrets: true, ownedByYou: false },
        { id: "ownhttp", usesStoredSecrets: true, ownedByYou: true },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/X-Hidden-Key|kv-row-1|X-Api-Key|client-h-1/);
  });

  // Pinned (temporary rule 4 "legacy"): an extension of another user that
  // the agent already lists gets the credential notice too.
  it("covers a legacy extension of another user on an agent the user can open", async () => {
    // findAgentUnchecked reads the first query result: the agent goes first.
    historyItems.push({
      id: "agent-legacy",
      type: "PERSONA",
      userId: "agent-owner",
      isPublished: true,
      extensionIds: ["legacyext"],
    });
    seedExtension({ id: "legacyext", userId: "other-user", isPublished: false });

    const result = await GetExtensionCredentialInfo(["legacyext"], "agent-legacy");
    expect(result).toEqual({
      status: "OK",
      response: [{ id: "legacyext", usesStoredSecrets: true, ownedByYou: false }],
    });
  });
});
