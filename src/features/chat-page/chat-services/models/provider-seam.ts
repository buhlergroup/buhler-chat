/**
 * provider-seam.ts
 *
 * Generic provider abstraction. Resolves a model id (any provider) into
 * everything `streamText` needs to actually invoke that provider:
 *
 *   - `model`              the LanguageModelV4 instance
 *   - `builtInTools(...)`  provider-native server-side tools merged into
 *                          the user's effective-toggles set
 *   - `providerOptions(...)` per-provider options block (reasoning,
 *                          prompt-cache key, anything else)
 *
 * Today only Azure (gpt-5.* via @ai-sdk/azure / Responses API) is wired up;
 * the seam keeps route.ts agnostic so an Anthropic implementation slots in
 * without touching the route handler — just register a new entry here and
 * add models to MODEL_CONFIGS with `provider: "anthropic"`.
 *
 * What goes where on addition of a new provider:
 *   1. Add `provider: "anthropic"` (or similar) to the model's ModelConfig.
 *   2. Add a branch below resolving that provider's LanguageModelV4 +
 *      built-in tools + providerOptions shape.
 *   3. If Anthropic exposes tools we want to surface (e.g. their server-
 *      side bash tool), wire those into builtInTools branch. Otherwise
 *      Anthropic returns an empty toolset and only custom tools (our RAG,
 *      sub-agents, extension tools) flow through.
 *
 * Architect2 SEV-2 B10: this kills the "hardcoded azure.tools.* and
 * providerOptions.openai.* in route.ts" coupling.
 */

import type { LanguageModelV4, JSONValue } from "@ai-sdk/provider";
import { azure } from "@ai-sdk/azure";
import { anthropic } from "@ai-sdk/anthropic";
import { resolveAzureModel, resolveFoundryModel, resolveAnthropicModel } from "./provider";
import {
  MODEL_CONFIGS,
  type ChatModel,
  type ProviderReasoningEffort,
  type ModelConfig,
  type ModelProvider,
} from "../models";
import type { ChatThreadModel } from "../models";

/**
 * Effective tool toggles for this turn — merged from per-request payload +
 * thread defaults by the route handler before this seam is called.
 */
export interface BuiltInToggles {
  codeInterpreter: boolean;
  imageGeneration: boolean;
  webSearch: boolean;
}

export interface ResolvedProvider {
  model: LanguageModelV4;
  /**
   * Map of provider-native tools keyed by stable tool-name (used as part
   * type by the AI SDK stream). Merged with custom tools by the route.
   */
  builtInTools: Record<string, unknown>;
  /**
   * Object passed verbatim into streamText({ providerOptions }).
   * Provider-specific keys; AI SDK ignores unknown providers' keys.
   * Values must be JSON-serialisable per AI SDK's SharedV4ProviderOptions.
   */
  providerOptions: Record<string, Record<string, JSONValue>>;
}

export interface ResolveProviderArgs {
  modelId: ChatModel;
  thread: Pick<ChatThreadModel, "id" | "codeInterpreterContainerId">;
  toggles: BuiltInToggles;
  reasoning: {
    supported: boolean;
    effort: ProviderReasoningEffort | undefined;
  };
  /**
   * Files the user attached for code_interpreter this turn (OpenAI file
   * IDs from `/api/code-interpreter/upload`). When no container is
   * reusable, we ask Azure to spin up a fresh container with these
   * files attached via `container: { fileIds }` — without this the
   * container starts empty and `read_file()` returns "file not found".
   *
   * The caller is responsible for invalidating a stale container before
   * calling: if `codeInterpreterContainerId` is set we trust it covers
   * these file IDs. Mismatch resolution lives in route.ts via the
   * persisted `codeInterpreterFileIdsSignature`.
   */
  codeInterpreterFileIds?: string[];
  /**
   * Overrides the value sent as `promptCacheKey`. Defaults to `thread.id`.
   * Two callers need this:
   *   - the sub-agent tool, whose prefix (its own persona message + the
   *     delegated task) has nothing in common with the parent thread's, so
   *     sharing the parent's key would only cause cache misses;
   *   - the persona cache-key strategy (prompt-cache-key.ts), which
   *     deliberately shares one key across threads that have the same
   *     developer message so they can read each other's prefix.
   */
  promptCacheKey?: string;
}

