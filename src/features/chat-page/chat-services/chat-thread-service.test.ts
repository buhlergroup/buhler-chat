import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

// ---- helpers ----
const hashedEmail = createHash("sha256").update("test@example.com").digest("hex");

// ---- In-memory Cosmos container ----
let historyItems: any[] = [];

const historyContainer = {
  items: {
    upsert: vi.fn(async (doc: any) => ({ resource: doc })),
    query: vi.fn((_q: any) => ({
      fetchAll: async () => ({ resources: historyItems }),
    })),
  },
  item: vi.fn((id: string, _pk?: string) => ({
    read: vi.fn(async () => ({ resource: historyItems.find((i) => i.id === id) })),
  })),
};

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => historyContainer,
  ConfigContainer: () => historyContainer,
}));

vi.mock("@/features/auth-page/auth-api", () => ({
  authOptions: {},
  options: {},
}));

vi.mock("@/features/chat-page/chat-services/azure-ai-search/azure-ai-search", () => ({
  DeleteDocumentsOfChatThread: vi.fn(async () => [{ status: "OK", response: true }]),
}));

vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/features/chat-page/chat-services/chat-api/chat-api-text", () => ({
  ChatApiTitleAndIntent: vi.fn(async () => ({ title: "Generated Title", intent: "general" })),
}));

// ---- import after mocks ----
import {
  FindAllChatThreadForCurrentUser,
  FindChatThreadForCurrentUser,
  CreateChatThread,
  UpsertChatThread,
  AddExtensionToChatThread,
  RemoveExtensionFromChatThread,
  UpdateChatThreadSelectedModel,
  UpdateChatThreadReasoningEffort,
  UpdateChatThreadUsage,
  AddAttachedFile,
  RemoveAttachedFile,
  SoftDeleteChatContentsForCurrentUser,
  SoftDeleteChatThreadForCurrentUser,
  UpdateChatTitle,
  CreateChatAndRedirect,
  EnsureChatThreadOperation,
} from "./chat-thread-service";
import { CHAT_THREAD_ATTRIBUTE, DEFAULT_MODEL } from "./models";

