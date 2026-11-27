import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
import { tool, type UIMessageChunk } from "ai";
import { z } from "zod";

vi.mock("@/features/auth-page/helpers", () => ({ userHashedId: vi.fn(async () => "hashed-user") }));
vi.mock("@/features/common/services/logger", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

const runCopilotTurn = vi.fn();
vi.mock("./copilot-session", () => ({ runCopilotTurn: (...args: unknown[]) => runCopilotTurn(...args) }));

const persist = vi.fn(async (_args: unknown) => undefined);
vi.mock("../chat-api/persist-assistant", () => ({
  persistAssistantFromFinishEvent: (args: unknown) => persist(args),
  friendlyErrorMessage: (e: { message: string }) => `friendly: ${e.message}`,
}));
const uploads = vi.hoisted(() => ({
  entries: [{ path: "/workspace/uploads/a.pdf", dataKey: "d1", lastModified: new Date(1), size: 3 }] as Array<{
    path: string;
    dataKey: string;
    lastModified: Date;
    size?: number;
  }>,
  /** Files written to the thread's workspace (path -> text). */
  written: new Map<string, string>(),
}));
vi.mock("./workspace-files", async () => {
  const { uploadsNote } = await import("./workspace-uploads");
  return {
    threadWorkspace: async () => ({
      fs: {
        listEntries: async () => uploads.entries,
        writeFileBytes: async (path: string, content: Uint8Array) => {
          uploads.written.set(path, Buffer.from(content).toString("utf8"));
        },
      },
    }),
    chatDocumentIndexDeps: () => ({}),
    workspaceExtractDeps: () => ({}),
    workspaceUploadEntries: async () => uploads.entries,
    workspaceUploadsNote: (entries: never[]) => uploadsNote(entries),
    unindexedWorkspaceUploads: async () => uploads.entries.map((e) => e.path),
  };
});
const resolveSubAgents = vi.fn(async (_args: unknown) => ({ personas: [] }));
vi.mock("./subagent-resolver", () => ({
  resolveSubAgents: (args: unknown) => resolveSubAgents(args),
  canUsePersona: async () => true,
}));
const recordAgent = vi.fn(async (_id: string, _u: unknown) => undefined);
vi.mock("@/features/common/services/agent-stats-service", () => ({
  RecordAgentInteraction: (id: string, u: unknown) => recordAgent(id, u),
}));
const updateTitle = vi.fn(async () => undefined);
vi.mock("../chat-thread-service", () => ({ UpdateChatTitle: () => updateTitle() }));
const upsert = vi.fn(async (_row: unknown) => undefined);
vi.mock("../chat-message-service", () => ({ UpsertChatMessage: (row: unknown) => upsert(row) }));

import { recordSubAgentInteractions, runCopilotChatTurn, TURN_START_FAILED } from "./chat-turn";
import { WEB_SEARCH_REQUESTED_NOTE } from "./web-search-default";
import { ThreadBusyError } from "./thread-lease";
import { TurnLimitError } from "./runtime-limits";
import { MODEL_CONFIGS } from "../models";
import { abortPublisher, hasActivePublisher, __resetStreamPublishers } from "../chat-api/stream-publisher";

const modelConfig = {
  id: "gpt-5.5",
  provider: "azure",
  supportsResponsesAPI: true,
  contextWindow: 400_000,
  pricing: { inputPerMillion: 1, outputPerMillion: 10, cachedInputPerMillion: 0.1 },
} as never;

const ctx = (threadId: string) =>
  ({
    thread: { id: threadId, personaId: "agent-1", isTemporary: false },
    subAgentIds: ["sub-current"],
    user: { id: "user@example.invalid" },
    threadDocumentIds: [],
    history: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }],
    turnId: "turn-1",
    documentHintText: undefined,
  }) as never;

