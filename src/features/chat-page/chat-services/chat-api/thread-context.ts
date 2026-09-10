import "server-only";

/**
 * Why there is no `"use server"` here
 * -----------------------------------
 * `"use server"` marks a module as a SERVER ACTION surface: Next turns every
 * export into an RPC endpoint a client component may call, and therefore
 * rejects any export that is not an async function. This module is reached
 * only from other server modules, never from a client component, so it wants
 * the opposite guarantee — "never bundle me for the browser" — which is what
 * `import "server-only"` gives. That is the convention the neighbouring
 * non-action server modules follow (`persist-assistant.ts`, `rate-limit.ts`,
 * `stream-publisher.ts`, ...). Do not add the directive back: it is not needed
 * for a server module, and it breaks `next build` the moment this file gains a
 * sync export.
 */

/**
 * thread-context.ts
 *
 * Loads everything needed before the streaming response begins:
 * - resolves / creates the chat thread
 * - fetches the current user
 * - loads message history and adapts it to UIMessages
 * - resolves document hints, extensions, and attached files
 * - writes the user's turn to Cosmos so that a page refresh during streaming
 *   shows the outgoing message immediately (matches today's behaviour in
 *   chat-api-response.ts).
 */

import { getCurrentUser, userHashedId } from "@/features/auth-page/helpers";
import { logDebug, logError, logInfo, logWarn } from "@/features/common/services/logger";
import type { UIMessage } from "ai";
import { createIdGenerator } from "ai";
import { CreateChatMessage } from "../chat-message-service";
import { FindAllChatDocuments } from "../chat-document-service";
import { FindAllChatMessagesForCurrentUser } from "../chat-message-service";
import { EnsureChatThreadOperation } from "../chat-thread-service";
import { uiMessagesFromChatMessages } from "./message-adapter";
import { compareByCodepoint } from "../tools/stabilize-toolset";
import { getBase64ImageReference } from "../chat-image-persistence-service";
import { isImageReference } from "../chat-image-persistence-utils";
import type { HistoryCompactionOutcome, SummaryOutcome } from "./compaction-part";
import {
  applyHistoryWatermark,
  planHistoryTrim,
  resolveHistoryBudget,
  resolveHistoryProtectedTurns,
} from "./history-budget";
import {
  formatSummaryReplayText,
  historySummaryRowId,
  type ChatHistorySummaryModel,
} from "./history-summary";
import {
  FindChatHistorySummary,
  isHistorySummaryEnabled,
  recordHistoryCompaction,
} from "./history-summary-service";
import {
  AttachedFileModel,
  ChatMessageModel,
  ChatThreadModel,
  DefaultTools,
  MODEL_CONFIGS,
  UserPrompt,
} from "../models";

// ---------------------------------------------------------------------------
// History file-ref resolution
// ---------------------------------------------------------------------------

/**
 * Walks the user-message FileUIPart entries and replaces any
 * `blob://threadId/filename` reference (the canonical persistence format
 * for uploaded images and code_interpreter outputs) with a `data:`
 * URL the AI SDK can ship to the model without a network fetch.
 *
 * Why this is necessary: AI SDK v6's `convertToLanguageModelPrompt` →
 * `downloadAssets` validates every URL via `validateDownloadUrl`, which
 * rejects any scheme that isn't http(s) or data — `blob://` fails. The
 * read adapter (`uiMessagesFromChatMessages`) passes refs through
 * verbatim because it's sync and can't read blob storage. We do the
 * async resolution here, once, before history reaches streamText.
 *
 * A failed lookup is logged and the part is dropped (better than poisoning
 * the whole turn with a download error).
 */
/**
 * Replaces every `image_generation` tool output's `result` field with an
 * opaque placeholder before history reaches `convertToModelMessages`.
 *
 * Why this is necessary: the read adapter resolves `blob://` →
 * `/api/images?…` so the UI can render persisted images. If we left
 * that URL in the history that goes to the model on a follow-up turn,
 * the model echoes it as `![alt](/api/images?…)` markdown — and
 * Streamdown renders an image inline in the new assistant text. Since
 * the prior tool widget already shows the same image, the user sees
 * it twice. Stripping the URL from the model's view stops the echo;
 * the UI render path still has the URL via the same read adapter.
 *
 * Browser-render history (built by chat-page.tsx via uiMessagesFromChatMessages)
 * is a separate call and keeps the URL — only the server-side history
 * passed to streamText is stripped here.
 */
