import { ChatCompletionMessage } from "openai/resources/chat/completions";
import {
  OpenAIV1Instance,
  OpenAIV1ReasoningInstance,
} from "@/features/common/services/openai";
import { logError } from "@/features/common/services/logger";

export const CHAT_DOCUMENT_ATTRIBUTE = "CHAT_DOCUMENT";
export const CHAT_THREAD_ATTRIBUTE = "CHAT_THREAD";
export const MESSAGE_ATTRIBUTE = "CHAT_MESSAGE";
export const CHAT_CITATION_ATTRIBUTE = "CHAT_CITATION";

export type ChatModel =
  | "gpt-5.6-sol"
  | "gpt-5.6-terra"
  | "gpt-5.6-luna"
  | "gpt-5.5"
  | "gpt-5.4"
  | "gpt-5.4-mini"
  // Foundry-hosted (OpenAI-compatible) models. Served via the "foundry"
  // provider seam, not Azure Responses. DeepSeek/Kimi double as downgrade
  // targets; Grok is a selectable option.
  | "DeepSeek-V4-Pro"
  | "Kimi-K2.6"
  | "grok-4.3"
  // Anthropic Claude models served via the Azure /anthropic surface
  // (Messages API) through the "anthropic" provider seam.
  | "claude-opus-4-8"
  | "claude-sonnet-5";

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
  /**
   * Price per 1M tokens WRITTEN into the prompt cache. GPT-5.6 and Anthropic
   * both bill a cache write at 1.25x the uncached input rate; the earlier GPT
   * generations and the Foundry models don't bill writes separately. Absence
   * therefore means "no write surcharge" and the write tokens are billed at
   * `inputPerMillion` like any other input (see computeTokenCostUsd).
   *
   * Set it on every model whose provider reports cache-write tokens, or the
   * cost is under-stated by 25 % of the write portion while the
   * `cacheWriteTokensUsed` metric still reports the true count.
   */
  cacheWritePerMillion?: number;
}

/**
 * Model generation ("family"). Gates provider features that are generation-
 * specific rather than per-model:
 *   - GPT-5.6 accepts the Responses-API `prompt_cache_options` block and
 *     bills cache writes; earlier generations reject it with HTTP 400.
 *   - the persona prompt-cache-key strategy only applies to GPT-5.6, whose
 *     implicit cache matches partial prefixes.
 *   - each generation accepts a different set of reasoning-effort levels.
 * Absence means "unclassified"; every feature gated on a family treats an
 * absent family as "not that family", so old entries keep working.
 */
export type ModelFamily = "gpt-5.6" | "gpt-5.5" | "gpt-5.4" | "foundry" | "claude";

/**
 * The upstream provider that serves this model. Switches the route's
 * provider-seam to a different concrete implementation:
 *
 *   - "azure":     @ai-sdk/azure → OpenAI Responses API (default).
 *   - "anthropic": @ai-sdk/anthropic → Azure /anthropic Messages API.
 *   - "foundry":   @ai-sdk/openai createOpenAI() pointed at the Bühler
 *                  Azure AI Foundry OpenAI-compatible endpoint. Chat
 *                  Completions only — no Responses-API tools/reasoning.
 *
 * Absence is treated as "azure" for backward compatibility with existing
 * MODEL_CONFIGS entries.
 */
export type ModelProvider = "azure" | "anthropic" | "foundry";

/**
 * Capability badges shown next to a model in the picker.
 *   - "vision":    accepts image input
 *   - "imageGen":  can generate images
 *   - "webSearch": can search the web
 *   - "code":      can run code (code interpreter / Python)
 * NOTE: imageGen / webSearch / code are Azure-Responses built-in tools and are
 * only callable by provider "azure" models. Anthropic/Foundry models that
 * route through Chat/Messages APIs can't invoke those built-ins.
 */
export type ModelCapability = "vision" | "imageGen" | "webSearch" | "code";