function makeThread(overrides: Partial<any> = {}): any {
  return {
    id: "t1",
    name: "Test Thread",
    userId: hashedEmail,
    createdAt: new Date("2026-01-01"),
    lastMessageAt: new Date("2026-01-01"),
    bookmarked: false,
    isDeleted: false,
    type: CHAT_THREAD_ATTRIBUTE,
    personaMessage: "",
    personaMessageTitle: "Test Persona",
    extension: [],
    personaDocumentIds: [],
    selectedModel: DEFAULT_MODEL,
    useName: "Test User",
    isTemporary: false,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<any> = {}): any {
  return {
    id: `msg-${Math.random()}`,
    threadId: "t1",
    userId: hashedEmail,
    content: "hello",
    role: "user",
    name: "Test User",
    type: "CHAT_MESSAGE",
    isDeleted: false,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  historyItems = [];
  vi.clearAllMocks();
  historyContainer.items.upsert.mockImplementation(async (doc: any) => ({ resource: doc }));
  historyContainer.items.query.mockImplementation((_q: any, _opts?: any) => ({
    fetchAll: async () => ({ resources: historyItems }),
  }));
  historyContainer.item.mockImplementation((id: string, _pk?: string) => ({
    read: vi.fn(async () => ({ resource: historyItems.find((i) => i.id === id) })),
  }));
});

describe("chat-page.unit.thread-service.001 — FindAllChatThreadForCurrentUser scopes by hashed userId", () => {
  it("passes userId and type params", async () => {
    let capturedQuery: any;
    historyContainer.items.query.mockImplementationOnce((q: any, _opts?: any) => {
      capturedQuery = q;
      return { fetchAll: async () => ({ resources: [] }) };
    });
    const result = await FindAllChatThreadForCurrentUser();
    expect(result.status).toBe("OK");
    expect(capturedQuery.parameters).toEqual(
      expect.arrayContaining([
        { name: "@userId", value: hashedEmail },
        { name: "@type", value: CHAT_THREAD_ATTRIBUTE },
        { name: "@isDeleted", value: false },
      ])
    );
  });
});

describe("chat-page.unit.thread-service.002 — FindAllChatThreadForCurrentUser returns ERROR on Cosmos throw", () => {
  it("wraps cosmos error", async () => {
    historyContainer.items.query.mockImplementationOnce(() => ({
      fetchAll: async () => { throw new Error("throttled"); },
    }));
    const result = await FindAllChatThreadForCurrentUser();
    expect(result.status).toBe("ERROR");
    expect((result as any).errors[0].message).toContain("throttled");
  });
});

describe("chat-page.unit.thread-service.003 — FindChatThreadForCurrentUser returns NOT_FOUND when resource missing", () => {
  it("returns NOT_FOUND", async () => {
    historyContainer.item.mockImplementationOnce(() => ({
      read: vi.fn(async () => ({ resource: undefined })),
    }));
    const result = await FindChatThreadForCurrentUser("t1");
    expect(result.status).toBe("NOT_FOUND");
  });
});

describe("chat-page.unit.thread-service.004 — FindChatThreadForCurrentUser returns NOT_FOUND when isDeleted", () => {
  it("returns NOT_FOUND for deleted", async () => {
    historyContainer.item.mockImplementationOnce(() => ({
      read: vi.fn(async () => ({ resource: makeThread({ isDeleted: true }) })),
    }));
    const result = await FindChatThreadForCurrentUser("t1");
    expect(result.status).toBe("NOT_FOUND");
  });
});

describe("chat-page.unit.thread-service.005 — FindChatThreadForCurrentUser returns NOT_FOUND when type mismatched", () => {
  it("returns NOT_FOUND for wrong type", async () => {
    historyContainer.item.mockImplementationOnce(() => ({
      read: vi.fn(async () => ({ resource: { ...makeThread(), type: "OTHER" } })),
    }));
    const result = await FindChatThreadForCurrentUser("t1");
    expect(result.status).toBe("NOT_FOUND");
  });
});

describe("chat-page.unit.thread-service.006 — FindChatThreadForCurrentUser passes hashed userId as partitionKey", () => {
  it("calls item(id, hashedEmail)", async () => {
    historyContainer.item.mockImplementationOnce((id: string) => {
      expect(id).toBe("t1");
      return {
        read: vi.fn(async () => ({ resource: makeThread() })),
      };
    });
    await FindChatThreadForCurrentUser("t1");
    expect(historyContainer.item).toHaveBeenCalledWith("t1", hashedEmail);
  });
});

describe("chat-page.unit.thread-service.007 — CreateChatThread sets defaults", () => {
  it("upserts with correct defaults", async () => {
    const result = await CreateChatThread();
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.isDeleted).toBe(false);
    expect(doc.bookmarked).toBe(false);
    expect(doc.isTemporary).toBe(false);
    expect(doc.type).toBe(CHAT_THREAD_ATTRIBUTE);
    expect(doc.selectedModel).toBe(DEFAULT_MODEL);
    expect(doc.id).toBeTruthy();
    expect(doc.createdAt).toBeTruthy();
  });
});

describe("chat-page.unit.thread-service.008 — CreateChatThread honors overrides", () => {
  it("sets isTemporary and name", async () => {
    const result = await CreateChatThread({ name: "X", temporary: true });
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.isTemporary).toBe(true);
    expect(doc.name).toBe("X");
  });
});

