import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Stub out the Azure LanguageModelV3 resolver — we only care that the seam
// CALLS it for azure-tagged models and threads the right shape downstream.
const mockResolveAzureModel = vi.fn(() => ({
  __azureModel: true,
}));
const mockResolveFoundryModel = vi.fn(() => ({
  __foundryModel: true,
}));
const mockResolveAnthropicModel = vi.fn(() => ({
  __anthropicModel: true,
}));
vi.mock("./provider", () => ({
  resolveAzureModel: (...a: unknown[]) => mockResolveAzureModel(...a),
  resolveFoundryModel: (...a: unknown[]) => mockResolveFoundryModel(...a),
  resolveAnthropicModel: (...a: unknown[]) => mockResolveAnthropicModel(...a),
}));

// Stub Azure built-in tool factories so we can assert which ones the
// seam invoked + with what container id.
const mockCodeInterpreter = vi.fn((opts: unknown) => ({ kind: "code", opts }));
const mockImageGeneration = vi.fn((opts: unknown) => ({ kind: "image", opts }));
const mockWebSearchPreview = vi.fn((opts: unknown) => ({ kind: "web", opts }));
vi.mock("@ai-sdk/azure", () => ({
  azure: {
    tools: {
      codeInterpreter: (...a: unknown[]) => mockCodeInterpreter(...a),
      imageGeneration: (...a: unknown[]) => mockImageGeneration(...a),
      webSearchPreview: (...a: unknown[]) => mockWebSearchPreview(...a),
    },
  },
}));

import { resolveProvider, getFileIdsSignature } from "./provider-seam";

const baseThread = { id: "thread-1", codeInterpreterContainerId: undefined };
const baseReasoning = { supported: false, effort: undefined };
const offToggles = { codeInterpreter: false, imageGeneration: false, webSearch: false };