/** A fake Copilot turn whose stream stays open until the turn's abort signal trips. */
function fakeTurnUntilAbort() {
  runCopilotTurn.mockImplementation(async (input: { abortSignal: AbortSignal }) => {
    let controller!: ReadableStreamDefaultController<UIMessageChunk>;
    const stream = new ReadableStream<UIMessageChunk>({ start: (c) => void (controller = c) });
    controller.enqueue({ type: "start" });
    controller.enqueue({ type: "start-step" });
    controller.enqueue({ type: "text-start", id: "t" });
    controller.enqueue({ type: "text-delta", id: "t", delta: "partial" });
    const result = new Promise((resolve) => {
      input.abortSignal.addEventListener("abort", () => {
        controller.enqueue({ type: "text-end", id: "t" });
        controller.enqueue({ type: "finish-step" });
        controller.enqueue({ type: "abort" });
        controller.close();
        resolve({
          text: "partial",
          toolResults: [],
          steps: [{ text: "partial", reasoningText: "", toolCalls: [], toolResults: [] }],
          finishReason: "other",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokenDetails: { reasoningTokens: 0 } },
          aborted: true,
          sessionMode: "live",
          seededEvents: 0,
          turnUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0, byModel: {}, bySubAgent: {} },
          subAgentPersonas: {},
        });
      });
    });
    return { stream, result };
  });
}