export interface ModelConfig {
  id: ChatModel;
  name: string;
  description: string;
  getInstance: () => any;
  supportsReasoning: boolean;
  supportedSummarizers?: string[];
  supportsResponsesAPI: boolean;
  supportsImageGeneration?: boolean;
  supportsComputerUse?: boolean;
  /** Optional override of the route's provider seam. Defaults to "azure". */
  provider?: ModelProvider;
  /** Model generation. Absence means "unclassified" — see ModelFamily. */
  family?: ModelFamily;
  /**
   * True when the model accepts the Responses-API `prompt_cache_options`
   * block (`{ mode, ttl }`). GPT-5.6 does. gpt-5.5 and older answer
   * HTTP 400 "prompt_cache_options is not supported on this model", so this
   * capability is gated per model instead of being sent unconditionally.
   */
  promptCacheOptionsSupported?: boolean;
  deploymentName?: string;
  defaultReasoningEffort?: ReasoningEffort;
  /**
   * Effort levels this model's provider accepts. Only needed where they
   * differ from DEFAULT_REASONING_EFFORT_LEVELS: GPT-5.6 adds "xhigh"/"max",
   * both 5.6 and 5.5 add "none", and NEITHER accepts "minimal". Used to
   * validate the REASONING_EFFORT_OVERRIDES env map — sending a level a model
   * rejects is an HTTP 400 on every turn.
   *
   * This array is the PROVIDER's word, measured against the deployment, and
   * nothing may widen it to suit the UI. Both directions are covered:
   * `getPickableReasoningEfforts` hides a level the model does not take, and
   * `resolveReasoningEffort` maps a stored or hand-sent one down to "low"
   * before the request is built. Verified on the dev deployments:
   *
   *   gpt-5.5      400 Unsupported value: 'minimal' is not supported with the
   *                'gpt-5.5-2026-04-24' model. Supported values are: 'none',
   *                'low', 'medium', 'high', and 'xhigh'.
   *   gpt-5.6-*    same, with 'max' additionally supported.
   */
  supportedReasoningEfforts?: ReadonlyArray<ProviderReasoningEffort>;
  pricing: ModelPricing;
  contextWindow: number;
  /**
   * Upper bound on the tokens the model may emit for one call, passed to
   * streamText/generateText as `maxOutputTokens`. Not a context limit — a
   * guardrail against one runaway turn billing at the output rate.
   *
   * REASONING TOKENS COUNT AGAINST IT. On the Responses API the ceiling covers
   * reasoning plus the visible answer, and on Anthropic's Messages API
   * `max_tokens` covers thinking plus the answer — so at effort "high" and
   * above a turn can spend most of the budget thinking and then be cut off
   * mid-sentence. The chat path surfaces `finishReason: "length"` rather than
   * letting that pass as a complete answer.
   *
   * The numbers, and why they differ:
   *   32000  the 5.6 family and 5.5 — reasoning-heavy, and the models people
   *          bring long-form work to. 16000 was measurably tight at high
   *          effort.
   *   16000  Claude (thinking is adaptive, so the cap is the bill guardrail
   *          rather than the thinking budget) and gpt-5.4.
   *    8000  the small models, which are picked for speed and cost.
   *
   * `MAX_OUTPUT_TOKENS_OVERRIDES` overrides this per model per environment;
   * see models/max-output-tokens.ts. Absent here and unset there means no
   * ceiling is sent and the provider default applies.
   */
  maxOutputTokens?: number;
  fallbackModel?: ChatModel;
  dailyTokenLimit?: number;
  dailyCostLimit?: number;
  /**
   * When true, this model may be used as an automatic hard-cap downgrade
   * target (see downgrade-config.ts / budget-service.ts). The set of
   * eligible models is chosen cheapest-first at cap time.
   */
  hardCapEligible?: boolean;
  /**
   * When true, the model is hidden from the user-facing picker (/api/models)
   * but can still be selected programmatically as a downgrade target.
   */
  hiddenFromPicker?: boolean;
  /** Capability badges rendered in the picker (text is implicit for all). */
  capabilities?: ModelCapability[];
  /**
   * Ceiling on ESTIMATED history tokens carried into a prompt for threads on
   * this model. Absent means the shared default in history-budget.ts
   * (256,000); `HISTORY_TOKEN_BUDGET` overrides both.
   *
   * Not a context limit — the 5.6 family has ~1M tokens of context. It is a
   * cost limit on the history that is re-sent every turn.
   *
   * NO MODEL SETS THIS TODAY. Every model currently takes the module default
   * (or the `HISTORY_TOKEN_BUDGET` env override), so this field is a seam with
   * a reader and no producer. It is kept, not deleted, because a per-model
   * cut-off is the natural lever once one model's input price justifies a
   * different one — set it here on that model and `resolveHistoryBudget`
   * already honours it. Until then, do not describe it as a configured
   * override: nothing configures it.
   *
   * Whatever is configured here is still BOUNDED at resolution time by
   * `longContextThresholdTokens` (minus a reserve) or, failing that, by 60 % of
   * `contextWindow` — see `resolveHistoryBudget`. So this field can lower the
   * budget for an expensive model but cannot raise it past what the model can
   * afford to be handed.
   */
  historyTokenBudget?: number;
  /**
   * Input-token count above which the provider switches this model to a
   * separate, more expensive billing tier — NOT a context limit and not a
   * failure mode. Azure bills GPT-5.6 input above 272k at a "long context"
   * tier at 2x the normal rate (visible as the `LongCo*` meters); nothing
   * errors, the invoice just doubles for the whole request, cached tokens
   * included.
   *
   * `resolveHistoryBudget` keeps the carried history under
   * `longContextThresholdTokens − HISTORY_LONG_CONTEXT_RESERVE`, so a long
   * thread cannot drift over the cliff on its own — which would otherwise be
   * the most expensive way to cross it, since history is re-sent every turn.
   *
   * Absent means "no tier boundary known", and the guard falls back to a
   * fraction of `contextWindow`.
   */
  longContextThresholdTokens?: number;
}