describe("chat-page.unit.thread-service.009 — UpsertChatThread rejects cross-user updates", () => {
  it("returns UNAUTHORIZED when the thread belongs to a different user", async () => {
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({
        resource: makeThread({ userId: "other-user-hash" }),
      })),
    }));
    const thread = makeThread({ id: "t1", userId: "other-user-hash" });
    const result = await UpsertChatThread(thread);
    expect(result.status).toBe("UNAUTHORIZED");
  });
});

describe("chat-page.unit.thread-service.010 — UpsertChatThread allows admin", () => {
  it("admin can update other users threads", async () => {
    const { getServerSession } = await import("next-auth");
    const adminSession = {
      user: { name: "Admin", email: "admin@test.local", isAdmin: true, accessToken: "admin-token" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    };
    (getServerSession as any).mockResolvedValue(adminSession);
    try {
      historyContainer.item.mockImplementation(() => ({
        read: vi.fn(async () => ({
          resource: makeThread({ id: "t1", userId: "other-user-hash" }),
        })),
      }));
      const thread = makeThread({ id: "t1", userId: "other-user-hash" });
      const result = await UpsertChatThread(thread);
      expect(result.status).toBe("OK");
    } finally {
      (getServerSession as any).mockResolvedValue({
        user: { name: "Test User", email: "test@example.com", isAdmin: false, accessToken: "test-access-token" },
        expires: new Date(Date.now() + 86400000).toISOString(),
      });
    }
  });
});

describe("chat-page.unit.thread-service.011 — UpsertChatThread does not create threads", () => {
  it("returns NOT_FOUND for a thread without id and writes nothing", async () => {
    const thread = makeThread({ id: undefined });
    const result = await UpsertChatThread(thread);
    expect(result.status).toBe("NOT_FOUND");
    expect(historyContainer.items.upsert).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for an unknown id (e.g. a thread in another user's partition) and writes nothing", async () => {
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({ resource: undefined })),
    }));
    const result = await UpsertChatThread(
      makeThread({ id: "victim-thread", userId: "victim-hash", name: "pwned" })
    );
    expect(result.status).toBe("NOT_FOUND");
    expect(historyContainer.items.upsert).not.toHaveBeenCalled();
  });
});

describe("chat-page.unit.thread-service.011b — UpsertChatThread takes only user-editable fields", () => {
  it("allowed: name and bookmarked change", async () => {
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({ resource: makeThread({ name: "Old", bookmarked: false }) })),
    }));
    const result = await UpsertChatThread(makeThread({ name: "New", bookmarked: true }));
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.name).toBe("New");
    expect(doc.bookmarked).toBe(true);
  });

  it("denied: personaId, extension ids and other capability fields from the client are ignored", async () => {
    const stored = makeThread({
      personaId: "agent-1",
      extension: ["ext-own"],
      personaDocumentIds: ["doc-1"],
      personaMessage: "stored system prompt",
      subAgentIds: [],
    });
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({ resource: stored })),
    }));
    const result = await UpsertChatThread(
      makeThread({
        name: "Renamed",
        personaId: "private-agent-of-someone-else",
        extension: ["private-extension-of-someone-else"],
        personaDocumentIds: ["foreign-doc"],
        personaMessage: "injected",
        subAgentIds: ["foreign-agent"],
        defaultTools: { webSearch: true },
        userId: "victim-hash",
      })
    );
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.name).toBe("Renamed");
    expect(doc.personaId).toBe("agent-1");
    expect(doc.extension).toEqual(["ext-own"]);
    expect(doc.personaDocumentIds).toEqual(["doc-1"]);
    expect(doc.personaMessage).toBe("stored system prompt");
    expect(doc.subAgentIds).toEqual([]);
    expect(doc.defaultTools).toBeUndefined();
    expect(doc.userId).toBe(hashedEmail);
  });
});

describe("chat-page.unit.thread-service.012 — UpsertChatThread sets lastMessageAt to current time", () => {
  it("stamps lastMessageAt", async () => {
    const frozen = new Date("2026-05-15T10:00:00.000Z");
    vi.setSystemTime(frozen);
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({ resource: makeThread() })),
    }));
    await UpsertChatThread(makeThread());
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(new Date(doc.lastMessageAt).toISOString()).toBe(frozen.toISOString());
    vi.useRealTimers();
  });
});

