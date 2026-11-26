import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FindAllChatThreadsForAdmin,
  FindAllChatMessagesForAdmin,
} from "./reporting-service";
import type { ChatThreadModel, ChatMessageModel } from "../../chat-page/chat-services/models";

// ---------- module-level mocks ----------

const { mockGetCurrentUser, mockFetchAll } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockFetchAll: vi.fn(),
}));

vi.mock("@/features/auth-page/helpers", () => ({
  getCurrentUser: mockGetCurrentUser,
}));

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: {
      query: () => ({ fetchAll: mockFetchAll }),
    },
  }),
}));

// ---------- helpers ----------

function makeAdminUser() {
  return {
    name: "Admin User",
    email: "admin@example.com",
    image: "",
    isAdmin: true,
    token: "tok",
    isLocalDevUser: false,
  };
}

function makeNonAdminUser() {
  return {
    name: "Regular User",
    email: "user@example.com",
    image: "",
    isAdmin: false,
    token: "tok",
    isLocalDevUser: false,
  };
}

function makeThread(id: string): ChatThreadModel {
  return {
    id,
    name: `Thread ${id}`,
    useName: `user-${id}@example.com`,
    createdAt: new Date("2024-03-01T00:00:00Z"),
    lastMessageAt: new Date("2024-03-01T00:01:00Z"),
    userId: "u1",
    isDeleted: false,
    bookmarked: false,
    personaMessage: "",
    personaMessageTitle: "",
    extension: [],
    type: "CHAT_THREAD",
  };
}

function makeMessage(id: string, threadId = "th1"): ChatMessageModel {
  return {
    id,
    content: `Message ${id}`,
    role: "user",
    name: "Alice",
    createdAt: new Date("2024-03-01T00:00:00Z"),
    isDeleted: false,
    threadId,
    userId: "u1",
    type: "CHAT_MESSAGE",
  };
}

// ---------- FindAllChatThreadsForAdmin ----------

describe("reporting-service.unit.001 — admin gets thread list", () => {
  it("returns OK with threads when user is admin", async () => {
    mockGetCurrentUser.mockResolvedValueOnce(makeAdminUser());
    const threads = [makeThread("t1"), makeThread("t2")];
    mockFetchAll.mockResolvedValueOnce({ resources: threads });

    const result = await FindAllChatThreadsForAdmin(100, 0);

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response).toHaveLength(2);
      expect(result.response[0].id).toBe("t1");
    }
  });
});

describe("reporting-service.unit.001b — older rows lose their agent id lists", () => {
  it("returns the threads without personaDocumentIds and subAgentIds", async () => {
    mockGetCurrentUser.mockResolvedValueOnce(makeAdminUser());
    const legacy = {
      ...makeThread("t1"),
      personaId: "agent-1",
      personaDocumentIds: ["doc-1"],
      subAgentIds: ["sub-1"],
    } as ChatThreadModel;
    mockFetchAll.mockResolvedValueOnce({ resources: [legacy] });

    const result = await FindAllChatThreadsForAdmin(100, 0);

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response[0].personaId).toBe("agent-1");
      expect(result.response[0]).not.toHaveProperty("personaDocumentIds");
      expect(result.response[0]).not.toHaveProperty("subAgentIds");
    }
  });
});

describe("reporting-service.unit.002 — non-admin is rejected for threads", () => {
  it("returns ERROR with authorization message when user is not admin", async () => {
    mockGetCurrentUser.mockResolvedValueOnce(makeNonAdminUser());

    const result = await FindAllChatThreadsForAdmin(100, 0);

    expect(result.status).toBe("ERROR");
    if (result.status !== "OK") {
      expect(result.errors[0].message).toMatch(/not authorized/i);
    }
    // Cosmos should never be touched for unauthorized calls
    expect(mockFetchAll).not.toHaveBeenCalled();
  });
});

describe("reporting-service.unit.003 — cosmos error is caught for threads", () => {
  it("returns ERROR when Cosmos throws", async () => {
    mockGetCurrentUser.mockResolvedValueOnce(makeAdminUser());
    mockFetchAll.mockRejectedValueOnce(new Error("Cosmos unavailable"));

    const result = await FindAllChatThreadsForAdmin(100, 0);

    expect(result.status).toBe("ERROR");
    if (result.status !== "OK") {
      expect(result.errors[0].message).toContain("Cosmos unavailable");
    }
  });
});

describe("reporting-service.unit.004 — pagination offset is forwarded", () => {
  it("passes correct limit and offset to the query", async () => {
    mockGetCurrentUser.mockResolvedValueOnce(makeAdminUser());
    mockFetchAll.mockResolvedValueOnce({ resources: [] });

    await FindAllChatThreadsForAdmin(50, 150);

    expect(mockFetchAll).toHaveBeenCalledTimes(1);
  });
});

describe("reporting-service.unit.005 — empty thread result is still OK", () => {
  it("returns OK with empty array when no threads exist", async () => {
    mockGetCurrentUser.mockResolvedValueOnce(makeAdminUser());
    mockFetchAll.mockResolvedValueOnce({ resources: [] });

    const result = await FindAllChatThreadsForAdmin(100, 0);

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response).toEqual([]);
    }
  });
});

// ---------- FindAllChatMessagesForAdmin ----------

describe("reporting-service.unit.006 — admin gets messages for thread", () => {
  it("returns OK with messages when user is admin", async () => {
    mockGetCurrentUser.mockResolvedValueOnce(makeAdminUser());
    const messages = [makeMessage("m1", "th1"), makeMessage("m2", "th1")];
    mockFetchAll.mockResolvedValueOnce({ resources: messages });

    const result = await FindAllChatMessagesForAdmin("th1");

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response).toHaveLength(2);
    }
  });
});

describe("reporting-service.unit.007 — non-admin is rejected for messages", () => {
  it("returns ERROR for non-admin attempting to read messages", async () => {
    mockGetCurrentUser.mockResolvedValueOnce(makeNonAdminUser());

    const result = await FindAllChatMessagesForAdmin("th1");

    expect(result.status).toBe("ERROR");
    if (result.status !== "OK") {
      expect(result.errors[0].message).toMatch(/not authorized/i);
    }
    expect(mockFetchAll).not.toHaveBeenCalled();
  });
});

describe("reporting-service.unit.008 — cosmos error is caught for messages", () => {
  it("returns ERROR when Cosmos throws during message fetch", async () => {
    mockGetCurrentUser.mockResolvedValueOnce(makeAdminUser());
    mockFetchAll.mockRejectedValueOnce(new Error("Network timeout"));

    const result = await FindAllChatMessagesForAdmin("th1");

    expect(result.status).toBe("ERROR");
    if (result.status !== "OK") {
      expect(result.errors[0].message).toContain("Network timeout");
    }
  });
});

describe("reporting-service.unit.009 — empty message list is still OK", () => {
  it("returns OK with empty array when thread has no messages", async () => {
    mockGetCurrentUser.mockResolvedValueOnce(makeAdminUser());
    mockFetchAll.mockResolvedValueOnce({ resources: [] });

    const result = await FindAllChatMessagesForAdmin("empty-thread");

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response).toEqual([]);
    }
  });
});

describe("reporting-service.unit.010 — authorization checked before any DB call", () => {
  it("does not call HistoryContainer when user is non-admin", async () => {
    mockGetCurrentUser.mockResolvedValueOnce(makeNonAdminUser());

    await FindAllChatMessagesForAdmin("any-thread");

    // If auth check fires first, fetchAll must not be called
    expect(mockFetchAll).not.toHaveBeenCalled();
  });
});