export const MODEL_CONFIGS: Record<ChatModel, ModelConfig> = {
  // ── GPT-5.6 family (2026-07-09) ─────────────────────────────────────────
  // Official list prices per 1M tokens (input / output / cached input / cache
  // write): Sol 5.00 / 30.00 / 0.50 / 6.25, Terra 2.00 / 12.00 / 0.20 / 2.50,
  // Luna 0.20 / 1.20 / 0.02 / 0.25. Cache reads keep the 90% cached-input
  // discount; cache WRITES are billed at 1.25x the uncached input rate and
  // are modelled via ModelPricing.cacheWritePerMillion.
  // Above 272k input tokens the whole request moves to the "long context" tier
  // at 2x the normal rate (the LongCo* meters), which is what
  // longContextThresholdTokens keeps the carried history clear of.
  "gpt-5.6-sol": {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    description: "Flagship GPT-5.6 model with state-of-the-art capabilities",
    getInstance: () => OpenAIV1ReasoningInstance(),
    family: "gpt-5.6",
    promptCacheOptionsSupported: true,
    supportsReasoning: true,
    supportsResponsesAPI: true,
    supportsImageGeneration: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT56_SOL_DEPLOYMENT_NAME,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    pricing: { inputPerMillion: 5.00, outputPerMillion: 30.00, cachedInputPerMillion: 0.50, cacheWritePerMillion: 6.25 },
    contextWindow: 1050000,
    longContextThresholdTokens: 272000,
    maxOutputTokens: 32000,
    fallbackModel: "gpt-5.6-luna",
    capabilities: ["vision", "imageGen", "webSearch", "code"],
  },
  "gpt-5.6-terra": {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    description: "Balanced GPT-5.6 model for everyday advanced tasks",
    getInstance: () => OpenAIV1ReasoningInstance(),
    family: "gpt-5.6",
    promptCacheOptionsSupported: true,
    supportsReasoning: true,
    supportsResponsesAPI: true,
    supportsImageGeneration: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT56_TERRA_DEPLOYMENT_NAME,
    // Terra is the default model: "medium" is the effort at which it earns
    // its keep on everyday work. Sol and Luna stay on "low".
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    pricing: { inputPerMillion: 2.00, outputPerMillion: 12.00, cachedInputPerMillion: 0.20, cacheWritePerMillion: 2.50 },
    contextWindow: 1050000,
    longContextThresholdTokens: 272000,
    maxOutputTokens: 32000,
    fallbackModel: "gpt-5.6-luna",
    capabilities: ["vision", "imageGen", "webSearch", "code"],
  },
  "gpt-5.6-luna": {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    description: "Fast and efficient GPT-5.6 model for everyday tasks",
    getInstance: () => OpenAIV1Instance(),
    family: "gpt-5.6",
    promptCacheOptionsSupported: true,
    supportsReasoning: false,
    supportsResponsesAPI: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT56_LUNA_DEPLOYMENT_NAME,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    pricing: { inputPerMillion: 0.20, outputPerMillion: 1.20, cachedInputPerMillion: 0.02, cacheWritePerMillion: 0.25 },
    contextWindow: 400000,
    longContextThresholdTokens: 272000,
    maxOutputTokens: 32000,
    hardCapEligible: true,
    capabilities: ["vision", "webSearch", "code"],
  },
  "gpt-5.5": {
    id: "gpt-5.5",
    name: "GPT-5.5",
    description: "Latest GPT-5.5 model with state-of-the-art capabilities",
    getInstance: () => OpenAIV1ReasoningInstance(),
    family: "gpt-5.5",
    supportsReasoning: true,
    supportsResponsesAPI: true,
    supportsImageGeneration: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT55_DEPLOYMENT_NAME,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    // No cacheWritePerMillion: gpt-5.5 does not bill cache writes separately.
    pricing: { inputPerMillion: 5.00, outputPerMillion: 30.00, cachedInputPerMillion: 0.50 },
    contextWindow: 1050000,
    maxOutputTokens: 32000,
    fallbackModel: "gpt-5.6-luna",
    capabilities: ["vision", "imageGen", "webSearch", "code"],
  },
  "gpt-5.4": {
    id: "gpt-5.4",
    name: "GPT-5.4",
    description: "Latest GPT-5.4 model with state-of-the-art capabilities",
    getInstance: () => OpenAIV1ReasoningInstance(),
    family: "gpt-5.4",
    supportsReasoning: true,
    supportsResponsesAPI: true,
    supportsImageGeneration: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT54_DEPLOYMENT_NAME,
    defaultReasoningEffort: "low",
    pricing: { inputPerMillion: 2.50, outputPerMillion: 15.00, cachedInputPerMillion: 0.25 },
    contextWindow: 1050000,
    maxOutputTokens: 16000,
    fallbackModel: "gpt-5.6-luna",
    capabilities: ["vision", "imageGen", "webSearch", "code"],
  },
  "gpt-5.4-mini": {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    description: "Fast and efficient GPT-5.4 model for everyday tasks",
    getInstance: () => OpenAIV1Instance(),
    family: "gpt-5.4",
    supportsReasoning: false,
    supportsResponsesAPI: true,
    deploymentName: process.env.AZURE_OPENAI_API_GPT54_MINI_DEPLOYMENT_NAME,
    defaultReasoningEffort: "medium",
    pricing: { inputPerMillion: 0.75, outputPerMillion: 4.50, cachedInputPerMillion: 0.075 },
    contextWindow: 400000,
    maxOutputTokens: 8000,
    capabilities: ["vision", "webSearch", "code"],
  },
  // ── Foundry-hosted low-cost downgrade targets ──────────────────────────
  // Served via the "foundry" provider seam (OpenAI-compatible Chat
  // Completions). Chat-only: no Responses-API tools / reasoning. Hidden from
  // the picker by default (downgrade-only). Pricing below is indicative —
  // confirm against the Bühler Foundry contract before enabling in prod.
  "DeepSeek-V4-Pro": {
    id: "DeepSeek-V4-Pro",
    name: "DeepSeek V4 Pro",
    description: "Fast, efficient general-purpose model",
    getInstance: () => {
      throw new Error(
        "Foundry models run via the provider seam (streamText), not the legacy getInstance path",
      );
    },
    provider: "foundry",
    family: "foundry",
    supportsReasoning: false,
    supportsResponsesAPI: false,
    deploymentName: process.env.FOUNDRY_DEEPSEEK_DEPLOYMENT_NAME,
    pricing: { inputPerMillion: 0.30, outputPerMillion: 1.20, cachedInputPerMillion: 0.03 },
    contextWindow: 163840,
    maxOutputTokens: 8000,
    hardCapEligible: true,
    capabilities: ["code", "imageGen"],
  },
  "Kimi-K2.6": {
    id: "Kimi-K2.6",
    name: "Kimi K2.6",
    description: "Large-context conversational model",
    getInstance: () => {
      throw new Error(
        "Foundry models run via the provider seam (streamText), not the legacy getInstance path",
      );
    },
    provider: "foundry",
    family: "foundry",
    supportsReasoning: false,
    supportsResponsesAPI: false,
    deploymentName: process.env.FOUNDRY_KIMI_DEPLOYMENT_NAME,
    pricing: { inputPerMillion: 0.15, outputPerMillion: 2.50, cachedInputPerMillion: 0.015 },
    contextWindow: 262144,
    maxOutputTokens: 8000,
    hardCapEligible: true,
    capabilities: ["vision", "imageGen", "code"],
  },
  "grok-4.3": {
    id: "grok-4.3",
    name: "Grok 4.3",
    description: "xAI Grok 4.3 (Foundry) — reasoning model",
    getInstance: () => {
      throw new Error(
        "Foundry models run via the provider seam (streamText), not the legacy getInstance path",
      );
    },
    provider: "foundry",
    family: "foundry",
    // Foundry emits the reasoning item inconsistently; no effort selector.
    supportsReasoning: false,
    supportsResponsesAPI: false,
    deploymentName: process.env.FOUNDRY_GROK_DEPLOYMENT_NAME,
    // TODO: confirm Grok pricing before relying on cost tracking (placeholder).
    pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0, cachedInputPerMillion: 0.75 },
    contextWindow: 256000,
    maxOutputTokens: 8000,
  },
  // ── Anthropic Claude (Azure /anthropic Messages API) ───────────────────
  // Premium selectable models — NOT downgrade targets (Opus is pricier than
  // GPT-5.5). Served via the "anthropic" provider seam.
  "claude-opus-4-8": {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    description: "Anthropic's most capable model for complex work",
    getInstance: () => {
      throw new Error(
        "Anthropic models run via the provider seam (streamText), not the legacy getInstance path",
      );
    },
    provider: "anthropic",
    family: "claude",
    supportsReasoning: true,
    supportsResponsesAPI: false,
    // "low", matching the effort every Claude turn has actually been running
    // at: resolveReasoningEffort's hardcoded fallback. Making the default
    // explicit is the fix; RAISING it is a product and cost decision, taken
    // separately, and REASONING_EFFORT_OVERRIDES is the lever for it.
    defaultReasoningEffort: "low",
    deploymentName: process.env.AZURE_ANTHROPIC_OPUS48_DEPLOYMENT_NAME,
    // Anthropic bills a 5-minute ephemeral cache WRITE at 1.25x base input
    // and a read at 0.1x, same shape as GPT-5.6. The write price has to be
    // here or computeTokenCostUsd leaves those tokens in the uncached bucket
    // at 1.0x — and prompt-builder.ts marks a cache_control breakpoint on
    // every Claude turn, so there are always writes to bill.
    pricing: {
      inputPerMillion: 15.0,
      outputPerMillion: 75.0,
      cachedInputPerMillion: 1.5,
      cacheWritePerMillion: 18.75,
    },
    contextWindow: 1000000,
    maxOutputTokens: 16000,
    // Image input + Claude's native web search/fetch (wired in the anthropic
    // seam). Code execution is deferred (needs the separate Anthropic Files
    // API). Can't call the Azure built-ins (image gen etc.).
    capabilities: ["vision", "webSearch"],
  },
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    description: "Balanced Anthropic model — fast, strong general performance",
    getInstance: () => {
      throw new Error(
        "Anthropic models run via the provider seam (streamText), not the legacy getInstance path",
      );
    },
    provider: "anthropic",
    family: "claude",
    supportsReasoning: true,
    supportsResponsesAPI: false,
    // See the note on claude-opus-4-8.
    defaultReasoningEffort: "low",
    deploymentName: process.env.AZURE_ANTHROPIC_SONNET5_DEPLOYMENT_NAME,
    // 1.25x base input for a 5-minute ephemeral cache write; see the note on
    // claude-opus-4-8.
    pricing: {
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
      cachedInputPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    },
    contextWindow: 1000000,
    maxOutputTokens: 16000,
    // Image input + native web search/fetch (wired in the anthropic seam).
    // Code execution deferred (Anthropic Files API differs).
    capabilities: ["vision", "webSearch"],
  },
};

