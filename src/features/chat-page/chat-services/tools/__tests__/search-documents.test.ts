import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/features/auth-page/helpers", () => ({
  userHashedId: vi.fn(async () => "hashed-user"),
}));

vi.mock("@/features/persona-page/persona-services/persona-document-graph-check", () => ({
  allowedPersonaDocumentIds: vi.fn(async () => []),
}));

vi.mock("../../azure-ai-search/azure-ai-search", () => ({
  SimilaritySearch: vi.fn(async () => ({ status: "OK", response: [] })),
}));

vi.mock("../../citation-service", () => ({
  CreateCitations: vi.fn(async () => []),
  FormatCitations: vi.fn((docs: any[]) => docs),
}));

// Any Cosmos write from the tool would go through here.
const historyCreate = vi.fn();
const historyUpsert = vi.fn();
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({ items: { create: historyCreate, upsert: historyUpsert } }),
}));

import { searchDocumentsTool } from "../search-documents";
import type { ToolContext } from "../tool-context";
import { SimilaritySearch } from "../../azure-ai-search/azure-ai-search";
import { CreateCitations } from "../../citation-service";
import { allowedPersonaDocumentIds as AllowedPersonaDocumentIds } from "@/features/persona-page/persona-services/persona-document-graph-check";

const makeCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  user: "hashed-user",
  threadId: "thread1",
  threadDocumentIds: [],
  personaDocumentIds: [],
  defaultTools: {} as any,
  extensions: [],
  ...overrides,
});

const runSearch = async (ctx: ToolContext): Promise<string> => {
  const tool = searchDocumentsTool(ctx) as any;
  await tool.execute({ query: "q" }, {});
  const call = vi.mocked(SimilaritySearch).mock.calls[0];
  return call[2] as string;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("chat-page.unit.search-documents.001 — search filter", () => {
  it("builds the filter from the user, the thread and the allowed persona documents", async () => {
    vi.mocked(AllowedPersonaDocumentIds).mockResolvedValueOnce(["docA", "docB"]);
    const filter = await runSearch(makeCtx({ personaDocumentIds: ["docA", "docB"] }));
    expect(filter).toBe(
      "(user eq 'hashed-user' and chatThreadId eq 'thread1') or search.in(personaDocumentId, 'docA,docB', ',')"
    );
  });

  it("drops a persona document id that contains the search.in delimiter", async () => {
    vi.mocked(AllowedPersonaDocumentIds).mockResolvedValueOnce([
      "docA,victimDoc",
      "docB",
    ]);
    const filter = await runSearch(makeCtx());
    expect(filter).not.toContain("victimDoc");
    expect(filter).toContain("search.in(personaDocumentId, 'docB', ',')");
  });

  it("drops a persona document id that contains a quote", async () => {
    vi.mocked(AllowedPersonaDocumentIds).mockResolvedValueOnce([
      "docA') or (user ne 'x",
    ]);
    const filter = await runSearch(makeCtx());
    expect(filter).toBe("(user eq 'hashed-user' and chatThreadId eq 'thread1')");
  });

  it("escapes a quote in the thread id", async () => {
    const filter = await runSearch(
      makeCtx({ threadId: "t1') or (user ne 'x" })
    );
    expect(filter).toBe(
      "(user eq 'hashed-user' and chatThreadId eq 't1'') or (user ne ''x')"
    );
  });
});

describe("chat-page.unit.search-documents.002 — results go to the model without CHAT_CITATION rows", () => {
  const hits = [
    {
      score: 0.9,
      document: { pageContent: "alpha ".repeat(120), metadata: "a.pdf", chatThreadId: "thread1", id: "", user: "", personaDocumentId: null },
    },
    {
      score: 0.5,
      document: { pageContent: "beta", metadata: "b.pdf", chatThreadId: "thread1", id: "", user: "", personaDocumentId: null },
    },
  ];

  it("writes no citation rows and returns the same result shape", async () => {
    vi.mocked(SimilaritySearch).mockResolvedValueOnce({ status: "OK", response: hits } as any);
    const tool = searchDocumentsTool(makeCtx()) as any;
    const result = await tool.execute({ query: "q" }, {});

    expect(CreateCitations).not.toHaveBeenCalled();
    expect(historyCreate).not.toHaveBeenCalled();
    expect(historyUpsert).not.toHaveBeenCalled();

    expect(result.documentCount).toBe(2);
    expect(result.query).toBe("q");
    expect(result.documents.map((d: any) => [d.content, d.metadata, d.relevanceScore])).toEqual([
      [hits[0].document.pageContent, "a.pdf", 0.9],
      [hits[1].document.pageContent, "b.pdf", 0.5],
    ]);
    // Every result still has its own non-empty id.
    const ids = result.documents.map((d: any) => d.id);
    expect(ids.every((id: string) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(result.contextText).toContain("[Document 1] a.pdf");
    expect(result.contextText).toContain("...");
    expect(result.contextText).toContain("[Document 2] b.pdf\nContent: beta");
  });
});
