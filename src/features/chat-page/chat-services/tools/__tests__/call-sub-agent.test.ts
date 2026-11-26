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

// Agent skills: no skills in these tests (the store would reach Cosmos).
vi.mock("@/features/persona-page/persona-services/skills/persona-skill-store", () => ({
  loadUsableSkills: vi.fn(async () => []),
  readSkillFile: vi.fn(),
}));
vi.mock("@/features/persona-page/persona-services/persona-service", () => ({
  FindAllPersonaForCurrentUser: vi.fn(async () => ({ status: "OK", response: [] })),
}));
// The sub-agent needs the whole persona row (file and sub-agent ids): the
// server-only lookup, not the FindPersonaByID action.
vi.mock("@/features/persona-page/persona-services/persona-lookup", () => ({
  findPersonaForCurrentUser: mockFindPersonaByID,
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

// The sub-agent loads ITS OWN extensions through the shared access rule.
const mockResolveExtensions = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
vi.mock("@/features/extensions-page/extension-services/extension-runtime", () => ({
  resolveExtensionsForChat: (...a: unknown[]) => mockResolveExtensions(...a),
}));

// ─── subject under test ───────────────────────────────────────────────────────
import { callSubAgentTool } from "../call-sub-agent";
import {
  PROMPT_CACHE_KEY_MAX_LENGTH,
  toolsetSignature,
} from "../../models/prompt-cache-key";
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
    subAgentIds: ["agent-1"],
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
    // delegation reads its own cached prefix instead of rewriting one. The
    // agent id is hashed so real 36-char ids stay under OpenAI's 64-char
    // prompt_cache_key limit.
    const expectedKey = `thread-1:sub:${toolsetSignature(["agent-1"])}`;
    expect(openai.promptCacheKey).toBe(expectedKey);
    expect(expectedKey.length).toBeLessThanOrEqual(PROMPT_CACHE_KEY_MAX_LENGTH);
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

  it("gives a sub-agent its own skills: catalog in the instructions, load_skill context without code interpreter", async () => {
    const { buildToolset } = await import("../registry");
    const store = await import(
      "@/features/persona-page/persona-services/skills/persona-skill-store"
    );
    const skill = { name: "demo-skill", description: "Builds demos." };
    vi.mocked(store.loadUsableSkills).mockResolvedValueOnce([skill as never]);

    const t = callSubAgentTool(makeCtx());
    await (t as any).execute(
      { agent_id: "agent-1", task: "task" },
      { abortSignal: undefined }
    );

    expect(store.loadUsableSkills).toHaveBeenCalledWith("agent-1");
    expect(buildToolset).toHaveBeenCalledWith(
      expect.objectContaining({ skills: [skill], skillsInCodeInterpreter: [] })
    );
    const call = mockGenerateText.mock.calls[0][0] as { instructions: string };
    expect(call.instructions).toContain(FAKE_PERSONA.personaMessage);
    expect(call.instructions).toContain("- demo-skill: Builds demos.");
  });

describe("callSubAgentTool — the sub-agent's own extensions", () => {
  it("resolves the sub-agent persona's extensions with the access rule and hands them to its toolset", async () => {
    const { buildToolset } = await import("../registry");
    const resolved = [{ extension: { id: "mcp-1" }, headerSecrets: {} }];
    mockResolveExtensions.mockResolvedValueOnce(resolved);
    mockFindPersonaByID.mockResolvedValueOnce({
      status: "OK",
      response: { ...FAKE_PERSONA, extensionIds: ["mcp-1"] },
    });
    mockGenerateText.mockResolvedValueOnce({ text: "ok", usage: {} });

    const t = callSubAgentTool(makeCtx({ extensions: [{ extension: { id: "thread-ext" } as never, headerSecrets: {} }] }));
    await (t as unknown as { execute: (a: unknown, o: object) => Promise<unknown> }).execute(
      { agent_id: "agent-1", task: "do it" },
      {}
    );

    expect(mockResolveExtensions).toHaveBeenCalledWith({ extensionIds: ["mcp-1"], personaId: "agent-1" });
    const subCtx = vi.mocked(buildToolset).mock.calls.at(-1)![0];
    expect(subCtx.extensions).toBe(resolved);
  });
});
});

// Pinned: the model chooses agent_id, and tool output (for example from a
// Remote MCP server) can steer it. Any agent the user can open may still be
// called (discovery), but only a configured sub-agent runs with its own
// extensions; below a discovered agent no extensions are resolved either.
describe("callSubAgentTool — extensions only for configured sub-agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindPersonaByID.mockResolvedValue({
      status: "OK",
      response: { ...FAKE_PERSONA, id: "other-agent", extensionIds: ["mcp-1"], subAgentIds: ["grandchild"] },
    });
    mockGenerateText.mockResolvedValue({ text: "ok", usage: {} });
    mockResolveExtensions.mockResolvedValue([{ extension: { id: "mcp-1" }, headerSecrets: {} }]);
  });

  it.each([
    ["an id outside the list", ["agent-1"]],
    ["an empty list", []],
    ["no list", undefined],
  ])("runs a discovered agent (%s) without extensions and without configured sub-agents", async (_label, subAgentIds) => {
    const { buildToolset } = await import("../registry");
    const t = callSubAgentTool(makeCtx({ subAgentIds: subAgentIds as string[] | undefined }));
    const result = await (t as any).execute({ agent_id: "other-agent", task: "task" }, { abortSignal: undefined });

    expect(result.response).toBe("ok");
    expect(mockFindPersonaByID).toHaveBeenCalledWith("other-agent");
    expect(mockResolveExtensions).not.toHaveBeenCalled();
    const subCtx = vi.mocked(buildToolset).mock.calls.at(-1)![0];
    expect(subCtx.extensions).toEqual([]);
    expect(subCtx.subAgentIds).toEqual([]);
  });

  it("runs a configured sub-agent with its own extensions and sub-agents", async () => {
    const { buildToolset } = await import("../registry");
    const t = callSubAgentTool(makeCtx({ subAgentIds: ["agent-1", "other-agent"] }));
    await (t as any).execute({ agent_id: "other-agent", task: "task" }, { abortSignal: undefined });

    expect(mockResolveExtensions).toHaveBeenCalledWith({ extensionIds: ["mcp-1"], personaId: "other-agent" });
    const subCtx = vi.mocked(buildToolset).mock.calls.at(-1)![0];
    expect(subCtx.extensions).toEqual([{ extension: { id: "mcp-1" }, headerSecrets: {} }]);
    expect(subCtx.subAgentIds).toEqual(["grandchild"]);
  });

  it("still refuses an agent the user cannot open", async () => {
    mockFindPersonaByID.mockResolvedValue({ status: "NOT_FOUND", errors: [{ message: "not found" }] });
    const t = callSubAgentTool(makeCtx({ subAgentIds: [] }));
    await expect(
      (t as any).execute({ agent_id: "hidden-agent", task: "task" }, { abortSignal: undefined })
    ).rejects.toThrow(/not found or you do not have access/);
    expect(mockResolveExtensions).not.toHaveBeenCalled();
  });
});