describe("chat-page.unit.thread-service.013 — AddExtensionToChatThread is idempotent", () => {
  it("no upsert when already present", async () => {
    historyContainer.item.mockImplementationOnce(() => ({
      read: vi.fn(async () => ({
        resource: makeThread({ extension: ["ext-1"] }),
      })),
    }));
    const result = await AddExtensionToChatThread({ chatThreadId: "t1", extensionId: "ext-1" });
    expect(result.status).toBe("OK");
    expect(historyContainer.items.upsert).not.toHaveBeenCalled();
  });
});

describe("chat-page.unit.thread-service.014 — AddExtensionToChatThread appends new extension", () => {
  it("allowed: upserts with a published extension added", async () => {
    historyItems = [
      { id: "ext-1", type: "EXTENSION", userId: "publisher-hash", isPublished: true },
    ];
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({
        resource: makeThread({ extension: [] }),
      })),
    }));
    const result = await AddExtensionToChatThread({ chatThreadId: "t1", extensionId: "ext-1" });
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.extension).toContain("ext-1");
  });

  it("allowed: the user's own private extension", async () => {
    historyItems = [
      { id: "ext-mine", type: "EXTENSION", userId: hashedEmail, isPublished: false },
    ];
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({ resource: makeThread({ extension: [] }) })),
    }));
    const result = await AddExtensionToChatThread({ chatThreadId: "t1", extensionId: "ext-mine" });
    expect(result.status).toBe("OK");
  });

  it("denied: another user's private extension is NOT_FOUND and not added", async () => {
    historyItems = [
      { id: "ext-private", type: "EXTENSION", userId: "other-hash", isPublished: false },
    ];
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({ resource: makeThread({ extension: [] }) })),
    }));
    const result = await AddExtensionToChatThread({ chatThreadId: "t1", extensionId: "ext-private" });
    expect(result.status).toBe("NOT_FOUND");
    expect(historyContainer.items.upsert).not.toHaveBeenCalled();
  });

  it("denied: an unknown extension id is NOT_FOUND", async () => {
    historyItems = [];
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({ resource: makeThread({ extension: [] }) })),
    }));
    const result = await AddExtensionToChatThread({ chatThreadId: "t1", extensionId: "nope" });
    expect(result.status).toBe("NOT_FOUND");
    expect(historyContainer.items.upsert).not.toHaveBeenCalled();
  });
});

describe("chat-page.unit.thread-service.015 — RemoveExtensionFromChatThread filters out the id", () => {
  it("upserts with extension removed", async () => {
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({
        resource: makeThread({ extension: ["a", "b"] }),
      })),
    }));
    const result = await RemoveExtensionFromChatThread({ chatThreadId: "t1", extensionId: "a" });
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.extension).toEqual(["b"]);
  });
});

describe("chat-page.unit.thread-service.016 — UpdateChatThreadSelectedModel", () => {
  it("upserts with selectedModel", async () => {
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({
        resource: makeThread({ selectedModel: "gpt-5.4-mini" }),
      })),
    }));
    const result = await UpdateChatThreadSelectedModel("t1", "gpt-5.5");
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.selectedModel).toBe("gpt-5.5");
  });
});

describe("chat-page.unit.thread-service.017 — UpdateChatThreadReasoningEffort", () => {
  it("writes reasoningEffort field", async () => {
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({
        resource: makeThread(),
      })),
    }));
    const result = await UpdateChatThreadReasoningEffort("t1", "high");
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.reasoningEffort).toBe("high");
  });
});