/**
 * Stable signature for a set of OpenAI file IDs. Used by the route to
 * detect when a thread's attached-file set changed between turns so the
 * persisted container_id can be invalidated and Azure asked to create a
 * fresh container with the new file set. Sort + dedupe so reorder /
 * duplicates don't cause spurious invalidations.
 */
export function getFileIdsSignature(fileIds: string[] | undefined): string {
  if (!fileIds || fileIds.length === 0) return "";
  return [...new Set(fileIds)].sort().join(",");
}

/**
 * Build a ResolvedProvider from a ChatModel id + per-turn context.
 * Throws if the model id is unknown or its provider has no factory wired.
 */
export function resolveProvider(args: ResolveProviderArgs): ResolvedProvider {
  const config: ModelConfig | undefined = MODEL_CONFIGS[args.modelId];
  if (!config) {
    throw new Error(`resolveProvider: unknown modelId "${args.modelId}"`);
  }

  // ModelConfig.provider is optional today (Azure-only). Treat absence as
  // "azure" to keep existing rows working without backfill.
  const providerTag: ModelProvider = config.provider ?? "azure";

  switch (providerTag) {
    case "azure":
      return resolveAzureBackedProvider(args, config);
    case "foundry":
      return resolveFoundryBackedProvider(args);
    case "anthropic":
      return resolveAnthropicBackedProvider(args);
    default:
      throw new Error(
        `resolveProvider: unhandled provider "${providerTag}" for model "${args.modelId}"`
      );
  }
}

function resolveAzureBackedProvider(
  args: ResolveProviderArgs,
  config: ModelConfig,
): ResolvedProvider {
  const model = resolveAzureModel(args.modelId);

  // Built-in tools that Azure runs server-side (Responses API).
  // codeInterpreter: container reuse OR fileIds-bootstrap, see below.
  // imageGeneration & webSearchPreview: parameterless.
  const builtInTools: Record<string, unknown> = {};
  if (args.toggles.codeInterpreter) {
    const containerId = args.thread.codeInterpreterContainerId;
    const fileIds = args.codeInterpreterFileIds ?? [];
    // Three shapes the @ai-sdk/azure codeInterpreter accepts:
    //   - container: "<id>"           → reuse the existing container; files
    //                                    are already attached on Azure's side
    //   - container: { fileIds: [..]} → ask Azure to mint a new container
    //                                    and attach these uploaded files
    //   - {}                          → empty container, no files
    // We pick reuse first because it's stable across turns AND preserves
    // any working-directory state the interpreter built up (downloaded
    // CSVs, generated images, etc.). Route invalidates this id when the
    // file signature changes, so a non-empty containerId here implies
    // the files are still current.
    let codeInterpreterArgs: { container?: string | { fileIds?: string[] } } = {};
    if (containerId) {
      codeInterpreterArgs = { container: containerId };
    } else if (fileIds.length > 0) {
      codeInterpreterArgs = { container: { fileIds } };
    }
    builtInTools["code_interpreter"] = azure.tools.codeInterpreter(codeInterpreterArgs);
  }
  if (args.toggles.imageGeneration) {
    // partialImages: 0 tells Azure NOT to stream partial-image previews.
    // Without this, Azure emits a partial as a `tool-result` chunk with
    // `preliminary: true` followed by the final — the duplicate
    // `tool-output-available` UI event throws the model off and it ends
    // the turn with no text response. See the matching `preliminary`
    // filter in image-generation-stream-rewriter.ts.
    builtInTools["image_generation"] = azure.tools.imageGeneration({
      partialImages: 0,
    });
  }
  if (args.toggles.webSearch) {
    builtInTools["web_search_preview"] = azure.tools.webSearchPreview({});
  }

  // Provider options. The @ai-sdk/azure model speaks OpenAI Responses API
  // under the hood so the providerOptions namespace is "openai", not
  // "azure" — verified from @ai-sdk/openai/internal types.
  const openaiOptions: Record<string, JSONValue> = {
    promptCacheKey: args.promptCacheKey ?? args.thread.id,
    store: false,
  };
  // GPT-5.6 exposes `prompt_cache_options`: implicit mode keeps the automatic
  // prefix matching we already rely on, and ttl "30m" extends the cache
  // lifetime from the ~5-minute default so a user who thinks between turns
  // still lands a cache read instead of re-writing the whole prefix.
  // Strictly gated: gpt-5.5 and older answer HTTP 400
  // "prompt_cache_options is not supported on this model".
  if (config.promptCacheOptionsSupported) {
    openaiOptions.promptCacheOptions = { mode: "implicit", ttl: "30m" };
  }
  if (args.reasoning.supported && args.reasoning.effort) {
    openaiOptions.reasoningEffort = args.reasoning.effort;
    openaiOptions.reasoningSummary = "auto";
    openaiOptions.include = ["reasoning.encrypted_content"];
  }

  return {
    model,
    builtInTools,
    providerOptions: { openai: openaiOptions },
  };
}

