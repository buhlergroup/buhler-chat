import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// No model is ever reached from this file: `recordHistoryCompaction` takes the
// summariser as a parameter and every test injects its own.

// ── Cosmos ────────────────────────────────────────────────────────────────────
let stored: any[] = [];
const upsert = vi.fn(async (doc: any) => {
  stored = [...stored.filter((d) => d.id !== doc.id), doc];
  return { resource: doc };
});
const query = vi.fn(() => ({
  fetchAll: async () => ({
    resources: stored.filter((d) => d.type === "CHAT_HISTORY_SUMMARY" && !d.isDeleted),
  }),
}));
vi.mock("@/features/common/services/cosmos", () => ({
  HistoryContainer: () => ({ items: { upsert, query } }),
}));

// ── Auth ──────────────────────────────────────────────────────────────────────
vi.mock("@/features/auth-page/helpers", () => ({
  userHashedId: vi.fn(async () => "user-hash"),
}));

// ── Logger ────────────────────────────────────────────────────────────────────
const logWarn = vi.fn();
const logError = vi.fn();
vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: (...a: unknown[]) => logWarn(...a),
  logError: (...a: unknown[]) => logError(...a),
}));

// ── Model table ───────────────────────────────────────────────────────────────
// MODEL_CONFIGS reads the deployment-name env vars at MODULE LOAD, which in a
// test means before any `process.env` assignment in a test body. A small table
// keeps the resolution deterministic and states which seam each model is on.
//
// Mutable, and reset per test: one case needs "this environment has nothing
// callable", which no combination of env vars can produce now that the table —
// not the env — owns the deployment names.
const { modelTable } = vi.hoisted(() => ({
  modelTable: {} as Record<string, Record<string, unknown>>,
}));
vi.mock("../models", () => ({ MODEL_CONFIGS: modelTable }));

const DEFAULT_MODEL_TABLE: Record<string, Record<string, unknown>> = {
  "gpt-5.6-sol": { id: "gpt-5.6-sol", deploymentName: "sol-dep" },
  "gpt-5.6-terra": { id: "gpt-5.6-terra", deploymentName: "terra-dep" },
  "gpt-5.6-luna": { id: "gpt-5.6-luna", deploymentName: "luna-dep" },
  // In the table, but not deployed in this environment.
  "gpt-5.5": { id: "gpt-5.5" },
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    provider: "anthropic",
    deploymentName: "claude-dep",
  },
  "DeepSeek-V4-Pro": {
    id: "DeepSeek-V4-Pro",
    provider: "foundry",
    deploymentName: "deepseek-dep",
  },
};

function resetModelTable(entries = DEFAULT_MODEL_TABLE) {
  for (const key of Object.keys(modelTable)) delete modelTable[key];
  for (const [key, value] of Object.entries(entries)) modelTable[key] = value;
}

// ── Provider seam + metric ────────────────────────────────────────────────────
// The summariser reaches a model ONLY through the seam now (the legacy
// chat-completions client 404'd on the 5.6 deployments). Tests inject their own
// summariser, so the seam must never actually be asked for a client.
const mockResolveProvider = vi.fn(() => {
  throw new Error("no live model calls in unit tests");
});
vi.mock("../models/provider-seam", () => ({
  resolveProvider: (...a: unknown[]) => mockResolveProvider(...(a as [])),
}));

// generateText: the summariser's one provider call. Mocked because these
// tests must never reach a model; asserted on because its options ARE the
// contract that broke (a 404 from the wrong client, an unproven effort value).
const mockGenerateText = vi.fn(async () => ({
  text: "FACTS: from the seam.",
  usage: { inputTokens: 120, outputTokens: 34 },
}));
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: (...a: unknown[]) => mockGenerateText(...(a as [])) };
});

const mockReportHistorySummaryTokens = vi.fn(async () => undefined);
vi.mock("@/features/common/services/chat-metrics-service", () => ({
  reportHistorySummaryTokens: (...a: unknown[]) =>
    mockReportHistorySummaryTokens(...(a as [])),
}));

import {
  DEFAULT_HISTORY_SUMMARY_TIMEOUT_MS,
  FindChatHistorySummary,
  SoftDeleteChatHistorySummary,
  isHistorySummaryEnabled,
  recordHistoryCompaction,
  resolveHistorySummaryModel,
  resolveHistorySummaryTimeoutMs,
} from "./history-summary-service";
import { HISTORY_SUMMARY_ATTRIBUTE } from "./history-summary";
import type { BudgetMessage } from "./history-budget";

