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

function getWeeklyResetLabel(): string {
  const now = new Date();
  const friday = new Date(now);
  const dayOfWeek = now.getDay();
  let daysUntilFri = (5 - dayOfWeek + 7) % 7;
  if (daysUntilFri === 0 && now.getHours() >= 17) daysUntilFri = 7;
  friday.setDate(now.getDate() + daysUntilFri);
  friday.setHours(17, 0, 0, 0);
  const diffMs = friday.getTime() - now.getTime();
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  if (days > 1) return `Fri 17:00 (${days}d)`;
  if (days === 1) return `1d ${hours}h`;
  return `${hours}h`;
}

export const UserUsage = () => {
  const [usage, setUsage] = useState<UsageData | null>(null);

  const fetchUsage = async () => {
    try {
      const res = await fetch("/api/usage");
      if (res.ok) setUsage(await res.json());
    } catch { /* non-critical */ }
  };

  useEffect(() => {
    fetchUsage();
    const interval = setInterval(fetchUsage, 60_000);
    return () => clearInterval(interval);
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
        </DropdownMenuLabel>

        {/* Weekly */}
        {usage.weekly.totalTokens > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="font-normal py-2">
              <div className="flex items-baseline justify-between mb-2">
                <p className="text-sm font-semibold tracking-tight">This Week</p>
                <span className="text-[10px] text-muted-foreground/70">resets {getWeeklyResetLabel()}</span>
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