/**
 * Foundry (OpenAI-compatible Chat Completions) seam. These models are
 * downgrade targets only and deliberately expose NO Azure-Responses
 * features:
 *   - builtInTools is empty — code_interpreter / image_generation /
 *     web_search are Azure-Responses server-side tools that don't exist on
 *     the Foundry endpoint. (The route already strips those toggles for
 *     non-Responses models via effectiveToolsSafe.)
 *   - providerOptions is empty — promptCacheKey / store / reasoning* are
 *     Azure-Responses-only keys the generic /openai/v1 endpoint may reject.
 * Custom registry tools (RAG, sub-agents, extensions) still flow through
 * the route's `tools` map and work normally with Chat Completions.
 */
function resolveFoundryBackedProvider(args: ResolveProviderArgs): ResolvedProvider {
  return {
    model: resolveFoundryModel(args.modelId),
    builtInTools: {},
    providerOptions: {},
  };
}

/**
 * Anthropic (Azure /anthropic Messages API) seam. Claude can't call the Azure
 * Responses built-ins; instead it has its OWN server tools. We wire the
 * NATIVE web-search tool when the web-search toggle is on (confirmed available
 * on Microsoft Foundry; the SDK adds the required beta header automatically).
 *
 * Deferred: code execution (`codeExecution_*`) — it works, but file upload /
 * download goes through Anthropic's Files API, which differs from the Azure
 * one; wiring that is a separate task. Image generation isn't an Anthropic
 * capability. Custom registry tools (RAG, sub-agents, extensions) still flow
 * through the route's `tools` map. Reasoning/thinking options are not sent
 * (configs are supportsReasoning:false).
 */
function resolveAnthropicBackedProvider(args: ResolveProviderArgs): ResolvedProvider {
  const builtInTools: Record<string, unknown> = {};
  if (args.toggles.webSearch) {
    // Web search + web fetch are paired: search finds pages, fetch reads them.
    builtInTools["web_search"] = anthropic.tools.webSearch_20260209({ maxUses: 5 });
    builtInTools["web_fetch"] = anthropic.tools.webFetch_20260209({ maxUses: 5 });
  }

  // Adaptive thinking is Claude 4.x's reasoning mode, enabled only for a
  // config that declares supportsReasoning. We never send
  // temperature/top_p/top_k (the route doesn't, and Opus 4.8 rejects them with
  // a 400), so adaptive thinking is safe to leave on. `effort` is mapped from
  // the user's ReasoningEffort selection; "minimal" → "low".
  const anthropicOptions: Record<string, JSONValue> = {};
  if (args.reasoning.supported) {
    // Inside the gate, not above it: a Claude entry declared
    // supportsReasoning:false (the obvious way to add a cheap Haiku-class
    // model) would otherwise still get thinking enabled — and still be
    // billed for thinking tokens — with the reasoning gate bypassed.
    anthropicOptions.thinking = { type: "adaptive" };
  }
  if (args.reasoning.supported && args.reasoning.effort) {
    // Claude's adaptive thinking takes low/medium/high. Map the levels that
    // only exist on the OpenAI side onto the nearest Claude equivalent.
    const effort = args.reasoning.effort;
    anthropicOptions.effort =
      effort === "minimal" || effort === "none"
        ? "low"
        : effort === "xhigh" || effort === "max"
          ? "high"
          : effort;
  }

  return {
    model: resolveAnthropicModel(args.modelId),
    builtInTools,
    providerOptions: { anthropic: anthropicOptions },
  };
}
