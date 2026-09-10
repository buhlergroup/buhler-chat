import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── hoisted mocks (must be declared before any vi.mock factory that references them) ──
const {
  mockGenerateText,
  mockFindPersonaByID,
  mockResolveAzureModel,
  mockResolveFoundryModel,
  mockResolveAnthropicModel,
} = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockFindPersonaByID: vi.fn(),
  mockResolveAzureModel: vi.fn(() => ({ provider: "azure", modelId: "fake" })),
  mockResolveFoundryModel: vi.fn(() => ({ provider: "foundry", modelId: "fake" })),
  mockResolveAnthropicModel: vi.fn(() => ({
    provider: "anthropic",
    modelId: "fake",
  })),
}));

// Patch MODEL_CONFIGS so deploymentName is always populated in tests
vi.mock("@/features/chat-page/chat-services/models", async () => {
  const actual = await vi.importActual<
    typeof import("@/features/chat-page/chat-services/models")
  >("@/features/chat-page/chat-services/models");
  const patched = Object.fromEntries(
    Object.entries(actual.MODEL_CONFIGS).map(([k, v]) => [
      k,
      { ...(v as any), deploymentName: (v as any).deploymentName ?? `deploy-${k}` },
    ])
  );
  return { ...actual, MODEL_CONFIGS: patched };
});

// ─── module mocks ────────────────────────────────────────────────────────────
vi.mock("@/features/common/services/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/features/persona-page/persona-services/persona-service", () => ({
  FindPersonaByID: mockFindPersonaByID,
  FindAllPersonaForCurrentUser: vi.fn(async () => ({ status: "OK", response: [] })),
}));

// call-sub-agent now goes through the provider seam, which resolves all three
// provider families — stub every entry point the seam imports.
vi.mock("@/features/chat-page/chat-services/models/provider", () => ({
  resolveAzureModel: mockResolveAzureModel,
  resolveFoundryModel: mockResolveFoundryModel,
  resolveAnthropicModel: mockResolveAnthropicModel,
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: mockGenerateText,
  };
});

// buildToolset mock to avoid cascade
vi.mock("../registry", () => ({
  buildToolset: vi.fn(async () => ({})),
}));

// ─── subject under test ───────────────────────────────────────────────────────
import { callSubAgentTool } from "../call-sub-agent";
import type { ToolContext } from "../tool-context";

// ─── helpers ─────────────────────────────────────────────────────────────────
function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    user: "user-hash",
    threadId: "thread-1",
    threadDocumentIds: [],
    personaDocumentIds: [],
    defaultTools: {},
    extensions: [],
    depth: 0,
    ...overrides,
  };
}

const FAKE_PERSONA = {
  id: "agent-1",
  name: "Finance Agent",
  description: "Handles finance queries",
  personaMessage: "You are a finance expert.",
  extensionIds: [],
  isPublished: true,
  type: "PERSONA" as const,
  createdAt: new Date(),
  personaDocumentIds: [],
  selectedModel: "gpt-5.4-mini",
  subAgentIds: [],
  defaultTools: {},
};