/** A model this environment can actually route a turn to. */
function isDeployedModel(id: ChatModel): boolean {
  return !!MODEL_CONFIGS[id]?.deploymentName?.trim();
}

/**
 * Model used when the request, the thread and the picker all say nothing.
 * This is the code default; `DEFAULT_MODEL_ID` overrides it at deploy time.
 */
export const CODE_DEFAULT_MODEL: ChatModel = "gpt-5.6-terra";

/**
 * Resolve the default model, letting the deployment override the code
 * default via the `DEFAULT_MODEL_ID` env var. A value that is unknown OR has
 * no deployment behind it is ignored with a logged error rather than crashing
 * the app or — worse — silently routing every chat to a model the environment
 * cannot serve.
 *
 * Both checks matter, and for different reasons. An unknown id is a typo. A
 * KNOWN id with no deployment is the more dangerous mistake: it passes the
 * name check, gets written onto every new thread, and then
 * `resolveModelAndLimits` throws "Missing deployment configuration" on every
 * single turn — a 500 per chat that reads like a chat bug rather than a
 * missing app setting. So a candidate has to be deployed here too, as long as
 * there is a deployed alternative to fall back to.
 *
 * NOTE: this is a server-side env var, so it is NOT inlined into the client
 * bundle; a browser evaluating this module sees CODE_DEFAULT_MODEL. That is
 * harmless because the picker takes its default from /api/models (server) and
 * the route re-resolves the effective model server-side on every turn.
 */