describe("chat-page.unit.thread-service.018 — UpdateChatThreadUsage accumulates onto existing usage", () => {
  it("adds to totals", async () => {
    const frozen = new Date("2026-05-15T12:00:00.000Z");
    vi.setSystemTime(frozen);
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({
        resource: makeThread({
          usage: {
            totalInputTokens: 10,
            totalOutputTokens: 5,
            totalCachedTokens: 1,
            totalCostUsd: 0.1,
            lastUpdated: "2026-01-01T00:00:00.000Z",
          },
        }),
      })),
    }));
    const result = await UpdateChatThreadUsage("t1", 2, 3, 1, 0.5);
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.usage.totalInputTokens).toBe(12);
    expect(doc.usage.totalOutputTokens).toBe(8);
    expect(doc.usage.totalCachedTokens).toBe(2);
    expect(doc.usage.totalCostUsd).toBeCloseTo(0.6);
    expect(doc.usage.lastUpdated).toBe(frozen.toISOString());
    vi.useRealTimers();
  });
});

describe("chat-page.unit.thread-service.019 — UpdateChatThreadUsage initializes usage from zero when absent", () => {
  it("creates usage from scratch", async () => {
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({
        resource: makeThread({ usage: undefined }),
      })),
    }));
    const result = await UpdateChatThreadUsage("t1", 1, 1, 0, 0.05);
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.usage.totalInputTokens).toBe(1);
    expect(doc.usage.totalOutputTokens).toBe(1);
    expect(doc.usage.totalCachedTokens).toBe(0);
    expect(doc.usage.totalCostUsd).toBeCloseTo(0.05);
  });
});

describe("chat-page.unit.thread-service.020 — AddAttachedFile deduplicates by id", () => {
  it("no upsert when file id already present", async () => {
    historyContainer.item.mockImplementationOnce(() => ({
      read: vi.fn(async () => ({
        resource: makeThread({ attachedFiles: [{ id: "f1", name: "f1.csv", type: "code-interpreter" }] }),
      })),
    }));
    const result = await AddAttachedFile("t1", { id: "f1", name: "f1.csv", type: "code-interpreter" });
    expect(result.status).toBe("OK");
    expect(historyContainer.items.upsert).not.toHaveBeenCalled();
  });
});

describe("chat-page.unit.thread-service.021 — RemoveAttachedFile removes matching id", () => {
  it("upserts without the removed file", async () => {
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({
        resource: makeThread({
          attachedFiles: [
            { id: "a", name: "a.csv", type: "code-interpreter" },
            { id: "b", name: "b.csv", type: "code-interpreter" },
          ],
        }),
      })),
    }));
    const result = await RemoveAttachedFile("t1", "a");
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.attachedFiles.map((f: any) => f.id)).toEqual(["b"]);
  });
});

describe("chat-page.unit.thread-service.022 — SoftDeleteChatContentsForCurrentUser deletes all when no options", () => {
  it("marks all messages isDeleted=true", async () => {
    const msgs = [makeMessage({ id: "m1" }), makeMessage({ id: "m2" }), makeMessage({ id: "m3" })];
    historyContainer.item.mockImplementation((_id: string) => ({
      read: vi.fn(async () => ({ resource: makeThread() })),
    }));
    let callCount = 0;
    historyContainer.items.query.mockImplementation((_q: any, _opts?: any) => ({
      fetchAll: async () => {
        callCount++;
        if (callCount === 1) return { resources: msgs };
        return { resources: [] }; // no docs
      },
    }));
    const result = await SoftDeleteChatContentsForCurrentUser("t1");
    expect(result.status).toBe("OK");
    const messageCalls = historyContainer.items.upsert.mock.calls.filter(
      (c: any) => c[0].type === "CHAT_MESSAGE"
    );
    const upsertedIds = messageCalls.map((c: any) => c[0].id);
    expect(upsertedIds).toContain("m1");
    expect(upsertedIds).toContain("m2");
    expect(upsertedIds).toContain("m3");
    const allDeleted = messageCalls
      .filter((c: any) => ["m1", "m2", "m3"].includes(c[0].id))
      .every((c: any) => c[0].isDeleted === true);
    expect(allDeleted).toBe(true);
  });
});

