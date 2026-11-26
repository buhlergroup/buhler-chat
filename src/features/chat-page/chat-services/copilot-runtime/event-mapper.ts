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
 * One model call is one AI SDK "step" (start-step ... finish-step). Events of
 * runtime sub-agents (envelope `agentId`) are ignored: the app's own
 * call_sub_agent tool is an ordinary custom tool.
 *
 * Pure and synchronous: the caller feeds events and writes the chunks.
 */
import type { UIMessageChunk } from "ai";

/** The part of a Copilot session event this mapper reads. */
export interface CopilotEventLike {
  type: string;
  agentId?: string;
  // Event payloads differ per type; each branch below reads its own fields.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  /** Number of model calls. */
  calls: number;
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
  };
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
    if (event.agentId) return false;
    this.start();
    const data = event.data ?? {};
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
        this.emit({ type: "error", errorText: this.error.message });
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
    this.emit({ type: "error", errorText: message });
    this.finish();
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onUsage(data: any): void {
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onToolStart(data: any): void {
    const toolCallId = String(data.toolCallId);
    const toolName = String(data.toolName ?? "unknown");
    const input = data.arguments ?? {};
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onToolComplete(data: any): void {
    const toolCallId = String(data.toolCallId);
    const call = this.toolCalls.get(toolCallId);
    const toolName = call?.toolName ?? "unknown";
    const dynamic = this.isDynamic(toolName) ? { dynamic: true } : {};
    if (data.success === true) {
      const raw = this.options.rawToolOutput?.(toolCallId);
      const output =
        raw && "output" in raw ? raw.output : (data.result?.content ?? data.result?.detailedContent ?? null);
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
    const errorText = String(data.error?.message ?? data.result?.content ?? "Tool execution failed");
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
