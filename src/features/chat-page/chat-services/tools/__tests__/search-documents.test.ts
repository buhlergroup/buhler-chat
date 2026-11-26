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

import { searchDocumentsTool } from "../search-documents";
import type { ToolContext } from "../tool-context";
import { SimilaritySearch } from "../../azure-ai-search/azure-ai-search";
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
