"use client";
import { FC } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { useChat } from "../chat-store";

export const TokenUsageDisplay: FC = () => {
  const { lastUsageData } = useChat();

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

  // Context ring data
  const hasContext = lastUsageData.contextWindowSize > 0 && lastUsageData.inputTokens > 0;
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
          <p className="text-sm font-semibold tracking-tight mb-2">Thread Usage <span className="text-[10px] font-normal text-muted-foreground">(estimated)</span></p>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total tokens</span>
              <span className="tabular-nums">{lastUsageData.threadTotalTokens.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last input</span>
              <span className="tabular-nums">{lastUsageData.inputTokens.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last output</span>
              <span className="tabular-nums">{lastUsageData.outputTokens.toLocaleString()}</span>
            </div>
            {lastUsageData.cachedTokens > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Cached</span>
                <span className="tabular-nums">{lastUsageData.cachedTokens.toLocaleString()}</span>
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
              <div className="text-xs">
                <div className="flex justify-between items-center mb-1.5">
                  <span className="text-muted-foreground">Context window</span>
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
                <div className="flex justify-between mt-1 text-[10px] text-muted-foreground">
                  <span>{formatTokens(lastUsageData.inputTokens)}</span>
                  <span>{formatTokens(lastUsageData.contextWindowSize)}</span>
                </div>
              </div>
            </DropdownMenuLabel>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-normal py-1.5">
          <p className="text-[10px] text-muted-foreground/60 leading-tight">Costs are estimates only. No charges are applied.</p>
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