describe("provider-seam — Azure branch", () => {
  beforeEach(() => {
    mockResolveAzureModel.mockClear();
    mockCodeInterpreter.mockClear();
    mockImageGeneration.mockClear();
    mockWebSearchPreview.mockClear();
  });

  it("returns the Azure LanguageModel via resolveAzureModel", () => {
    const r = resolveProvider({
      modelId: "gpt-5.5",
      thread: baseThread,
      toggles: offToggles,
      reasoning: baseReasoning,
    });
    expect(mockResolveAzureModel).toHaveBeenCalledWith("gpt-5.5");
    expect((r.model as { __azureModel?: boolean }).__azureModel).toBe(true);
  });

  it("builtInTools is empty when no toggles are on", () => {
    const r = resolveProvider({
      modelId: "gpt-5.5",
      thread: baseThread,
      toggles: offToggles,
      reasoning: baseReasoning,
    });
    expect(Object.keys(r.builtInTools)).toEqual([]);
  });

  it("includes code_interpreter with container option when toggle on + container id set", () => {
    const r = resolveProvider({
      modelId: "gpt-5.5",
      thread: { id: "t", codeInterpreterContainerId: "cnt-abc" },
      toggles: { codeInterpreter: true, imageGeneration: false, webSearch: false },
      reasoning: baseReasoning,
    });
    expect(Object.keys(r.builtInTools)).toEqual(["code_interpreter"]);
    expect(mockCodeInterpreter).toHaveBeenCalledWith({ container: "cnt-abc" });
  });

  it("includes code_interpreter with empty options when toggle on + no container id", () => {
    const r = resolveProvider({
      modelId: "gpt-5.5",
      thread: baseThread,
      toggles: { codeInterpreter: true, imageGeneration: false, webSearch: false },
      reasoning: baseReasoning,
    });
    expect(Object.keys(r.builtInTools)).toEqual(["code_interpreter"]);
    expect(mockCodeInterpreter).toHaveBeenCalledWith({});
  });

  it("passes container: { fileIds } when files attached + no container yet", () => {
    // First turn with SharePoint / uploaded files: no persisted container,
    // so Azure mints a new one with these uploads attached. Pre-fix the
    // route ignored payload.codeInterpreterFileIds and the model saw an
    // empty container → "I don't have this file".
    resolveProvider({
      modelId: "gpt-5.5",
      thread: { id: "t", codeInterpreterContainerId: undefined },
      toggles: { codeInterpreter: true, imageGeneration: false, webSearch: false },
      reasoning: baseReasoning,
      codeInterpreterFileIds: ["file-abc", "file-def"],
    });
    expect(mockCodeInterpreter).toHaveBeenCalledWith({
      container: { fileIds: ["file-abc", "file-def"] },
    });
  });

  it("prefers existing containerId over fileIds (route handles invalidation)", () => {
    // Subsequent turn with the same files: provider seam trusts the
    // persisted container. The route's signature check is what
    // invalidates `codeInterpreterContainerId` upstream when files
    // actually changed.
    resolveProvider({
      modelId: "gpt-5.5",
      thread: { id: "t", codeInterpreterContainerId: "cnt-existing" },
      toggles: { codeInterpreter: true, imageGeneration: false, webSearch: false },
      reasoning: baseReasoning,
      codeInterpreterFileIds: ["file-abc"],
    });
    expect(mockCodeInterpreter).toHaveBeenCalledWith({ container: "cnt-existing" });
  });

  it("falls back to empty options when toggle on, no container, no files", () => {
    resolveProvider({
      modelId: "gpt-5.5",
      thread: baseThread,
      toggles: { codeInterpreter: true, imageGeneration: false, webSearch: false },
      reasoning: baseReasoning,
      codeInterpreterFileIds: [],
    });
    expect(mockCodeInterpreter).toHaveBeenCalledWith({});
  });

  it("includes image_generation + web_search_preview when their toggles are on", () => {
    const r = resolveProvider({
      modelId: "gpt-5.5",
      thread: baseThread,
      toggles: { codeInterpreter: false, imageGeneration: true, webSearch: true },
      reasoning: baseReasoning,
    });
    expect(Object.keys(r.builtInTools).sort()).toEqual([
      "image_generation",
      "web_search_preview",
    ]);
  });

  it("providerOptions.openai.promptCacheKey is the thread id", () => {
    const r = resolveProvider({
      modelId: "gpt-5.5",
      thread: { id: "thread-xyz", codeInterpreterContainerId: undefined },
      toggles: offToggles,
      reasoning: baseReasoning,
    });
    const openai = r.providerOptions.openai as Record<string, unknown>;
    expect(openai.promptCacheKey).toBe("thread-xyz");
    expect(openai.store).toBe(false);
    // No reasoning when not supported.
    expect(openai.reasoningEffort).toBeUndefined();
    expect(openai.include).toBeUndefined();
  });

  it("uses promptCacheKey when the caller overrides it, otherwise the thread id", () => {
    const overridden = resolveProvider({
      modelId: "gpt-5.6-sol",
      thread: { id: "thread-parent", codeInterpreterContainerId: undefined },
      toggles: offToggles,
      reasoning: baseReasoning,
      promptCacheKey: "thread-parent:sub:agent-9",
    });
    expect(
      (overridden.providerOptions.openai as Record<string, unknown>)
        .promptCacheKey,
    ).toBe("thread-parent:sub:agent-9");

    const defaulted = resolveProvider({
      modelId: "gpt-5.6-sol",
      thread: { id: "thread-parent", codeInterpreterContainerId: undefined },
      toggles: offToggles,
      reasoning: baseReasoning,
    });
    expect(
      (defaulted.providerOptions.openai as Record<string, unknown>)
        .promptCacheKey,
    ).toBe("thread-parent");
  });

  it("emits reasoning options only when supported + effort provided", () => {
    const r = resolveProvider({
      modelId: "gpt-5.5",
      thread: baseThread,
      toggles: offToggles,
      reasoning: { supported: true, effort: "high" },
    });
    const openai = r.providerOptions.openai as Record<string, unknown>;
    expect(openai.reasoningEffort).toBe("high");
    expect(openai.reasoningSummary).toBe("auto");
    expect(openai.include).toEqual(["reasoning.encrypted_content"]);
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const)(
    "sends promptCacheOptions { implicit, 30m } for %s",
    (modelId) => {
      const r = resolveProvider({
        modelId,
        thread: baseThread,
        toggles: offToggles,
        reasoning: baseReasoning,
      });
      const openai = r.providerOptions.openai as Record<string, unknown>;
      expect(openai.promptCacheOptions).toEqual({
        mode: "implicit",
        ttl: "30m",
      });
      // The key + store contract is unchanged by the cache options.
      expect(openai.promptCacheKey).toBe("thread-1");
      expect(openai.store).toBe(false);
    },
  );

  it.each(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"] as const)(
    "omits promptCacheOptions for %s (the model answers HTTP 400)",
    (modelId) => {
      const r = resolveProvider({
        modelId,
        thread: baseThread,
        toggles: offToggles,
        reasoning: baseReasoning,
      });
      const openai = r.providerOptions.openai as Record<string, unknown>;
      expect(openai.promptCacheOptions).toBeUndefined();
      expect(openai.promptCacheKey).toBe("thread-1");
      expect(openai.store).toBe(false);
    },
  );

  it("omits reasoning options when supported=true but effort is undefined", () => {
    const r = resolveProvider({
      modelId: "gpt-5.5",
      thread: baseThread,
      toggles: offToggles,
      reasoning: { supported: true, effort: undefined },
    });
    const openai = r.providerOptions.openai as Record<string, unknown>;
    expect(openai.reasoningEffort).toBeUndefined();
  });
});

describe("provider-seam — Foundry branch", () => {
  beforeEach(() => {
    mockResolveFoundryModel.mockClear();
    mockResolveAzureModel.mockClear();
  });

  it("resolves Foundry models via resolveFoundryModel, NOT resolveAzureModel", () => {
    const r = resolveProvider({
      modelId: "DeepSeek-V4-Pro",
      thread: baseThread,
      toggles: offToggles,
      reasoning: baseReasoning,
    });
    expect(mockResolveFoundryModel).toHaveBeenCalledWith("DeepSeek-V4-Pro");
    expect(mockResolveAzureModel).not.toHaveBeenCalled();
    expect((r.model as { __foundryModel?: boolean }).__foundryModel).toBe(true);
  });

  it("emits NO built-in tools (Foundry has no Azure-Responses tools)", () => {
    const r = resolveProvider({
      modelId: "Kimi-K2.6",
      thread: baseThread,
      // Even if toggles were on, Foundry must not surface azure.tools.*.
      toggles: { codeInterpreter: true, imageGeneration: true, webSearch: true },
      reasoning: baseReasoning,
    });
    expect(r.builtInTools).toEqual({});
  });

  it("emits empty providerOptions (no promptCacheKey/store/reasoning keys)", () => {
    const r = resolveProvider({
      modelId: "DeepSeek-V4-Pro",
      thread: { id: "thread-xyz", codeInterpreterContainerId: undefined },
      toggles: offToggles,
      reasoning: { supported: true, effort: "high" },
    });
    expect(r.providerOptions).toEqual({});
  });
});

describe("provider-seam — Anthropic branch", () => {
  beforeEach(() => {
    mockResolveAnthropicModel.mockClear();
    mockResolveAzureModel.mockClear();
  });

  it("resolves Anthropic models via resolveAnthropicModel, NOT resolveAzureModel", () => {
    const r = resolveProvider({
      modelId: "claude-opus-4-8",
      thread: baseThread,
      toggles: offToggles,
      reasoning: baseReasoning,
    });
    expect(mockResolveAnthropicModel).toHaveBeenCalledWith("claude-opus-4-8");
    expect(mockResolveAzureModel).not.toHaveBeenCalled();
    expect((r.model as { __anthropicModel?: boolean }).__anthropicModel).toBe(true);
  });

  it("enables adaptive thinking + mapped effort; no Azure-Responses keys; no tools when toggles off", () => {
    const r = resolveProvider({
      modelId: "claude-sonnet-5",
      thread: { id: "thread-xyz", codeInterpreterContainerId: undefined },
      toggles: offToggles,
      reasoning: { supported: true, effort: "high" },
    });
    expect(r.builtInTools).toEqual({});
    const anth = r.providerOptions.anthropic as Record<string, unknown>;
    expect(anth.thinking).toEqual({ type: "adaptive" });
    expect(anth.effort).toBe("high");
    expect(r.providerOptions.openai).toBeUndefined();
  });

  it("maps 'minimal' effort to 'low'", () => {
    const r = resolveProvider({
      modelId: "claude-opus-4-8",
      thread: baseThread,
      toggles: offToggles,
      reasoning: { supported: true, effort: "minimal" },
    });
    expect((r.providerOptions.anthropic as Record<string, unknown>).effort).toBe("low");
  });

  it("wires Claude NATIVE web search + web fetch when the web-search toggle is on", () => {
    const r = resolveProvider({
      modelId: "claude-opus-4-8",
      thread: baseThread,
      // code_interpreter / image_generation must NOT produce Anthropic tools.
      toggles: { codeInterpreter: true, imageGeneration: true, webSearch: true },
      // Both Claude configs declare supportsReasoning, so this is the shape a
      // real Claude turn takes.
      reasoning: { supported: true, effort: "medium" },
    });
    expect(Object.keys(r.builtInTools).sort()).toEqual(["web_fetch", "web_search"]);
    // A tool toggle must not switch thinking off, and never an openai block.
    expect((r.providerOptions.anthropic as Record<string, unknown>).thinking).toEqual({ type: "adaptive" });
    expect(r.providerOptions.openai).toBeUndefined();
  });

  it("leaves thinking off when the config does not support reasoning (negative)", () => {
    // The gate has to cover `thinking`, not just `effort`. A Claude entry
    // added with supportsReasoning:false — the obvious way to wire a cheap
    // Haiku-class model — would otherwise still think, and still be billed
    // for the thinking tokens.
    const r = resolveProvider({
      modelId: "claude-sonnet-5",
      thread: baseThread,
      toggles: offToggles,
      reasoning: baseReasoning,
    });
    const anth = r.providerOptions.anthropic as Record<string, unknown>;
    expect(anth.thinking).toBeUndefined();
    expect(anth.effort).toBeUndefined();
  });
});

describe("provider-seam — error paths", () => {
  it("throws on unknown modelId", () => {
    expect(() =>
      resolveProvider({
        modelId: "does-not-exist" as never,
        thread: baseThread,
        toggles: offToggles,
        reasoning: baseReasoning,
      }),
    ).toThrow(/unknown modelId/);
  });
});

describe("getFileIdsSignature", () => {
  it("returns empty string for undefined or empty input", () => {
    expect(getFileIdsSignature(undefined)).toBe("");
    expect(getFileIdsSignature([])).toBe("");
  });

  it("sorts and dedupes so reorder / duplicates don't trigger invalidation", () => {
    expect(getFileIdsSignature(["b", "a"])).toBe("a,b");
    expect(getFileIdsSignature(["a", "b", "a"])).toBe("a,b");
    expect(getFileIdsSignature(["a", "b"])).toEqual(getFileIdsSignature(["b", "a"]));
  });

  it("produces distinct signatures for distinct sets", () => {
    expect(getFileIdsSignature(["a"])).not.toBe(getFileIdsSignature(["a", "b"]));
  });
});
