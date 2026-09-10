import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Heavy server-only modules ─────────────────────────────────────────────────
vi.mock("server-only", () => ({}));
vi.mock("@/features/common/services/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("@/features/theme/theme-config", () => ({
  CHAT_DEFAULT_SYSTEM_PROMPT: "You are a helpful assistant.",
}));

// ── Mocked route deps ─────────────────────────────────────────────────────────
const mockLoadThreadContext = vi.fn();
const mockResolveModelAndLimits = vi.fn();
const mockBuildToolset = vi.fn();
const mockPersistAssistant = vi.fn();
const mockResolveAzureModel = vi.fn();
const mockResolveProvider = vi.fn();
const mockFindAllExtensions = vi.fn();

const mockApplyDocumentHintPlacement = vi.fn((ctx: unknown) => ctx);
vi.mock("@/features/chat-page/chat-services/chat-api/thread-context", () => ({
  loadThreadContext: (...a: unknown[]) => mockLoadThreadContext(...a),
  // Pure and cheap, so the real one runs here: the route's call to it is part
  // of the behaviour these tests exercise, and a stub that returned the
  // context unchanged would hide a regression in the placement correction.
  applyDocumentHintPlacement: (...a: unknown[]) =>
    mockApplyDocumentHintPlacement(...a),
}));
vi.mock("@/features/chat-page/chat-services/chat-api/model-selection", () => ({
  resolveModelAndLimits: (...a: unknown[]) => mockResolveModelAndLimits(...a),
}));
const mockRepairExtensionToolCall = vi.fn();
vi.mock("@/features/chat-page/chat-services/tools/registry", () => ({
  buildToolset: (...a: unknown[]) => mockBuildToolset(...a),
  repairExtensionToolCall: (...a: unknown[]) => mockRepairExtensionToolCall(...a),
}));
vi.mock("@/features/chat-page/chat-services/chat-api/persist-assistant", () => ({
  persistAssistantFromFinishEvent: (...a: unknown[]) => mockPersistAssistant(...a),
}));
vi.mock("@/features/chat-page/chat-services/models/provider", () => ({
  resolveAzureModel: (...a: unknown[]) => mockResolveAzureModel(...a),
}));
const mockRecordRealUsage = vi.fn(async () => undefined);
vi.mock(
  "@/features/chat-page/chat-services/chat-api/history-summary-service",
  () => ({
    recordHistoryCompactionRealUsage: (...a: unknown[]) =>
      mockRecordRealUsage(...(a as [])),
  }),
);
vi.mock("@/features/chat-page/chat-services/models/provider-seam", () => ({
  resolveProvider: (...a: unknown[]) => mockResolveProvider(...a),
  getFileIdsSignature: (ids: string[] | undefined) =>
    !ids || ids.length === 0 ? "" : [...new Set(ids)].sort().join(","),
}));
const mockEnsureContainer = vi.fn();
vi.mock(
  "@/features/chat-page/chat-services/code-interpreter-container",
  () => ({
    ensureCodeInterpreterContainer: (...a: unknown[]) =>
      mockEnsureContainer(...a),
  }),
);
const mockUpdateContainer = vi.fn(async () => ({ status: "OK" }));
vi.mock("@/features/chat-page/chat-services/chat-thread-service", () => ({
  UpdateChatTitle: vi.fn(async () => ({ status: "OK" })),
  UpdateChatThreadCodeInterpreterContainer: (...a: unknown[]) =>
    mockUpdateContainer(...(a as [])),
}));
vi.mock("@/features/extensions-page/extension-services/extension-service", () => ({
  FindAllExtensionForCurrentUserAndIds: (...a: unknown[]) => mockFindAllExtensions(...a),
  FindSecureHeaderValue: vi.fn(async () => ({ status: "ERROR", errors: [] })),
}));

vi.mock("@/features/auth-page/helpers", () => ({
  userHashedId: vi.fn(async () => "test-user-hash"),
  getCurrentUser: vi.fn(async () => ({
    name: "Test User",
    email: "test@example.com",
    isAdmin: false,
  })),
}));

vi.mock(
  "@/features/chat-page/chat-services/chat-api/rate-limit-subject",
  () => ({
    resolveRateLimitSubject: vi.fn(async () => "user:test-user-hash"),
  }),
);

// Disable rate limit for the existing scenarios; one specific test re-enables it.
process.env.AZURECHAT_RATE_LIMIT_DISABLED = "1";

// ── ai SDK mock: streamText captures onFinish so we can fire it inline ────────
//
// `createUIMessageStream` / `createUIMessageStreamResponse` are deliberately
// NOT mocked: the route owns the stream now and writes its own parts into it
// before merging the model's, so the real wrapper is what makes the emitted
// SSE assertable. streamText's stream stands in as an empty one.
const mockConsumeStream = vi.fn(async () => undefined);
const mockToUIMessageStream = vi.fn(
  () =>
    new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
);
let capturedOnFinish: ((event: unknown) => void | Promise<void>) | undefined;

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: vi.fn((options: { onEnd?: typeof capturedOnFinish }) => {
      capturedOnFinish = options.onEnd;
      return {
        consumeStream: mockConsumeStream,
        toUIMessageStream: mockToUIMessageStream,
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 20 }),
        // `finalStep` carries the LAST step's own usage. The compaction notice
        // quotes prompt sizes, so it reads this and never the all-steps
        // roll-up on `usage` — which on a 2-step turn is twice a prompt.
        finalStep: Promise.resolve({
          usage: { inputTokens: 10, outputTokens: 20 },
        }),
      };
    }),
    convertToModelMessages: vi.fn(async () => []),
  };
});

