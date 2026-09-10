/**
 * /api/chat — AI SDK 7 streamText route.
 *
 * Built-in Azure server-side tools (code_interpreter, image_generation,
 * web_search_preview) ARE exposed by @ai-sdk/azure v4 via azure.tools.*
 * — confirmed from node_modules/@ai-sdk/azure/dist/index.d.ts which re-exports
 * them from @ai-sdk/openai/internal as azureOpenaiTools, accessible as
 * azure.tools.codeInterpreter / .imageGeneration / .webSearchPreview.
 * Included conditionally based on ctx.defaultTools toggles.
 */

import {
  streamText,
  convertToModelMessages,
  isStepCount,
  createIdGenerator,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import type { StepResult, ToolSet } from "ai";
import {
  validateCodeInterpreterFileIds,
  validateMultimodalInput,
} from "@/features/chat-page/chat-services/chat-api/validate-input";
import { resolveModelAndLimits } from "@/features/chat-page/chat-services/chat-api/model-selection";
import { compactionDonePart } from "@/features/chat-page/chat-services/chat-api/compaction-part";
import { recordHistoryCompactionRealUsage } from "@/features/chat-page/chat-services/chat-api/history-summary-service";
import {
  loadThreadContext,
  applyDocumentHintPlacement,
} from "@/features/chat-page/chat-services/chat-api/thread-context";
import { persistAssistantFromFinishEvent } from "@/features/chat-page/chat-services/chat-api/persist-assistant";
import { consumeRateLimitToken } from "@/features/chat-page/chat-services/chat-api/rate-limit";
import { resolveRateLimitSubject } from "@/features/chat-page/chat-services/chat-api/rate-limit-subject";
import { createSandboxUrlTransform } from "@/features/chat-page/chat-services/chat-api/sandbox-url-transform";
import { createImageGenerationStreamRewriter } from "@/features/chat-page/chat-services/chat-api/image-generation-stream-rewriter";
import { createCodeInterpreterStreamRewriter } from "@/features/chat-page/chat-services/chat-api/code-interpreter-stream-rewriter";
import { resolveProvider, getFileIdsSignature } from "@/features/chat-page/chat-services/models/provider-seam";
import { resolveMaxOutputTokens } from "@/features/chat-page/chat-services/models/max-output-tokens";
import { ensureCodeInterpreterContainer } from "@/features/chat-page/chat-services/code-interpreter-container";
import { computeRequestUsage, type ChatMessageMetadata } from "@/features/chat-page/chat-services/chat-api/usage-data";
import {
  UpdateChatTitle,
  UpdateChatThreadCodeInterpreterContainer,
} from "@/features/chat-page/chat-services/chat-thread-service";
import { buildToolset, repairExtensionToolCall } from "@/features/chat-page/chat-services/tools/registry";
import { stabilizeToolset } from "@/features/chat-page/chat-services/tools/stabilize-toolset";
import {
  startPublisher,
  unregisterPublisher,
} from "@/features/chat-page/chat-services/chat-api/stream-publisher";
import { enforceSameOriginRequest } from "@/features/chat-page/chat-services/chat-api/same-origin";
import {
  buildSystemMessage,
  withAnthropicPromptCache,
  withPromptCacheBreakpoint,
} from "@/features/chat-page/chat-services/chat-api/prompt-builder";
import { resolvePromptCacheKey } from "@/features/chat-page/chat-services/models/prompt-cache-key";
import { CHAT_DEFAULT_SYSTEM_PROMPT } from "@/features/theme/theme-config";
import {
  FindAllExtensionForCurrentUserAndIds,
  FindSecureHeaderValue,
} from "@/features/extensions-page/extension-services/extension-service";
import { logError, logInfo, logWarn } from "@/features/common/services/logger";
import { type UserPrompt } from "@/features/chat-page/chat-services/models";

// Allow streaming responses to run for up to 10 minutes (600 seconds)
export const maxDuration = 600;

/**
 * Distill a useful error message from a stream event when AI SDK reports
 * `finishReason: "error"` without firing `onError`. Mines two sources:
 * `event.warnings` (the AI SDK's CallWarning array) and
 * `event.providerMetadata` (provider-specific error payload under
 * `openai` / `azure`). Returns null when neither carries anything usable.
 */
function reconstructStreamError(
  event: {
    warnings?: ReadonlyArray<{ message?: string } | unknown>;
    providerMetadata?: Record<string, Record<string, unknown>>;
  },
): { message: string; name: string } | null {
  const provider = event.providerMetadata;
  const providerError =
    provider?.openai?.error ?? provider?.azure?.error;
  const providerErrorMessage =
    typeof providerError === "string"
      ? providerError
      : (providerError as { message?: string } | undefined)?.message;
  const warningMessages = (event.warnings ?? [])
    .map((w) => (w as { message?: string } | undefined)?.message)
    .filter((m): m is string => typeof m === "string" && m.length > 0)
    .join("; ");
  const synthesized = providerErrorMessage || warningMessages;
  return synthesized ? { message: synthesized, name: "ProviderError" } : null;
}

/**
 * Walks the AI SDK step results looking for a code_interpreter tool call
 * and returns its containerId. Built-in Azure tools aren't in our
 * `ToolSet`, so the part's `input` is typed `never` after the discriminant
 * narrow — we widen back to the Responses-API shape locally rather than
 * polluting the route's ToolSet declaration.
 */
function harvestCodeInterpreterContainerId(
  steps: ReadonlyArray<StepResult<ToolSet>>,
): string | undefined {
  for (const step of steps) {
    for (const part of step.content) {
      if (part.type !== "tool-call" && part.type !== "tool-result") continue;
      if (part.toolName !== "code_interpreter") continue;
      const input = (part as { input?: { containerId?: unknown } }).input;
      const containerId = input?.containerId;
      if (typeof containerId === "string" && containerId.length > 0) {
        return containerId;
      }
    }
  }
  return undefined;
}

// Hard upper bound on the multipart body. validateMultimodalInput enforces a
// 20MB per-image cap, but a max of 16 images × 20MB = 320MB still arrives in
// memory before per-image checks run. The cap below short-circuits that path.
const MAX_REQUEST_BYTES = 50 * 1024 * 1024;

export async function POST(req: Request) {
  // CSRF defense: reject cross-origin POSTs. See same-origin.ts.
  const originCheck = enforceSameOriginRequest(req);
  if (originCheck) return originCheck;

  // Body-size guard. experimental.serverActions.bodySizeLimit covers only
  // Server Actions, NOT route handlers — without this check a single
  // multipart upload can pin a container with hundreds of MB before the
  // per-image validator runs.
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return new Response("Request body too large", { status: 413 });
  }

  // Cost-bomb defense: token bucket keyed on a "subject" abstraction so
  // we can swap to per-org or per-tenant limits without touching this
  // handler (architect2 SEV-2 B11). Refuse before doing any Cosmos
  // reads or LLM provisioning so a runaway client can't pin the
  // container with cheap work either.
  let rateLimitKey: string;
  try {
    rateLimitKey = await resolveRateLimitSubject();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const rateLimit = consumeRateLimitToken(rateLimitKey);
  if (rateLimit.allowed === false) {
    return new Response("Rate limit exceeded", {
      status: 429,
      headers: { "retry-after": String(rateLimit.retryAfterSeconds) },
    });
  }

  const form = await req.formData();
  const images = form
    .getAll("image-base64")
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  const validation = validateMultimodalInput(images);
  if (validation.ok === false) {
    return new Response(validation.error, { status: validation.status });
  }

  const payload: UserPrompt = {
    ...JSON.parse(form.get("content") as string),
    multimodalImages: images,
    multimodalImage: images[0] ?? "",
  };

  const codeInterpreterFilesValidation = validateCodeInterpreterFileIds(
    payload.codeInterpreterFileIds
  );
  if (codeInterpreterFilesValidation.ok === false) {
    return new Response(codeInterpreterFilesValidation.error, {
      status: codeInterpreterFilesValidation.status,
    });
  }

  let ctx: Awaited<ReturnType<typeof loadThreadContext>>;
  try {
    ctx = await loadThreadContext(payload);
  } catch (err) {
    logError("/api/chat: loadThreadContext failed", {
      error: err,
      message: err instanceof Error ? err.message : String(err),
    });
    const status = (err as { status?: number })?.status ?? 500;
    return new Response(
      status === 401 ? "Unauthorized" : "Failed to load thread context",
      { status },
    );
  }

  // `effectiveModel` is the model that will actually run after limit/cap and
  // intent downgrades — NOT necessarily payload.selectedModel. `modelConfig`
  // is the config for that same effective model (invariant:
  // modelConfig.id === effectiveModel), so cost, reasoning support, and the
  // provider seam must all be driven from these, never re-derived from the
  // raw payload/thread (doing so was the bug where a downgrade changed cost
  // but not the model that actually ran).
  const { modelConfig, fallbackInfo, effectiveReasoningEffort, selectedModel: effectiveModel } =
    await resolveModelAndLimits(payload, ctx.thread);

  // The document hint's placement follows the EFFECTIVE model's provider, not
  // the thread's. loadThreadContext could only guess from thread.selectedModel
  // because the model resolution above needs the thread it returns; this turn's
  // picker or a cap/intent downgrade can land on another provider entirely.
  // Getting it wrong sends a mid-conversation system message to Claude, which
  // is the one placement the Azure /anthropic surface may reject outright.
  // Idempotent, and a no-op when the two already agree.
  ctx = applyDocumentHintPlacement(ctx, modelConfig.provider);
  if (ctx.documentHintPlacement !== "none") {
    logInfo("/api/chat document hint placement", {
      threadId: ctx.thread.id,
      threadModel: ctx.thread.selectedModel,
      effectiveModel,
      placement: ctx.documentHintPlacement,
    });
  }

  // Resolve effective tool toggles up-front: per-request payload overrides the
  // thread's persisted defaultTools (the request body is the authoritative
  // user intent for this turn, since the UI toggles update local state and
  // may not have been persisted to the thread yet). Needed early so the
  // system prompt can add tool-specific instructions (e.g. image_generation
  // → embed result inline as markdown image).
  const effectiveTools = {
    codeInterpreter:
      payload.codeInterpreterEnabled ?? ctx.defaultTools?.codeInterpreter ?? false,
    imageGeneration:
      payload.imageGenerationEnabled ?? ctx.defaultTools?.imageGeneration ?? false,
    webSearch:
      payload.webSearchEnabled ?? ctx.defaultTools?.webSearch ?? false,
  };

  // Gate built-in tools by what the effective model's provider can actually
  // host. The provider seam owns the concrete tool wiring; here we only decide
  // which toggles to forward:
  //   - azure (Responses API): all built-ins (code_interpreter / image_gen /
  //     web_search).
  //   - anthropic (Messages API): web search maps to Claude's NATIVE web-search
  //     tool. Code execution / image gen are NOT forwarded yet (code execution
  //     needs the separate Anthropic Files API — deferred).
  //   - foundry (Chat Completions): no server tools; the seam ignores toggles.
  // Custom registry tools (RAG, sub-agents, extensions) are unaffected.
  const effectiveToolsSafe = modelConfig.supportsResponsesAPI
    ? effectiveTools
    : modelConfig.provider === "anthropic"
      ? { codeInterpreter: false, imageGeneration: false, webSearch: effectiveTools.webSearch }
      : { codeInterpreter: false, imageGeneration: false, webSearch: false };
  const strippedToolNames = (Object.keys(effectiveTools) as (keyof typeof effectiveTools)[])
    .filter((k) => effectiveTools[k] && !effectiveToolsSafe[k]);
  if (strippedToolNames.length > 0) {
    logWarn("/api/chat stripped built-in tools the effective model can't host", {
      effectiveModel,
      strippedToolNames,
    });
  }

  // ── prompt prefix assembly (cache-stability critical) ──────────────────
  // The generative-UI block is process-constant, so it is handed to
  // buildSystemMessage as `trailingStaticBlock` instead of being concatenated
  // after the call. That lets the builder keep the per-thread `documentHint`
  // in final position — see the ORDERING note in prompt-builder.ts.
  const system =
    buildSystemMessage({
      staticSystemPrompt: CHAT_DEFAULT_SYSTEM_PROMPT,
      personaMessage: ctx.thread.personaMessage ?? "",
      documentHint: ctx.documentHint,
      trailingStaticBlock:
        // Generative UI: GPT-5.5 reliably declines a UI *tool* under tool_choice
        // auto (it prefers to emit markdown), but it WILL emit a fenced code block.
        // So we instruct it to emit a json-render spec as a ```genui block, which
        // rich-response renders as a real Bühler card (see components/ai-elements).
        "\n\n## Interactive UI (generative UI)\n" +
        "When the user asks for a dashboard, metrics/KPIs, a comparison, a table, or a chart — or whenever numeric/structured data is clearer shown visually — render it as an interactive card by emitting a fenced code block whose language tag is `genui`, containing a json-render spec. Do NOT render that content as a markdown table.\n" +
        'The spec is a FLAT object: { "root": "<id>", "elements": { "<id>": { "type": <Component>, "props": { … }, "children": ["<childId>"] } } }. `children` is an array of element ids; `root` is the top element id.\n' +
        "Component types and props: Stack { direction: 'col' | 'row' }; Card { title?, description? }; Stat { label, value, delta?, trend?: 'up' | 'down' | 'flat' }; Badge { label, tone?: 'default' | 'success' | 'warning' | 'destructive' }; Table { columns: string[], rows: string[][] }; Text { content, muted? }; Chart { kind?: 'line' | 'bar', title?, data: { label: string, value: number }[] }.\n" +
        "A short markdown sentence alongside the ```genui block is fine.",
    });
  // ── end prompt prefix assembly ─────────────────────────────────────────

  // Resolve extension IDs → full objects with header secrets for buildToolset
  type ResolvedExt = Parameters<typeof buildToolset>[0]["extensions"][number];
  const resolvedExtensions: ResolvedExt[] = [];
  if (ctx.extensions.length > 0) {
    const extResp = await FindAllExtensionForCurrentUserAndIds(ctx.extensions);
    if (extResp.status === "OK") {
      // FindAllExtensionForCurrentUserAndIds is deliberately over-broad
      // (isPublished=true OR userId=@userId OR id IN @ids) so it can resolve
      // publisher-owned extensions the current user doesn't own. That means
      // it can return every published/owned extension the user has access
      // to, not just the ones configured on this thread. Narrow back down to
      // exactly ctx.extensions (the thread's configured extension ids) so an
      // agent/persona only gets the tools it was actually wired with.
      const configuredExtensions = extResp.response.filter((e) =>
        ctx.extensions.includes(e.id)
      );
      for (const ext of configuredExtensions) {
        const headerSecrets: Record<string, string> = {};
        for (const h of ext.headers) {
          const v = await FindSecureHeaderValue(h.id);
          if (v.status === "OK") headerSecrets[h.key] = v.response;
          else logWarn("/api/chat: failed to resolve extension header", { headerId: h.id });
        }
        resolvedExtensions.push({ extension: ext as ResolvedExt["extension"], headerSecrets });
      }
    }
  }

  const tools = await buildToolset({
    user: ctx.user.id,
    threadId: ctx.thread.id,
    threadDocumentIds: ctx.threadDocumentIds,
    personaDocumentIds: ctx.personaDocumentIds,
    defaultTools: ctx.defaultTools ?? {},
    extensions: resolvedExtensions,
    subAgentIds: ctx.thread.subAgentIds,
    // Browser-local datetime for the get_current_time tool (server UTC fallback).
    clientDateTime: req.headers.get("x-client-datetime") ?? undefined,
    depth: 0,
  });

  // Code-interpreter file IDs the user attached this turn. The chat-store
  // sends them as `codeInterpreterFileIds` (OpenAI file IDs from
  // /api/code-interpreter/upload). When this set differs from the
  // persisted signature, the previous Azure container's files no longer
  // match user intent — invalidate so the provider seam asks Azure to
  // mint a fresh container with `container: { fileIds }`. Without this
  // the route used to (and now again does) ignore attached files,
  // surfacing as "I don't have this file" from the model.
  const requestedCiFileIds = payload.codeInterpreterFileIds ?? [];
  const requestedCiSignature = getFileIdsSignature(requestedCiFileIds);
  const persistedCiSignature = ctx.thread.codeInterpreterFileIdsSignature ?? "";
  const ciFilesChanged = requestedCiSignature !== persistedCiSignature;
  if (effectiveToolsSafe.codeInterpreter && ciFilesChanged) {
    try {
      await UpdateChatThreadCodeInterpreterContainer(
        ctx.thread.id,
        "",
        requestedCiSignature,
      );
      ctx.thread.codeInterpreterContainerId = undefined;
      ctx.thread.codeInterpreterFileIdsSignature = requestedCiSignature;
      logInfo("/api/chat invalidated code_interpreter container", {
        threadId: ctx.thread.id,
        previousSignature: persistedCiSignature,
        newSignature: requestedCiSignature,
        fileCount: requestedCiFileIds.length,
      });
    } catch (err) {
      logError("/api/chat failed to invalidate code_interpreter container", {
        threadId: ctx.thread.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Prompt-cache prefix stability for code_interpreter. The tool definition
  // is part of the cached prefix, and it used to change between turn 1
  // (container: {} or { fileIds }) and turn 2 (container: "<harvested id>"),
  // so a code-interpreter thread could never match its own cached prefix.
  // Creating the container BEFORE the first model call puts the id in the
  // definition from turn 1 onwards. If creation fails we keep the old
  // bootstrap-then-harvest path, which still works.
  // Runs on EVERY code-interpreter turn, not only the first. The guard here
  // used to be `&& !ctx.thread.codeInterpreterContainerId`, which meant a
  // thread that once had a container never checked it again — so once Azure
  // reclaimed it, every later turn declared a dead id and failed on
  // "Container is expired." with no way out. ensureCodeInterpreterContainer
  // now validates a stored id and replaces it only when it has really gone,
  // so the steady state is still one container per thread and one stable tool
  // definition.
  if (effectiveToolsSafe.codeInterpreter) {
    const containerId = await ensureCodeInterpreterContainer({
      threadId: ctx.thread.id,
      existingContainerId: ctx.thread.codeInterpreterContainerId,
      fileIds: requestedCiFileIds,
    });
    // Nothing to do when the id is unchanged: it is already on the thread and
    // already persisted. Only a new or replaced container needs a write.
    if (containerId && containerId !== ctx.thread.codeInterpreterContainerId) {
      // Persist BEFORE using it. The id has to survive to the next turn even
      // if the model never calls the tool this turn — otherwise turn 2 mints
      // another container and changes the definition again, which is the
      // instability this pre-creation exists to remove.
      //
      // And if the write fails, the id must NOT go on the wire: an
      // unpersisted id is invisible to the next turn, so every turn would
      // mint one more container. A sustained Cosmos write failure would then
      // be an unbounded container-creation loop with nothing to stop it.
      // Falling back to the old bootstrap-then-harvest shape costs a cache
      // miss; the loop costs money.
      let persisted = false;
      try {
        await UpdateChatThreadCodeInterpreterContainer(
          ctx.thread.id,
          containerId,
          requestedCiSignature,
        );
        persisted = true;
      } catch (err) {
        logError("/api/chat failed to persist pre-created container id", {
          threadId: ctx.thread.id,
          containerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (persisted) {
        ctx.thread.codeInterpreterContainerId = containerId;
      } else {
        logWarn(
          "/api/chat discarding an unpersisted container id for this turn",
          { threadId: ctx.thread.id, containerId },
        );
      }
    }
  }

  // Resolve provider-native parts (model, built-in tools, providerOptions)
  // through the provider seam so Anthropic / future providers slot in
  // without touching this route handler (architect2 SEV-2 B10).
  // Prompt-cache key. Default strategy is the thread id; the "persona"
  // strategy deliberately shares one key across the threads of an agent so
  // the second thread onwards READS the system+tools prefix the first one
  // wrote (measured: same key + same developer message => shared prefix on
  // GPT-5.6). The built-in tool names are derived from the toggles rather
  // than from the resolved seam output because the key has to be known before
  // the seam runs, and the toggle set determines the built-ins one-to-one.
  const cacheKeyToolNames = [
    ...Object.keys(tools),
    ...(effectiveToolsSafe.codeInterpreter ? ["code_interpreter"] : []),
    ...(effectiveToolsSafe.imageGeneration ? ["image_generation"] : []),
    ...(effectiveToolsSafe.webSearch ? ["web_search"] : []),
  ];
  // The shard key must be OPAQUE: prompt_cache_key travels to the provider in
  // the request body, and ctx.user.id is the user's EMAIL address. Reuse the
  // rate-limit subject ("user:<sha256 hashed id>"), which is already resolved
  // at the top of this handler — opaque, stable per user, and no second
  // session lookup.
  const promptCacheKey = resolvePromptCacheKey({
    modelId: effectiveModel,
    threadId: ctx.thread.id,
    personaId: ctx.thread.personaId,
    toolNames: cacheKeyToolNames,
    userKey: rateLimitKey,
  });

  const resolved = resolveProvider({
    modelId: effectiveModel,
    thread: {
      id: ctx.thread.id,
      codeInterpreterContainerId: ctx.thread.codeInterpreterContainerId,
    },
    toggles: effectiveToolsSafe,
    reasoning: {
      supported: modelConfig.supportsReasoning,
      effort: effectiveReasoningEffort,
    },
    codeInterpreterFileIds: requestedCiFileIds,
    promptCacheKey,
  });
  logInfo("/api/chat builtInTools", {
    keys: Object.keys(resolved.builtInTools),
    effectiveTools: effectiveToolsSafe,
  });

  // Cast through `ToolSet` (the AI SDK's public interface) rather than
  // through streamText's parameter type. ToolSet is structurally a
  // Record<string, Tool>; both `tools` (custom registry) and
  // `resolved.builtInTools` (provider-native) satisfy it.
  // One canonical order for the whole toolset — built-ins AND custom tools
  // together. Merging the built-ins onto the (already sorted) custom tools
  // left their position dependent on object insertion order, so the tools
  // array on the wire changed shape whenever a toggle changed which built-ins
  // existed. See stabilize-toolset.ts.
  const allTools = stabilizeToolset(
    {
      ...tools,
      ...resolved.builtInTools,
    },
    Object.keys(resolved.builtInTools),
  ) as ToolSet;

  // Captured by `onError` so the failure cause can flow into onFinish's
  // sentinel row — without this, every provider failure renders as the
  // generic "no content" message, masking real causes (content filter,
  // unsupported tool, auth/quota) from the user.
  let lastStreamError: { message: string; name?: string } | undefined;
  // Set true when onFinish runs. If streamText fails early (e.g. asset
  // download rejected with AI_DownloadError before any chunk lands),
  // onFinish never fires — and without a fallback the thread is left with
  // just a user row, so the UI polls for 60 s and shows "no reply" even
  // though we know what went wrong. The consumeStream catch below uses
  // this flag to write a sentinel as a last-resort.
  let onFinishRan = false;

  // streamText's onAbort fires when the abort signal trips, but the
  // event it hands us only contains finished `steps` — mid-step text
  // deltas live nowhere addressable after abort. Accumulate them via
  // onChunk so the stop endpoint can persist what the user already saw.
  let accumulatedText = "";
  let accumulatedReasoning = "";

  // Reasoning wall-clock: stamp the first reasoning-delta, and close the
  // window at the first text-delta that follows (the model has stopped
  // thinking and started answering). Falls back to the last reasoning-delta
  // if the turn produced no text. Surfaced to the UI as "Thought for Ns" and
  // persisted so the timer survives a reload.
  let reasoningStartedAt: number | null = null;
  let reasoningEndedAt: number | null = null;
  let lastReasoningAt: number | null = null;
  const computeReasoningDurationMs = (): number | undefined => {
    if (reasoningStartedAt === null) return undefined;
    const end = reasoningEndedAt ?? lastReasoningAt ?? reasoningStartedAt;
    return Math.max(0, end - reasoningStartedAt);
  };

  // Register the publisher BEFORE streamText so we can pass abortSignal
  // and so a fast first-chunk doesn't race a late subscriber. The
  // returned AbortController is what POST /api/chat/[id]/stop calls
  // abort() on — req.signal is deliberately NOT forwarded so that a
  // browser tab-switch does not cancel the run (stream-publisher.ts
  // keeps replaying for the next subscriber).
  const { abortController, publish } = startPublisher(ctx.thread.id);

  // Every provider caches a prompt PREFIX and wants the end of the reusable
  // prefix marked with a breakpoint; only the wire field differs, and that
  // detail lives in prompt-builder.ts. What differs per seam is whether a
  // breakpoint is REQUIRED:
  //
  //   anthropic (Claude via the Azure /anthropic Messages API) — required.
  //     Nothing is cached without an explicit cache_control breakpoint, so the
  //     system prompt is always folded into a cached SystemModelMessage and the
  //     latest turn is always marked; the tools+system+history prefix is then
  //     replayed (cache-read) across turns instead of re-billed every turn.
  //   openai / Azure Responses — optional. The seam already gets automatic
  //     prefix caching from promptCacheKey, so the breakpoint only PINS where
  //     the shared unit ends and stays behind a flag (see below).
  // ctx.modelHistory, not ctx.history: it is the same conversation plus the
  // prompt scaffolding (replayed summary, document hint) already in the order
  // the model must see it. ctx.history stays the real conversation for the
  // title check and for originalMessages below.
  const modelMessages = await convertToModelMessages(ctx.modelHistory);
  // PROMPT_CACHE_PERSONA_BREAKPOINT: pin a cache breakpoint at the end of the
  // static developer/system prefix on whichever provider serves the turn, so
  // the system+tools block shared by every thread of an agent is one cache
  // unit. It is a NO-OP on Anthropic — that seam always pins the same
  // breakpoint, flag or not — so the flag only gates the Responses seam, where
  // the mode:"explicit" wire value is still unverified against Azure (see
  // withPromptCacheBreakpoint) and the default is therefore off.
  const usePersonaBreakpoint =
    process.env.PROMPT_CACHE_PERSONA_BREAKPOINT === "true" &&
    modelConfig.provider !== "anthropic" &&
    modelConfig.provider !== "foundry" &&
    modelConfig.promptCacheOptionsSupported === true;
  const streamPrompt =
    modelConfig.provider === "anthropic"
      ? withAnthropicPromptCache(system, modelMessages)
      : usePersonaBreakpoint
        ? withPromptCacheBreakpoint(system, modelMessages)
        : { instructions: system, messages: modelMessages };

  const result = streamText({
    model: resolved.model,
    instructions: streamPrompt.instructions,
    messages: streamPrompt.messages,
    // The prompt carries app-authored system messages INSIDE `messages`: the
    // document-hint tail (thread-context.ts) and the replayed history summary
    // are both `role: "system"` UIMessages, and convertToModelMessages maps
    // them to system ModelMessages at the same index. AI SDK 7 rejects that by
    // default (InvalidPromptError, "System messages are not allowed in the
    // prompt or messages fields") because a system message coming from
    // untrusted, persisted chat data is an injection vector. Ours are neither
    // user-supplied nor round-tripped from the model — the loader builds both
    // from server-side state — and their POSITION is the whole point (the hint
    // has to sit at the prompt tail to stay out of the cached prefix), so they
    // cannot move to `instructions`.
    allowSystemInMessages: true,
    tools: allTools,
    // Per-model ceiling on emitted tokens, via the resolver so the env
    // override applies here and in the sub-agent identically. Reasoning
    // tokens count against it, which is why a turn can finish with
    // finishReason "length" — see the truncation notice in persist-assistant.
    maxOutputTokens: resolveMaxOutputTokens({
      modelId: effectiveModel,
      modelValue: modelConfig.maxOutputTokens,
    }),
    stopWhen: isStepCount(15),
    // Repairs bare, pre-namespacing extension tool names the model may
    // echo from old persisted thread history (see repairExtensionToolCall)
    // instead of letting NoSuchToolError kill the turn.
    repairToolCall: repairExtensionToolCall,
    abortSignal: abortController.signal,
    experimental_transform: (() => {
      // Shared map populated by the code-interpreter rewriter when it
      // persists a data: URL → blob ref; the sandbox text-delta transform
      // consumes it to substitute matching data: URLs the model echoes
      // in its prose.
      const dataUrlToBlobRef = new Map<string, string>();
      return [
        createImageGenerationStreamRewriter(ctx.thread.id),
        createCodeInterpreterStreamRewriter(ctx.thread.id, dataUrlToBlobRef),
        createSandboxUrlTransform(ctx.thread.id, dataUrlToBlobRef),
      ];
    })(),
    providerOptions: resolved.providerOptions,
    onError: ({ error }) => {
      // `Error` objects have non-enumerable `.message` and `.stack`, so
      // logging `{ error }` straight loses everything when the logger
      // JSON-stringifies. Spread the readable fields explicitly so the
      // failure cause actually lands in the log instead of `{}`.
      const e = error as { message?: string; name?: string; stack?: string; cause?: unknown };
      const message = e?.message ?? String(error);
      lastStreamError = { message, name: e?.name };
      logError("/api/chat streamText error", {
        threadId: ctx.thread.id,
        turnId: ctx.turnId,
        message,
        name: e?.name,
        stack: e?.stack,
        cause: e?.cause,
      });
    },
    onChunk: ({ chunk }) => {
      if (chunk.type === "reasoning-delta") {
        const now = Date.now();
        if (reasoningStartedAt === null) reasoningStartedAt = now;
        lastReasoningAt = now;
        accumulatedReasoning += chunk.text;
        return;
      }
      // The first NON-reasoning chunk after thinking began closes the
      // reasoning window — this is when the model stops thinking and starts
      // answering or calling a tool. Closing on text-delta only would fold a
      // 40 s image-generation tool run into the "thinking" time on tool turns;
      // closing on any non-reasoning chunk matches the live Reasoning timer.
      if (reasoningStartedAt !== null && reasoningEndedAt === null) {
        reasoningEndedAt = Date.now();
      }
      if (chunk.type === "text-delta") accumulatedText += chunk.text;
    },
    onAbort: async ({ steps }) => {
      logWarn("/api/chat streamText onAbort fired", {
        threadId: ctx.thread.id,
        textLen: accumulatedText.length,
        stepCount: steps.length,
      });
      // Persist whatever the user already saw. Synthesize an OnFinishEvent
      // shape from the accumulated chunks + any completed-step toolResults
      // so we can reuse the existing persist path. onFinish does NOT fire
      // after an abort, so this is the only place to write the partial.
      onFinishRan = true;
      try {
        const aggregatedToolResults = steps.flatMap((s) => s.toolResults);
        await persistAssistantFromFinishEvent({
          threadId: ctx.thread.id,
          turnId: ctx.turnId,
          event: {
            text: accumulatedText,
            reasoningText: accumulatedReasoning || undefined,
            toolResults: aggregatedToolResults,
            finishReason: "other",
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            steps,
          } as unknown as Parameters<typeof persistAssistantFromFinishEvent>[0]["event"],
          modelConfig,
          fallbackInfo: fallbackInfo.fellBack ? fallbackInfo : undefined,
          reasoningDurationMs: computeReasoningDurationMs(),
          personaId: ctx.thread.isTemporary ? undefined : ctx.thread.personaId,
        });
      } catch (err) {
        logError("/api/chat onAbort persist failed", {
          threadId: ctx.thread.id,
          turnId: ctx.turnId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        unregisterPublisher(ctx.thread.id);
      }
    },
    // Persist from streamText.onFinish so the assistant turn lands in
    // Cosmos when the LLM finishes — not when the response stream closes
    // (which happens early on client disconnect and would persist a
    // partial message).
    onEnd: async (event) => {
      logInfo("/api/chat streamText.onFinish fired", {
        threadId: ctx.thread.id,
        finishReason: event.finishReason,
        textLen: event.text.length,
        toolResultCount: event.toolResults.length,
        toolResultNames: event.toolResults.map((r) => r.toolName),
      });
      // When finishReason === "error", `onError` does NOT always fire (the
      // AI SDK distinguishes thrown stream errors from provider-reported
      // error finish reasons). Mine `event.warnings` / `event.providerMetadata`
      // for the cause so the sentinel row in Cosmos isn't a generic
      // "no content" placeholder.
      if (event.finishReason === "error" && !lastStreamError) {
        const synthesized = reconstructStreamError(event);
        if (synthesized) {
          lastStreamError = synthesized;
          logError("/api/chat onFinish reconstructed streamError from event", {
            threadId: ctx.thread.id,
            turnId: ctx.turnId,
            message: synthesized.message,
          });
        }
      }
      onFinishRan = true;
      try {
        await persistAssistantFromFinishEvent({
          threadId: ctx.thread.id,
          turnId: ctx.turnId,
          event,
          modelConfig,
          fallbackInfo: fallbackInfo.fellBack ? fallbackInfo : undefined,
          streamError: lastStreamError,
          reasoningDurationMs: computeReasoningDurationMs(),
          personaId: ctx.thread.isTemporary ? undefined : ctx.thread.personaId,
        });
        // Generate a thread title from the first user message. ctx.history
        // has just the user message we appended in loadThreadContext when
        // this is the first turn (length === 1). Fire-and-forget — title
        // is cosmetic; failures shouldn't block the assistant reply.
        if (ctx.history.length === 1) {
          UpdateChatTitle(ctx.thread.id, payload.message).catch((err) => {
            logError("/api/chat UpdateChatTitle failed", {
              threadId: ctx.thread.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        // Harvest the container_id Azure stamped on any code_interpreter
        // tool call this turn so the next turn reuses the same container
        // (preserves uploaded files + working-directory state). For
        // provider-executed tools the AI SDK surfaces typed tool-call
        // parts in step.content; built-in Azure tool inputs aren't in
        // our ToolSet so we narrow the input shape locally.
        const harvestedContainerId = harvestCodeInterpreterContainerId(
          event.steps ?? [],
        );
        if (
          harvestedContainerId &&
          harvestedContainerId !== ctx.thread.codeInterpreterContainerId
        ) {
          UpdateChatThreadCodeInterpreterContainer(
            ctx.thread.id,
            harvestedContainerId,
            requestedCiSignature,
          ).catch((err) => {
            logError("/api/chat failed to persist code_interpreter containerId", {
              threadId: ctx.thread.id,
              containerId: harvestedContainerId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } catch (err) {
        // Persist failed (Cosmos transient, etc). One retry, then if still
        // broken write a sentinel row so the user sees *something* instead
        // of an orphan user row + polling forever (architect2 SEV-1 B1).
        logError("/api/chat persistAssistantFromFinishEvent failed, retrying", {
          threadId: ctx.thread.id,
          turnId: ctx.turnId,
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          await persistAssistantFromFinishEvent({
            threadId: ctx.thread.id,
            turnId: ctx.turnId,
            event,
            modelConfig,
            fallbackInfo: fallbackInfo.fellBack ? fallbackInfo : undefined,
            streamError: lastStreamError,
            reasoningDurationMs: computeReasoningDurationMs(),
            personaId: ctx.thread.isTemporary
              ? undefined
              : ctx.thread.personaId,
          });
        } catch (retryErr) {
          logError("/api/chat persistAssistantFromFinishEvent retry failed", {
            threadId: ctx.thread.id,
            turnId: ctx.turnId,
            error:
              retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
          // Last-resort sentinel — at least an assistant row exists for
          // this turn so polling stops and history doesn't show a hanging
          // user row.
          try {
            const { UpsertChatMessage } = await import(
              "@/features/chat-page/chat-services/chat-message-service"
            );
            const { userHashedId } = await import("@/features/auth-page/helpers");
            await UpsertChatMessage({
              id: `sentinel-${ctx.turnId}`,
              createdAt: new Date(),
              isDeleted: false,
              threadId: ctx.thread.id,
              userId: await userHashedId(),
              name: "system",
              role: "assistant",
              content:
                "_The generation completed but the result could not be saved (Cosmos write failed twice). Please resend your message._",
              type: "CHAT_MESSAGE",
              turnId: ctx.turnId,
            });
          } catch (sentinelErr) {
            // Even the sentinel write failed. The 60-second polling cap
            // in chat-page.tsx will at least surface "no reply arrived"
            // to the user. Log loudly so App Insights captures the
            // triple-failure for the on-call to find.
            logError("/api/chat sentinel write failed (triple-failure)", {
              threadId: ctx.thread.id,
              turnId: ctx.turnId,
              error:
                sentinelErr instanceof Error
                  ? sentinelErr.message
                  : String(sentinelErr),
            });
          }
        }
      } finally {
        // Drop the publisher entry; nothing useful to resume after the
        // stream is fully persisted to Cosmos.
        unregisterPublisher(ctx.thread.id);
      }
    },
  });

  // Drain the stream so the LLM call runs to completion even when the
  // browser disconnects (user navigates mid-stream). The promise returned
  // is PromiseLike — wrap in Promise.resolve to attach error handling.
  //
  // After the stream settles, check whether onFinish actually ran. If the
  // stream errored BEFORE any chunk (e.g. AI_DownloadError on history
  // assets, model deployment 404, auth refused at the first hop), the AI
  // SDK fires onError but skips onFinish — so no sentinel is written and
  // the UI polls for 60 s on an orphaned user row. Write a sentinel here
  // as a last resort so the chat doesn't appear hung.
  Promise.resolve(result.consumeStream())
    .catch(async (err) => {
      logError("/api/chat consumeStream rejected", {
        threadId: ctx.thread.id,
        turnId: ctx.turnId,
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(async () => {
      unregisterPublisher(ctx.thread.id);
      if (onFinishRan) return;
      // When the user clicked stop, consumeStream settles (rejected
      // promise from the abort) BEFORE streamText's onAbort callback
      // runs — so onFinishRan is still false here. Don't write a
      // sentinel in that case; onAbort owns persistence on the abort
      // path. Without this guard the sentinel races onAbort's partial
      // and overwrites the tokens the user already saw.
      if (abortController.signal.aborted) return;
      logWarn(
        "/api/chat onFinish never fired — writing early-error sentinel",
        {
          threadId: ctx.thread.id,
          turnId: ctx.turnId,
          lastStreamError,
        },
      );
      try {
        const [{ UpsertChatMessage }, { userHashedId }, { friendlyErrorMessage }] =
          await Promise.all([
            import("@/features/chat-page/chat-services/chat-message-service"),
            import("@/features/auth-page/helpers"),
            import(
              "@/features/chat-page/chat-services/chat-api/persist-assistant"
            ),
          ]);
        const sentinelText = lastStreamError
          ? friendlyErrorMessage(lastStreamError)
          : "_⚠️ Something went wrong generating the reply. Please try again, or start a new chat if it keeps happening._";
        await UpsertChatMessage({
          id: `sentinel-${ctx.turnId}`,
          createdAt: new Date(),
          isDeleted: false,
          threadId: ctx.thread.id,
          userId: await userHashedId(),
          name: "system",
          role: "assistant",
          content: sentinelText,
          type: "CHAT_MESSAGE",
          turnId: ctx.turnId,
        });
      } catch (sentinelErr) {
        logError(
          "/api/chat early-error sentinel write failed",
          {
            threadId: ctx.thread.id,
            turnId: ctx.turnId,
            error:
              sentinelErr instanceof Error
                ? sentinelErr.message
                : String(sentinelErr),
          },
        );
      }
    });

  // Build the framed UI-message-stream HTTP response, then tee the body:
  // one branch is sent to the POST caller, the other feeds the per-thread
  // publisher so reattach (GET /api/chat/[id]/stream) can replay the
  // buffered prefix and forward live chunks. tee() backpressures both
  // consumers on the slower one — the publisher drains eagerly so the
  // POST stream isn't held back when no GET is attached.
  //
  // The stream is OURS, not streamText's: it is created with a writer so the
  // route can put its own parts on the assistant message before the model's
  // chunks, and the model stream is merged into it. Today that is the
  // compaction notice; anything else the turn needs to tell the user goes the
  // same way.
  // Two different quantities have to reach the header, and only one of them is
  // on the terminal `finish` part.
  //
  //   TURN TOTALS       `finish.totalUsage` — the all-steps roll-up. The SDK
  //                     is explicit: "When there are multiple steps, the usage
  //                     is the sum of all step usages". That sum is what was
  //                     billed, so cost and the cache split come from it.
  //   LAST PROMPT SIZE  the LAST `finish-step` part's own `usage.inputTokens`.
  //                     `TextStreamFinishStepPart` carries per-step usage
  //                     (ai/dist/index.d.ts, the `finish-step` member of
  //                     `TextStreamPart`); the `finish` part carries only the
  //                     roll-up. So the step value has to be caught as it goes
  //                     past — hence these two counters.
  //
  // `messageMetadata` is invoked for EVERY part (the SDK's own transform calls
  // it before `toUIMessageChunk`), and a non-undefined return on a part that is
  // not `start`/`finish` makes the SDK enqueue an extra `message-metadata`
  // chunk. So: capture on `finish-step`, and emit ONLY on `finish`.
  let lastStepInputTokens: number | undefined;
  let stepCount = 0;

  const modelStream = result.toUIMessageStream({
    // Ship the turn's token usage on the assistant message metadata so the
    // header's live usage display updates every turn (the chat session's
    // onFinish reads this). Provider-agnostic: the SDK normalises usage to
    // inputTokens/outputTokens for both Azure (Responses) and Anthropic
    // (Messages) before it reaches us. Fires on the terminal `finish` part.
    messageMetadata: ({ part }): ChatMessageMetadata | undefined => {
      if (part.type === "finish-step") {
        stepCount += 1;
        // Last one wins: steps arrive in order, so after the final
        // `finish-step` this holds the size of the last prompt sent.
        lastStepInputTokens = part.usage?.inputTokens ?? lastStepInputTokens;
        return undefined;
      }
      if (part.type !== "finish") return undefined;
      const u = part.totalUsage;
      return {
        usage: computeRequestUsage({
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
          cachedTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens ?? 0,
          // Undefined when no `finish-step` carried a number; computeRequestUsage
          // then falls back to the roll-up, which is exact for one step.
          ...(typeof lastStepInputTokens === "number"
            ? { lastPromptTokens: lastStepInputTokens }
            : {}),
          ...(stepCount > 0 ? { stepCount } : {}),
          modelConfig,
        }),
      };
    },
  });
  const framedResponse = createUIMessageStreamResponse({
    stream: createUIMessageStream({
      // Persistence mode: the assistant message keeps the id the SDK would
      // have given it through toUIMessageStreamResponse, so nothing
      // downstream (client reconciliation, resume) changes shape.
      originalMessages: ctx.history,
      generateId: createIdGenerator({ prefix: "msg", size: 16 }),
      onError: (err) => (err instanceof Error ? err.message : String(err)),
      execute: async ({ writer }) => {
        // The compaction notice is written TWICE under one part id, and the
        // SDK reconciles data parts by (type, id) so the row updates in place.
        //
        //   now          "Compacted 2 older turns into a summary" — the trim
        //                already happened in loadThreadContext (the summariser
        //                is a model call on the request path, and its output
        //                goes into the prompt this very turn replays), so the
        //                fact is known immediately. The token counts are not.
        //   at the end   the same line with the provider's REAL numbers:
        //                "(34,012 → 17,565 tokens)". `tokensAfter` IS the size
        //                of this request's LAST prompt (the final step's
        //                inputTokens), which does not exist until the request
        //                finishes. Both ends are prompt sizes, never the
        //                billed all-steps sum — a trim shrinks the prompt, and
        //                a roll-up would report it growing on a tool turn.
        //
        // No estimate is ever shown. A number in the header that later
        // disagrees with the provider's own accounting is worse than no number
        // for a few seconds.
        if (ctx.compaction) {
          writer.write(compactionDonePart(ctx.compaction));
          logInfo("/api/chat wrote compaction notice", {
            threadId: ctx.thread.id,
            turnId: ctx.turnId,
            trimmedTurns: ctx.compaction.trimmedTurns,
            summaryOutcome: ctx.compaction.summaryOutcome,
            durationMs: ctx.compaction.durationMs,
          });
        }
        writer.merge(modelStream);

        if (!ctx.compaction) return;
        // Awaiting AFTER the merge is what keeps the stream open long enough
        // to write again: createUIMessageStream closes when this callback's
        // promise settles and the merged stream is done. `finalStep` resolves
        // at the model's finish event.
        //
        // `finalStep`, NOT `result.usage`. Both ends of this notice are PROMPT
        // SIZES — "the prompt went from 34,012 to 17,565" — and `result.usage`
        // is the all-steps roll-up, which on a tool turn adds up several
        // prompts and would claim the trim made the prompt bigger.
        // `StreamTextResult.finalStep` is a `PromiseLike<StepResult>` and
        // `StepResult` carries its own per-step `usage` (ai/dist/index.d.ts).
        try {
          const finalStep = await result.finalStep;
          const tokensAfter = finalStep?.usage?.inputTokens ?? 0;
          if (tokensAfter <= 0) return;
          writer.write(
            compactionDonePart(ctx.compaction, {
              // The previous request's real prompt size, read at load time
              // before this turn overwrote it. Absent on a thread's first
              // turn, in which case the notice shows only what it is now.
              ...(typeof ctx.previousRequestPromptTokens === "number" &&
              ctx.previousRequestPromptTokens > 0
                ? { tokensBefore: ctx.previousRequestPromptTokens }
                : {}),
              tokensAfter,
            }),
          );
          logInfo("/api/chat completed the compaction notice", {
            threadId: ctx.thread.id,
            turnId: ctx.turnId,
            realTokensBefore: ctx.previousRequestPromptTokens,
            realTokensAfter: tokensAfter,
          });
          // Same numbers onto the compaction row, so the divider a reloaded
          // page draws says what the live notice said. Fails soft inside.
          await recordHistoryCompactionRealUsage({
            threadId: ctx.thread.id,
            ...(typeof ctx.previousRequestPromptTokens === "number"
              ? { realTokensBefore: ctx.previousRequestPromptTokens }
              : {}),
            realTokensAfter: tokensAfter,
          });
        } catch (err) {
          // A usage read that fails must not fail the turn: the user already
          // has their answer, and the notice simply keeps its shorter form.
          logWarn("/api/chat could not complete the compaction notice", {
            threadId: ctx.thread.id,
            turnId: ctx.turnId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    }),
  });
  if (!framedResponse.body) {
    unregisterPublisher(ctx.thread.id);
    return framedResponse;
  }
  // `blob://` references flow through the wire unchanged. The client
  // resolves them at render time (tool-part-view / chat-image-display).
  const [responseBranch, publisherBranch] = framedResponse.body.tee();
  publish(publisherBranch);

  return new Response(responseBranch, {
    status: framedResponse.status,
    statusText: framedResponse.statusText,
    headers: framedResponse.headers,
  });
}
