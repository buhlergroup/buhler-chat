import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

const hashedEmail = createHash("sha256").update("test@example.com").digest("hex");

let historyItems: any[] = [];

const historyContainer = {
  items: {
    upsert: vi.fn(async (doc: any) => ({ resource: doc })),
    query: vi.fn((_q?: any, _opts?: any) => ({
      fetchAll: async () => ({ resources: historyItems }),
    })),
  },
  item: vi.fn((id: string, _pk?: string) => ({
    read: vi.fn(async () => ({ resource: historyItems.find((i) => i.id === id) })),
  })),
};

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => historyContainer,
}));

vi.mock("@/features/auth-page/auth-api", () => ({
  authOptions: {},
  options: {},
}));

vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/features/chat-page/chat-services/chat-image-persistence-service", () => ({
  processMessageForImagePersistence: vi.fn(async (_threadId: string, content: string, img?: string) => ({
    content,
    multiModalImage: img,
  })),
}));

import {
  FindTopChatMessagesForCurrentUser,
  FindAllChatMessagesForCurrentUser,
  CreateChatMessage,
  UpsertChatMessage,
  UpdateChatMessage,
} from "./chat-message-service";
import { MESSAGE_ATTRIBUTE } from "./models";
import * as nextAuth from "next-auth";

beforeEach(() => {
  historyItems = [];
  vi.clearAllMocks();
  historyContainer.items.upsert.mockImplementation(async (doc: any) => ({ resource: doc }));
  historyContainer.items.query.mockImplementation((_q?: any, _opts?: any) => ({
    fetchAll: async () => ({ resources: historyItems }),
  }));
  historyContainer.item.mockImplementation((id: string, _pk?: string) => ({
    read: vi.fn(async () => ({ resource: historyItems.find((i) => i.id === id) })),
  }));
});

describe("chat-page.unit.message-service.001 — FindTopChatMessagesForCurrentUser scopes by hashed userId", () => {
  it("includes correct query parameters", async () => {
    let captured: any;
    historyContainer.items.query.mockImplementationOnce((q: any, _opts?: any) => {
      captured = q;
      return { fetchAll: async () => ({ resources: [] }) };
    });
    await FindTopChatMessagesForCurrentUser("thread-1", 50);
    expect(captured).toBeDefined();
    expect(captured.parameters).toEqual(
      expect.arrayContaining([
        { name: "@userId", value: hashedEmail },
        { name: "@threadId", value: "thread-1" },
        { name: "@top", value: 50 },
        { name: "@isDeleted", value: false },
      ])
    );
  });
});

describe("chat-page.unit.message-service.002 — FindTopChatMessagesForCurrentUser keeps its top=30 default for non-chat callers", () => {
  it("still defaults to 30, but the chat path no longer uses this function", async () => {
    // The default itself is unchanged. What changed is who calls it: the chat
    // path now loads the whole thread and compacts it when the provider's
    // measured prompt size exceeds the budget (see history-budget.ts and
    // chat-page.unit.message-service.015), because the row cap made the prompt
    // prefix slide by one row on every turn past 30 and cost a large part of
    // the prompt-cache hit rate. This function stays for callers that
    // genuinely want the newest N rows.
    let captured: any;
    historyContainer.items.query.mockImplementationOnce((q: any, _opts?: any) => {
      captured = q;
      return { fetchAll: async () => ({ resources: [] }) };
    });
    await FindTopChatMessagesForCurrentUser("thread-1");
    expect(captured).toBeDefined();
    const topParam = captured.parameters.find((p: any) => p.name === "@top");
    expect(topParam?.value).toBe(30);
  });
});