vi.mock("@ai-sdk/azure", () => ({
  azure: {
    tools: {
      codeInterpreter: vi.fn(() => ({})),
      imageGeneration: vi.fn(() => ({})),
      webSearchPreview: vi.fn(() => ({})),
    },
  },
}));

import { POST } from "../route";

// ── Fixtures ──────────────────────────────────────────────────────────────────
const CTX = {
  thread: {
    id: "t1",
    selectedModel: "gpt-4o",
    personaMessage: "",
    defaultTools: undefined,
    codeInterpreterContainerId: undefined,
  },
  user: { id: "user-hash", name: "Test User", email: "test@example.com", isAdmin: false },
  history: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }],
  modelHistory: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }],
  responsesHistory: [],
  documentHint: undefined,
  documentHintPlacement: "none",
  threadDocumentIds: [],
  personaDocumentIds: [],
  defaultTools: undefined,
  extensions: [],
  attachedFiles: [],
};
const MODEL_RESULT = {
  modelConfig: {
    id: "gpt-4o",
    supportsReasoning: false,
    supportsResponsesAPI: true,
    pricing: undefined,
  },
  fallbackInfo: { fellBack: false },
  effectiveReasoningEffort: undefined,
  selectedModel: "gpt-4o",
};

function makeRequest(contentObj: object, imageFields: string[] = []) {
  const fd = new FormData();
  fd.set("content", JSON.stringify(contentObj));
  for (const img of imageFields) fd.append("image-base64", img);
  const headers = new Map<string, string>([
    ["origin", "http://localhost:3000"],
    ["content-length", "1024"],
  ]);
  return {
    url: "http://localhost:3000/api/chat",
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    formData: vi.fn().mockResolvedValue(fd),
    signal: new AbortController().signal,
  } as unknown as Request;
}

