export const USER_USAGE_ATTRIBUTE = "USER_USAGE";

export interface ModelUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  requestCount: number;
}

/**
 * One model's share of a turn: its tokens and its cost at its own price.
 * A turn can use several models (the chat model, sub-agents, the tools'
 * own model calls); each is counted under its own model id.
 */
export interface ModelUsageIncrement {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens?: number;
  costUsd: number;
}

export interface UserUsageModel {
  id: string;
  userId: string;
  date: string;
  type: typeof USER_USAGE_ATTRIBUTE;
  models: Record<string, ModelUsageBreakdown>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCostUsd: number;
}

import type { ChatModel } from "@/features/chat-page/chat-services/models";

export interface LimitCheckResult {
  exceeded: boolean;
  limitType?: "tokens" | "cost";
  currentUsage?: number;
  limit?: number;
  fallbackModel?: ChatModel;
}