const ENV_KEYS = [
  "HISTORY_SUMMARY_ENABLED",
  "HISTORY_SUMMARY_DEPLOYMENT_NAME",
  "HISTORY_SUMMARY_TIMEOUT_MS",
  "AZURE_OPENAI_API_GPT56_TERRA_DEPLOYMENT_NAME",
  "AZURE_OPENAI_API_GPT56_LUNA_DEPLOYMENT_NAME",
  "AZURE_OPENAI_API_GPT56_SOL_DEPLOYMENT_NAME",
  "AZURE_OPENAI_API_MINI_DEPLOYMENT_NAME",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  stored = [];
  vi.clearAllMocks();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AZURE_OPENAI_API_GPT56_TERRA_DEPLOYMENT_NAME = "terra-dep";
  process.env.AZURE_OPENAI_API_GPT56_LUNA_DEPLOYMENT_NAME = "luna-dep";
  resetModelTable();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const dropped: BudgetMessage[] = [
  { id: "m1", role: "user", content: "Always answer in metric units." },
  { id: "m2", role: "assistant", content: "Noted." },
];

function summariserReturning(text: string) {
  return vi.fn(async () => ({ text, inputTokens: 120, outputTokens: 34 }));
}

// ---------------------------------------------------------------------------

describe("chat-page.unit.history-summary-service.001 — configuration", () => {
  it("is off unless the flag is exactly \"true\"", () => {
    for (const value of [undefined, "", "false", "1", "TRUE", "yes"]) {
      if (value === undefined) delete process.env.HISTORY_SUMMARY_ENABLED;
      else process.env.HISTORY_SUMMARY_ENABLED = value;
      expect(isHistorySummaryEnabled()).toBe(false);
    }
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    expect(isHistorySummaryEnabled()).toBe(true);
  });

  it("resolves a MODEL ID, not a bare deployment name", () => {
    // The seam builds the client from a model id. Returning a deployment
    // string is what let the summariser end up on the legacy
    // chat-completions surface, which answers 404 for the 5.6 deployments.
    expect(resolveHistorySummaryModel({ selectedModel: "gpt-5.6-sol" })).toEqual(
      expect.objectContaining({
        modelId: "gpt-5.6-sol",
        deploymentName: "sol-dep",
        source: "thread",
      }),
    );
  });

  it("summarises on the thread's own model, whichever provider it is on", () => {
    // The dropped block is the block that model just had in context. Sending
    // it elsewhere pays for every one of those tokens again, cold. The seam
    // covers all three providers, so Claude threads no longer have to move.
    expect(
      resolveHistorySummaryModel({ selectedModel: "claude-sonnet-5" })?.modelId,
    ).toBe("claude-sonnet-5");
    expect(
      resolveHistorySummaryModel({ selectedModel: "DeepSeek-V4-Pro" })?.modelId,
    ).toBe("DeepSeek-V4-Pro");
  });

  it("lets the explicit override beat even the thread's model", () => {
    process.env.HISTORY_SUMMARY_DEPLOYMENT_NAME = "luna-dep";
    expect(
      resolveHistorySummaryModel({ selectedModel: "gpt-5.6-sol" }),
    ).toEqual(
      expect.objectContaining({ modelId: "gpt-5.6-luna", source: "env" }),
    );
  });

  it("skips a configured deployment no model config owns, and logs it", () => {
    // Nothing could build a client for it, so honouring it would 404 on every
    // trim — which is the defect this resolution replaced.
    process.env.HISTORY_SUMMARY_DEPLOYMENT_NAME = "a-deployment-nobody-owns";
    const chosen = resolveHistorySummaryModel();
    expect(chosen).toEqual(
      expect.objectContaining({ modelId: "gpt-5.6-terra", source: "terra" }),
    );
    expect(
      logWarn.mock.calls.map((c) => String(c[0])).join(" "),
    ).toContain("has no model config");
  });

  it("skips a thread model that is not in the table, or not deployed here", () => {
    // gpt-9000 does not exist; gpt-5.5 exists but this environment has no
    // deployment for it. Both mean "cannot call it".
    expect(resolveHistorySummaryModel({ selectedModel: "gpt-9000" })?.source).toBe(
      "terra",
    );
    expect(resolveHistorySummaryModel({ selectedModel: "gpt-5.5" })?.source).toBe(
      "terra",
    );
  });

  it("defaults to terra, then luna, then the titles deployment", () => {
    expect(resolveHistorySummaryModel()?.modelId).toBe("gpt-5.6-terra");

    // Terra not deployed here.
    resetModelTable({
      "gpt-5.6-luna": DEFAULT_MODEL_TABLE["gpt-5.6-luna"],
      "gpt-5.6-sol": DEFAULT_MODEL_TABLE["gpt-5.6-sol"],
    });
    expect(resolveHistorySummaryModel()?.modelId).toBe("gpt-5.6-luna");

    // Neither terra nor luna: the titles deployment counts only if a model
    // config owns it.
    resetModelTable({ "gpt-5.6-sol": DEFAULT_MODEL_TABLE["gpt-5.6-sol"] });
    process.env.AZURE_OPENAI_API_MINI_DEPLOYMENT_NAME = "sol-dep";
    expect(resolveHistorySummaryModel()).toEqual(
      expect.objectContaining({ modelId: "gpt-5.6-sol", source: "titles" }),
    );
  });

  it("resolves to undefined when nothing callable is configured", () => {
    resetModelTable({});
    expect(resolveHistorySummaryModel()).toBeUndefined();
  });
});

describe("chat-page.unit.history-summary-service.002 — recordHistoryCompaction writes the watermark", () => {
  it("persists the row with the summary when the feature is on", async () => {
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    const summarise = summariserReturning("FACTS: metric units.");

    const row = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise,
    });

    expect(summarise).toHaveBeenCalledTimes(1);
    expect(row).not.toBeNull();
    expect(row!.type).toBe(HISTORY_SUMMARY_ATTRIBUTE);
    expect(row!.content).toBe("FACTS: metric units.");
    expect(row!.coversThroughMessageId).toBe("m2");
    expect(row!.coversMessageCount).toBe(2);
    expect(row!.model).toBe("gpt-5.6-terra");
    expect(row!.estimatedTokens).toBeGreaterThan(0);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("writes the watermark with an EMPTY summary when the feature is off", async () => {
    // The watermark is what stops a trim from sliding forward one turn at a
    // time, so it has to be persisted regardless of the feature flag.
    const summarise = summariserReturning("should not be used");

    const row = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise,
    });

    expect(summarise).not.toHaveBeenCalled();
    expect(row!.content).toBe("");
    expect(row!.model).toBe("");
    expect(row!.estimatedTokens).toBe(0);
    expect(row!.coversThroughMessageId).toBe("m2");
  });

  it("makes the row readable back through FindChatHistorySummary", async () => {
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise: summariserReturning("body"),
    });

    const found = await FindChatHistorySummary("t1");
    expect(found?.content).toBe("body");
    expect(found?.coversThroughMessageId).toBe("m2");
  });

  it("upserts in place, so a thread never accumulates summary rows", async () => {
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    const first = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise: summariserReturning("first"),
    });
    const second = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: [{ id: "m3", role: "user", content: "more" }],
      coversThroughMessageId: "m3",
      previous: first,
      summarise: summariserReturning("second"),
    });

    expect(second!.id).toBe(first!.id);
    expect(stored.filter((d) => d.type === HISTORY_SUMMARY_ATTRIBUTE)).toHaveLength(1);
    expect(second!.coversThroughMessageId).toBe("m3");
    // coversMessageCount is cumulative across trims.
    expect(second!.coversMessageCount).toBe(3);
  });

  it("returns null when even the watermark cannot be written", async () => {
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    upsert.mockRejectedValueOnce(new Error("cosmos down"));

    const row = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise: summariserReturning("body"),
    });

    expect(row).toBeNull();
    expect(logError).toHaveBeenCalled();
  });

  it("does not call the summariser for an empty block", async () => {
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    const summarise = summariserReturning("body");
    const row = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: [],
      coversThroughMessageId: "m0",
      summarise,
    });
    expect(summarise).not.toHaveBeenCalled();
    expect(row!.content).toBe("");
  });
});