export function resolveDefaultModel(
  raw: string | undefined = process.env.DEFAULT_MODEL_ID,
): ChatModel {
  const candidate = raw?.trim();
  if (!candidate) return CODE_DEFAULT_MODEL;
  if (!Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, candidate)) {
    logError("DEFAULT_MODEL_ID is not a known model id — ignoring", {
      value: candidate,
      fallback: CODE_DEFAULT_MODEL,
    });
    return CODE_DEFAULT_MODEL;
  }
  if (!isDeployedModel(candidate as ChatModel)) {
    // Falling back is only an improvement if the code default can actually
    // serve a turn. When it cannot either — a bare environment, or one that
    // deploys neither — there is nothing better to offer, so honour the
    // configured id and let the loud log be the signal.
    if (isDeployedModel(CODE_DEFAULT_MODEL)) {
      logError("DEFAULT_MODEL_ID has no deployment in this environment — ignoring", {
        value: candidate,
        fallback: CODE_DEFAULT_MODEL,
      });
      return CODE_DEFAULT_MODEL;
    }
    logError(
      "DEFAULT_MODEL_ID has no deployment, and neither does the code default — honouring it anyway",
      { value: candidate, codeDefault: CODE_DEFAULT_MODEL },
    );
  }
  return candidate as ChatModel;
}

export const DEFAULT_MODEL: ChatModel = resolveDefaultModel();

/** Models the user can't currently select (e.g. over budget), with the reason. */
export type DisabledModels = Partial<Record<ChatModel, { reason: string }>>;

export interface ModelAvailability {
  availableModels: Record<ChatModel, ModelConfig>;
  disabledModels: DisabledModels;
}

/**
 * Fetches both the selectable models and any currently-disabled ones (with a
 * reason, e.g. a budget cap) in a single call. Falls back to all models /
 * nothing-disabled if the API is unreachable.
 */