// ─── tests ───────────────────────────────────────────────────────────────────
describe("callSubAgentTool – execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockFindPersonaByID.mockResolvedValue({
      status: "OK",
      response: FAKE_PERSONA,
    });

    mockGenerateText.mockResolvedValue({
      text: "Finance answer.",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalInputTokens: 100,
      },
    });
  });

  it("returns {response, usage} shape with correct fields", async () => {
    const t = callSubAgentTool(makeCtx());
    const result = await (t as any).execute(
      { agent_id: "agent-1", task: "Summarise Q3 results" },
      { abortSignal: undefined }
    );

    expect(result.agentName).toBe("Finance Agent");
    expect(result.agentId).toBe("agent-1");
    expect(result.response).toBe("Finance answer.");
    expect(result.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(typeof result.usage.costUsd).toBe("number");
    expect(result.summary).toMatch(/Finance Agent/);
  });

  it("calls generateText with the persona's model", async () => {
    const t = callSubAgentTool(makeCtx());
    await (t as any).execute(
      { agent_id: "agent-1", task: "Do something" },
      { abortSignal: undefined }
    );

    expect(mockResolveAzureModel).toHaveBeenCalledWith("gpt-5.4-mini");
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: FAKE_PERSONA.personaMessage,
        messages: [{ role: "user", content: "Do something" }],
      })
    );
  });

  it("caps the sub-agent generation with the model's maxOutputTokens", async () => {
    const t = callSubAgentTool(makeCtx());
    await (t as any).execute(
      { agent_id: "agent-1", task: "Do something" },
      { abortSignal: undefined }
    );

    // FAKE_PERSONA runs on gpt-5.4-mini, whose configured cap is 8000.
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 8000 })
    );
  });

  it("sends the seam's provider options: a sub-agent cache key, store:false and the model's effort", async () => {
    const t = callSubAgentTool(makeCtx());
    await (t as any).execute(
      { agent_id: "agent-1", task: "Do something" },
      { abortSignal: undefined }
    );

    const options = mockGenerateText.mock.calls[0][0] as {
      providerOptions?: { openai?: Record<string, unknown> };
    };
    const openai = options.providerOptions?.openai ?? {};
    // Namespaced under the parent thread but distinct from it, so a repeated
    // delegation reads its own cached prefix instead of rewriting one.
    expect(openai.promptCacheKey).toBe("thread-1:sub:agent-1");
    expect(openai.store).toBe(false);
    // gpt-5.4-mini is supportsReasoning:false → no effort keys are sent.
    expect(openai.reasoningEffort).toBeUndefined();
  });

  it("sends promptCacheOptions for a GPT-5.6 sub-agent and a reasoning effort", async () => {
    mockFindPersonaByID.mockResolvedValue({
      status: "OK",
      response: { ...FAKE_PERSONA, selectedModel: "gpt-5.6-sol" },
    });

    const t = callSubAgentTool(makeCtx());
    await (t as any).execute(
      { agent_id: "agent-1", task: "Do something" },
      { abortSignal: undefined }
    );

    const options = mockGenerateText.mock.calls[0][0] as {
      providerOptions?: { openai?: Record<string, unknown> };
    };
    const openai = options.providerOptions?.openai ?? {};
    expect(openai.promptCacheOptions).toEqual({ mode: "implicit", ttl: "30m" });
    expect(openai.reasoningEffort).toBe("low");
    expect(openai.store).toBe(false);
  });

  it("resolves a Claude persona through the anthropic seam, not the Azure one", async () => {
    mockFindPersonaByID.mockResolvedValue({
      status: "OK",
      response: { ...FAKE_PERSONA, selectedModel: "claude-sonnet-5" },
    });

    const t = callSubAgentTool(makeCtx());
    await (t as any).execute(
      { agent_id: "agent-1", task: "Do something" },
      { abortSignal: undefined }
    );

    expect(mockResolveAnthropicModel).toHaveBeenCalledWith("claude-sonnet-5");
    expect(mockResolveAzureModel).not.toHaveBeenCalled();
    const options = mockGenerateText.mock.calls[0][0] as {
      providerOptions?: Record<string, unknown>;
    };
    expect(options.providerOptions).toHaveProperty("anthropic");
  });

  it("passes abortSignal to generateText", async () => {
    const abortController = new AbortController();
    const t = callSubAgentTool(makeCtx());
    await (t as any).execute(
      { agent_id: "agent-1", task: "task" },
      { abortSignal: abortController.signal }
    );

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: abortController.signal })
    );
  });

  it("throws when persona is not found (no {error:...} wrapping)", async () => {
    mockFindPersonaByID.mockResolvedValue({
      status: "NOT_FOUND",
      errors: [{ message: "not found" }],
    });

    const t = callSubAgentTool(makeCtx());
    await expect(
      (t as any).execute(
        { agent_id: "nonexistent", task: "task" },
        { abortSignal: undefined }
      )
    ).rejects.toThrow(/not found or you do not have access/);
  });

  it("throws when generateText throws (no swallowing)", async () => {
    mockGenerateText.mockRejectedValue(new Error("Provider timeout"));
    const t = callSubAgentTool(makeCtx());
    await expect(
      (t as any).execute(
        { agent_id: "agent-1", task: "task" },
        { abortSignal: undefined }
      )
    ).rejects.toThrow("Provider timeout");
  });

  it("recurse guard: at depth=2 sub-toolset is empty", async () => {
    const { buildToolset } = await import("../registry");
    const t = callSubAgentTool(makeCtx({ depth: 1 })); // depth 1 → sub-context depth 2 → empty
    await (t as any).execute(
      { agent_id: "agent-1", task: "task" },
      { abortSignal: undefined }
    );
    // buildToolset should have been called with depth: 2
    expect(buildToolset).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 2 })
    );
  });

  it("recurse guard: at depth=2 context, buildToolset is NOT called", async () => {
    const { buildToolset } = await import("../registry");
    vi.clearAllMocks(); // reset call count
    mockFindPersonaByID.mockResolvedValue({ status: "OK", response: FAKE_PERSONA });
    mockGenerateText.mockResolvedValue({ text: "ok", usage: { inputTokens: 10, outputTokens: 5, totalInputTokens: 10 } });

    const t = callSubAgentTool(makeCtx({ depth: 2 }));
    await (t as any).execute(
      { agent_id: "agent-1", task: "task" },
      { abortSignal: undefined }
    );
    expect(buildToolset).not.toHaveBeenCalled();
  });
});
