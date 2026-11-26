/**
 * Maps Copilot runtime session events to AI SDK UI message stream chunks, so
 * the existing client (useChat), the stream publisher / resume and the
 * persistence path see the same wire format as on the AI SDK path.
 *
 *   assistant.reasoning_delta   -> reasoning-start / reasoning-delta
 *   assistant.message_delta     -> text-start / text-delta
 *   assistant.message           -> closes the open parts; ends one model call
 *   tool.execution_start        -> tool-input-available
 *   tool.execution_complete     -> tool-output-available | tool-output-error
 *   assistant.usage             -> summed into the turn usage
 *   session.error               -> error
 *   abort                       -> abort
 *   session.idle                -> finish (with usage metadata)
 *
 * One model call is one AI SDK "step" (start-step ... finish-step).
 *
 * Sub-agents: the parent's `task` call becomes ONE tool part `sub_agent`
 * (input: agent and task; output: the sub-agent's answer), rendered as
 * "Sub-agent <name>". Events of the sub-agent itself (envelope `agentId`)
 * add their model usage to the turn and are otherwise not shown.
 *
 * Runtime compactions become the `data-compaction` notice the AI SDK path
 * uses (see compactionPart).
 *
 * Pure and synchronous: the caller feeds events and writes the chunks.
 */
import type { UIMessageChunk } from "ai";
import { COMPACTION_DATA_PART_TYPE, COMPACTION_PART_ID, type CompactionDataPart } from "../chat-api/compaction-part";

/** The runtime's tool that starts a sub-agent, and the tool part the chat shows for it. */
export const RUNTIME_SUBAGENT_TOOL = "task";
export const SUBAGENT_PART_TOOL = "sub_agent";

/** Tokens of one model (or one sub-agent). */
export interface UsageBucket {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
}

const emptyBucket = (): UsageBucket => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 });

/** One runtime compaction, as the session reported it. */
export interface RuntimeCompaction {
  success: boolean;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
}

/** The data-compaction part for a runtime compaction (no turn count: the runtime summarises the whole older history). */
export function compactionPart(c: RuntimeCompaction): CompactionDataPart {
  return {
    type: COMPACTION_DATA_PART_TYPE,
    id: COMPACTION_PART_ID,
    data: {
      status: "done",
      trimmedTurns: 0,
      summaryOutcome: c.success ? "ok" : "failed",
      durationMs: c.durationMs ?? 0,
      ...(typeof c.preTokens === "number" ? { tokensBefore: c.preTokens } : {}),
      ...(typeof c.postTokens === "number" ? { tokensAfter: c.postTokens } : {}),
    },
  };
}

/** The part of a Copilot session event this mapper reads. */
export interface CopilotEventLike {
  type: string;
  agentId?: string;
  // Event payloads differ per type; each branch below reads its own fields.
  data?: any;
}

/** Token usage of one turn, summed over all model calls. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Input tokens of the LAST model call (the prompt size now in context). */
  lastInputTokens?: number;
  /** Number of model calls of the main agent. */
  calls: number;
  /** Tokens per model, main agent AND sub-agents (cost is priced per model). */
  byModel: Record<string, UsageBucket>;
  /** Tokens per sub-agent name (included in the totals above). */
  bySubAgent: Record<string, UsageBucket>;
  /** Time to first token of the first model call, as the runtime measured it. */
  firstTimeToFirstTokenMs?: number;
}

export interface MappedToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  dynamic: true;
}

export interface MappedStep {
  text: string;
  reasoningText: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: MappedToolResult[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    inputTokenDetails: { cacheReadTokens: number; cacheWriteTokens: number };
  };
}

export type MappedFinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";

/** onFinish-shaped result, for persistAssistantFromFinishEvent. */
export interface MappedTurnResult {
  text: string;
  reasoningText?: string;
  toolResults: MappedToolResult[];
  steps: MappedStep[];
  finishReason: MappedFinishReason;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    inputTokenDetails: { cacheReadTokens: number; cacheWriteTokens: number };
    outputTokenDetails: { reasoningTokens: number };
  };
  aborted: boolean;
  error?: { message: string; name?: string };
}

export interface EventMapperOptions {
  /** Names of the app's own tools; every other tool is a runtime built-in. */
  appToolNames: ReadonlySet<string>;
  /** Metadata for the terminal `finish` chunk (usage for the header). */
  finishMetadata?: (usage: TurnUsage) => unknown;
  /** Raw tool output by call id (from the tool adapter); preferred over the runtime's text. */
  rawToolOutput?: (toolCallId: string) => { output?: unknown } | undefined;
  /** UI-safe error text of an app tool call (see ToolUserError); built-ins use the runtime's text. */
  toolErrorText?: (toolCallId: string) => string | undefined;
  /** Display name of a sub-agent by its runtime name. */
  subAgentDisplayName?: (name: string) => string;
  /** Runtime name of a sub-agent instance (envelope agentId), for usage per sub-agent. */
  subAgentNameOf?: (agentId: string) => string | undefined;
  /** Text shown for a runtime session error (the details go to the log). */
  errorText?: (message: string, errorType?: string) => string;
}