export async function getModelAvailability(): Promise<ModelAvailability> {
  try {
    const response = await fetch('/api/models');
    if (!response.ok) {
      throw new Error('Failed to fetch model availability');
    }
    const data = await response.json();
    return {
      availableModels: data.availableModels,
      disabledModels: data.disabledModels ?? {},
    };
  } catch (error) {
    logError("Error fetching model availability", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { availableModels: MODEL_CONFIGS, disabledModels: {} };
  }
}

/**
 * Fetches available models from the server API
 * This is necessary because environment variables are only accessible on the server side
 */
export async function getAvailableModels(): Promise<Record<ChatModel, ModelConfig>> {
  try {
    const response = await fetch('/api/models');
    if (!response.ok) {
      throw new Error('Failed to fetch available models');
    }
    const data = await response.json();
    return data.availableModels;
  } catch (error) {
    logError("Error fetching available models", { 
      error: error instanceof Error ? error.message : String(error) 
    });
    // Fallback to all models if API fails
    return MODEL_CONFIGS;
  }
}

/**
 * Fetches available model IDs from the server API
 */
export async function getAvailableModelIds(): Promise<ChatModel[]> {
  try {
    const response = await fetch('/api/models');
    if (!response.ok) {
      throw new Error('Failed to fetch available models');
    }
    const data = await response.json();
    return data.availableModelIds;
  } catch (error) {
    logError("Error fetching available model IDs", { 
      error: error instanceof Error ? error.message : String(error) 
    });
    // Fallback to all model IDs if API fails
    return Object.keys(MODEL_CONFIGS) as ChatModel[];
  }
}

/**
 * Fetches the default model from the server API
 */
export async function getDefaultModel(): Promise<ChatModel> {
  try {
    const response = await fetch('/api/models');
    if (!response.ok) {
      throw new Error('Failed to fetch default model');
    }
    const data = await response.json();
    return data.defaultModel;
  } catch (error) {
    logError("Error fetching default model", { 
      error: error instanceof Error ? error.message : String(error) 
    });
    return DEFAULT_MODEL;
  }
}

/**
 * Checks if a specific model is available by fetching from server API
 */
export async function isModelAvailable(modelId: ChatModel): Promise<boolean> {
  try {
    const availableModels = await getAvailableModels();
    return !!availableModels[modelId];
  } catch (error) {
    logError("Error checking model availability", { 
      modelId,
      error: error instanceof Error ? error.message : String(error) 
    });
    // Fallback to checking if model exists in config
    return !!MODEL_CONFIGS[modelId];
  }
}

export interface ChatMessageModel {
  id: string;
  createdAt: Date;
  isDeleted: boolean;
  threadId: string;
  userId: string;
  content: string;
  role: ChatRole;
  name: string;
  multiModalImage?: string;
  multiModalImages?: string[];
  reasoningContent?: string;
  /**
   * Wall-clock the model spent reasoning this turn, in milliseconds. Measured
   * server-side in the /api/chat onChunk timer and round-tripped via the
   * message-adapter so the UI's "Thought for Ns" label survives a reload.
   */
  reasoningDurationMs?: number;
  toolCallHistory?: Array<{ name: string; arguments: string; result?: string; timestamp: Date }>;
  /**
   * Ordered layout of the assistant turn's UIMessage parts, including the
   * step boundaries the AI SDK emitted live. Without it a rehydrated turn is
   * rebuilt as one single step — `[text, tool-call…]` — while the live turn
   * was `[tool-call] / [result] / [text]`, so convertToModelMessages produces
   * a DIFFERENT model-message sequence for the same turn and the next request
   * has no cached prefix to match.
   *
   * Entries: "step-start" | "reasoning" | "text:<charCount>" |
   * "tool:<toolCallId>". Text is stored as lengths because the row's
   * `content` is the loss-free concatenation of the turn's text parts, so the
   * per-step slices can be cut back out of it.
   *
   * Absent on rows written before this existed — those keep the old rebuild.
   */
  stepLayout?: string[];
  type: typeof MESSAGE_ATTRIBUTE;
  reasoningState?: any;
  /**
   * Stable identifier for the conversational turn this row belongs to.
   * One turn = one user submission + the assistant message + any tool
   * rows generated during it. Allows:
   *   - atomic-turn persistence detection (partial turns are findable)
   *   - turn-level cost rollup
   * Optional for backward compatibility with rows written before this
   * field existed; absence means "pre-turnId data".
   */
  turnId?: string;
  /**
   * Position of this row inside its turn, strictly increasing in the order
   * the rows were produced (assistant text, then each tool call/result).
   * Cosmos rows of one turn are written in a single batch and routinely share
   * a `createdAt` down to the millisecond, so createdAt alone cannot order
   * them; the history loader orders by createdAt, then sequence, then id.
   *
   * Starts at 1 — 0 is left to the user row, which is written separately by
   * loadThreadContext before the turn runs. Optional for backward
   * compatibility: rows written before this field existed have no sequence
   * and keep sorting by createdAt/id alone.
   */
  sequence?: number;
}

export type ChatRole = "system" | "user" | "assistant" | "function" | "tool" | "reasoning";

export type AttachedFileType = "code-interpreter" | "search-indexed";

export interface AttachedFileModel {
  id: string;
  name: string;
  type: AttachedFileType;
  uploadedAt?: Date;
}

export interface ThreadUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCostUsd: number;
  lastUpdated: string;
  // Most-recent turn's token counts. Persisted so a reloaded thread can show
  // the same "Last input/output" the header showed live, instead of 0.
  // Optional for backward compatibility with rows written before this existed.
  /**
   * TURN TOTAL input tokens of the most recent turn: the sum over every step,
   * which is what was billed. NOT the size of the last prompt — see
   * `lastPromptTokens`.
   */
  lastInputTokens?: number;
  lastOutputTokens?: number;
  lastCachedTokens?: number;
  /**
   * LAST-STEP PROMPT SIZE of the most recent turn: the real `inputTokens` of
   * that turn's final step, i.e. how big the last prompt actually was.
   *
   * Kept apart from `lastInputTokens` because AI SDK 7 rolls step usage up
   * ("When there are multiple steps, the usage is the sum of all step usages")
   * and a tool turn therefore bills several prompts while only ever sending
   * one at a time. This is the field the context row shows and the history
   * budget compares against.
   *
   * Absent on rows written before it existed. Readers fall back to
   * `lastInputTokens`, which is exact for a single-step turn and OVERSTATES a
   * multi-step one by roughly the number of steps.
   */
  lastPromptTokens?: number;
  /**
   * Cache WRITE tokens of the most recent turn. Persisted alongside the reads
   * so the header's cache row survives a reload: without it a reloaded thread
   * showed reads and a "plain" figure that silently included the writes, which
   * are the expensive ones (1.25x uncached input on GPT-5.6 and Claude).
   */
  lastCacheWriteTokens?: number;
}

export interface DefaultTools {
  webSearch?: boolean;
  imageGeneration?: boolean;
  companyContent?: boolean;
  codeInterpreter?: boolean;
}