describe("chat-page.unit.thread-service.023 — SoftDeleteChatContentsForCurrentUser deletes after untilMessageIndex", () => {
  it("only deletes from index+1 onwards", async () => {
    const msgs = [
      makeMessage({ id: "m0" }),
      makeMessage({ id: "m1" }),
      makeMessage({ id: "m2" }),
      makeMessage({ id: "m3" }),
      makeMessage({ id: "m4" }),
    ];
    historyContainer.item.mockImplementation((_id: string) => ({
      read: vi.fn(async () => ({ resource: makeThread() })),
    }));
    // First query call is for messages, second is for documents
    let callCount = 0;
    historyContainer.items.query.mockImplementation((_q: any, _opts?: any) => ({
      fetchAll: async () => {
        callCount++;
        if (callCount === 1) return { resources: msgs };
        return { resources: [] }; // No documents
      },
    }));
    await SoftDeleteChatContentsForCurrentUser("t1", { untilMessageIndex: 1 });
    const messageCalls = historyContainer.items.upsert.mock.calls.filter(
      (c: any) => c[0].type === "CHAT_MESSAGE"
    );
    const upsertedIds = messageCalls.map((c: any) => c[0].id);
    expect(upsertedIds).not.toContain("m0");
    expect(upsertedIds).not.toContain("m1");
    expect(upsertedIds).toContain("m2");
    expect(upsertedIds).toContain("m3");
    expect(upsertedIds).toContain("m4");
  });
});

describe("chat-page.unit.thread-service.024 — SoftDeleteChatContentsForCurrentUser returns ERROR on invalid untilMessageId", () => {
  it("returns ERROR with untilMessageId not found", async () => {
    const msgs = [makeMessage({ id: "m1" }), makeMessage({ id: "m2" })];
    historyContainer.item.mockImplementation((_id: string) => ({
      read: vi.fn(async () => ({ resource: makeThread() })),
    }));
    // First query: messages
    historyContainer.items.query.mockImplementationOnce((_q: any, _opts?: any) => ({
      fetchAll: async () => ({ resources: msgs }),
    }));
    const result = await SoftDeleteChatContentsForCurrentUser("t1", { untilMessageId: "missing" });
    expect(result.status).toBe("ERROR");
    expect((result as any).errors[0].message).toContain("untilMessageId not found");
  });
});

describe("chat-page.unit.thread-service.025 — SoftDeleteChatContentsForCurrentUser returns ERROR on out-of-bounds index", () => {
  it("returns ERROR with out of bounds", async () => {
    const msgs = [makeMessage({ id: "m1" }), makeMessage({ id: "m2" })];
    historyContainer.item.mockImplementation((_id: string) => ({
      read: vi.fn(async () => ({ resource: makeThread() })),
    }));
    historyContainer.items.query.mockImplementationOnce((_q: any, _opts?: any) => ({
      fetchAll: async () => ({ resources: msgs }),
    }));
    const result = await SoftDeleteChatContentsForCurrentUser("t1", { untilMessageIndex: 5 });
    expect(result.status).toBe("ERROR");
    expect((result as any).errors[0].message).toContain("out of bounds");
  });
});

describe("chat-page.unit.thread-service.026 — SoftDeleteChatThreadForCurrentUser marks thread isDeleted", () => {
  it("upserts thread with isDeleted=true", async () => {
    historyContainer.item.mockImplementation((_id: string) => ({
      read: vi.fn(async () => ({ resource: makeThread() })),
    }));
    // Queries return empty (no messages, no docs)
    historyContainer.items.query.mockImplementation((_q: any, _opts?: any) => ({
      fetchAll: async () => ({ resources: [] }),
    }));
    const result = await SoftDeleteChatThreadForCurrentUser("t1");
    expect(result.status).toBe("OK");
    const threadUpserts = historyContainer.items.upsert.mock.calls.filter(
      (c: any) => c[0].type === CHAT_THREAD_ATTRIBUTE && c[0].isDeleted === true
    );
    expect(threadUpserts.length).toBeGreaterThan(0);
  });
});