describe("chat-page.unit.history-summary-service.003 — the previous summary is folded in", () => {
  it("passes the previous summary to the summariser and replaces it", async () => {
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    const first = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise: summariserReturning("FACTS: metric units."),
    });

    const summarise = vi.fn(async () => ({
      text: "FACTS: metric units. DECISIONS: ship Friday.",
      inputTokens: 200,
      outputTokens: 60,
    }));
    const second = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: [{ id: "m4", role: "user", content: "Ship on Friday." }],
      coversThroughMessageId: "m4",
      previous: first,
      summarise,
    });

    const [call] = summarise.mock.calls as unknown as [
      [{ userPrompt: string; systemPrompt: string; deployment: string }],
    ];
    expect(call[0].userPrompt).toContain("<prior-summary>");
    expect(call[0].userPrompt).toContain("FACTS: metric units.");
    expect(call[0].deployment).toBe("terra-dep");
    expect(call[0].modelId).toBe("gpt-5.6-terra");
    expect(second!.content).toContain("DECISIONS: ship Friday.");
  });

  it("keeps the previous summary when the feature is switched off mid-thread", async () => {
    const previous = {
      id: "summary-t1",
      type: HISTORY_SUMMARY_ATTRIBUTE as typeof HISTORY_SUMMARY_ATTRIBUTE,
      threadId: "t1",
      userId: "user-hash",
      isDeleted: false,
      createdAt: new Date("2026-09-01"),
      role: "system" as const,
      kind: "summary" as const,
      content: "FACTS: earned earlier.",
      coversThroughMessageId: "m2",
      coversMessageCount: 2,
      model: "luna-dep",
      estimatedTokens: 6,
    };

    const row = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m9",
      previous,
    });

    // Context already paid for is not thrown away just because the flag moved.
    expect(row!.content).toBe("FACTS: earned earlier.");
    expect(row!.coversThroughMessageId).toBe("m9");
  });
});