export interface ChatThreadModel {
  id: string;
  name: string;
  createdAt: Date;
  lastMessageAt: Date;
  userId: string;
  useName: string;
  isDeleted: boolean;
  bookmarked: boolean;
  personaMessage: string;
  personaMessageTitle: string;
  extension: string[];
  type: typeof CHAT_THREAD_ATTRIBUTE;
  personaDocumentIds: string[];
  selectedModel?: ChatModel;
  reasoningEffort?: ReasoningEffort;
  isTemporary?: boolean;
  codeInterpreterContainerId?: string;
  codeInterpreterFileIdsSignature?: string;
  attachedFiles?: Array<AttachedFileModel>;
  subAgentIds?: string[];
  usage?: ThreadUsage;
  defaultTools?: DefaultTools;
  /**
   * Conversation intent, classified once at title-creation time and sticky
   * thereafter. Drives intent-based model downgrade (see model-selection.ts /
   * downgrade-config.ts). Absent on threads created before this field existed.
   */
  intent?: ChatIntent;
  /**
   * Id of the agent (persona) this thread was started from. Absent on
   * default/extension/temporary chats and on threads created before this
   * field existed. Used to attribute per-agent usage statistics.
   */
  personaId?: string;
}

export interface UserPrompt {
  id: string; // thread id
  message: string;
  // Back-compat: single image
  multimodalImage?: string;
  // Preferred: multiple images
  multimodalImages?: string[];
  selectedModel?: ChatModel;
  reasoningEffort?: ReasoningEffort;
  webSearchEnabled?: boolean;
  imageGenerationEnabled?: boolean;
  companyContentEnabled?: boolean;
  codeInterpreterEnabled?: boolean;
  codeInterpreterFileIds?: string[];
  // ISO 8601 datetime from the user's browser, including the local UTC offset
  // (e.g. "2026-05-29T19:40:00.123+02:00"). Forwarded to the built-in `time`
  // tool so the model can answer questions in the user's local time rather
  // than the server's (typically UTC) clock.
  clientDateTime?: string;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/**
 * Effort levels a provider will actually accept. Superset of the four values
 * the picker offers: GPT-5.6 also takes "none" / "xhigh" / "max" and GPT-5.5
 * takes "none" / "xhigh". Kept separate from ReasoningEffort so widening what
 * a deployment may configure does not widen what the UI has to render.
 */
export type ProviderReasoningEffort =
  | ReasoningEffort
  | "none"
  | "xhigh"
  | "max";

/** Levels accepted when a ModelConfig names none — the picker's own set. */
export const DEFAULT_REASONING_EFFORT_LEVELS: ReadonlyArray<ProviderReasoningEffort> =
  ["minimal", "low", "medium", "high"];

/**
 * The levels the effort picker may show for a model, in the picker's own
 * order: its four options, minus anything the model's provider does not
 * accept.
 *
 * Filtering rather than trusting the UI's list is the whole point. The picker
 * offered "minimal" to every reasoning model, but no GPT-5.5 or 5.6
 * deployment accepts it — a user selecting it pinned the value on the thread
 * and every later turn answered 400 until they changed it back. A level the
 * provider rejects must not be selectable.
 *
 * Client-safe: a pure filter over MODEL_CONFIGS with no logging and no
 * server-only import, so the selector component can call it directly.
 */
export function getPickableReasoningEfforts(
  modelId: ChatModel | undefined,
): ReadonlyArray<ReasoningEffort> {
  const supported = modelId
    ? MODEL_CONFIGS[modelId]?.supportedReasoningEfforts
    : undefined;
  if (!supported) return DEFAULT_REASONING_EFFORT_LEVELS as ReadonlyArray<ReasoningEffort>;
  return (DEFAULT_REASONING_EFFORT_LEVELS as ReadonlyArray<ReasoningEffort>).filter(
    (level) => supported.includes(level),
  );
}

/**
 * The level to USE for a model, given one that was asked for. An effort the
 * model does not accept maps to "low" — the cheapest level every reasoning
 * model in the table does accept, and the one the code fell back to anyway
 * before any of this was configurable.
 *
 * Mapping rather than passing it through is a change of position, and the
 * reason is measurement: `resolveReasoningEffort` used to argue that
 * "silently rewriting someone's explicit choice is worse than passing it on".
 * It is not, when passing it on is an HTTP 400 on every turn of the thread.
 */
export function clampReasoningEffort(
  modelId: ChatModel | undefined,
  effort: ProviderReasoningEffort,
): ProviderReasoningEffort {
  const supported = modelId
    ? MODEL_CONFIGS[modelId]?.supportedReasoningEfforts
    : undefined;
  const levels = supported ?? DEFAULT_REASONING_EFFORT_LEVELS;
  return levels.includes(effort) ? effort : "low";
}

/**
 * Coarse conversation-intent classes used for intent-based model downgrade.
 * "general" is the safe catch-all (never downgraded). Classified once at
 * title time; see chat-api-text.ts ChatApiTitleAndIntent + downgrade-config.ts.
 */
export type ChatIntent =
  | "coding"
  | "translation"
  | "summarization"
  | "data_analysis"
  | "creative"
  | "general";

export interface ChatDocumentModel {
  id: string;
  name: string;
  chatThreadId: string;
  userId: string;
  isDeleted: boolean;
  createdAt: Date;
  type: typeof CHAT_DOCUMENT_ATTRIBUTE;
}

export interface ToolsInterface {
  name: string;
  description: string;
  parameters: any;
}

export type MenuItemsGroupName = "Bookmarked" | "Past 7 days" | "Previous";

export type MenuItemsGroup = {
  groupName: MenuItemsGroupName;
} & ChatThreadModel;

export type ChatCitationModel = {
  id: string;
  content: any;
  userId: string;
  type: typeof CHAT_CITATION_ATTRIBUTE;
};

export type AzureChatCompletionFunctionCall = {
  type: "functionCall";
  response: ChatCompletionMessage.FunctionCall;
};

export type AzureChatCompletionFunctionCallResult = {
  type: "functionCallResult";
  response: string;
};

export type AzureChatCompletionContent = {
  type: "content";
  response: any; // This will be the streaming snapshot from OpenAI
};

export type AzureChatCompletionFinalContent = {
  type: "finalContent";
  response: string;
};

export type AzureChatCompletionError = {
  type: "error";
  response: string;
};

export type AzureChatCompletionAbort = {
  type: "abort";
  response: string;
};

export type AzureChatCompletionReasoning = {
  type: "reasoning";
  response: string;
};

export interface UsageDataResponse {
  /** TURN TOTAL: summed over every step of the last request. */
  inputTokens: number;
  /** TURN TOTAL: summed over every step of the last request. */
  outputTokens: number;
  /** TURN TOTAL: summed over every step of the last request. */
  cachedTokens: number;
  /**
   * Input tokens the provider WROTE into the prompt cache this turn. Optional
   * because the persisted thread usage a reloaded page seeds from does not
   * track writes; the live path always supplies it.
   */
  cacheWriteTokens?: number;
  totalTokens: number;
  costUsd: number;
  threadTotalCostUsd: number;
  threadTotalTokens: number;
  /**
   * LAST-STEP PROMPT SIZE of the last request — the real size of the last
   * prompt sent, which is what the context row means by "context". Optional so
   * a thread seeded from a row written before it existed still renders; those
   * readers fall back to `inputTokens`, which overstates a multi-step turn.
   */
  lastPromptTokens?: number;
  /**
   * Model calls the last request made. Present on the live path; absent for a
   * thread seeded from persisted usage, because it is not persisted.
   */
  stepCount?: number;
  contextWindowSize: number;
  /** Share of the context window the LAST PROMPT filled. */
  contextUsagePercent: number;
  model: string;
}

export type AzureChatCompletionUsageData = {
  type: "usageData";
  response: UsageDataResponse;
};

export type AzureChatCompletionUsageWarning = {
  type: "usageWarning";
  response: {
    message: string;
    originalModel: string;
    fallbackModel: string;
    limitType: "tokens" | "cost";
    currentUsage: number;
    limit: number;
  };
};

export type AzureChatCompletion =
  | AzureChatCompletionError
  | AzureChatCompletionFunctionCall
  | AzureChatCompletionFunctionCallResult
  | AzureChatCompletionContent
  | AzureChatCompletionFinalContent
  | AzureChatCompletionAbort
  | AzureChatCompletionReasoning
  | AzureChatCompletionUsageData
  | AzureChatCompletionUsageWarning;

// https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/read?view=doc-intel-4.0.0&tabs=sample-code#input-requirements-v4
export enum SupportedFileExtensionsDocumentIntellicence {
  JPEG = "JPEG",
  JPG = "JPG",
  PNG = "PNG",
  BMP = "BMP",
  TIFF = "TIFF",
  HEIF = "HEIF",
  DOCX = "DOCX",
  XLSX = "XLSX",
  PPTX = "PPTX",
  HTML = "HTML",
  PDF = "PDF",
}

// https://platform.openai.com/docs/guides/images?api-mode=responses#image-input-requirements
export enum SupportedFileExtensionsInputImages{
  JPEG = "JPEG",
  JPG = "JPG",
  PNG = "PNG",
  WEBP = "WEBP"
}

export enum SupportedFileExtensionsTextFiles {
  TXT = "TXT",
  LOG = "LOG",
  CSV = "CSV",
  MD = "MD",
  RTF = "RTF",
  HTML = "HTML",
  HTM = "HTM",
  CSS = "CSS",
  JS = "JS",
  JSON = "JSON",
  XML = "XML",
  YML = "YML",
  YAML = "YAML",
  PHP = "PHP",
  PY = "PY",
  JAVA = "JAVA",
  C = "C",
  H = "H",
  CPP = "CPP",
  HPP = "HPP",
  TS = "TS",
  SQL = "SQL",
  INI = "INI",
  CONF = "CONF",
  ENV = "ENV",
  TEX = "TEX",
  SH = "SH",
  BAT = "BAT",
  PS1 = "PS1",
  GITIGNORE = "GITIGNORE",
  GRADLE = "GRADLE",
  GROOVY = "GROOVY",
  MAKEFILE = "MAKEFILE",
  MK = "MK",
  PLIST = "PLIST",
  TOML = "TOML",
  RC = "RC",
}