const FINISH_REASONS: Record<string, MappedFinishReason> = {
  stop: "stop",
  end_turn: "stop",
  length: "length",
  max_tokens: "length",
  content_filter: "content-filter",
  tool_calls: "tool-calls",
  tool_use: "tool-calls",
};

export class CopilotEventMapper {
  private readonly steps: MappedStep[] = [];
  private stepState: "none" | "open" | "closed" = "none";
  private openTextId: string | undefined;
  private openReasoningId: string | undefined;
  private readonly streamedTextIds = new Set<string>();
  private readonly streamedReasoningIds = new Set<string>();
  private readonly toolCalls = new Map<string, { toolName: string; input: unknown; step: MappedStep }>();
  private readonly usage: TurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    calls: 0,
    byModel: {},
    bySubAgent: {},
  };
  private readonly compactionStarts: number[] = [];
  private lastFinishReason: MappedFinishReason = "stop";
  private error: { message: string; name?: string } | undefined;
  private aborted = false;
  private started = false;
  private finished = false;

  constructor(
    private readonly emit: (chunk: UIMessageChunk) => void,
    private readonly options: EventMapperOptions,
  ) {}

  /** Opens the message. Call once before the first event. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.emit({ type: "start" });
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get turnUsage(): Readonly<TurnUsage> {
    return this.usage;
  }

  /** Feeds one event. Returns true once the turn is over (session.idle). */
  handle(event: CopilotEventLike): boolean {
    if (this.finished) return true;
    const data = event.data ?? {};
    if (event.agentId) {
      // A sub-agent's own events: only its model usage counts (into the turn).
      if (event.type === "assistant.usage") this.onUsage(data, event.agentId);
      return false;
    }
    this.start();
    switch (event.type) {
      case "assistant.reasoning_delta":
        this.onReasoningDelta(String(data.reasoningId ?? "reasoning"), String(data.deltaContent ?? ""));
        break;
      case "assistant.reasoning":
        this.onReasoningComplete(String(data.reasoningId ?? "reasoning"), String(data.content ?? ""));
        break;
      case "assistant.message_delta":
        this.onTextDelta(String(data.messageId ?? "text"), String(data.deltaContent ?? ""));
        break;
      case "assistant.message":
        this.onMessage(data);
        break;
      case "assistant.usage":
        this.onUsage(data);
        break;
      case "tool.execution_start":
        this.onToolStart(data);
        break;
      case "tool.execution_complete":
        this.onToolComplete(data);
        break;
      case "session.error":
        this.error = { message: String(data.message ?? "Unknown error"), name: data.errorType };
        this.lastFinishReason = "error";
        this.emit({ type: "error", errorText: this.uiErrorText(this.error.message, this.error.name) });
        break;
      case "session.compaction_start":
        this.compactionStarts.push(Date.now());
        break;
      case "session.compaction_complete":
        this.emitCompaction({
          success: data.success === true,
          preTokens: data.preCompactionTokens,
          postTokens: data.postCompactionTokens,
          durationMs: this.compactionStarts.length > 0 ? Date.now() - this.compactionStarts.shift()! : undefined,
        });
        break;
      case "abort":
        this.aborted = true;
        break;
      case "session.idle":
        if (data.aborted) this.aborted = true;
        this.finish();
        return true;
      default:
        break;
    }
    return false;
  }

  /** Ends the turn without a session.idle (e.g. the send itself failed). */
  fail(message: string, name?: string): void {
    if (this.finished) return;
    this.start();
    this.error = { message, name };
    this.lastFinishReason = "error";
    this.emit({ type: "error", errorText: this.uiErrorText(message, name) });
    this.finish();
  }

  /** Shows a runtime compaction (also one that finished between turns). */
  emitCompaction(c: RuntimeCompaction): void {
    if (this.finished || !c.success) return;
    this.start();
    this.emit(compactionPart(c) as unknown as UIMessageChunk);
  }

  private uiErrorText(message: string, name?: string): string {
    return this.options.errorText ? this.options.errorText(message, name) : message;
  }

  /** Ends the turn as aborted (stop button) when the runtime sends no idle. */
  abort(): void {
    if (this.finished) return;
    this.start();
    this.aborted = true;
    this.finish();
  }

  /** The onFinish-shaped result. Valid once the turn is over. */
  result(): MappedTurnResult {
    const last = this.steps.at(-1);
    const toolCount = this.steps.reduce((n, s) => n + s.toolResults.length, 0);
    return {
      text: last?.text ?? "",
      reasoningText: last?.reasoningText ? last.reasoningText : undefined,
      toolResults: last?.toolResults ?? [],
      steps: this.steps,
      finishReason: this.aborted
        ? "other"
        : this.error
          ? "error"
          : this.lastFinishReason === "tool-calls" && toolCount === 0
            ? "stop"
            : this.lastFinishReason,
      usage: {
        inputTokens: this.usage.inputTokens,
        outputTokens: this.usage.outputTokens,
        totalTokens: this.usage.inputTokens + this.usage.outputTokens,
        inputTokenDetails: {
          cacheReadTokens: this.usage.cacheReadTokens,
          cacheWriteTokens: this.usage.cacheWriteTokens,
        },
        outputTokenDetails: { reasoningTokens: this.usage.reasoningTokens },
      },
      aborted: this.aborted,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  // ── steps and parts ─────────────────────────────────────────────────────
  private currentStep(): MappedStep {
    if (this.stepState === "closed") {
      this.closeParts();
      this.emit({ type: "finish-step" });
      this.stepState = "none";
    }
    if (this.stepState === "none") {
      this.emit({ type: "start-step" });
      this.steps.push({ text: "", reasoningText: "", toolCalls: [], toolResults: [] });
      this.stepState = "open";
    }
    return this.steps[this.steps.length - 1];
  }

  /** The step tool events attach to: the last one, without opening a new one. */
  private toolStep(): MappedStep {
    return this.steps.length > 0 && this.stepState !== "none" ? this.steps[this.steps.length - 1] : this.currentStep();
  }

  private closeReasoning(): void {
    if (this.openReasoningId === undefined) return;
    this.emit({ type: "reasoning-end", id: this.openReasoningId });
    this.openReasoningId = undefined;
  }

  private closeText(): void {
    if (this.openTextId === undefined) return;
    this.emit({ type: "text-end", id: this.openTextId });
    this.openTextId = undefined;
  }

  private closeParts(): void {
    this.closeReasoning();
    this.closeText();
  }

  private onReasoningDelta(id: string, delta: string): void {
    if (!delta) return;
    const step = this.currentStep();
    this.closeText();
    if (this.openReasoningId !== id) {
      this.closeReasoning();
      this.openReasoningId = id;
      this.emit({ type: "reasoning-start", id });
    }
    this.streamedReasoningIds.add(id);
    step.reasoningText += delta;
    this.emit({ type: "reasoning-delta", id, delta });
  }

  private onReasoningComplete(id: string, content: string): void {
    if (this.streamedReasoningIds.has(id) || !content) {
      this.closeReasoning();
      return;
    }
    const step = this.currentStep();
    this.closeText();
    this.emit({ type: "reasoning-start", id });
    this.emit({ type: "reasoning-delta", id, delta: content });
    this.emit({ type: "reasoning-end", id });
    this.streamedReasoningIds.add(id);
    step.reasoningText += content;
  }

  private onTextDelta(id: string, delta: string): void {
    if (!delta) return;
    const step = this.currentStep();
    this.closeReasoning();
    if (this.openTextId !== id) {
      this.closeText();
      this.openTextId = id;
      this.emit({ type: "text-start", id });
    }
    this.streamedTextIds.add(id);
    step.text += delta;
    this.emit({ type: "text-delta", id, delta });
  }

  private onMessage(data: any): void {
    const id = String(data.messageId ?? `text-${this.steps.length}`);
    const content = typeof data.content === "string" ? data.content : "";
    const reasoning = typeof data.reasoningText === "string" ? data.reasoningText : "";
    const step = this.currentStep();
    if (reasoning && !step.reasoningText) {
      // Reasoning that was not streamed as deltas: show it before the text.
      const rid = `${id}-reasoning`;
      this.closeText();
      this.emit({ type: "reasoning-start", id: rid });
      this.emit({ type: "reasoning-delta", id: rid, delta: reasoning });
      this.emit({ type: "reasoning-end", id: rid });
      step.reasoningText = reasoning;
    }
    this.closeReasoning();
    if (content && !this.streamedTextIds.has(id)) {
      this.closeText();
      this.emit({ type: "text-start", id });
      this.emit({ type: "text-delta", id, delta: content });
      this.emit({ type: "text-end", id });
      this.streamedTextIds.add(id);
      step.text += content;
    } else if (content && step.text !== content) {
      // The final message is authoritative for the stored text.
      step.text = content;
    }
    this.closeText();
    for (const req of Array.isArray(data.toolRequests) ? data.toolRequests : []) {
      step.toolCalls.push({ toolCallId: req.toolCallId, toolName: req.name, input: req.arguments ?? {} });
    }
    this.stepState = "closed";
  }

  private onUsage(data: any, agentId?: string): void {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const input = num(data.inputTokens);
    const output = num(data.outputTokens);
    const cacheRead = num(data.cacheReadTokens);
    const cacheWrite = num(data.cacheWriteTokens);
    this.usage.inputTokens += input;
    this.usage.outputTokens += output;
    this.usage.cacheReadTokens += cacheRead;
    this.usage.cacheWriteTokens += cacheWrite;
    this.usage.reasoningTokens += num(data.reasoningTokens);
    const add = (bucket: UsageBucket) => {
      bucket.inputTokens += input;
      bucket.outputTokens += output;
      bucket.cacheReadTokens += cacheRead;
      bucket.cacheWriteTokens += cacheWrite;
      bucket.calls += 1;
    };
    const model = typeof data.model === "string" && data.model ? data.model : "unknown";
    add((this.usage.byModel[model] ??= emptyBucket()));
    if (agentId) {
      // A sub-agent's call: billed with the turn, but not a step of the main agent.
      const name = this.options.subAgentNameOf?.(agentId) ?? "unknown";
      add((this.usage.bySubAgent[name] ??= emptyBucket()));
      return;
    }
    this.usage.lastInputTokens = input;
    this.usage.calls += 1;
    if (this.usage.firstTimeToFirstTokenMs === undefined && typeof data.timeToFirstTokenMs === "number") {
      this.usage.firstTimeToFirstTokenMs = data.timeToFirstTokenMs;
    }
    if (typeof data.finishReason === "string") {
      this.lastFinishReason = FINISH_REASONS[data.finishReason] ?? "other";
    }
    if (data.contentFilterTriggered === true) this.lastFinishReason = "content-filter";
    const step = this.steps.at(-1);
    if (step) {
      step.usage = {
        inputTokens: input,
        outputTokens: output,
        inputTokenDetails: { cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
      };
    }
  }

  private isDynamic(toolName: string): boolean {
    return !this.options.appToolNames.has(toolName);
  }

  private onToolStart(data: any): void {
    const toolCallId = String(data.toolCallId);
    let toolName = String(data.toolName ?? "unknown");
    let input = data.arguments ?? {};
    if (toolName === RUNTIME_SUBAGENT_TOOL) {
      // A sub-agent start: one "Sub-agent <name>" part with the task.
      const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
      const agentType = String(args.agent_type ?? "");
      toolName = SUBAGENT_PART_TOOL;
      input = {
        agent: this.options.subAgentDisplayName?.(agentType) ?? agentType,
        agentName: agentType,
        task: String(args.description ?? args.name ?? ""),
        prompt: String(args.prompt ?? ""),
      };
    }
    const step = this.toolStep();
    this.closeParts();
    this.toolCalls.set(toolCallId, { toolName, input, step });
    if (!step.toolCalls.some((c) => c.toolCallId === toolCallId)) {
      step.toolCalls.push({ toolCallId, toolName, input });
    }
    this.emit({
      type: "tool-input-available",
      toolCallId,
      toolName,
      input,
      ...(this.isDynamic(toolName) ? { dynamic: true } : {}),
    });
  }

  private onToolComplete(data: any): void {
    const toolCallId = String(data.toolCallId);
    const call = this.toolCalls.get(toolCallId);
    const toolName = call?.toolName ?? "unknown";
    const dynamic = this.isDynamic(toolName) ? { dynamic: true } : {};
    if (data.success === true) {
      const raw = this.options.rawToolOutput?.(toolCallId);
      let output =
        raw && "output" in raw ? raw.output : (data.result?.content ?? data.result?.detailedContent ?? null);
      if (toolName === SUBAGENT_PART_TOOL) {
        output = { agent: (call?.input as { agent?: string } | undefined)?.agent ?? "", response: output };
      }
      this.emit({ type: "tool-output-available", toolCallId, output, ...dynamic });
      (call?.step ?? this.toolStep()).toolResults.push({
        type: "tool-result",
        toolCallId,
        toolName,
        input: call?.input ?? {},
        output,
        dynamic: true,
      });
      return;
    }
    const errorText =
      this.options.toolErrorText?.(toolCallId) ??
      String(data.error?.message ?? data.result?.content ?? "Tool execution failed");
    this.emit({ type: "tool-output-error", toolCallId, errorText, ...dynamic });
  }

  private finish(): void {
    this.closeParts();
    if (this.stepState !== "none") this.emit({ type: "finish-step" });
    this.stepState = "none";
    this.finished = true;
    if (this.aborted) {
      this.emit({ type: "abort" });
      return;
    }
    const metadata = this.options.finishMetadata?.(this.usage);
    const finishReason = this.result().finishReason;
    this.emit({
      type: "finish",
      finishReason,
      ...(metadata !== undefined ? { messageMetadata: metadata } : {}),
    });
  }
}