describe("chat-page.unit.thread-service.027 — UpdateChatTitle classifies title + intent", () => {
  it("calls ChatApiTitleAndIntent with the prompt and persists both title and intent", async () => {
    const { ChatApiTitleAndIntent } = await import("./chat-api/chat-api-text");
    (ChatApiTitleAndIntent as any).mockResolvedValueOnce({ title: "My Title", intent: "coding" });
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({ resource: makeThread() })),
    }));
    await UpdateChatTitle("t1", "help me write python");
    expect((ChatApiTitleAndIntent as any).mock.calls[0][0]).toBe("help me write python");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.name).toBe("My Title");
    expect(doc.intent).toBe("coding");
  });
});

describe("chat-page.unit.thread-service.028 — UpdateChatTitle keeps old name when title is empty", () => {
  it("preserves existing name but still records intent", async () => {
    const { ChatApiTitleAndIntent } = await import("./chat-api/chat-api-text");
    (ChatApiTitleAndIntent as any).mockResolvedValueOnce({ title: "", intent: "general" });
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({ resource: makeThread({ name: "Old Name" }) })),
    }));
    await UpdateChatTitle("t1", "some prompt");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.name).toBe("Old Name");
    expect(doc.intent).toBe("general");
  });
});

describe("chat-page.unit.thread-service.029 — CreateChatAndRedirect redirects on success", () => {
  it("throws NEXT_REDIRECT", async () => {
    await expect(CreateChatAndRedirect()).rejects.toThrow(/NEXT_REDIRECT:\/chat\//);
  });
});

describe("chat-page.unit.thread-service.030 — EnsureChatThreadOperation returns OK for owner", () => {
  it("owner gets OK", async () => {
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({ resource: makeThread({ userId: hashedEmail }) })),
    }));
    const result = await EnsureChatThreadOperation("t1");
    expect(result.status).toBe("OK");
  });
});

describe("chat-page.unit.thread-service.031 — EnsureChatThreadOperation admin sees other users threads", () => {
  it("admin gets OK", async () => {
    const { getServerSession } = await import("next-auth");
    (getServerSession as any).mockResolvedValue({
      user: { name: "Admin", email: "admin@test.local", isAdmin: true, accessToken: "tok" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    });
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({ resource: makeThread({ userId: "other" }) })),
    }));
    const result = await EnsureChatThreadOperation("t1");
    expect(result.status).toBe("OK");
    // restore
    (getServerSession as any).mockResolvedValue({
      user: { name: "Test User", email: "test@example.com", isAdmin: false, accessToken: "test-access-token" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    });
  });
});

describe("chat-page.unit.thread-service.032 — EnsureChatThreadOperation returns NOT_FOUND unchanged", () => {
  it("NOT_FOUND passes through", async () => {
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({ resource: undefined })),
    }));
    const result = await EnsureChatThreadOperation("t1");
    expect(result.status).toBe("NOT_FOUND");
  });
});

describe("chat-page.unit.thread-service.033 — EnsureChatThreadOperation blocks cross-user access", () => {
  it("returns UNAUTHORIZED when thread is owned by another non-admin user", async () => {
    historyContainer.item.mockImplementation(() => ({
      read: vi.fn(async () => ({ resource: makeThread({ userId: "someone-else" }) })),
    }));
    const result = await EnsureChatThreadOperation("t1");
    expect(result.status).toBe("UNAUTHORIZED");
  });
});