describe("/api/chat route (AI SDK v6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnFinish = undefined;
    mockLoadThreadContext.mockResolvedValue(CTX);
    mockResolveModelAndLimits.mockResolvedValue(MODEL_RESULT);
    mockBuildToolset.mockResolvedValue({});
    mockPersistAssistant.mockResolvedValue(undefined);
    mockResolveAzureModel.mockReturnValue({});
    mockResolveProvider.mockReturnValue({
      model: {},
      builtInTools: {},
      providerOptions: { openai: { promptCacheKey: "test", store: false } },
    });
    mockFindAllExtensions.mockResolvedValue({ status: "OK", response: [] });
  });

  it("returns 200 text/event-stream and fires persistAssistantFromFinishEvent when streamText.onEnd fires", async () => {
    const req = makeRequest({ message: "hello", id: "t1" });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(typeof capturedOnFinish).toBe("function");

    // Simulate the LLM finishing in the background.
    await capturedOnFinish!({
      text: "hi",
      reasoningText: undefined,
      toolResults: [],
      usage: { inputTokens: 10, outputTokens: 20 },
      finishReason: "stop",
    });

    expect(mockPersistAssistant).toHaveBeenCalledOnce();
    expect(mockPersistAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "t1",
        event: expect.objectContaining({ text: "hi" }),
      }),
    );
  });

  it("wires repairExtensionToolCall into streamText's repairToolCall option", async () => {
    const { streamText } = await import("ai");
    const req = makeRequest({ message: "hello", id: "t1" });
    await POST(req);

    const streamTextMock = streamText as unknown as { mock: { calls: unknown[][] } };
    const options = streamTextMock.mock.calls[0][0] as {
      repairToolCall?: (...args: unknown[]) => unknown;
    };
    expect(typeof options.repairToolCall).toBe("function");

    // The wired function is a thin wrapper (module-mock hoisting pattern
    // used throughout this file) — prove it forwards to the real export
    // rather than asserting on function identity.
    await options.repairToolCall?.("repair-args");
    expect(mockRepairExtensionToolCall).toHaveBeenCalledWith("repair-args");
  });

  describe("code_interpreter container pre-creation (prefix stability)", () => {
    const ciCtx = {
      ...CTX,
      thread: { ...CTX.thread, codeInterpreterContainerId: undefined },
      defaultTools: { codeInterpreter: true },
    };

    it("creates the container before the first model call and declares it on turn 1", async () => {
      mockLoadThreadContext.mockResolvedValue(structuredClone(ciCtx));
      mockEnsureContainer.mockResolvedValue("cntr_precreated");

      await POST(makeRequest({ message: "plot this", id: "t1", codeInterpreterEnabled: true }));

      expect(mockEnsureContainer).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "t1", fileIds: [] }),
      );
      // The seam sees the id on the FIRST turn, so the tool definition it
      // builds is the same string every later turn will send.
      expect(mockResolveProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          thread: expect.objectContaining({
            codeInterpreterContainerId: "cntr_precreated",
          }),
        }),
      );
      // Persisted straight away — otherwise turn 2 would mint another one.
      expect(mockUpdateContainer).toHaveBeenCalledWith("t1", "cntr_precreated", "");
    });

    it("revalidates the stored container each turn and writes nothing when it is unchanged", async () => {
      // The guard here used to skip the check entirely once a thread had a
      // container, so a reclaimed one was never replaced and every later turn
      // failed on "Container is expired.". The check now runs every turn; an
      // unchanged id still costs no Cosmos write and still gives the seam the
      // same string, so the tool definition stays byte-stable.
      mockLoadThreadContext.mockResolvedValue({
        ...structuredClone(ciCtx),
        thread: { ...ciCtx.thread, codeInterpreterContainerId: "cntr_existing" },
      });
      mockEnsureContainer.mockResolvedValue("cntr_existing");

      await POST(makeRequest({ message: "again", id: "t1", codeInterpreterEnabled: true }));

      expect(mockEnsureContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "t1",
          existingContainerId: "cntr_existing",
        }),
      );
      expect(mockUpdateContainer).not.toHaveBeenCalled();
      expect(mockResolveProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          thread: expect.objectContaining({
            codeInterpreterContainerId: "cntr_existing",
          }),
        }),
      );
    });

    it("persists and declares a replacement when the stored container has expired", async () => {
      mockLoadThreadContext.mockResolvedValue({
        ...structuredClone(ciCtx),
        thread: { ...ciCtx.thread, codeInterpreterContainerId: "cntr_dead" },
      });
      mockEnsureContainer.mockResolvedValue("cntr_fresh");

      await POST(makeRequest({ message: "again", id: "t1", codeInterpreterEnabled: true }));

      expect(mockUpdateContainer).toHaveBeenCalledWith("t1", "cntr_fresh", "");
      expect(mockResolveProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          thread: expect.objectContaining({
            codeInterpreterContainerId: "cntr_fresh",
          }),
        }),
      );
    });

    it("falls back to the old inline bootstrap when creation fails (negative)", async () => {
      mockLoadThreadContext.mockResolvedValue(structuredClone(ciCtx));
      mockEnsureContainer.mockResolvedValue(undefined);

      await POST(makeRequest({ message: "plot this", id: "t1", codeInterpreterEnabled: true }));

      expect(mockResolveProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          thread: expect.objectContaining({
            codeInterpreterContainerId: undefined,
          }),
        }),
      );
      expect(mockUpdateContainer).not.toHaveBeenCalled();
    });

    it("does not create a container when code_interpreter is off (negative)", async () => {
      mockLoadThreadContext.mockResolvedValue(structuredClone(CTX));
      await POST(makeRequest({ message: "hello", id: "t1" }));
      expect(mockEnsureContainer).not.toHaveBeenCalled();
    });

    it("discards an id it could not persist rather than minting one per turn", async () => {
      // The whole point of pre-creating is that the NEXT turn finds the id on
      // the thread. An unpersisted id is invisible to the next turn, so if it
      // went on the wire anyway every turn would create one more container —
      // an unbounded spend loop out of a Cosmos write failure. Sending the
      // old bootstrap shape instead costs one cache miss.
      mockLoadThreadContext.mockResolvedValue(structuredClone(ciCtx));
      mockEnsureContainer.mockResolvedValue("cntr_orphan");
      mockUpdateContainer.mockRejectedValueOnce(new Error("cosmos down"));

      await POST(makeRequest({ message: "plot this", id: "t1", codeInterpreterEnabled: true }));

      expect(mockResolveProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          thread: expect.objectContaining({
            codeInterpreterContainerId: undefined,
          }),
        }),
      );
    });
  });

  describe("prompt cache key + explicit breakpoint", () => {
    // The breakpoint is a provider-neutral concept: the flag says "pin one at
    // the end of the static developer/system prefix on whichever provider
    // serves the turn". Only the wire field differs per seam, and on Anthropic
    // the breakpoint is unconditional, so the flag cannot change anything.
    it("passes the thread id as the cache key under the default strategy", async () => {
      await POST(makeRequest({ message: "hello", id: "t1" }));
      expect(mockResolveProvider).toHaveBeenCalledWith(
        expect.objectContaining({ promptCacheKey: "t1" }),
      );
    });

    it("shares a persona-scoped key across threads under the persona strategy", async () => {
      const saved = process.env.PROMPT_CACHE_KEY_STRATEGY;
      process.env.PROMPT_CACHE_KEY_STRATEGY = "persona";
      mockResolveModelAndLimits.mockResolvedValue({
        ...MODEL_RESULT,
        modelConfig: { ...MODEL_RESULT.modelConfig, id: "gpt-5.6-terra" },
        selectedModel: "gpt-5.6-terra",
      });
      mockLoadThreadContext.mockResolvedValue({
        ...structuredClone(CTX),
        thread: { ...CTX.thread, id: "t1", personaId: "agent-7" },
      });
      try {
        await POST(makeRequest({ message: "hello", id: "t1" }));
        const first = mockResolveProvider.mock.calls[0][0] as {
          promptCacheKey?: string;
        };
        expect(first.promptCacheKey).toMatch(/^persona:agent-7:[0-9a-f]{8}:\d+$/);

        // A DIFFERENT thread of the same agent must land on the same key —
        // that is the whole point: it reads the prefix thread 1 wrote.
        mockResolveProvider.mockClear();
        mockLoadThreadContext.mockResolvedValue({
          ...structuredClone(CTX),
          thread: { ...CTX.thread, id: "t2", personaId: "agent-7" },
        });
        await POST(makeRequest({ message: "hello", id: "t2" }));
        const second = mockResolveProvider.mock.calls[0][0] as {
          promptCacheKey?: string;
        };
        expect(second.promptCacheKey).toBe(first.promptCacheKey);
      } finally {
        if (saved === undefined) delete process.env.PROMPT_CACHE_KEY_STRATEGY;
        else process.env.PROMPT_CACHE_KEY_STRATEGY = saved;
      }
    });

    it("shards on the hashed user id, never on the email in ctx.user.id", async () => {
      const saved = process.env.PROMPT_CACHE_KEY_STRATEGY;
      process.env.PROMPT_CACHE_KEY_STRATEGY = "persona";
      mockResolveModelAndLimits.mockResolvedValue({
        ...MODEL_RESULT,
        modelConfig: { ...MODEL_RESULT.modelConfig, id: "gpt-5.6-terra" },
        selectedModel: "gpt-5.6-terra",
      });
      // CTX.user.id is an email-shaped value in production; it must not reach
      // the provider, since prompt_cache_key travels in the request body.
      mockLoadThreadContext.mockResolvedValue({
        ...structuredClone(CTX),
        thread: { ...CTX.thread, id: "t1", personaId: "agent-7" },
        user: { ...CTX.user, id: "someone@example.com", email: "someone@example.com" },
      });
      try {
        await POST(makeRequest({ message: "hello", id: "t1" }));
        const key = (
          mockResolveProvider.mock.calls[0][0] as { promptCacheKey?: string }
        ).promptCacheKey;
        expect(key).not.toContain("someone@example.com");
        expect(key).not.toContain("@");
        expect(key).toMatch(/^persona:agent-7:[0-9a-f]{8}:\d+$/);
      } finally {
        if (saved === undefined) delete process.env.PROMPT_CACHE_KEY_STRATEGY;
        else process.env.PROMPT_CACHE_KEY_STRATEGY = saved;
      }
    });

    it("keeps the thread id for a non-5.6 model even under the persona strategy (negative)", async () => {
      const saved = process.env.PROMPT_CACHE_KEY_STRATEGY;
      process.env.PROMPT_CACHE_KEY_STRATEGY = "persona";
      try {
        // MODEL_RESULT runs gpt-4o, which is not in the 5.6 family.
        await POST(makeRequest({ message: "hello", id: "t1" }));
        expect(mockResolveProvider).toHaveBeenCalledWith(
          expect.objectContaining({ promptCacheKey: "t1" }),
        );
      } finally {
        if (saved === undefined) delete process.env.PROMPT_CACHE_KEY_STRATEGY;
        else process.env.PROMPT_CACHE_KEY_STRATEGY = saved;
      }
    });

    it("sends a plain system string when the breakpoint flag is off (default)", async () => {
      const { streamText } = await import("ai");
      await POST(makeRequest({ message: "hello", id: "t1" }));
      const options = (streamText as unknown as { mock: { calls: unknown[][] } })
        .mock.calls[0][0] as { instructions?: unknown };
      expect(typeof options.instructions).toBe("string");
    });

    it("marks an explicit breakpoint on the developer message when the flag is on and the model is 5.6", async () => {
      const { streamText } = await import("ai");
      const saved = process.env.PROMPT_CACHE_PERSONA_BREAKPOINT;
      process.env.PROMPT_CACHE_PERSONA_BREAKPOINT = "true";
      mockResolveModelAndLimits.mockResolvedValue({
        ...MODEL_RESULT,
        modelConfig: {
          ...MODEL_RESULT.modelConfig,
          id: "gpt-5.6-terra",
          promptCacheOptionsSupported: true,
        },
        selectedModel: "gpt-5.6-terra",
      });
      try {
        await POST(makeRequest({ message: "hello", id: "t1" }));
        const options = (streamText as unknown as { mock: { calls: unknown[][] } })
          .mock.calls[0][0] as {
          instructions?: { role?: string; providerOptions?: Record<string, unknown> };
        };
        expect(options.instructions?.role).toBe("system");
        expect(
          (options.instructions?.providerOptions as { openai?: Record<string, unknown> })
            ?.openai?.promptCacheBreakpoint,
        ).toEqual({ mode: "explicit" });
      } finally {
        if (saved === undefined)
          delete process.env.PROMPT_CACHE_PERSONA_BREAKPOINT;
        else process.env.PROMPT_CACHE_PERSONA_BREAKPOINT = saved;
      }
    });

    it.each([
      ["off", undefined],
      ["on", "true"],
    ])(
      "always pins the system-prefix breakpoint on Anthropic — the flag is a no-op there (flag %s)",
      async (_label, flagValue) => {
        const { streamText } = await import("ai");
        const saved = process.env.PROMPT_CACHE_PERSONA_BREAKPOINT;
        if (flagValue === undefined) delete process.env.PROMPT_CACHE_PERSONA_BREAKPOINT;
        else process.env.PROMPT_CACHE_PERSONA_BREAKPOINT = flagValue;
        mockResolveModelAndLimits.mockResolvedValue({
          ...MODEL_RESULT,
          modelConfig: {
            ...MODEL_RESULT.modelConfig,
            id: "claude-sonnet-5",
            provider: "anthropic",
            supportsResponsesAPI: false,
          },
          selectedModel: "claude-sonnet-5",
        });
        try {
          await POST(makeRequest({ message: "hello", id: "t1" }));
          const options = (streamText as unknown as { mock: { calls: unknown[][] } })
            .mock.calls[0][0] as {
            instructions?: { role?: string; providerOptions?: Record<string, unknown> };
          };
          expect(options.instructions?.role).toBe("system");
          // Anthropic's wire form of the same breakpoint.
          expect(
            (options.instructions?.providerOptions as {
              anthropic?: Record<string, unknown>;
            })?.anthropic?.cacheControl,
          ).toEqual({ type: "ephemeral" });
          // and NOT the Responses-seam field.
          expect(
            (options.instructions?.providerOptions as {
              openai?: Record<string, unknown>;
            })?.openai,
          ).toBeUndefined();
        } finally {
          if (saved === undefined)
            delete process.env.PROMPT_CACHE_PERSONA_BREAKPOINT;
          else process.env.PROMPT_CACHE_PERSONA_BREAKPOINT = saved;
        }
      },
    );

    it("does not mark a breakpoint on a pre-5.6 model even with the flag on (negative)", async () => {
      const { streamText } = await import("ai");
      const saved = process.env.PROMPT_CACHE_PERSONA_BREAKPOINT;
      process.env.PROMPT_CACHE_PERSONA_BREAKPOINT = "true";
      try {
        // MODEL_RESULT's config has no promptCacheOptionsSupported flag.
        await POST(makeRequest({ message: "hello", id: "t1" }));
        const options = (streamText as unknown as { mock: { calls: unknown[][] } })
          .mock.calls[0][0] as { instructions?: unknown };
        expect(typeof options.instructions).toBe("string");
      } finally {
        if (saved === undefined)
          delete process.env.PROMPT_CACHE_PERSONA_BREAKPOINT;
        else process.env.PROMPT_CACHE_PERSONA_BREAKPOINT = saved;
      }
    });
  });

  describe("compaction notice", () => {
    // A trim makes the model know less than the transcript on screen. The
    // data part is the only thing that tells the user, so its shape is a
    // contract with the component that renders it.
    const COMPACTION = {
      trimmedTurns: 12,
      measuredPromptTokens: 284_000,
      summaryOutcome: "ok",
      summaryModel: "gpt-5.6-terra",
      durationMs: 4210,
      summaryText: "FACTS: the user prefers metric units.",
      coversThroughMessageId: "m42",
    };

    async function postAndReadStream(
      compaction?: unknown,
      extraCtx: Record<string, unknown> = {},
    ): Promise<string> {
      mockLoadThreadContext.mockResolvedValue({
        ...structuredClone(CTX),
        ...(compaction ? { compaction } : {}),
        ...extraCtx,
      });
      const res = await POST(makeRequest({ message: "hello", id: "t1" }));
      expect(res.status).toBe(200);
      return await res.text();
    }

    function compactionFrames(body: string): any[] {
      return body
        .split("\n")
        .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
        .map((line) => JSON.parse(line.slice("data: ".length)))
        .filter((f) => f.type === "data-compaction");
    }

    it("writes the notice twice under one id: no numbers, then the real ones", async () => {
      // The mocked streamText reports inputTokens 10 as this request's usage,
      // and the context carries 34,012 as the previous request's.
      const body = await postAndReadStream(COMPACTION, {
        previousRequestPromptTokens: 34_012,
      });
      const parts = compactionFrames(body);

      expect(parts).toHaveLength(2);
      // One id, so the SDK updates the row in place instead of drawing a
      // second divider.
      expect(parts[0].id).toBe("compaction");
      expect(parts[1].id).toBe("compaction");

      // First write: the fact, with NO token counts — they are the provider's
      // real numbers and this request has not finished. No estimate stands in.
      expect(parts[0].data).toEqual({
        status: "done",
        trimmedTurns: 12,
        summaryOutcome: "ok",
        summaryModel: "gpt-5.6-terra",
        durationMs: 4210,
        summaryText: "FACTS: the user prefers metric units.",
      });
      // The plan's own trigger figure never reaches the wire: what the user
      // sees is the pair of real prompt sizes either side of the trim.
      expect(body).not.toContain("284000");

      // Second write: the real numbers.
      expect(parts[1].data).toMatchObject({
        tokensBefore: 34_012,
        tokensAfter: 10,
      });
      // And the same pair is stamped on the compaction row, for the divider a
      // reloaded page draws.
      expect(mockRecordRealUsage).toHaveBeenCalledWith({
        threadId: "t1",
        realTokensBefore: 34_012,
        realTokensAfter: 10,
      });
    });

    it("omits the before-count on a thread's first turn", async () => {
      const body = await postAndReadStream(COMPACTION);
      const parts = compactionFrames(body);
      expect(parts).toHaveLength(2);
      expect(parts[1].data.tokensAfter).toBe(10);
      expect(parts[1].data.tokensBefore).toBeUndefined();
    });

    it("writes nothing when the turn did not trim (negative)", async () => {
      const body = await postAndReadStream();
      expect(body).not.toContain("data-compaction");
    });

    it("carries the reason code when there is no summary", async () => {
      // "failed", not "off": the UI must not blame the feature flag for a
      // summariser that was called and broke.
      const body = await postAndReadStream({
        trimmedTurns: 3,
        measuredPromptTokens: 90_000,
        summaryOutcome: "failed",
        durationMs: 12,
      });
      const frame = compactionFrames(body)[0];
      expect(frame.data.summaryOutcome).toBe("failed");
      expect(frame.data.summaryText).toBeUndefined();
      expect(frame.data.summaryModel).toBeUndefined();
    });
  });

  describe("message metadata — turn totals vs the last prompt", () => {
    // `toUIMessageStream({ messageMetadata })` is called for EVERY stream part.
    // `finish` carries only the ALL-STEPS roll-up (`totalUsage`); the per-step
    // input is on each `finish-step` part (`TextStreamFinishStepPart.usage` in
    // ai/dist/index.d.ts). So the route catches the step value as it goes past
    // and emits once, on `finish`.
    async function metadataCallback() {
      await POST(makeRequest({ message: "hello", id: "t1" }));
      const options = mockToUIMessageStream.mock.calls.at(-1)?.[0] as {
        messageMetadata: (o: { part: unknown }) => unknown;
      };
      expect(options?.messageMetadata).toBeTypeOf("function");
      return options.messageMetadata;
    }

    const finishStep = (inputTokens: number, outputTokens: number) => ({
      type: "finish-step" as const,
      usage: { inputTokens, outputTokens },
    });

    const finish = (u: Record<string, unknown>) => ({
      type: "finish" as const,
      totalUsage: u,
    });

    it("api.chat.usage.001: a 3-step turn bills the sum and reports the last prompt", async () => {
      const messageMetadata = await metadataCallback();

      // Steps arrive in order. None of them may emit metadata: a non-undefined
      // return on a part that is not start/finish makes the SDK enqueue an
      // extra message-metadata chunk.
      expect(messageMetadata({ part: finishStep(30_000, 200) })).toBeUndefined();
      expect(messageMetadata({ part: finishStep(34_000, 150) })).toBeUndefined();
      expect(messageMetadata({ part: finishStep(35_000, 400) })).toBeUndefined();

      const meta = messageMetadata({
        part: finish({
          inputTokens: 99_000,
          outputTokens: 750,
          inputTokenDetails: { cacheReadTokens: 60_000, cacheWriteTokens: 20_000 },
        }),
      }) as { usage: Record<string, number> };

      // Turn totals: what was billed.
      expect(meta.usage.inputTokens).toBe(99_000);
      expect(meta.usage.outputTokens).toBe(750);
      expect(meta.usage.cachedTokens).toBe(60_000);
      expect(meta.usage.cacheWriteTokens).toBe(20_000);
      expect(meta.usage.stepCount).toBe(3);

      // Last prompt: what the context row shows. The LAST step's input, not
      // the largest and not the sum.
      expect(meta.usage.lastPromptTokens).toBe(35_000);
    });

    it("api.chat.usage.002: a 1-step turn reports the same number for both", async () => {
      const messageMetadata = await metadataCallback();
      messageMetadata({ part: finishStep(17_527, 400) });
      const meta = messageMetadata({
        part: finish({ inputTokens: 17_527, outputTokens: 400 }),
      }) as { usage: Record<string, number> };

      expect(meta.usage.inputTokens).toBe(17_527);
      expect(meta.usage.lastPromptTokens).toBe(17_527);
      expect(meta.usage.stepCount).toBe(1);
    });

    it("api.chat.usage.003: falls back to the roll-up when no step part carried a number", async () => {
      const messageMetadata = await metadataCallback();
      const meta = messageMetadata({
        part: finish({ inputTokens: 17_527, outputTokens: 400 }),
      }) as { usage: Record<string, number> };

      expect(meta.usage.lastPromptTokens).toBe(17_527);
      expect(meta.usage.stepCount).toBe(1);
    });

    it("api.chat.usage.004: emits nothing for any other part (negative)", async () => {
      const messageMetadata = await metadataCallback();
      for (const part of [
        { type: "start" },
        { type: "text-delta", text: "hi" },
        { type: "tool-call" },
        { type: "start-step" },
      ]) {
        expect(messageMetadata({ part })).toBeUndefined();
      }
    });
  });

  it("passes the effective model's maxOutputTokens into streamText", async () => {
    const { streamText } = await import("ai");
    mockResolveModelAndLimits.mockResolvedValue({
      ...MODEL_RESULT,
      modelConfig: { ...MODEL_RESULT.modelConfig, maxOutputTokens: 16000 },
    });
    await POST(makeRequest({ message: "hello", id: "t1" }));

    const streamTextMock = streamText as unknown as { mock: { calls: unknown[][] } };
    const options = streamTextMock.mock.calls[0][0] as { maxOutputTokens?: number };
    expect(options.maxOutputTokens).toBe(16000);
  });

  it("leaves maxOutputTokens undefined when the model config has no cap (negative)", async () => {
    const { streamText } = await import("ai");
    // MODEL_RESULT's config carries no maxOutputTokens — the option must not
    // be invented, so the provider default still applies.
    await POST(makeRequest({ message: "hello", id: "t1" }));

    const streamTextMock = streamText as unknown as { mock: { calls: unknown[][] } };
    const options = streamTextMock.mock.calls[0][0] as { maxOutputTokens?: number };
    expect(options.maxOutputTokens).toBeUndefined();
  });

  it("passes the resolved effective model into resolveProvider (no-regression: effective == selected)", async () => {
    const req = makeRequest({ message: "hello", id: "t1" });
    await POST(req);
    expect(mockResolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "gpt-4o" }),
    );
  });

  it("threads a downgraded model from resolveModelAndLimits into resolveProvider (not the raw payload)", async () => {
    // Simulate a cap/intent downgrade: the selected model differs from the
    // payload/thread model. The provider seam must receive the downgraded id.
    mockResolveModelAndLimits.mockResolvedValue({
      ...MODEL_RESULT,
      modelConfig: { id: "gpt-5.4-mini", supportsReasoning: false, supportsResponsesAPI: true, pricing: undefined },
      selectedModel: "gpt-5.4-mini",
      fallbackInfo: { fellBack: true, reason: "cap", originalModel: "gpt-4o", fallbackModel: "gpt-5.4-mini" },
    });
    const req = makeRequest({ message: "hello", id: "t1", selectedModel: "gpt-4o" });
    await POST(req);
    expect(mockResolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "gpt-5.4-mini" }),
    );
  });

  it("strips built-in tool toggles when the effective model lacks the Responses API (Foundry downgrade)", async () => {
    mockResolveModelAndLimits.mockResolvedValue({
      ...MODEL_RESULT,
      modelConfig: { id: "DeepSeek-V4-Pro", supportsReasoning: false, supportsResponsesAPI: false, pricing: undefined },
      selectedModel: "DeepSeek-V4-Pro",
    });
    const req = makeRequest({
      message: "hello",
      id: "t1",
      webSearchEnabled: true,
      codeInterpreterEnabled: true,
    });
    await POST(req);
    expect(mockResolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "DeepSeek-V4-Pro",
        toggles: { codeInterpreter: false, imageGeneration: false, webSearch: false },
      }),
    );
  });

  it("returns validation error before calling streamText when image is oversized", async () => {
    const { streamText } = await import("ai");
    const oversized = "data:image/png;base64," + "A".repeat(21 * 1024 * 1024);
    const req = makeRequest({ message: "hi", id: "t1" }, [oversized]);
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(streamText).not.toHaveBeenCalled();
    expect(mockLoadThreadContext).not.toHaveBeenCalled();
  });

  it("returns 401 when loadThreadContext throws with status 401", async () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    mockLoadThreadContext.mockRejectedValue(err);
    const req = makeRequest({ message: "hi", id: "t1" });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockPersistAssistant).not.toHaveBeenCalled();
  });

  it("returns 403 when Origin does not match host (CSRF defense)", async () => {
    const { streamText } = await import("ai");
    const fd = new FormData();
    fd.set("content", JSON.stringify({ message: "x", id: "t1" }));
    const headers = new Map<string, string>([
      ["origin", "https://evil.example.com"],
      ["content-length", "1024"],
    ]);
    const req = {
      url: "http://localhost:3000/api/chat",
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      formData: vi.fn().mockResolvedValue(fd),
      signal: new AbortController().signal,
    } as unknown as Request;

    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(streamText).not.toHaveBeenCalled();
    expect(mockLoadThreadContext).not.toHaveBeenCalled();
  });

  it("returns 403 when Origin and Referer are both absent", async () => {
    const fd = new FormData();
    fd.set("content", JSON.stringify({ message: "x", id: "t1" }));
    const headers = new Map<string, string>([["content-length", "1024"]]);
    const req = {
      url: "http://localhost:3000/api/chat",
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      formData: vi.fn().mockResolvedValue(fd),
      signal: new AbortController().signal,
    } as unknown as Request;

    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(mockLoadThreadContext).not.toHaveBeenCalled();
  });

  it("accepts when Referer matches host and Origin is absent", async () => {
    const fd = new FormData();
    fd.set("content", JSON.stringify({ message: "x", id: "t1" }));
    const headers = new Map<string, string>([
      ["referer", "http://localhost:3000/chat/t1"],
      ["content-length", "1024"],
    ]);
    const req = {
      url: "http://localhost:3000/api/chat",
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      formData: vi.fn().mockResolvedValue(fd),
      signal: new AbortController().signal,
    } as unknown as Request;

    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("returns 413 when content-length exceeds MAX_REQUEST_BYTES", async () => {
    const { streamText } = await import("ai");
    const fd = new FormData();
    fd.set("content", JSON.stringify({ message: "x", id: "t1" }));
    const headers = new Map<string, string>([
      ["origin", "http://localhost:3000"],
      ["content-length", String(100 * 1024 * 1024)], // 100 MB, above 50 MB cap
    ]);
    const req = {
      url: "http://localhost:3000/api/chat",
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      formData: vi.fn().mockResolvedValue(fd),
      signal: new AbortController().signal,
    } as unknown as Request;

    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(streamText).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Regression: AI SDK v6 migration (51118c8) dropped the filter that narrowed
  // FindAllExtensionForCurrentUserAndIds' response down to the thread's
  // configured extensions. That query is deliberately over-broad
  // (isPublished=true OR userId=@userId OR id IN @ids) so it can resolve
  // publisher-owned extensions too — without the filter, every published or
  // user-owned extension the caller has access to (not just the ones wired to
  // this thread/persona) got forwarded into buildToolset. Nested in this
  // describe (not a sibling) so it inherits the beforeEach above, which
  // resets all the route's mocked collaborators between tests.
  // ───────────────────────────────────────────────────────────────────────────
  describe("extension resolution filter", () => {
    function makeExtension(id: string) {
      return {
        id,
        name: `Extension ${id}`,
        description: "d",
        executionSteps: "s",
        headers: [],
        userId: "some-other-user",
        isPublished: true,
        createdAt: new Date(),
        type: "EXTENSION",
        functions: [],
      };
    }

    it("only forwards extensions whose id is in the thread's configured extension list to buildToolset", async () => {
      const configuredExtension = makeExtension("configured-ext");
      // Simulates the over-broad query surfacing extensions the user owns or
      // that are published, but that are NOT configured on this thread.
      const leakedExtension = makeExtension("leaked-ext-not-on-thread");

      mockLoadThreadContext.mockResolvedValue({
        ...CTX,
        extensions: ["configured-ext"],
      });
      mockFindAllExtensions.mockResolvedValue({
        status: "OK",
        response: [configuredExtension, leakedExtension],
      });

      const req = makeRequest({ message: "hello", id: "t1" });
      await POST(req);

      expect(mockFindAllExtensions).toHaveBeenCalledWith(["configured-ext"]);
      expect(mockBuildToolset).toHaveBeenCalledOnce();
      const passedExtensions = mockBuildToolset.mock.calls[0][0].extensions as Array<{
        extension: { id: string };
      }>;
      expect(passedExtensions).toHaveLength(1);
      expect(passedExtensions[0].extension.id).toBe("configured-ext");
      expect(
        passedExtensions.some((e) => e.extension.id === "leaked-ext-not-on-thread")
      ).toBe(false);
    });

    it("forwards no extensions when the thread has none configured, even if FindAllExtensionForCurrentUserAndIds is never called", async () => {
      mockLoadThreadContext.mockResolvedValue({ ...CTX, extensions: [] });

      const req = makeRequest({ message: "hello", id: "t1" });
      await POST(req);

      expect(mockFindAllExtensions).not.toHaveBeenCalled();
      expect(mockBuildToolset).toHaveBeenCalledOnce();
      expect(mockBuildToolset.mock.calls[0][0].extensions).toEqual([]);
    });

    it("resolves multiple configured extensions and drops multiple leaked ones", async () => {
      const configuredA = makeExtension("cfg-a");
      const configuredB = makeExtension("cfg-b");
      const leakedA = makeExtension("leak-a");
      const leakedB = makeExtension("leak-b");

      mockLoadThreadContext.mockResolvedValue({
        ...CTX,
        extensions: ["cfg-a", "cfg-b"],
      });
      mockFindAllExtensions.mockResolvedValue({
        status: "OK",
        response: [leakedA, configuredA, leakedB, configuredB],
      });

      const req = makeRequest({ message: "hello", id: "t1" });
      await POST(req);

      const passedExtensions = mockBuildToolset.mock.calls[0][0].extensions as Array<{
        extension: { id: string };
      }>;
      const passedIds = passedExtensions.map((e) => e.extension.id).sort();
      expect(passedIds).toEqual(["cfg-a", "cfg-b"]);
    });
  });
});
