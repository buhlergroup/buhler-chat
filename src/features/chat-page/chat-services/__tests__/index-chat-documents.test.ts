import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { setSession, defaultSession } from "@/__tests__/helpers/session-mock";

const USER_HASH = createHash("sha256")
  .update(defaultSession!.user.email)
  .digest("hex");

let historyItems: any[] = [];
const historyContainer = {
  items: {
    upsert: vi.fn(),
    query: vi.fn(() => ({ fetchAll: async () => ({ resources: [] }) })),
  },
  item: vi.fn((id: string, partitionKey: string) => ({
    read: vi.fn(async () => ({
      resource: historyItems.find(
        (i) => i.id === id && i.userId === partitionKey
      ),
    })),
  })),
};

vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => historyContainer,
  ConfigContainer: () => historyContainer,
}));

vi.mock("@/features/auth-page/auth-api", () => ({ options: {}, authOptions: {} }));

vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/features/common/services/document-intelligence", () => ({
  DocumentIntelligenceInstance: vi.fn(),
}));

vi.mock("@/features/common/navigation-helpers", () => ({
  RevalidateCache: vi.fn(),
}));

vi.mock("@/features/chat-page/chat-services/azure-ai-search/azure-ai-search", () => ({
  EnsureIndexIsCreated: vi.fn(async () => ({ status: "OK", response: {} })),
  IndexDocuments: vi.fn(async () => [{ status: "OK", response: true }]),
}));

import { IndexChatDocuments } from "../chat-document-service";
import { IndexDocuments } from "@/features/chat-page/chat-services/azure-ai-search/azure-ai-search";

const thread = (id: string, userId: string, extra: Record<string, any> = {}) => ({
  id,
  userId,
  type: "CHAT_THREAD",
  isDeleted: false,
  ...extra,
});

beforeEach(() => {
  historyItems = [];
  vi.clearAllMocks();
  setSession(defaultSession);
});

describe("chat-page.unit.document-service.index — IndexChatDocuments", () => {
  it("indexes the chunks for a thread of the caller, without a persona document id", async () => {
    historyItems.push(thread("thread1", USER_HASH));
    const result = await IndexChatDocuments(["chunk"], "a.txt", "thread1");
    expect(result).toEqual([{ status: "OK", response: true }]);
    expect(IndexDocuments).toHaveBeenCalledWith(["chunk"], "a.txt", "thread1");
    expect(vi.mocked(IndexDocuments).mock.calls[0]).toHaveLength(3);
  });

  it("refuses a thread of another user", async () => {
    historyItems.push(thread("thread1", "other-user-hash"));
    const result = await IndexChatDocuments(["chunk"], "a.txt", "thread1");
    expect(result[0].status).toBe("ERROR");
    expect(IndexDocuments).not.toHaveBeenCalled();
  });

  it("refuses an item that is not a chat thread, and a deleted thread", async () => {
    historyItems.push(thread("persona1", USER_HASH, { type: "PERSONA" }));
    historyItems.push(thread("gone", USER_HASH, { isDeleted: true }));
    expect((await IndexChatDocuments(["c"], "a.txt", "persona1"))[0].status).toBe("ERROR");
    expect((await IndexChatDocuments(["c"], "a.txt", "gone"))[0].status).toBe("ERROR");
    expect(IndexDocuments).not.toHaveBeenCalled();
  });

  it("refuses an invalid thread id and invalid documents", async () => {
    historyItems.push(thread("thread1", USER_HASH));
    expect((await IndexChatDocuments(["c"], "a.txt", "t1' or 'x"))[0].status).toBe("ERROR");
    expect((await IndexChatDocuments([{} as any], "a.txt", "thread1"))[0].status).toBe("ERROR");
    expect(IndexDocuments).not.toHaveBeenCalled();
  });
});