describe("chat-page.unit.history-summary-service.004 — fallback when the summariser fails", () => {
  it("still advances the watermark when the summariser throws", async () => {
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    const summarise = vi.fn(async () => {
      throw new Error("429 rate limited");
    });

    const row = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise,
    });

    // Plain trimming: the block is gone, the watermark holds, no summary.
    expect(row).not.toBeNull();
    expect(row!.content).toBe("");
    expect(row!.coversThroughMessageId).toBe("m2");
    expect(logWarn).toHaveBeenCalled();
    const warned = logWarn.mock.calls.map((c) => String(c[0])).join(" | ");
    expect(warned).toContain("falling back to plain trimming");
  });

  it("keeps an earlier summary when a later summariser call throws", async () => {
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    const first = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise: summariserReturning("FACTS: metric units."),
    });

    const second = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: [{ id: "m5", role: "user", content: "next" }],
      coversThroughMessageId: "m5",
      previous: first,
      summarise: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    // The old summary still correctly describes everything before this block,
    // so only the newly dropped block is lost.
    expect(second!.content).toBe("FACTS: metric units.");
    expect(second!.coversThroughMessageId).toBe("m5");
  });

  it("falls back when the summariser returns only whitespace", async () => {
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    const row = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise: summariserReturning("   \n  "),
    });
    expect(row!.content).toBe("");
    expect(logWarn).toHaveBeenCalled();
  });

  it("falls back when no deployment is configured", async () => {
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    // Nothing callable at all: no env override, no thread model, and no model
    // in the table carries a deployment.
    resetModelTable({});
    const summarise = summariserReturning("body");

    const row = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise,
    });

    expect(summarise).not.toHaveBeenCalled();
    expect(row!.content).toBe("");
    expect(row!.coversThroughMessageId).toBe("m2");
  });
});

