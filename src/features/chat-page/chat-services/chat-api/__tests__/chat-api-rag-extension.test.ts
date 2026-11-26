import { describe, it, expect, vi, beforeEach } from "vitest";

// The AI Search extension (/api/document) is the one remaining writer of
// CHAT_CITATION rows: its prompt asks the model for {% citation %} tags with
// these ids, and the reporting page opens them through FindCitationByID.

vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/features/auth-page/helpers", () => ({
  userHashedId: vi.fn(async () => "hashed-user"),
}));

vi.mock("../../azure-ai-search/azure-ai-search", () => ({
  ExtensionSimilaritySearch: vi.fn(async () => ({
    status: "OK",
    response: [
      {
        score: 0.8,
        document: {
          pageContent: "page text",
          metadata: "doc.pdf",
          chatThreadId: "t1",
          id: "x",
          user: "u",
          personaDocumentId: null,
          embedding: [0.1, 0.2],
        },
      },
    ],
  })),
}));

const created: any[] = [];
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({
    items: {
      create: vi.fn(async (doc: any) => {
        created.push(doc);
        return { resource: doc };
      }),
    },
  }),
}));

import { SearchAzureAISimilarDocuments } from "../chat-api-rag-extension";

beforeEach(() => {
  created.length = 0;
});

describe("chat-page.unit.rag-extension.001 — the AI Search extension still stores its citations", () => {
  it("writes one CHAT_CITATION row per result in the caller's partition and returns its id", async () => {
    const req = new Request("http://localhost/api/document", {
      method: "POST",
      headers: {
        vectors: "embedding",
        searchName: "s",
        indexName: "i",
        authorization: "hashed-user",
      },
      body: JSON.stringify({ search: "q" }),
    });

    const res = await SearchAzureAISimilarDocuments(req);
    const body = await res.json();

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ type: "CHAT_CITATION", userId: "hashed-user" });
    expect(created[0].content.document.pageContent).toBe("page text");
    expect(body).toEqual([{ id: created[0].id, content: created[0].content }]);
  });
});