describe("runCopilotChatTurn", () => {
  beforeEach(() => {
    __resetStreamPublishers();
    runCopilotTurn.mockReset();
  });

  it("the stop endpoint's abortPublisher cancels the Copilot turn, and the partial is persisted", async () => {
    fakeTurnUntilAbort();
    const res = await runCopilotChatTurn({
      ctx: ctx("thread-stop"),
      payload: { message: "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: {},
    });
    expect(res.status).toBe(200);
    const input = runCopilotTurn.mock.calls[0][0] as { abortSignal: AbortSignal; priorHistory: unknown[]; userKey: string };
    expect(input.userKey).toBe("hashed-user");
    expect(input.priorHistory).toEqual([]);
    // Copilot path only: index_document joins the app tools, uploads are named.
    const full = runCopilotTurn.mock.calls[0][0] as { toolset: Record<string, unknown>; contextNote?: string };
    expect(Object.keys(full.toolset)).toContain("index_document");
    expect(Object.keys(full.toolset)).toContain("extract_text");
    expect(full.contextNote).toContain("/workspace/uploads/a.pdf");
    expect(input.abortSignal.aborted).toBe(false);
    expect(hasActivePublisher("thread-stop")).toBe(true);

    // What POST /api/chat/[id]/stop does:
    expect(abortPublisher("thread-stop")).toBe(true);
    expect(input.abortSignal.aborted).toBe(true);

    const body = await res.text();
    expect(body).toContain("\"type\":\"text-delta\"");
    expect(body).toContain("\"type\":\"abort\"");
    await vi.waitFor(() => expect(persist).toHaveBeenCalled());
    const persisted = persist.mock.calls[0][0] as { threadId: string; turnId: string; event: { text: string; finishReason: string }; personaId?: string };
    expect(persisted).toMatchObject({ threadId: "thread-stop", turnId: "turn-1", personaId: "agent-1" });
    expect(persisted.event).toMatchObject({ text: "partial", finishReason: "other" });
    await vi.waitFor(() => expect(hasActivePublisher("thread-stop")).toBe(false));
    expect(updateTitle).toHaveBeenCalled(); // first turn of the thread
  });

  it("finish metadata carries the usage numbers the header reads (computeRequestUsage)", async () => {
    fakeTurnUntilAbort();
    await runCopilotChatTurn({
      ctx: ctx("thread-usage"),
      payload: { message: "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: {},
    });
    const input = runCopilotTurn.mock.calls[0][0] as { finishMetadata: (u: unknown) => { usage: Record<string, number> } };
    const meta = input.finishMetadata({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      lastInputTokens: 40_000,
      calls: 3,
      byModel: {},
      bySubAgent: {},
    });
    expect(meta.usage).toMatchObject({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedTokens: 500_000,
      lastPromptTokens: 40_000,
      stepCount: 3,
      contextWindowSize: 400_000,
    });
    expect(meta.usage.costUsd).toBeGreaterThan(0);
    abortPublisher("thread-usage");
  });

  it("a turn that cannot start answers 500, writes a sentinel row and frees the publisher", async () => {
    runCopilotTurn.mockRejectedValue(new Error("runtime unavailable"));
    const res = await runCopilotChatTurn({
      ctx: ctx("thread-fail"),
      payload: { message: "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: {},
    });
    expect(res.status).toBe(500);
    // The raw cause stays in the log: the client gets a generic text.
    expect(await res.text()).toBe(TURN_START_FAILED);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sentinel-turn-1", role: "assistant", content: "friendly: runtime unavailable" }),
    );
    expect(hasActivePublisher("thread-fail")).toBe(false);
  });

  it("a user over the concurrent-turn limit gets 429 with the limit text", async () => {
    runCopilotTurn.mockRejectedValue(new TurnLimitError("user"));
    const res = await runCopilotChatTurn({
      ctx: ctx("thread-limit"),
      payload: { message: "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: {},
    });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("maximum number of replies running");
    expect(hasActivePublisher("thread-limit")).toBe(false);
  });

  it("does not offer call_sub_agent / search_sub_agent (the runtime's task tool delegates)", async () => {
    fakeTurnUntilAbort();
    await runCopilotChatTurn({
      ctx: ctx("thread-tools"),
      payload: { message: "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: { call_sub_agent: {} as never, search_sub_agent: {} as never, get_current_time: {} as never },
    });
    const input = runCopilotTurn.mock.calls.at(-1)![0] as { toolset: Record<string, unknown>; subAgents: unknown };
    expect(Object.keys(input.toolset)).toContain("get_current_time");
    expect(Object.keys(input.toolset)).not.toContain("call_sub_agent");
    expect(Object.keys(input.toolset)).not.toContain("search_sub_agent");
    expect(input.subAgents).toEqual({ personas: [] });
    // The agent's current sub-agents from the thread context, not a thread copy.
    expect(resolveSubAgents.mock.calls.at(-1)![0]).toMatchObject({
      subAgentIds: ["sub-current"],
      parentPersonaId: "agent-1",
    });
    abortPublisher("thread-tools");
  });

  it("prices sub-agent tokens at their own model's price", async () => {
    fakeTurnUntilAbort();
    await runCopilotChatTurn({
      ctx: ctx("thread-cost"),
      payload: { message: "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: {},
    });
    const input = runCopilotTurn.mock.calls.at(-1)![0] as { finishMetadata: (u: unknown) => { usage: Record<string, number> } };
    const bucket = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 });
    const base = { outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 1, bySubAgent: {} };
    // 1M tokens on the turn model only vs. 1M split with an unknown (= turn-priced) model: same cost.
    // Models without a config are priced at the turn model's price (1 USD / 1M input here).
    const unknown = input.finishMetadata({
      ...base,
      inputTokens: 1_000_000,
      byModel: { "test-model-a": bucket(500_000), "test-model-b": bucket(500_000) },
    });
    expect(unknown.usage.costUsd).toBeCloseTo(1, 10);
    // A configured model's tokens use that model's own price.
    const luna = MODEL_CONFIGS["gpt-5.6-luna" as keyof typeof MODEL_CONFIGS];
    const mixed = input.finishMetadata({
      ...base,
      inputTokens: 1_000_000,
      byModel: { "test-model-a": bucket(500_000), "azure/gpt-5.6-luna": bucket(500_000) },
    });
    expect(mixed.usage.costUsd).toBeCloseTo(0.5 + 0.5 * luna.pricing!.inputPerMillion, 10);
    abortPublisher("thread-cost");
  });

  it("persists the turn per model: chat model, sub-agent and web_search model, each at its own price", async () => {
    const bucket = (input: number, output: number) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 });
    const turnUsage = {
      inputTokens: 3_000_000,
      outputTokens: 300_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      calls: 1,
      // The main model as the runtime names it, the `general` sub-agent on
      // gpt-5.6-luna, and a web_search call on GPT-6 Luna (plain model id).
      byModel: {
        "azure/gpt-5.5": bucket(1_000_000, 100_000),
        "openai/gpt-5.6-luna": bucket(1_000_000, 100_000),
        "gpt-6-luna": bucket(1_000_000, 100_000),
      },
      bySubAgent: { general: bucket(1_000_000, 100_000) },
    };
    runCopilotTurn.mockImplementation(async () => ({
      stream: new ReadableStream<UIMessageChunk>({ start: (c) => c.close() }),
      result: Promise.resolve({
        text: "done",
        toolResults: [],
        steps: [{ text: "done", reasoningText: "", toolCalls: [], toolResults: [] }],
        finishReason: "stop",
        usage: { inputTokens: 3_000_000, outputTokens: 300_000, totalTokens: 3_300_000, inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokenDetails: { reasoningTokens: 0 } },
        aborted: false,
        sessionMode: "live",
        seededEvents: 0,
        turnUsage,
        subAgentPersonas: {},
      }),
    }));
    persist.mockClear();
    await runCopilotChatTurn({
      ctx: ctx("thread-per-model"),
      payload: { message: "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: {},
    });
    await vi.waitFor(() => expect(persist).toHaveBeenCalled());
    const persisted = persist.mock.calls[0][0] as { costUsd: number; byModel: Array<{ model: string; inputTokens: number; costUsd: number }> };
    expect(persisted.byModel.map((m) => m.model)).toEqual(["gpt-5.5", "gpt-5.6-luna", "gpt-6-luna"]);
    // 1M input + 100k output per model, each at its own MODEL_CONFIGS price.
    const cost = (id: "gpt-5.5" | "gpt-5.6-luna" | "gpt-6-luna") =>
      MODEL_CONFIGS[id].pricing.inputPerMillion + 0.1 * MODEL_CONFIGS[id].pricing.outputPerMillion;
    expect(persisted.byModel[0].costUsd).toBeCloseTo(cost("gpt-5.5"), 10);
    expect(persisted.byModel[1].costUsd).toBeCloseTo(cost("gpt-5.6-luna"), 10);
    expect(persisted.byModel[2].costUsd).toBeCloseTo(cost("gpt-6-luna"), 10);
    expect(persisted.costUsd).toBeCloseTo(persisted.byModel.reduce((s, m) => s + m.costUsd, 0), 10);
  });

  it("records per-agent stats for persona sub-agents with their own tokens", () => {
    const record = vi.fn(async () => undefined);
    recordSubAgentInteractions(
      {
        bySubAgent: {
          "research-abc123": { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 0, calls: 2 },
          general: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 },
        },
      },
      { "research-abc123": "persona-1" },
      record,
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("persona-1", { inputTokens: 100, outputTokens: 10, cachedTokens: 40 });
  });

  it("a turn on a thread that another instance or tab is running answers 409", async () => {
    runCopilotTurn.mockRejectedValue(new ThreadBusyError());
    const res = await runCopilotChatTurn({
      ctx: ctx("thread-busy"),
      payload: { message: "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: {},
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/still running/);
    expect(hasActivePublisher("thread-busy")).toBe(false);
  });
});

describe("runCopilotChatTurn: search_documents, uploads and run_code", () => {
  const search = (documentCount: number) =>
    tool({
      description: "Search through documents attached to the current chat.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }: { query: string }) => ({ query, documents: [], documentCount, summary: "Found 0" }),
    });
  const extensionTool = tool({ description: "Search the engineering guidelines.", inputSchema: z.object({ q: z.string() }), execute: async () => ({}) });

  async function turnWith(opts: {
    threadId: string;
    uploads: typeof uploads.entries;
    threadDocumentIds?: string[];
    personaDocumentIds?: string[];
    builtInToggles?: { imageGeneration: boolean; webSearch: boolean; codeInterpreter: boolean };
    systemMessage?: string;
    message?: string;
    turnId?: string;
  }) {
    uploads.entries = opts.uploads;
    fakeTurnUntilAbort();
    const base = ctx(opts.threadId) as Record<string, unknown>;
    await runCopilotChatTurn({
      ctx: {
        ...base,
        threadDocumentIds: opts.threadDocumentIds ?? [],
        personaDocumentIds: opts.personaDocumentIds ?? [],
        ...(opts.turnId ? { turnId: opts.turnId } : {}),
      } as never,
      payload: { message: opts.message ?? "hello" } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: opts.systemMessage ?? "sys",
      toolset: { search_documents: search(0), "ext_guidelines-abc": extensionTool },
      ...(opts.builtInToggles ? { builtInToggles: opts.builtInToggles } : {}),
    });
    abortPublisher(opts.threadId);
    return runCopilotTurn.mock.calls.at(-1)![0] as {
      toolset: Record<string, { description?: string; execute?: (a: unknown, o: unknown) => Promise<unknown> }>;
      contextNote?: string;
      systemMessage: string;
      prompt: string;
    };
  }

  beforeEach(() => {
    __resetStreamPublishers();
    runCopilotTurn.mockReset();
  });

  it("an agent with extensions, no documents and no uploads: no search_documents, the extension tool stays", async () => {
    const input = await turnWith({ threadId: "t-ext", uploads: [] });
    expect(Object.keys(input.toolset)).not.toContain("search_documents");
    expect(Object.keys(input.toolset)).toContain("ext_guidelines-abc");
    // index_document says when the search is there.
    expect(Object.keys(input.toolset)).toContain("index_document");
  });

  it("agent documents or indexed chat documents: search_documents is offered, for indexed documents only", async () => {
    for (const docs of [{ personaDocumentIds: ["pd1"] }, { threadDocumentIds: ["cd1"] }]) {
      const input = await turnWith({ threadId: `t-docs-${Object.keys(docs)[0]}`, uploads: [], ...docs });
      expect(input.toolset.search_documents.description).toMatch(/indexed documents/);
    }
  });

  it("an upload that is not indexed: the turn names it, and a search with no hit returns a hint naming it", async () => {
    const input = await turnWith({
      threadId: "t-upload",
      uploads: [{ path: "/workspace/uploads/report.pdf", dataKey: "d", lastModified: new Date(5), size: 10 }],
    });
    expect(input.contextNote).toContain("/workspace/uploads/report.pdf");
    expect(input.contextNote).toMatch(/stored, not indexed/);
    const out = (await input.toolset.search_documents.execute!({ query: "pressure" }, { toolCallId: "s", messages: [] })) as {
      documentCount: number;
      summary: string;
      unindexedUploads: string[];
    };
    expect(out.documentCount).toBe(0);
    expect(out.unindexedUploads).toEqual(["/workspace/uploads/report.pdf"]);
    expect(out.summary).toContain("/workspace/uploads/report.pdf");
    expect(out.summary).toMatch(/extract_text/);
  });

  it("the system message is the same on two turns of a thread whose uploads change", async () => {
    const first = await turnWith({ threadId: "t-stable", uploads: [], builtInToggles: { imageGeneration: false, webSearch: false, codeInterpreter: true } });
    const second = await turnWith({
      threadId: "t-stable",
      uploads: [{ path: "/workspace/uploads/new.xlsx", dataKey: "d", lastModified: new Date(9), size: 10 }],
      builtInToggles: { imageGeneration: false, webSearch: false, codeInterpreter: true },
    });
    expect(second.systemMessage).toBe(first.systemMessage);
    // run_code's description does not change with the files either.
    expect(second.toolset.run_code.description).toBe(first.toolset.run_code.description);
    // The new upload reaches the model in the turn's own message.
    expect(second.contextNote).toContain("/workspace/uploads/new.xlsx");
  });
});

describe("runCopilotChatTurn: a very large user message", () => {
  beforeEach(() => {
    __resetStreamPublishers();
    runCopilotTurn.mockReset();
    uploads.written.clear();
    uploads.entries = [];
  });

  async function turn(threadId: string, message: string, turnId = "turn-1") {
    fakeTurnUntilAbort();
    const base = ctx(threadId) as Record<string, unknown>;
    await runCopilotChatTurn({
      ctx: { ...base, turnId } as never,
      payload: { message } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: {},
    });
    abortPublisher(threadId);
    return runCopilotTurn.mock.calls.at(-1)![0] as { prompt: string; systemMessage: string; contextNote?: string };
  }

  it("is saved to /workspace/uploads and the model gets a note with the path, size and a preview", async () => {
    const big = "Line of pasted log text.\n".repeat(1000) + "QUESTION: what failed?";
    const input = await turn("t-big", big, "turn-big1");
    const path = "/workspace/uploads/pasted-text-turn-big1.txt";
    expect(uploads.written.get(path)).toBe(big);
    expect(input.prompt).toContain(path);
    expect(input.prompt).toContain(`(${Buffer.byteLength(big, "utf8")} bytes)`);
    expect(input.prompt.startsWith("The user's message was too long")).toBe(true);
    expect(input.prompt).toContain("Line of pasted log text.");
    expect(input.prompt.length).toBeLessThan(5 * 1024);
  });

  it("a message at the limit goes to the model as it is, and nothing is written", async () => {
    const atLimit = "x".repeat(16 * 1024);
    const input = await turn("t-limit", atLimit);
    expect(input.prompt).toBe(atLimit);
    expect(uploads.written.size).toBe(0);
  });

  it("the system message is the same with and without a saved paste", async () => {
    const small = await turn("t-sys", "hello", "turn-a");
    const big = await turn("t-sys", "y".repeat(20_000), "turn-b");
    expect(uploads.written.has("/workspace/uploads/pasted-text-turn-b.txt")).toBe(true);
    expect(big.systemMessage).toBe(small.systemMessage);
    expect(big.systemMessage).not.toContain("pasted-text");
    // The note is in the user message only.
    expect(big.prompt).toContain("/workspace/uploads/pasted-text-turn-b.txt");
  });
});

describe("runCopilotChatTurn: web_search on every turn (COPILOT_WEB_SEARCH_ALWAYS)", () => {
  const luna = MODEL_CONFIGS["gpt-5.6-luna" as keyof typeof MODEL_CONFIGS] as { deploymentName?: string };
  let deployment: string | undefined;

  beforeAll(() => {
    // A deployed Responses model for the tool (the test env has none).
    deployment = luna.deploymentName;
    luna.deploymentName = "luna-deployment";
  });
  afterAll(() => {
    luna.deploymentName = deployment;
  });
  beforeEach(() => {
    __resetStreamPublishers();
    runCopilotTurn.mockReset();
    uploads.entries = [];
    vi.stubEnv("COPILOT_WEB_SEARCH_ALWAYS", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function webTurn(threadId: string, webSearch: boolean, message = "What changed in the standard?") {
    fakeTurnUntilAbort();
    await runCopilotChatTurn({
      ctx: ctx(threadId),
      payload: { message } as never,
      modelConfig,
      effectiveModel: "gpt-5.5" as never,
      systemMessage: "sys",
      toolset: {},
      builtInToggles: { imageGeneration: false, webSearch, codeInterpreter: false },
    });
    abortPublisher(threadId);
    return runCopilotTurn.mock.calls.at(-1)![0] as {
      toolset: Record<string, { description?: string }>;
      systemMessage: string;
      prompt: string;
    };
  }

  it("toggle off, setting unset: web_search is offered", async () => {
    const input = await webTurn("t-web-default", false);
    expect(Object.keys(input.toolset)).toContain("web_search");
  });

  it("toggle off, setting false: web_search is not offered", async () => {
    vi.stubEnv("COPILOT_WEB_SEARCH_ALWAYS", "false");
    const input = await webTurn("t-web-off", false);
    expect(Object.keys(input.toolset)).not.toContain("web_search");
  });

  it("toggle on: web_search is offered, also with the setting false", async () => {
    expect(Object.keys((await webTurn("t-web-on", true)).toolset)).toContain("web_search");
    vi.stubEnv("COPILOT_WEB_SEARCH_ALWAYS", "false");
    expect(Object.keys((await webTurn("t-web-on-off", true)).toolset)).toContain("web_search");
  });

  it("the user message gets the web search note only when the toggle is on", async () => {
    const off = await webTurn("t-web-note", false, "What is new?");
    expect(off.prompt).toBe("What is new?");
    const on = await webTurn("t-web-note", true, "What is new?");
    expect(on.prompt.startsWith("What is new?")).toBe(true);
    expect(on.prompt.endsWith(WEB_SEARCH_REQUESTED_NOTE)).toBe(true);
  });

  it("the system message and the tool list are the same for toggle on and off turns", async () => {
    const off = await webTurn("t-web-stable", false);
    const on = await webTurn("t-web-stable", true);
    const off2 = await webTurn("t-web-stable", false);
    expect(on.systemMessage).toBe(off.systemMessage);
    expect(on.systemMessage).not.toContain(WEB_SEARCH_REQUESTED_NOTE);
    expect(Object.keys(on.toolset)).toEqual(Object.keys(off.toolset));
    expect(Object.keys(off2.toolset)).toEqual(Object.keys(off.toolset));
    // Static tool description: the same definition on every turn.
    expect(on.toolset.web_search.description).toBe(off.toolset.web_search.description);
  });
});
