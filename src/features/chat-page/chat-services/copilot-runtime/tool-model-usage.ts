/**
 * Model calls an app tool makes itself (web_search and run_code call the
 * Responses API outside the runtime) must count in the turn usage like the
 * runtime's own calls: same totals, own model bucket, own price.
 *
 * The tool adapter runs every app tool call inside the turn's sink
 * (TurnToolBinding.onModelUsage); a tool reports its call with
 * reportToolModelUsage and the turn's event mapper adds it to TurnUsage.
 * Outside a turn (no sink) a report is dropped.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelCallUsage } from "./event-mapper";

export type ModelUsageSink = (usage: ModelCallUsage) => void;

const sinks = new AsyncLocalStorage<ModelUsageSink>();

/** Runs `fn` with `sink` receiving the model calls it reports. */
export function withModelUsageSink<T>(sink: ModelUsageSink | undefined, fn: () => T): T {
  return sink ? sinks.run(sink, fn) : fn();
}

/** Adds a tool's own model call to the running turn's usage. */
export function reportToolModelUsage(usage: ModelCallUsage | undefined): void {
  if (!usage) return;
  sinks.getStore()?.(usage);
}

/**
 * The usage of one Responses API call under `model` (the MODEL_CONFIGS id of
 * the deployment that served it); undefined when the response has none.
 * `input_tokens` includes the cached ones, as the turn totals do.
 */
export function responsesCallUsage(model: string, usage: unknown): ModelCallUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const inputDetails = (u.input_tokens_details ?? {}) as Record<string, unknown>;
  const outputDetails = (u.output_tokens_details ?? {}) as Record<string, unknown>;
  const result: ModelCallUsage = {
    model,
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(inputDetails.cached_tokens),
    cacheWriteTokens: num(inputDetails.cache_write_tokens),
    reasoningTokens: num(outputDetails.reasoning_tokens),
  };
  return result.inputTokens > 0 || result.outputTokens > 0 ? result : undefined;
}
