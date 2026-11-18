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

vi.mock("@azure/keyvault-secrets", () => ({
  SecretClient: vi.fn().mockImplementation(function () {
    return {
      setSecret: mockKvSetSecret,
      getSecret: mockKvGetSecret,
      beginDeleteSecret: mockKvBeginDeleteSecret,
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
}));

import {
  CreateExtension,
  FindExtensionByID,
  EnsureExtensionOperation,
  FindSecureHeaderValue,
  DeleteExtension,
  UpdateExtension,
  FindAllExtensionForCurrentUser,
  FindAllExtensionForCurrentUserAndIds,
  CreateChatWithExtension,
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

  // 012 – FindSecureHeaderValue returns the secret value
  it("012 FindSecureHeaderValue returns the secret value", async () => {
    mockKvGetSecret.mockResolvedValueOnce({ name: "h1", value: "shh" });
    const result = await FindSecureHeaderValue("h1");
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response).toBe("shh");
    }
  });

  // 013 – FindSecureHeaderValue returns ERROR when KV value empty/undefined
  it("013 FindSecureHeaderValue returns ERROR when KV value empty", async () => {
    mockKvGetSecret.mockResolvedValueOnce({ name: "h1", value: "" });
    const result = await FindSecureHeaderValue("h1");
    expect(result.status).toBe("ERROR");
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
});
