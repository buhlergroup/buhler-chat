"use client";

import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Activity } from "lucide-react";
import { USAGE_CHANGED_EVENT } from "./usage-events";

/** Poll interval while the tab is visible. */
export const USAGE_POLL_MS = 5 * 60_000;
/** A tab that becomes visible refreshes when its data is older than this. */
const VISIBLE_REFRESH_MIN_MS = 60_000;

interface UsageData {
  daily: {
    totalTokens: number;
    totalCostUsd: number;
    models: Record<string, { inputTokens: number; outputTokens: number; costUsd: number; requestCount: number }>;
  };
  weekly: {
    totalTokens: number;
    totalCostUsd: number;
  };
  limits?: {
    dailyUsd: number;
    weeklyUsd: number;
  };
}

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

function getDailyResetLabel(): string {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const diffMs = midnight.getTime() - now.getTime();
  const hours = Math.floor(diffMs / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Usage-toward-budget bar. Hidden when no limit is configured (limit <= 0).
 * Green under 80%, amber 80–99%, red once the cap is hit (the point at which
 * the user is auto-downgraded to lower-cost models).
 */
function BudgetBar({ spent, limit }: { spent: number; limit: number }) {
  if (!limit || limit <= 0) return null;
  const pct = Math.min(100, (spent / limit) * 100);
  const over = spent >= limit;
  const near = !over && pct >= 80;
  const barColor = over ? "bg-destructive" : near ? "bg-amber-500" : "bg-primary";
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Budget</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          ${spent.toFixed(2)} / ${limit.toFixed(2)}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={`h-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      {over && (
        <p className="mt-1 text-[10px] leading-tight text-destructive">
          Limit reached — now using lower-cost models.
        </p>
      )}
    </div>
  );
}

export const UserUsage = () => {
  const [usage, setUsage] = useState<UsageData | null>(null);

  const fetchUsage = async () => {
    try {
      const res = await fetch("/api/usage");
      if (res.ok) setUsage(await res.json());
    } catch { /* non-critical */ }
  };

  // Every open tab used to call /api/usage each minute, also when hidden:
  // that was most of the database reads. Now: on mount, after each chat
  // turn, when the tab becomes visible again, and every 5 minutes while
  // the tab is visible.
  useEffect(() => {
    let last = 0;
    const refresh = () => {
      last = Date.now();
      void fetchUsage();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - last > VISIBLE_REFRESH_MIN_MS) refresh();
    };
    refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, USAGE_POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(USAGE_CHANGED_EVENT, refresh);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(USAGE_CHANGED_EVENT, refresh);
    };
  }, []);

  if (!usage || (usage.daily.totalTokens === 0 && usage.weekly.totalTokens === 0)) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center justify-center gap-1 text-[10px] tabular-nums text-muted-foreground px-1.5 py-1 rounded-md hover:bg-accent/50 active:bg-accent transition-colors cursor-pointer"
          aria-label={`Today: ${formatTokens(usage.daily.totalTokens)} tokens`}
        >
          <Activity size={10} className="shrink-0" />
          <span>{formatTokens(usage.daily.totalTokens)}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" className="w-60" align="end">
        {/* Daily */}
        <DropdownMenuLabel className="font-normal pb-2">
          <div className="flex items-baseline justify-between mb-2">
            <p className="text-sm font-semibold tracking-tight">Today</p>
            <span className="text-[10px] text-muted-foreground/70">resets in {getDailyResetLabel()}</span>
          </div>
          <div className="flex gap-4 text-xs">
            <div>
              <p className="text-muted-foreground text-[10px] uppercase tracking-wider mb-0.5">Tokens</p>
              <p className="tabular-nums font-medium text-sm">{usage.daily.totalTokens.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-[10px] uppercase tracking-wider mb-0.5">Est. cost ~</p>
              <p className="tabular-nums font-medium text-sm">{formatCost(usage.daily.totalCostUsd)}</p>
            </div>
          </div>
          <BudgetBar spent={usage.daily.totalCostUsd} limit={usage.limits?.dailyUsd ?? 0} />
        </DropdownMenuLabel>

        {/* Weekly */}
        {usage.weekly.totalTokens > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="font-normal py-2">
              <div className="flex items-baseline justify-between mb-2">
                <p className="text-sm font-semibold tracking-tight">Last 7 Days</p>
                <span className="text-[10px] text-muted-foreground/70">rolling 7-day sum</span>
              </div>
              <div className="flex gap-4 text-xs">
                <div>
                  <p className="text-muted-foreground text-[10px] uppercase tracking-wider mb-0.5">Tokens</p>
                  <p className="tabular-nums font-medium text-sm">{usage.weekly.totalTokens.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-[10px] uppercase tracking-wider mb-0.5">Est. cost ~</p>
                  <p className="tabular-nums font-medium text-sm">{formatCost(usage.weekly.totalCostUsd)}</p>
                </div>
              </div>
              <BudgetBar spent={usage.weekly.totalCostUsd} limit={usage.limits?.weeklyUsd ?? 0} />
            </DropdownMenuLabel>
          </>
        )}

        {/* Per-model breakdown */}
        {Object.keys(usage.daily.models).length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="font-normal pt-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Models (today)</p>
              <div className="space-y-1">
                {Object.entries(usage.daily.models).map(([model, data]) => (
                  <div key={model} className="flex items-center justify-between text-xs">
                    <span className="truncate text-muted-foreground">{model}</span>
                    <div className="flex items-center gap-2 tabular-nums shrink-0">
                      <span className="text-muted-foreground/70">{data.requestCount}req</span>
                      <span className="font-medium w-14 text-right">{formatCost(data.costUsd)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </DropdownMenuLabel>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-normal py-1.5">
          <p className="text-[10px] text-muted-foreground/60 leading-tight">Costs are estimates for informational purposes only. No charges are applied to your cost center.</p>
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