describe("chat-page.unit.message-service.015 — FindAllChatMessagesForCurrentUser has no row cap and orders oldest-first", () => {
  it("issues a query with no TOP and no @top parameter", async () => {
    let captured: any;
    historyContainer.items.query.mockImplementationOnce((q: any, _opts?: any) => {
      captured = q;
      return { fetchAll: async () => ({ resources: [] }) };
    });

    await FindAllChatMessagesForCurrentUser("thread-1");

    expect(captured).toBeDefined();
    expect(captured.query).not.toMatch(/\bTOP\b/i);
    expect(captured.parameters.some((p: any) => p.name === "@top")).toBe(false);
  });

  it("orders by createdAt ASC so callers need no reversal", async () => {
    let captured: any;
    historyContainer.items.query.mockImplementationOnce((q: any, _opts?: any) => {
      captured = q;
      return { fetchAll: async () => ({ resources: [] }) };
    });

    await FindAllChatMessagesForCurrentUser("thread-1");

    expect(captured.query).toMatch(/ORDER BY r\.createdAt ASC/i);
  });

  it("applies the same thread, user and isDeleted scoping as the capped query", async () => {
    let captured: any;
    historyContainer.items.query.mockImplementationOnce((q: any, _opts?: any) => {
      captured = q;
      return { fetchAll: async () => ({ resources: [] }) };
    });

    await FindAllChatMessagesForCurrentUser("thread-1");

    expect(captured.parameters).toEqual(
      expect.arrayContaining([
        { name: "@type", value: MESSAGE_ATTRIBUTE },
        { name: "@threadId", value: "thread-1" },
        { name: "@userId", value: hashedEmail },
        { name: "@isDeleted", value: false },
      ])
    );
  });

  it("returns every row it is given, well past the old 30-row cap", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `row ${i}`,
    }));
    historyContainer.items.query.mockImplementationOnce(() => ({
      fetchAll: async () => ({ resources: rows }),
    }));

    const result = await FindAllChatMessagesForCurrentUser("thread-1");
    expect(result.status).toBe("OK");
    expect((result as any).response).toHaveLength(250);
  });
});

describe("chat-page.unit.message-service.016 — the loader hands the cache fields through untouched", () => {
  // The seam: the assistant turn is persisted with a `sequence` (write order
  // inside the turn) and a `stepLayout` (the step boundaries the live turn
  // had). The loader is the only thing between those writes and the adapter
  // that replays them, so it must apply the sequence AND leave both fields on
  // the rows. Dropping either one silently reverts the prompt to a shape the
  // provider has not cached.
  const SAME = new Date("2026-09-07T11:00:00.000Z");

  it("applies sequence as the tie-break and preserves sequence and stepLayout", async () => {
    const layout = ["step-start", "tool:call-1", "step-start", "text:6"];
    // Handed over in the order a same-millisecond Cosmos read can produce.
    historyContainer.items.query.mockImplementationOnce(() => ({
      fetchAll: async () => ({
        resources: [
          { id: "t1", createdAt: SAME, role: "tool", content: "{}", sequence: 2 },
          { id: "a1", createdAt: SAME, role: "assistant", content: "answer", sequence: 1, stepLayout: layout },
          { id: "u1", createdAt: SAME, role: "user", content: "question" },
        ],
      }),
    }));

    const result = await FindAllChatMessagesForCurrentUser("thread-1");

    expect(result.status).toBe("OK");
    const rows = (result as any).response;
    // user (no sequence, counts as 0) → assistant (1) → tool (2).
    expect(rows.map((r: any) => r.id)).toEqual(["u1", "a1", "t1"]);
    expect(rows[1].sequence).toBe(1);
    expect(rows[1].stepLayout).toEqual(layout);
    expect(rows[2].sequence).toBe(2);
  });

  it("keeps rows written before either field existed in a stable order", async () => {
    historyContainer.items.query.mockImplementationOnce(() => ({
      fetchAll: async () => ({
        resources: [
          { id: "b", createdAt: SAME, role: "assistant", content: "b" },
          { id: "a", createdAt: SAME, role: "user", content: "a" },
        ],
      }),
    }));

    const result = await FindAllChatMessagesForCurrentUser("thread-1");
    const rows = (result as any).response;
    expect(rows.map((r: any) => r.id)).toEqual(["a", "b"]);
    expect(rows[0].sequence).toBeUndefined();
    expect(rows[0].stepLayout).toBeUndefined();
  });
});

