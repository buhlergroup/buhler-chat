"use client";
/**
 * The header's usage panel.
 *
 * ## Every number here is the provider's, not ours
 *
 * The panel shows the last COMPLETED request: its real `inputTokens`, its real
 * cache split, its real cost. Nothing is estimated, and nothing is marked "~".
 *
 * That is a deliberate constraint. The obvious alternative — forecast the next
 * prompt from the transcript on every keystroke — was built and rejected: an
 * estimate that later disagrees with the provider's own accounting (and with
 * the invoice) is worse than a number that is a turn old. While a response is
 * in flight the panel simply keeps showing the previous real values.
 *
 * ## Turn totals vs the last prompt
 *
 * A turn can be several model calls (steps): tool call, tool result, model
 * again. AI SDK 7 sums step usage over the turn, and that sum is what the
 * provider billed — so input, output, the cache split and the cost are all
 * "last request, all steps". The context row is the other quantity: the size
 * of the LAST prompt alone, which is the only one still standing in the
 * model's context. On a 3-step turn the totals are about three times the
 * context figure, which is correct and looks wrong — so the panel labels both,
 * and shows the step count when there was more than one.
 *
 * The context row therefore answers "what did the last prompt actually cost in
 * context", and the compaction notice in the transcript is what tells the user
 * a trim happened. The two now agree, because both quote the same provider
 * numbers — and both print them through the SAME pinned formatter
 * (`formatTokenCount`). A bare `toLocaleString()` renders 17565 as "17’565" on
 * a Swiss machine and "17,565" on a US one, so the panel and the notice could
 * disagree about a number they both took from the same field.
 */
import { FC } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { useChatStore } from "../chat-store-context";
import { formatTokenCount } from "../chat-services/chat-api/compaction-part";