describe("chat-page.unit.history-summary-service.005 — read and invalidate", () => {
  it("returns null when the thread has no compaction row", async () => {
    expect(await FindChatHistorySummary("t1")).toBeNull();
  });

  it("returns null rather than throwing when Cosmos fails", async () => {
    query.mockImplementationOnce(() => ({
      fetchAll: async () => {
        throw new Error("cosmos down");
      },
    }));
    expect(await FindChatHistorySummary("t1")).toBeNull();
    expect(logWarn).toHaveBeenCalled();
  });

  it("soft-deletes the row so a rewound thread stops replaying it", async () => {
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise: summariserReturning("body"),
    });
    expect(await FindChatHistorySummary("t1")).not.toBeNull();

    await SoftDeleteChatHistorySummary("t1");

    // Both the summary text AND the watermark go, so the budget re-derives a
    // cut from whatever survived the rewind.
    expect(await FindChatHistorySummary("t1")).toBeNull();
  });

  it("is a no-op when there is nothing to soft-delete", async () => {
    await SoftDeleteChatHistorySummary("t1");
    expect(upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("chat-page.unit.history-summary-service.006 — the summariser has a deadline", () => {
  it("resolves the timeout from the env, ignoring nonsense", () => {
    // A typo must not become "give up immediately", and must not become
    // "wait forever" either.
    expect(resolveHistorySummaryTimeoutMs(undefined)).toBe(
      DEFAULT_HISTORY_SUMMARY_TIMEOUT_MS,
    );
    expect(resolveHistorySummaryTimeoutMs("")).toBe(DEFAULT_HISTORY_SUMMARY_TIMEOUT_MS);
    expect(resolveHistorySummaryTimeoutMs("nope")).toBe(
      DEFAULT_HISTORY_SUMMARY_TIMEOUT_MS,
    );
    expect(resolveHistorySummaryTimeoutMs("0")).toBe(DEFAULT_HISTORY_SUMMARY_TIMEOUT_MS);
    expect(resolveHistorySummaryTimeoutMs("-5000")).toBe(
      DEFAULT_HISTORY_SUMMARY_TIMEOUT_MS,
    );
    expect(resolveHistorySummaryTimeoutMs("5000")).toBe(5000);
    expect(resolveHistorySummaryTimeoutMs("5000.9")).toBe(5000);
  });

  it("defaults to 20 seconds", () => {
    expect(DEFAULT_HISTORY_SUMMARY_TIMEOUT_MS).toBe(20_000);
  });

  it("falls back to the plain trim when the summariser hangs", async () => {
    // This call is on the REQUEST path — it runs before the stream starts, so
    // a hanging deployment would otherwise stall the turn with no ceiling.
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    process.env.HISTORY_SUMMARY_TIMEOUT_MS = "25";

    let settle: (() => void) | undefined;
    const hangs = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          // Never resolves on its own; kept addressable so the test can free
          // it rather than leaving a dangling promise behind.
          settle = () => resolve("too late");
        }),
    );

    const row = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise: hangs,
    });

    // The trim STILL STICKS: the watermark is the thing that makes the prompt
    // cheap, and it is written whether or not there is a summary to go with it.
    expect(row).not.toBeNull();
    expect(row!.content).toBe("");
    expect(row!.coversThroughMessageId).toBe("m2");
    expect(row!.model).toBe("");

    const warned = logWarn.mock.calls.map((c) => String(c[0])).join(" | ");
    expect(warned).toContain("timed out");
    expect(warned).toContain("falling back to plain trimming");
    // The payload has to say it was a timeout, not just that something failed.
    const timeoutCall = logWarn.mock.calls.find((c) =>
      String(c[0]).includes("timed out"),
    );
    expect((timeoutCall?.[1] as { timedOut?: boolean })?.timedOut).toBe(true);
    expect((timeoutCall?.[1] as { timeoutMs?: number })?.timeoutMs).toBe(25);

    settle?.();
  });

  it("aborts the signal it handed the summariser, rather than abandoning the call", async () => {
    // An abandoned HTTP call keeps spending on a result nobody will read.
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    process.env.HISTORY_SUMMARY_TIMEOUT_MS = "25";

    let seenSignal: AbortSignal | undefined;
    const hangs = vi.fn(
      (input: { signal?: AbortSignal }) =>
        new Promise<string>(() => {
          seenSignal = input.signal;
        }),
    );

    await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise: hangs,
    });

    expect(seenSignal).toBeDefined();
    expect(seenSignal!.aborted).toBe(true);
  });

  it("does not interfere with a summariser that answers in time", async () => {
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    process.env.HISTORY_SUMMARY_TIMEOUT_MS = "5000";

    const row = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise: summariserReturning("FACTS: metric units."),
    });

    expect(row!.content).toBe("FACTS: metric units.");
    expect(row!.model).toBe("gpt-5.6-terra");
    const warned = logWarn.mock.calls.map((c) => String(c[0])).join(" | ");
    expect(warned).not.toContain("timed out");
  });
});