describe("chat-page.unit.message-service.003 — FindAllChatMessagesForCurrentUser returns OK with resources", () => {
  it("returns messages array", async () => {
    const m1 = { id: "m1", role: "user", content: "hello" };
    const m2 = { id: "m2", role: "assistant", content: "world" };
    historyContainer.items.query.mockImplementationOnce(() => ({
      fetchAll: async () => ({ resources: [m1, m2] }),
    }));
    const result = await FindAllChatMessagesForCurrentUser("t1");
    expect(result.status).toBe("OK");
    expect((result as any).response).toEqual([m1, m2]);
  });
});

describe("chat-page.unit.message-service.004 — FindAllChatMessagesForCurrentUser returns ERROR on throw", () => {
  it("wraps error", async () => {
    historyContainer.items.query.mockImplementationOnce(() => ({
      fetchAll: async () => { throw new Error("db error"); },
    }));
    const result = await FindAllChatMessagesForCurrentUser("t1");
    expect(result.status).toBe("ERROR");
    expect((result as any).errors[0].message).toContain("db error");
  });
});

describe("chat-page.unit.message-service.005 — CreateChatMessage sets userId, type, isDeleted, generates id", () => {
  it("upserts with correct fields", async () => {
    const result = await CreateChatMessage({
      name: "Test User",
      content: "Hello",
      role: "user",
      chatThreadId: "t1",
    });
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.userId).toBe(hashedEmail);
    expect(doc.type).toBe(MESSAGE_ATTRIBUTE);
    expect(doc.isDeleted).toBe(false);
    expect(doc.id).toBeTruthy();
    expect(doc.id.length).toBe(36);
  });
});

describe("chat-page.unit.message-service.006 — CreateChatMessage persists processed content", () => {
  it("uses processed content from image persistence", async () => {
    const { processMessageForImagePersistence } = await import("./chat-image-persistence-service");
    (processMessageForImagePersistence as any).mockResolvedValueOnce({
      content: "cleaned",
      multiModalImage: "blob://t1/abc.png",
    });
    const result = await CreateChatMessage({
      name: "Test User",
      content: "raw base64 image data",
      role: "user",
      chatThreadId: "t1",
      multiModalImage: "data:image/png;base64,ABC",
    });
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.content).toBe("cleaned");
    expect(doc.multiModalImage).toBe("blob://t1/abc.png");
  });
});

describe("chat-page.unit.message-service.007 — UpsertChatMessage preserves provided id and createdAt", () => {
  it("keeps existing id and createdAt", async () => {
    const fixedId = "fixed-id-1234-5678-9012-abcdef";
    const fixedDate = new Date("2026-01-01T00:00:00.000Z");
    const result = await UpsertChatMessage({
      id: fixedId,
      createdAt: fixedDate,
      content: "test",
      role: "user",
      name: "Test",
      threadId: "t1",
      userId: hashedEmail,
      isDeleted: false,
      type: MESSAGE_ATTRIBUTE,
    });
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.id).toBe(fixedId);
    expect(new Date(doc.createdAt).toISOString()).toBe(fixedDate.toISOString());
  });
});

describe("chat-page.unit.message-service.008 — UpdateChatMessage returns NOT_FOUND when no message matches", () => {
  it("returns NOT_FOUND", async () => {
    const result = await UpdateChatMessage("nonexistent", { content: "new" });
    expect(result.status).toBe("NOT_FOUND");
    expect(historyContainer.items.upsert).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for a deleted row, a row of another type or an empty id", async () => {
    historyItems = [
      { id: "gone", userId: hashedEmail, type: MESSAGE_ATTRIBUTE, isDeleted: true },
      { id: "thread", userId: hashedEmail, type: "CHAT_THREAD", isDeleted: false },
    ];
    expect((await UpdateChatMessage("gone", { content: "x" })).status).toBe("NOT_FOUND");
    expect((await UpdateChatMessage("thread", { content: "x" })).status).toBe("NOT_FOUND");
    expect((await UpdateChatMessage("", { content: "x" })).status).toBe("NOT_FOUND");
    expect(historyContainer.items.upsert).not.toHaveBeenCalled();
  });
});