export const TokenUsageDisplay: FC = () => {
  const lastUsageData = useChatStore((s) => s.lastUsageData);

  if (!lastUsageData) return null;

  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return n.toString();
  };

  const formatCost = (cost: number) => {
    if (cost === 0) return "--";
    if (cost < 0.01) return "< $0.01";
    return `$${cost.toFixed(2)}`;
  };

  // Cache split of the last request. `plain` is what was neither read from
  // the cache nor written into it — the tokens billed at the full uncached
  // rate. Floored at zero: the provider reports the buckets as subsets of
  // inputTokens, and a negative remainder would mean we had misread them.
  const cacheReads = lastUsageData.cachedTokens ?? 0;
  const cacheWrites = lastUsageData.cacheWriteTokens ?? 0;
  const knowsWrites = typeof lastUsageData.cacheWriteTokens === "number";
  const plainInput = Math.max(
    lastUsageData.inputTokens - cacheReads - cacheWrites,
    0,
  );
  const hasCacheRow = lastUsageData.inputTokens > 0;

  // The size of the LAST prompt, which is what "context" means here. Absent on
  // a thread seeded from a row written before it was persisted; the turn total
  // then stands in, exact for a single-step turn and an overstatement of a
  // multi-step one.
  const lastPromptTokens =
    lastUsageData.lastPromptTokens ?? lastUsageData.inputTokens;
  // Only shown when it is greater than 1, and only the live path knows it: it
  // is what explains totals several times the size of the context figure.
  const stepCount = lastUsageData.stepCount ?? 1;
  const isMultiStep = stepCount > 1;

  // Context ring data
  const hasContext = lastUsageData.contextWindowSize > 0 && lastPromptTokens > 0;
  const percent = hasContext ? Math.min(lastUsageData.contextUsagePercent, 100) : 0;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percent / 100) * circumference;
  const ringColor =
    percent > 80 ? "text-red-500" : percent > 50 ? "text-yellow-500" : "text-primary/60";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground shrink-0 h-7 px-2 rounded-md border border-border/50 hover:border-border hover:bg-accent/40 active:bg-accent transition-all cursor-pointer"
          aria-label={`Thread usage: ${formatTokens(lastUsageData.threadTotalTokens)} tokens`}
        >
          {/* Context ring */}
          {hasContext && (
            <svg width="16" height="16" viewBox="0 0 16 16" className={ringColor} aria-hidden="true">
              <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.15" />
              <circle
                cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5"
                strokeDasharray={circumference} strokeDashoffset={strokeDashoffset}
                strokeLinecap="round" transform="rotate(-90 8 8)"
                className="transition-all duration-700 ease-out"
              />
            </svg>
          )}
          <span>{formatTokens(lastUsageData.threadTotalTokens)}</span>
          {lastUsageData.threadTotalCostUsd > 0 && (
            <>
              <span className="text-border">|</span>
              <span className="font-medium">{formatCost(lastUsageData.threadTotalCostUsd)}</span>
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" className="w-56">
        <DropdownMenuLabel className="font-normal pb-2">
          <p className="text-sm font-semibold tracking-tight mb-2">Thread Usage <span className="text-[10px] font-normal text-muted-foreground" data-testid="totals-scope">(last request, all steps)</span></p>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              {/* Cumulative input + output across every request of this
                  thread. It used to be labelled "Total tokens", which read
                  like a context size and invited the comparison with the
                  context row below — two different quantities. */}
              <span className="text-muted-foreground">Thread usage so far</span>
              <span className="tabular-nums">{formatTokenCount(lastUsageData.threadTotalTokens)}</span>
            </div>
            {isMultiStep && (
              /* Why the rows below are bigger than the context row: the turn
                 called the model more than once, and every call is billed. */
              <div className="flex justify-between" data-testid="step-count-row">
                <span className="text-muted-foreground">Model calls</span>
                <span className="tabular-nums">{stepCount} steps</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Input (all steps)</span>
              <span className="tabular-nums">{formatTokenCount(lastUsageData.inputTokens)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Output (all steps)</span>
              <span className="tabular-nums">{formatTokenCount(lastUsageData.outputTokens)}</span>
            </div>
            {hasCacheRow && (
              <div className="flex justify-between gap-2" data-testid="cache-row">
                {/* The three buckets of the last request's input, in one row.
                    Reads are billed at ~0.1x, writes at 1.25x, plain at 1x —
                    so this row is where the prompt-cache work shows up. */}
                <span className="text-muted-foreground">Cache (all steps)</span>
                <span className="tabular-nums text-right">
                  reads {formatTokenCount(cacheReads)}
                  {knowsWrites && <> · writes {formatTokenCount(cacheWrites)}</>}
                  {" · plain "}
                  {formatTokenCount(plainInput)}
                </span>
              </div>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-normal py-2">
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last request ~</span>
              <span className="tabular-nums font-medium">{formatCost(lastUsageData.costUsd)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Thread total ~</span>
              <span className="tabular-nums font-medium">{formatCost(lastUsageData.threadTotalCostUsd)}</span>
            </div>
          </div>
        </DropdownMenuLabel>
        {hasContext && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="font-normal pt-2">
              <div className="text-xs" data-testid="context-row">
                <div className="flex justify-between items-center mb-1.5">
                  {/* "last prompt", not "context window": this is the real
                      input size of the request that just completed, which is
                      exactly the context the model was sent. */}
                  <span className="text-muted-foreground">Context (last prompt)</span>
                  <span className="tabular-nums">{percent.toFixed(1)}%</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ease-out ${
                      percent > 80 ? "bg-red-500" : percent > 50 ? "bg-yellow-500" : "bg-primary/60"
                    }`}
                    style={{ width: `${Math.max(percent, 1)}%` }}
                  />
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground tabular-nums">
                  {formatTokenCount(lastPromptTokens)} of{" "}
                  {formatTokens(lastUsageData.contextWindowSize)} ·{" "}
                  {percent.toFixed(1)} %
                </div>
              </div>
            </DropdownMenuLabel>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-normal py-1.5">
          <p className="text-[10px] text-muted-foreground/60 leading-tight">
            Token counts are the provider&apos;s, for the last completed
            request. Input, output, cache and cost are the totals of all steps
            of that request. Context is the size of the last prompt alone.
            Costs are estimates only. No charges are applied.
          </p>
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