describe("chat-page.unit.thread-service.030 — the server chooses chat thread ids", () => {
  it("CreateChatThread ignores an id sent by the client", async () => {
    const result = await CreateChatThread({ id: "t1') or (user ne 'x" } as any);
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.id).not.toBe("t1') or (user ne 'x");
    expect(doc.id).toMatch(/^[0-9A-Za-z]{36}$/);
  });

  it("CreateChatThread uses the user id as the id of the temporary chat", async () => {
    const result = await CreateChatThread({ name: "Temp", temporary: true });
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.id).toBe(hashedEmail);
    expect(doc.userId).toBe(hashedEmail);
  });

  it("UpsertChatThread refuses an id outside the id charset", async () => {
    const result = await UpsertChatThread(
      makeThread({ id: "t1') or (user ne 'x" })
    );
    expect(result.status).toBe("NOT_FOUND");
    expect(historyContainer.items.upsert).not.toHaveBeenCalled();
  });

  it("UpsertChatThread keeps an existing thread in its partition", async () => {
    historyItems.push(makeThread({ id: "t1" }));
    const result = await UpsertChatThread(
      makeThread({ id: "t1", userId: "other-user-hash", name: "Renamed" })
    );
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.userId).toBe(hashedEmail);
    expect(doc.name).toBe("Renamed");
  });
});

// Pinned: thread write actions are callable from the browser. They used to
// store any attached code interpreter file id the client sent (which the chat
// then mounted in the container) and any userId (another user's partition).
describe("chat-page.unit.thread-service — server is the source of truth for code interpreter files", () => {
  const uploaded = { id: "f-up", name: "a.csv", type: "code-interpreter" as const, source: "upload" as const };

  it("UpsertChatThread keeps recorded files with their stored data and drops new ones", async () => {
    historyItems = [makeThread({ attachedFiles: [uploaded] })];
    const result = await UpsertChatThread(
      makeThread({
        attachedFiles: [
          { ...uploaded, source: "skill" },
          { id: "f-foreign", name: "x.csv", type: "code-interpreter", source: "upload" },
          { id: "doc-1", name: "n.pdf", type: "search-indexed" },
        ],
      }),
    );
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.attachedFiles).toEqual([
      uploaded,
      { id: "doc-1", name: "n.pdf", type: "search-indexed" },
    ]);
  });

  it("UpsertChatThread cannot create a thread with code interpreter files", async () => {
    const result = await UpsertChatThread(
      makeThread({
        id: "new-thread",
        attachedFiles: [{ id: "f-foreign", name: "x.csv", type: "code-interpreter" }],
      }),
    );
    expect(result.status).toBe("NOT_FOUND");
    expect(historyContainer.items.upsert).not.toHaveBeenCalled();
  });

  it("UpsertChatThread always writes to the caller's partition", async () => {
    historyItems = [makeThread()];
    await UpsertChatThread(makeThread({ userId: "other-user-hash" }));
    expect(historyContainer.items.upsert.mock.calls[0][0].userId).toBe(hashedEmail);
  });

  it("AddAttachedFile refuses a code interpreter file the server did not record", async () => {
    historyItems = [makeThread({ attachedFiles: [] })];
    const result = await AddAttachedFile("t1", {
      id: "f-foreign",
      name: "x.csv",
      type: "code-interpreter",
    });
    expect(result.status).toBe("NOT_FOUND");
    expect(historyContainer.items.upsert).not.toHaveBeenCalled();
  });

  it("AddAttachedFile still adds a search-indexed document", async () => {
    historyItems = [makeThread({ attachedFiles: [] })];
    const result = await AddAttachedFile("t1", { id: "doc-1", name: "n.pdf", type: "search-indexed" });
    expect(result.status).toBe("OK");
    expect(historyContainer.items.upsert.mock.calls[0][0].attachedFiles).toEqual([
      { id: "doc-1", name: "n.pdf", type: "search-indexed" },
    ]);
  });
});