describe("chat-page.unit.message-service.009 — UpdateChatMessage merges updates preserving id/createdAt/type", () => {
  it("preserves original fields while merging updates", async () => {
    const existingMsg = {
      id: "m1",
      createdAt: new Date("2026-01-01"),
      content: "old",
      role: "user",
      name: "Test",
      threadId: "t1",
      userId: hashedEmail,
      type: MESSAGE_ATTRIBUTE,
      isDeleted: false,
    };
    historyItems = [existingMsg];
    const result = await UpdateChatMessage("m1", { content: "new" });
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.content).toBe("new");
    expect(doc.id).toBe("m1");
    expect(new Date(doc.createdAt).toISOString()).toBe(new Date("2026-01-01").toISOString());
    expect(doc.type).toBe(MESSAGE_ATTRIBUTE);
    expect(doc.isDeleted).toBe(false);
  });

  it("keeps the row in the caller's partition even when the update names another userId", async () => {
    historyItems = [
      { id: "m1", userId: hashedEmail, type: MESSAGE_ATTRIBUTE, isDeleted: false, content: "old" },
    ];
    const result = await UpdateChatMessage("m1", { content: "new", userId: "someone-else" });
    expect(result.status).toBe("OK");
    expect(historyContainer.items.upsert.mock.calls[0][0].userId).toBe(hashedEmail);
  });
});

describe("chat-page.unit.message-service.010 — UpdateChatMessage reads the row with a point read in the caller's partition", () => {
  it("uses item(id, userId).read() and no query", async () => {
    historyItems = [
      { id: "m1", userId: hashedEmail, type: MESSAGE_ATTRIBUTE, isDeleted: false },
    ];
    await UpdateChatMessage("m1", { content: "new" });
    expect(historyContainer.item).toHaveBeenCalledWith("m1", hashedEmail);
    expect(historyContainer.items.query).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for a row of another user", async () => {
    historyItems = [
      { id: "m1", userId: "other-user", type: MESSAGE_ATTRIBUTE, isDeleted: false },
    ];
    const result = await UpdateChatMessage("m1", { content: "new" });
    expect(result.status).toBe("NOT_FOUND");
    expect(historyContainer.items.upsert).not.toHaveBeenCalled();
  });
});

describe("chat-page.unit.message-service.017 — the message queries are single-partition queries", () => {
  it("FindAllChatMessagesForCurrentUser passes the caller's partition key", async () => {
    await FindAllChatMessagesForCurrentUser("thread-1");
    expect(historyContainer.items.query).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.stringContaining("r.userId=@userId") }),
      { partitionKey: hashedEmail },
    );
  });

  it("FindTopChatMessagesForCurrentUser passes the caller's partition key", async () => {
    await FindTopChatMessagesForCurrentUser("thread-1", 5);
    expect(historyContainer.items.query).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.stringContaining("r.userId=@userId") }),
      { partitionKey: hashedEmail },
    );
  });
});

describe("chat-page.unit.message-service.011 — UpsertChatMessage forces userId to the session owner", () => {
  it("ignores a caller-supplied userId and writes the authenticated owner", async () => {
    const result = await UpsertChatMessage({
      id: "m1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      content: "hi",
      role: "assistant",
      name: "assistant",
      threadId: "victim-thread",
      userId: "victim-hashed-id",
      isDeleted: false,
      type: MESSAGE_ATTRIBUTE,
    });
    expect(result.status).toBe("OK");
    const doc = historyContainer.items.upsert.mock.calls[0][0];
    expect(doc.userId).toBe(hashedEmail);
    expect(doc.userId).not.toBe("victim-hashed-id");
  });
});

describe("chat-page.unit.message-service.012 — UpsertChatMessage refuses an unauthenticated write", () => {
  it("returns ERROR and never upserts when there is no session", async () => {
    vi.mocked(nextAuth.getServerSession).mockResolvedValueOnce(null as any);
    const result = await UpsertChatMessage({
      id: "m2",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      content: "x",
      role: "assistant",
      name: "assistant",
      threadId: "t",
      userId: "victim-hashed-id",
      isDeleted: false,
      type: MESSAGE_ATTRIBUTE,
    });
    expect(result.status).toBe("ERROR");
    expect(historyContainer.items.upsert).not.toHaveBeenCalled();
  });
});
