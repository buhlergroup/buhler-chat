import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/common/services/logger", () => ({
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

const mockFindAll = vi.fn();
vi.mock("@/features/persona-page/persona-services/persona-service", () => ({
  FindAllPersonaForCurrentUser: () => mockFindAll(),
}));

import { searchSubAgentTool } from "../search-sub-agent";
import type { ToolContext } from "../tool-context";

const CTX: ToolContext = {
  user: "u1",
  threadId: "t1",
  threadDocumentIds: [],
  personaDocumentIds: [],
  defaultTools: {},
  extensions: [],
  subAgentIds: ["p1", "p2", "p3"],
  depth: 0,
};

function makePersonas() {
  return [
    { id: "p1", name: "Python Assistant", description: "Helps with Python code." },
    { id: "p2", name: "Docs Writer", description: "Writes documentation." },
    { id: "p3", name: "Kubernetes Guru", description: "Cluster operations expert." },
  ];
}

async function run(query: string, ctx: ToolContext = CTX) {
  mockFindAll.mockResolvedValue({ status: "OK", response: makePersonas() });
  const t = searchSubAgentTool(ctx);
  // The AI SDK's `Tool` shape exposes `execute`; calling it directly is the
  // intended test seam.
  const result = await (t as any).execute({ query }, { abortSignal: undefined });
  return result as {
    query: string;
    agents: { id: string; name: string; description: string }[];
    summary: string;
  };
}

describe("searchSubAgentTool", () => {
  beforeEach(() => {
    mockFindAll.mockReset();
  });

  it("matches a keyword against name and description (case-insensitive)", async () => {
    const r = await run("python");
    expect(r.agents.map((a) => a.id)).toEqual(["p1"]);
  });

  it.each(["", "*", "all", "ALL"])(
    "lists every available agent for query=%j",
    async (query) => {
      const r = await run(query);
      expect(r.agents.map((a) => a.id)).toEqual(["p1", "p2", "p3"]);
      expect(r.summary).toMatch(/Listed all 3 available agent/);
    },
  );

  it("returns an empty result with a helpful summary when nothing matches", async () => {
    const r = await run("nonexistent-topic");
    expect(r.agents).toEqual([]);
    expect(r.summary).toMatch(/list every available agent/);
  });

  it("trims whitespace before deciding list-all vs keyword", async () => {
    const r = await run("   ");
    expect(r.agents).toHaveLength(3);
  });
});

// Pinned: search_sub_agent must not widen what call_sub_agent accepts. It
// lists only the configured sub-agents the user can open.
describe("searchSubAgentTool — only configured sub-agents", () => {
  beforeEach(() => {
    mockFindAll.mockReset();
  });

  it("lists only agents in subAgentIds", async () => {
    const r = await run("*", { ...CTX, subAgentIds: ["p2"] });
    expect(r.agents.map((a) => a.id)).toEqual(["p2"]);
  });

  it("ignores configured ids the user cannot open", async () => {
    const r = await run("*", { ...CTX, subAgentIds: ["p3", "hidden"] });
    expect(r.agents.map((a) => a.id)).toEqual(["p3"]);
  });

  it("lists nothing without configured sub-agents", async () => {
    const r = await run("", { ...CTX, subAgentIds: undefined });
    expect(r.agents).toEqual([]);
  });
});