describe("chat-page.unit.history-summary-service.007 — the summariser is not billed, but is measured", () => {
  async function serviceSource(): Promise<string> {
    const [{ readFile }, path] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    return readFile(
      path.join(
        process.cwd(),
        "features/chat-page/chat-services/chat-api/history-summary-service.ts",
      ),
      "utf-8",
    );
  }

  it("never touches the user's cap or the header's usage figure", async () => {
    // The user did not ask for this call; the budget did, to make their thread
    // cheaper. Charging their daily cap for our own housekeeping would be
    // wrong. Asserted on the source because the invariant is an ABSENCE —
    // there is no call to spy on.
    const source = await serviceSource();
    expect(source).not.toContain("budget-service");
    expect(source).not.toContain("reportPromptTokens");
    expect(source).not.toContain("recordUsage");
    expect(source).not.toContain("UpsertDailyUsage");
  });

  it("never constructs the legacy Azure chat-completions client", async () => {
    // THE REGRESSION GUARD. That client talks to *.openai.azure.com with an
    // api-version and answers 404 Resource not found for the 5.6 deployments,
    // so every trim failed and the UI blamed the feature flag. One way to
    // reach a model, and it is the seam the chat path uses on every turn.
    //
    // Comments are stripped first: this file's own doc comments name the old
    // client precisely so the next reader knows why it is gone, and the guard
    // is about the CODE.
    const code = (await serviceSource())
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(code).not.toContain("OpenAIV1Instance");
    expect(code).not.toContain("OpenAIMiniInstance");
    expect(code).not.toContain("chat.completions");
    expect(code).not.toContain("max_completion_tokens");
    expect(code).not.toContain("common/services/openai");
    // and it DOES go through the seam the chat route uses
    expect(code).toContain("resolveProvider");
    expect(code).toContain("generateText");
  });

  it("asks the seam for a proven option set, and no thinking panel", async () => {
    // The default summariser is the one path these tests do not inject, so
    // the seam call is where its options are checked. "low", not "none": the
    // picker never offers "none", so no live call has ever sent it to these
    // deployments — and an unproven provider combination is what 404'd here
    // in the first place.
    mockResolveProvider.mockReturnValueOnce({
      model: {} as never,
      builtInTools: {},
      providerOptions: {
        openai: {
          promptCacheKey: "summary:t1",
          store: false,
          reasoningEffort: "low",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      },
    } as never);

    process.env.HISTORY_SUMMARY_ENABLED = "true";
    await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      selectedModel: "gpt-5.6-terra",
      // no `summarise`: the real callSummariserModel runs, against the mocks
    });

    const seamArgs = mockResolveProvider.mock.calls[0][0] as unknown as {
      modelId: string;
      promptCacheKey: string;
      reasoning: { effort: string };
      toggles: Record<string, boolean>;
    };
    expect(seamArgs.modelId).toBe("gpt-5.6-terra");
    expect(seamArgs.reasoning.effort).toBe("low");
    // Its own cache namespace, derived from the thread and never an email.
    expect(seamArgs.promptCacheKey).toBe("summary:t1");
    expect(Object.values(seamArgs.toggles).every((on) => on === false)).toBe(true);

    const callOptions = mockGenerateText.mock.calls[0][0] as unknown as {
      maxOutputTokens?: number;
      providerOptions?: { openai?: Record<string, unknown> };
    };
    expect(callOptions.maxOutputTokens).toBe(2000);
    expect(callOptions.providerOptions?.openai).toMatchObject({
      promptCacheKey: "summary:t1",
      store: false,
    });
    // Dropped: nobody renders a summariser's thinking.
    expect(callOptions.providerOptions?.openai).not.toHaveProperty("reasoningSummary");
    expect(callOptions.providerOptions?.openai).not.toHaveProperty("include");
  });

  it("reports the summariser's tokens as their own metric", async () => {
    process.env.HISTORY_SUMMARY_ENABLED = "true";

    await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise: summariserReturning("FACTS: metric units."),
    });

    expect(mockReportHistorySummaryTokens).toHaveBeenCalledWith({
      inputTokens: 120,
      outputTokens: 34,
      chatModel: "gpt-5.6-terra",
      threadId: "t1",
    });
  });

  it("does not fail a good summary when the metric throws (negative)", async () => {
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    mockReportHistorySummaryTokens.mockRejectedValueOnce(
      new Error("meter exploded") as never,
    );

    const row = await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      summarise: summariserReturning("FACTS: metric units."),
    });

    expect(row!.content).toContain("FACTS: metric units.");
    expect(row!.summaryOutcome).toBe("ok");
  });

  it("passes the thread's model through from the compaction record", async () => {
    process.env.HISTORY_SUMMARY_ENABLED = "true";
    const summarise = summariserReturning("FACTS: on the thread's model.");

    await recordHistoryCompaction({
      threadId: "t1",
      userId: "user-hash",
      droppedMessages: dropped,
      coversThroughMessageId: "m2",
      selectedModel: "gpt-5.6-sol",
      summarise,
    });

    const [call] = summarise.mock.calls as unknown as [
      [{ deployment: string }],
    ];
    expect(call[0].deployment).toBe("sol-dep");
    expect(call[0].modelId).toBe("gpt-5.6-sol");
  });
});