function stripImageUrlsFromToolOutputs(history: UIMessage[]): UIMessage[] {
  return history.map((msg) => {
    if (msg.role !== "assistant") return msg;
    let mutated = false;
    const newParts = msg.parts.map((p) => {
      const part = p as {
        type: string;
        toolName?: string;
        output?: unknown;
      };
      const isImageGenToolPart =
        (part.type === "dynamic-tool" && part.toolName === "image_generation") ||
        part.type === "tool-image_generation";
      if (!isImageGenToolPart) return p;
      if (!part.output || typeof part.output !== "object") return p;
      mutated = true;
      return {
        ...p,
        output: {
          ...(part.output as object),
          // Replace the URL with a hint the model can use as context
          // without being able to echo it. The tool widget on the
          // browser side still has the real URL from its own render
          // pass — this strip only affects what the model sees.
          result: "[generated image displayed to the user]",
        },
      } as typeof p;
    });
    if (!mutated) return msg;
    return { ...msg, parts: newParts } as UIMessage;
  });
}

async function resolveHistoryFileRefs(
  history: UIMessage[],
): Promise<UIMessage[]> {
  const out: UIMessage[] = [];
  for (const msg of history) {
    if (msg.role !== "user") {
      out.push(msg);
      continue;
    }
    const newParts: UIMessage["parts"] = [];
    for (const part of msg.parts) {
      if (part.type !== "file") {
        newParts.push(part);
        continue;
      }
      const file = part as { type: "file"; url: string; mediaType?: string };
      if (!isImageReference(file.url)) {
        newParts.push(part);
        continue;
      }
      try {
        const dataUrl = await getBase64ImageReference(file.url);
        newParts.push({ ...file, url: dataUrl, mediaType: file.mediaType ?? "image/png" });
      } catch (err) {
        logWarn(
          "resolveHistoryFileRefs: failed to inline blob ref; dropping file part",
          {
            ref: file.url,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        // Skip this attachment — the model still gets the text content
        // and the next turn won't blow up on a missing blob.
      }
    }
    out.push({ ...msg, parts: newParts } as UIMessage);
  }
  return out;
}

// ---------------------------------------------------------------------------
// History compaction
// ---------------------------------------------------------------------------

/**
 * Replay a stored summary as the first conversation item.
 *
 * Role `user`, not `system`. Two reasons:
 *   - The message adapter and every provider seam already handle user
 *     messages; a mid-prompt system message is handled inconsistently across
 *     the three providers this app talks to (Azure Responses, the Azure
 *     /anthropic Messages API, and Foundry Chat Completions), and getting it
 *     right would mean touching provider files.
 *   - The developer message is assembled separately in route.ts and is
 *     process-constant; folding per-thread text into it would put a volatile
 *     segment back at the front of the prefix, which is the mistake this
 *     change set removes.
 *
 * Two consecutive user messages (this one and the oldest surviving turn) are
 * fine: the Anthropic seam groups same-role messages into one block, and the
 * OpenAI surfaces accept the sequence as-is.
 *
 * The id is derived from the thread so it is stable across turns.
 */
function summaryReplayMessage(
  threadId: string,
  summary: ChatHistorySummaryModel,
): UIMessage {
  return {
    id: historySummaryRowId(threadId),
    role: "user",
    parts: [
      { type: "text", text: formatSummaryReplayText(summary.content) },
    ],
  };
}

/**
 * Apply the persisted watermark, then the token budget, to a thread's rows.
 *
 * Order matters. The watermark comes first: rows an earlier trim already
 * accounted for must leave before anything is measured, otherwise the budget
 * would keep re-discovering them and keep moving the cut forward one turn at a
 * time. Only what survives the watermark is weighed against the budget.
 *
 * When a trim does happen this records it (advancing the watermark and, if the
 * feature is on, summarising the dropped block) before returning. That write is
 * the one thing standing between this design and the sliding window it
 * replaced, so it is awaited rather than fired and forgotten.
 *
 * Returns the rows to send and the summary to replay, if any.
 */
async function compactHistory(input: {
  threadId: string;
  selectedModel: ChatThreadModel["selectedModel"];
  rows: ChatMessageModel[];
  /**
   * Size of the LAST PROMPT of the thread's previous request, if recorded —
   * the ONE input to the compaction decision. A prompt size, not the billed
   * all-steps sum. Absent on a first turn or an old row, and then nothing is
   * compacted. See `TrimPlanOptions.measuredPromptTokens`.
   */
  threadUsageLastPromptTokens?: number;
}): Promise<{
  rows: ChatMessageModel[];
  summary: ChatHistorySummaryModel | null;
  /** Set only on a turn that actually trimmed. Drives the UI notice. */
  compaction: HistoryCompactionOutcome | undefined;
}> {
  const existingSummary = await FindChatHistorySummary(input.threadId);

  const { retained, alreadyCompacted } = applyHistoryWatermark(
    input.rows,
    existingSummary?.coversThroughMessageId,
  );

  const summaryEnabled = isHistorySummaryEnabled();
  // The budget follows the thread's selected model, not the effective model
  // resolved later in route.ts. A downgrade changes who answers the turn, not
  // how much of the thread is worth carrying, and reading it here keeps the
  // decision (and therefore the prefix) independent of per-turn routing.
  const budgetModelConfig = input.selectedModel
    ? MODEL_CONFIGS[input.selectedModel]
    : undefined;
  // The configured budget, bounded by what this model can afford to be handed:
  // its long-context billing threshold minus a reserve, else a fraction of its
  // context window. See resolveHistoryBudget.
  const budgetDecision = resolveHistoryBudget({
    modelBudget: budgetModelConfig?.historyTokenBudget,
    envBudget: process.env.HISTORY_TOKEN_BUDGET,
    longContextThresholdTokens: budgetModelConfig?.longContextThresholdTokens,
    contextWindow: budgetModelConfig?.contextWindow,
    envReserve: process.env.HISTORY_LONG_CONTEXT_RESERVE,
  });
  const budget = budgetDecision.budget;
  // Which of the four candidates actually decided. Debug, not info: it is the
  // same answer on every turn of every thread on a given model, and it is only
  // interesting when a budget looks wrong.
  logDebug("thread-context: resolved history token budget", {
    threadId: input.threadId,
    selectedModel: input.selectedModel,
    budget,
    baseBudget: budgetDecision.baseBudget,
    baseSource: budgetDecision.baseSource,
    guard: budgetDecision.guard,
    guardSource: budgetDecision.guardSource,
    reserve: budgetDecision.reserve,
    cappedByGuard: budgetDecision.cappedByGuard,
  });

  // The ONE input to the decision: the provider's measured size of this
  // thread's PREVIOUS last prompt. Over budget means compact the history and
  // start again; there is nothing else to work out and nothing to estimate.
  //
  // This is the previous turn's LAST-STEP input, not its billed roll-up. AI
  // SDK 7 sums step usage over a turn, so the roll-up counted one prompt per
  // step: measured on dev, a thread reported 285,647 against a 256,000 budget
  // while its real prompt was about half that, and compacted a thread that was
  // never over budget.
  const measuredPromptTokens = input.threadUsageLastPromptTokens;

  const plan = planHistoryTrim(retained, {
    budget,
    minKeptTurns: resolveHistoryProtectedTurns({
      envProtectedTurns: process.env.HISTORY_PROTECTED_TURNS,
    }),
    ...(typeof measuredPromptTokens === "number"
      ? { measuredPromptTokens }
      : {}),
  });

  if (!plan.trimmed) {
    if (plan.skipReason === "no-measurement") {
      // No recorded prompt size for this thread: its first turn, or a row
      // written before `lastPromptTokens` existed. Nothing to compare against,
      // so nothing is compacted and no summariser call is spent — and an
      // oversized first message could not be helped anyway, because the
      // current user turn is never droppable. DEBUG: once per new thread.
      logDebug("thread-context: no measured prompt size yet, not compacting", {
        threadId: input.threadId,
        budget: plan.budget,
        turnCount: plan.keptTurnCount,
        skipReason: plan.skipReason,
      });
    } else if (plan.skipReason === "nothing-droppable") {
      // Over budget with no history to compact: an empty thread, or every turn
      // protected by HISTORY_PROTECTED_TURNS. Nothing to do but let it through
      // — the alternative is dropping the question being answered.
      //
      // WARN only when the budget is the shipped default, where this means one
      // turn is genuinely enormous. With a deliberately small budget (a test
      // environment set to 10k, say) it happens routinely, and warning on
      // every turn of every thread would train people to ignore the log.
      const budgetIsDefault = budgetDecision.baseSource === "default";
      const log = budgetIsDefault ? logWarn : logInfo;
      log("thread-context: prompt over budget but nothing can be compacted", {
        threadId: input.threadId,
        measuredPromptTokens: plan.measuredPromptTokens,
        budget: plan.budget,
        budgetSource: budgetDecision.baseSource,
        turnCount: plan.keptTurnCount,
        protectedTurns: resolveHistoryProtectedTurns({
          envProtectedTurns: process.env.HISTORY_PROTECTED_TURNS,
        }),
        // No summariser call is spent and no notice is shown: nothing happened.
        skipReason: plan.skipReason,
      });
    }
    // "under-budget" is the ordinary outcome of almost every turn and is not
    // logged at all.
    return {
      rows: plan.kept,
      summary: summaryWithContent(existingSummary),
      compaction: undefined,
    };
  }

  logInfo("thread-context: compacted history, the thread starts again", {
    threadId: input.threadId,
    budget: plan.budget,
    measuredPromptTokens: plan.measuredPromptTokens,
    droppedTurnCount: plan.droppedTurnCount,
    keptTurnCount: plan.keptTurnCount,
    droppedMessageCount: plan.dropped.length,
    previouslyCompactedMessageCount: alreadyCompacted.length,
    summaryEnabled,
  });

  // Wall-clock of the trim as the user experiences it: the summariser call is
  // a model call on the request path, so this is the wait the notice explains.
  const startedAt = Date.now();
  const recorded = await recordHistoryCompaction({
    threadId: input.threadId,
    userId: await userHashedId(),
    droppedMessages: plan.dropped,
    coversThroughMessageId: plan.coversThroughMessageId!,
    previous: existingSummary,
    // Summarise on the thread's own model: it is the model that just had this
    // block in context, and re-sending the block to another deployment pays
    // for all of it again, cold.
    ...(input.selectedModel ? { selectedModel: input.selectedModel } : {}),
  });
  const durationMs = Date.now() - startedAt;

  // The reason code comes from the writer, which is the only place that knows
  // whether the summariser was off, absent, slow or broken. A row written
  // before outcomes existed has none, and that is "unknown" — NOT "off".
  // Mapping it to "off" put "no summary, feature off" in the transcript of
  // threads whose summariser was on and working, which is the same class of
  // misdiagnosis this reason code was added to remove. Note a row can carry
  // text from an EARLIER trim while this trim failed — so the text is only
  // shown when this trim itself succeeded.
  const summaryContent = recorded?.content?.trim() ?? "";
  const summaryOutcome: SummaryOutcome = recorded?.summaryOutcome ?? "unknown";
  const summarised = summaryOutcome === "ok" && summaryContent.length > 0;
  const compaction: HistoryCompactionOutcome = {
    trimmedTurns: plan.droppedTurnCount,
    // The measurement that triggered this compaction. What the USER sees are
    // the provider's real prompt sizes either side of the trim, written by the
    // route once this turn finishes.
    ...(typeof plan.measuredPromptTokens === "number"
      ? { measuredPromptTokens: plan.measuredPromptTokens }
      : {}),
    summaryOutcome,
    durationMs,
    ...(summarised && recorded?.model ? { summaryModel: recorded.model } : {}),
    ...(summarised ? { summaryText: summaryContent } : {}),
    ...(plan.coversThroughMessageId
      ? { coversThroughMessageId: plan.coversThroughMessageId }
      : {}),
  };

  // A failed write leaves the watermark where it was. This turn is still
  // trimmed (the user gets the cheap prompt); the next turn will re-derive the
  // same cut and try the write again.
  return {
    rows: plan.kept,
    summary: summaryWithContent(recorded ?? existingSummary),
    compaction,
  };
}

/**
 * Narrow a compaction row to one worth replaying. A row with empty `content`
 * is a watermark only — the block was trimmed without being summarised — and
 * replaying an empty summary would put a bare heading in front of the
 * conversation.
 */
function summaryWithContent(
  summary: ChatHistorySummaryModel | null,
): ChatHistorySummaryModel | null {
  if (!summary) return null;
  return summary.content.trim().length > 0 ? summary : null;
}

// ---------------------------------------------------------------------------
// Document hint placement
// ---------------------------------------------------------------------------

/**
 * Providers that accept a system message in the MIDDLE of `messages`, which is
 * what the tail placement needs. See the long note in `loadThreadContext`:
 * Anthropic's seam handles it by requesting a beta this app cannot verify
 * against the Azure /anthropic surface, and a wrong guess there is a hard 400.
 */
function providerTakesMidConversationSystem(provider: string | undefined): boolean {
  return provider !== "anthropic";
}

/**
 * The hint as its own developer message for the prompt tail. Role "system":
 * `convertToModelMessages` maps a system UIMessage to a system ModelMessage at
 * the same index, and the provider seams then render it as a system/developer
 * item.
 *
 * The id is derived from the thread, so the item is byte-identical across turns
 * for as long as the document set is unchanged.
 */
function documentHintTailMessage(threadId: string, hintText: string): UIMessage {
  return {
    id: documentHintMessageId(threadId),
    role: "system",
    parts: [{ type: "text", text: hintText.trimStart() }],
  };
}

function documentHintMessageId(threadId: string): string {
  return `dochint-${threadId}`;
}

/**
 * Re-place the document hint for the model that will ACTUALLY run the turn.
 *
 * `loadThreadContext` has to decide a placement before the effective model is
 * known — resolving the model needs the thread the loader returns — so it
 * decides from `thread.selectedModel`. That is not always the model that runs:
 * `resolveModelAndLimits` prefers `payload.selectedModel` (this turn's picker),
 * and a budget cap or an intent rule can downgrade to another model again. When
 * the two disagree ACROSS PROVIDERS the placement is wrong in a way that
 * matters:
 *
 *   - thread on Azure, effective model Claude: the hint would ride in the tail
 *     as a mid-conversation system message, the one case the tail placement is
 *     not allowed to take (hard 400 risk — see above).
 *   - thread on Claude, effective model Azure: the hint would stay in the
 *     developer message, moving the FIRST item of the prompt whenever the
 *     document set changes, which is the cache churn this change set removes.
 *
 * So the route calls this once `modelConfig` is resolved. Returns the context
 * unchanged when the placement already matches, and is idempotent.
 */
export function applyDocumentHintPlacement(
  ctx: ThreadContext,
  provider: string | undefined,
): ThreadContext {
  const hintText = ctx.documentHintText;
  if (!hintText) return ctx;

  const wanted: ThreadContext["documentHintPlacement"] =
    providerTakesMidConversationSystem(provider)
      ? "tail-message"
      : "developer-message";
  if (wanted === ctx.documentHintPlacement) return ctx;

  const hintId = documentHintMessageId(ctx.thread.id);
  const withoutHint = ctx.modelHistory.filter((m) => m.id !== hintId);

  if (wanted === "developer-message") {
    return {
      ...ctx,
      modelHistory: withoutHint,
      documentHint: hintText,
      documentHintPlacement: "developer-message",
    };
  }

  // Into the tail: immediately before the current user turn, which is the last
  // item of modelHistory by construction.
  const cut = Math.max(0, withoutHint.length - 1);
  return {
    ...ctx,
    modelHistory: [
      ...withoutHint.slice(0, cut),
      documentHintTailMessage(ctx.thread.id, hintText),
      ...withoutHint.slice(cut),
    ],
    documentHint: undefined,
    documentHintPlacement: "tail-message",
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ThreadContextUser {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
}

export interface ThreadContext {
  thread: ChatThreadModel;
  user: ThreadContextUser;
  /**
   * The real conversation in AI SDK UIMessage format, oldest-first, ending
   * with the turn the user just submitted. Persisted messages only — no
   * prompt scaffolding — so callers can still count turns (`length === 1`
   * means a first turn) and hand it to `toUIMessageStreamResponse` as
   * `originalMessages` without a synthetic item leaking to the browser.
   */
  history: UIMessage[];
  /**
   * `history` plus the prompt scaffolding, in the exact order it must reach
   * `convertToModelMessages`: the replayed summary (if any), then the
   * conversation, then the document hint (if it goes in the tail), then the
   * current user turn. This is what streamText should be given.
   */
  modelHistory: UIMessage[];
  /**
   * Document hint for the DEVELOPER message, set only when this thread's
   * provider cannot take a mid-conversation system message (see
   * `documentHintPlacement`). Undefined when the hint is already in
   * `modelHistory` — or when there are no documents at all.
   */
  documentHint: string | undefined;
  /**
   * The hint text itself, whichever placement it ended up in. Undefined when
   * the thread has no documents. `applyDocumentHintPlacement` needs it to move
   * the hint once the EFFECTIVE model is known.
   */
  documentHintText: string | undefined;
  /**
   * Where the document hint ended up. `"tail-message"` keeps the developer
   * message static for the life of the thread; `"developer-message"` is the
   * fallback. Exposed for logging and tests, not for dispatch.
   */
  documentHintPlacement: "tail-message" | "developer-message" | "none";
  threadDocumentIds: string[];
  personaDocumentIds: string[];
  defaultTools: DefaultTools | undefined;
  extensions: string[];
  attachedFiles: AttachedFileModel[];
  /**
   * Stable identifier for this turn. Stamped on the user row written at
   * load time and threaded through to persistAssistantFromFinishEvent so
   * every row written during the turn shares it. Enables partial-turn
   * detection.
   */
  turnId: string;
  /**
   * What the history trim did on THIS turn, or undefined when nothing was
   * trimmed. The route turns it into the `data-compaction` part the transcript
   * renders, which is the only way the user learns that the model can no
   * longer quote turns they can still scroll to.
   */
  compaction: HistoryCompactionOutcome | undefined;
  /**
   * The size of the LAST PROMPT of this thread's PREVIOUS request, read before
   * this turn overwrites it. The route pairs it with this request's own
   * last-prompt size so the compaction notice can state what the prompt
   * actually went from and to — both ends are prompt sizes, never the billed
   * all-steps roll-up, which on a tool turn counts one conversation several
   * times over. Undefined on a thread's first turn.
   */
  previousRequestPromptTokens: number | undefined;
}

// ---------------------------------------------------------------------------
// loadThreadContext
// ---------------------------------------------------------------------------

/**
 * Resolves all context required before a streaming request is dispatched.
 *
 * Side-effect: writes the user's outgoing message to Cosmos before the stream
 * starts, mirroring the behaviour in chat-api-response.ts line 135-143.
 *
 * Throws with { status: 401 } attached if the thread authorisation check fails.
 */
const userMessageIdGenerator = createIdGenerator({ prefix: "user", size: 16 });
const turnIdGenerator = createIdGenerator({ prefix: "turn", size: 16 });

export async function loadThreadContext(
  payload: UserPrompt
): Promise<ThreadContext> {
  // 1. Resolve / create thread
  const threadResponse = await EnsureChatThreadOperation(payload.id);
  if (threadResponse.status !== "OK") {
    const err = Object.assign(
      new Error("Unauthorized"),
      { status: 401 }
    );
    throw err;
  }
  const thread = threadResponse.response;

  // 2. Current user (needed for message authorship)
  const currentUser = await getCurrentUser();
  const user: ThreadContextUser = {
    id: currentUser.email, // consistent with hashValue usage elsewhere
    name: currentUser.name,
    email: currentUser.email,
    isAdmin: currentUser.isAdmin,
  };

  // 3. History.
  //
  // The whole thread, not `TOP 30`. The old row cap made the prompt prefix
  // move on every turn past row 30 — see the header comment in
  // history-budget.ts for the measured cost. What limits the prompt now is the
  // provider's own size for the previous request's last prompt, compared
  // against the budget: over it, the eligible history is compacted in one
  // block, so the prefix then holds still for dozens of turns at a time.
  // Nothing is estimated.
  const historyResponse = await FindAllChatMessagesForCurrentUser(thread.id);
  const allRows = historyResponse.status === "OK" ? historyResponse.response : [];
  if (historyResponse.status !== "OK") {
    logError("Error getting history", { errors: historyResponse.errors });
  }
  // FindAllChatMessagesForCurrentUser orders by createdAt ASC, which is the
  // oldest-first order every adapter downstream expects.

  const {
    rows: keptRows,
    summary: activeSummary,
    compaction,
  } = await compactHistory({
    threadId: thread.id,
    selectedModel: thread.selectedModel,
    rows: allRows,
    // Recorded by UpdateChatThreadUsage at the end of the previous turn, so
    // this is that request's real prompt size — read here BEFORE this turn
    // overwrites it.
    //
    // `lastPromptTokens` is the last step's own input, and it is the ONLY
    // figure allowed to trigger a compaction. There is deliberately no
    // fallback to `lastInputTokens`: that is the all-steps roll-up, which sums
    // one prompt per step and so overstates a multi-step turn by roughly the
    // number of steps. Compacting on it is the defect this branch exists to
    // remove, and doing it only to old threads would have been the same bug
    // with a smaller blast radius. No measurement means no compaction; the
    // next turn writes one and decides on its own number.
    ...(typeof thread.usage?.lastPromptTokens === "number"
      ? { threadUsageLastPromptTokens: thread.usage.lastPromptTokens }
      : {}),
  });

  const history = await resolveHistoryFileRefs(
    uiMessagesFromChatMessages(keptRows),
  );

  // The summary replaces the rows it covers, so it goes at the very front of
  // the conversation — immediately after the developer message.
  const summaryPrefix: UIMessage[] = activeSummary
    ? [summaryReplayMessage(thread.id, activeSummary)]
    : [];

  // 4. Documents
  const documentsResponse = await FindAllChatDocuments(thread.id);
  const hasChatDocuments =
    documentsResponse.status === "OK" &&
    documentsResponse.response.length > 0;
  const chatDocumentIds: string[] =
    hasChatDocuments
      ? documentsResponse.response.map((d) => d.id)
      : [];
  const personaDocumentIds: string[] =
    thread.personaDocumentIds ?? [];
  const hasPersonaDocuments = personaDocumentIds.length > 0;
  const hasAnyDocuments = hasChatDocuments || hasPersonaDocuments;

  // Build document hint matching the logic in chat-api-response.ts lines 114-123
  let documentHintText: string | undefined;
  if (hasAnyDocuments) {
    // Sort the names. FindAllChatDocuments already orders by createdAt, but the
    // hint is part of the prompt: a reshuffle here rewrites it and voids that
    // much of the cache. Sorting locally makes the line a pure function of the
    // document SET, independent of insertion order or of a same-millisecond
    // createdAt tie.
    //
    // Codepoint comparison, not localeCompare. Pinning the locale to "en" was
    // not enough: the comparison is still the pod's ICU build talking, so two
    // replicas built against different ICU data could order the same file
    // names differently and neither would match the other's cached prompt.
    const documentNames = hasChatDocuments
      ? [...documentsResponse.response]
          .map((doc) => doc.name)
          .sort(compareByCodepoint)
          .join(", ")
      : "";
    const contextLine = hasChatDocuments
      ? `DOCUMENT CONTEXT: The user has attached the following document(s) to this conversation: ${documentNames}.`
      : `DOCUMENT CONTEXT: The user has persona-linked document(s) available for this conversation.`;
    documentHintText =
      `\n\n${contextLine}\n\n` +
      `MANDATORY BEHAVIOR WHEN DOCUMENTS ARE PRESENT:\n` +
      `- You MUST first call the search_documents tool with the user's question as the query before composing an answer.\n` +
      `- If the first page is insufficient, iterate using top (max results, default 10) and skip (offset) to gather more context (e.g., top=10, skip=10 for page 2).\n` +
      `- Ground your answer in the retrieved content and cite filenames when relevant.\n` +
      `- Do not answer purely from prior knowledge when documents are attached.`;
  }

  // 4b. Where the hint goes.
  //
  // The hint is the most volatile input to the prompt: it appears, disappears
  // and changes wording the moment a user attaches or removes a document. In
  // the developer message — even at its end — a change there is a change to
  // the FIRST item of the prompt, so nothing after it can be reused and the
  // whole thread is re-billed at the cache-write rate. Moved into the tail,
  // between the history and the current question, it changes only the last few
  // hundred bytes and the developer message plus the entire history stay
  // byte-identical and cacheable.
  //
  // Not every provider will take a system message in the middle of `messages`:
  //   - azure (Responses API): supported. @ai-sdk/openai emits it as an
  //     `input` item with role system/developer at whatever position it holds.
  //   - foundry (Chat Completions): supported. Same conversion, and the API
  //     accepts a system message at any index.
  //   - anthropic (Azure /anthropic Messages API): @ai-sdk/anthropic does
  //     handle it, but by pushing a `role: "system"` message and requesting
  //     the `mid-conversation-system-2026-04-07` beta. Whether the Azure
  //     /anthropic surface honours that beta cannot be established without a
  //     live call, and getting it wrong is a hard 400 rather than a
  //     degradation — so Claude threads keep the developer-message placement.
  //
  // The provider read here is the THREAD's model. The model that actually runs
  // the turn is resolved later (it needs the thread this function returns), so
  // the route corrects the placement through `applyDocumentHintPlacement` once
  // it knows. See that function for why the correction is not optional.
  const provider = thread.selectedModel
    ? MODEL_CONFIGS[thread.selectedModel]?.provider ?? "azure"
    : "azure";
  const documentHintPlacement: ThreadContext["documentHintPlacement"] =
    documentHintText === undefined
      ? "none"
      : providerTakesMidConversationSystem(provider)
        ? "tail-message"
        : "developer-message";

  // 5. Extension IDs (full extension objects + header secrets are
  //    resolved later by route.ts so we don't fetch them twice).
  const extensions: string[] = thread.extension ?? [];

  // 6. Mint turnId. Stamped on the user row written below, threaded into
  //    persistAssistantFromFinishEvent so every row written during this
  //    turn carries it. Enables future per-turn reconciliation, resume,
  //    and submit-mutex without retroactive schema migrations.
  const turnId = turnIdGenerator();

  // No per-thread mutex. The architect-2 review (B5) flagged a concern
  // about two tabs interleaving turns on the same thread, but the
  // claim/release machinery added more failure modes than it
  // prevented: the release path runs in onFinish (outside Next.js's
  // request context), couldn't reliably read the partition key, and
  // ended up leaving locks stuck — every second turn 409'd. Each turn
  // mints its own turnId; Cosmos rows are tagged with it; concurrent
  // turns on the same thread now produce two valid turns with their
  // own IDs and ordering follows server timestamps. The trade-off is
  // accepting the occasional cross-tab interleave, which is cosmetic
  // and rare in practice. (Tracked in #45.)

  // 7. Write user turn to Cosmos BEFORE stream starts.
  //    Reading history (step 3) happens first, so the freshly-written user
  //    message is NOT in `history`. We must append it before returning,
  //    otherwise `streamText({ messages: convertToModelMessages(history) })`
  //    is invoked with no user turn and throws AI_InvalidPromptError.
  await CreateChatMessage({
    name: user.name,
    content: payload.message,
    role: "user",
    chatThreadId: thread.id,
    multiModalImage: payload.multimodalImage,
    multiModalImages: payload.multimodalImages,
    turnId,
  });

  const userImages = payload.multimodalImages ?? (payload.multimodalImage ? [payload.multimodalImage] : []);
  const userUIMessage: UIMessage = {
    id: userMessageIdGenerator(),
    role: "user",
    parts: [
      ...(payload.message ? [{ type: "text" as const, text: payload.message }] : []),
      ...userImages.map((url) => ({
        type: "file" as const,
        mediaType: "image/*",
        url,
      })),
    ],
  };

  // The hint as its own developer message in the prompt tail. See
  // `documentHintTailMessage`.
  const documentHintMessages: UIMessage[] =
    documentHintPlacement === "tail-message" && documentHintText
      ? [documentHintTailMessage(thread.id, documentHintText)]
      : [];

  return {
    thread,
    user,
    history: [...history, userUIMessage],
    modelHistory: [
      ...summaryPrefix,
      ...history,
      ...documentHintMessages,
      userUIMessage,
    ],
    documentHint:
      documentHintPlacement === "developer-message" ? documentHintText : undefined,
    documentHintText,
    documentHintPlacement,
    threadDocumentIds: chatDocumentIds,
    personaDocumentIds,
    defaultTools: thread.defaultTools,
    extensions,
    attachedFiles: thread.attachedFiles ?? [],
    turnId,
    compaction,
    // Same last-step-first, roll-up-as-fallback rule as the budget input
    // above: both describe the size of a prompt.
    previousRequestPromptTokens:
      thread.usage?.lastPromptTokens ?? thread.usage?.lastInputTokens,
  };
}
