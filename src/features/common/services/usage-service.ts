"use server";
import "server-only";

import { userHashedId } from "@/features/auth-page/helpers";
import { HistoryContainer } from "./cosmos";
import { ChatModel, MODEL_CONFIGS } from "@/features/chat-page/chat-services/models";
import { logError, logInfo } from "./logger";
import { SqlQuerySpec } from "@azure/cosmos";
import {
  USER_USAGE_ATTRIBUTE,
  UserUsageModel,
  LimitCheckResult,
  type ModelUsageIncrement,
} from "./usage-models";

function getTodayDateString(): string {
  return new Date().toISOString().split("T")[0];
}

function getUsageDocId(userId: string, date: string): string {
  return `${userId}-usage-${date}`;
}

export async function GetOrCreateDailyUsage(
  userId: string,
  date?: string
): Promise<UserUsageModel> {
  const d = date || getTodayDateString();
  const docId = getUsageDocId(userId, d);

  try {
    const { resource } = await HistoryContainer()
      .item(docId, userId)
      .read<UserUsageModel>();

    if (resource && resource.type === USER_USAGE_ATTRIBUTE) {
      return resource;
    }
  } catch {
    // Document doesn't exist, create it
  }

  const newDoc: UserUsageModel = {
    id: docId,
    userId,
    date: d,
    type: USER_USAGE_ATTRIBUTE,
    models: {},
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedTokens: 0,
    totalCostUsd: 0,
  };

  return newDoc;
}

/**
 * Adds one turn to the user's daily usage: each model the turn used under
 * its own id, with its own cost (one read-modify-write for all of them, so
 * the models of one turn cannot overwrite each other). Each model's
 * requestCount grows by one: the number of turns that used it.
 */
export async function IncrementUsage(
  userId: string,
  entries: ReadonlyArray<ModelUsageIncrement>
): Promise<void> {
  try {
    if (entries.length === 0) return;
    const usage = await GetOrCreateDailyUsage(userId);

    for (const { model, inputTokens, outputTokens, cachedTokens, costUsd } of entries) {
      const existing = usage.models[model] || {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        requestCount: 0,
      };

      usage.models[model] = {
        inputTokens: existing.inputTokens + inputTokens,
        outputTokens: existing.outputTokens + outputTokens,
        cachedTokens: existing.cachedTokens + cachedTokens,
        costUsd: existing.costUsd + costUsd,
        requestCount: existing.requestCount + 1,
      };

      usage.totalInputTokens += inputTokens;
      usage.totalOutputTokens += outputTokens;
      usage.totalCachedTokens += cachedTokens;
      usage.totalCostUsd += costUsd;
    }

    await HistoryContainer().items.upsert(usage);
    logInfo("Updated daily usage", { userId, models: entries.map((e) => e.model), date: usage.date });
  } catch (error) {
    logError("Failed to increment usage", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function GetDailyUsage(
  userId?: string,
  date?: string
): Promise<UserUsageModel> {
  const uid = userId || (await userHashedId());
  return GetOrCreateDailyUsage(uid, date);
}

export async function GetWeeklyUsage(
  userId?: string
): Promise<UserUsageModel[]> {
  const uid = userId || (await userHashedId());
  const today = new Date();
  const weekAgo = new Date(today);
  // -6, not -7: with an inclusive >= comparison below, this yields exactly a
  // 7-calendar-day window (today and the preceding 6 days).
  weekAgo.setDate(weekAgo.getDate() - 6);
  const weekAgoStr = weekAgo.toISOString().split("T")[0];

  try {
    const querySpec: SqlQuerySpec = {
      query:
        "SELECT * FROM root r WHERE r.type=@type AND r.userId=@userId AND r.date >= @startDate ORDER BY r.date DESC",
      parameters: [
        { name: "@type", value: USER_USAGE_ATTRIBUTE },
        { name: "@userId", value: uid },
        { name: "@startDate", value: weekAgoStr },
      ],
    };

    const { resources } = await HistoryContainer()
      .items.query<UserUsageModel>(querySpec, { partitionKey: uid })
      .fetchAll();

    return resources;
  } catch (error) {
    logError("Failed to get weekly usage", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function CheckLimits(
  userId: string,
  model: ChatModel
): Promise<LimitCheckResult> {
  const config = MODEL_CONFIGS[model];
  if (!config) {
    return { exceeded: false };
  }

  const hasTokenLimit = config.dailyTokenLimit && config.dailyTokenLimit > 0;
  const hasCostLimit = config.dailyCostLimit && config.dailyCostLimit > 0;

  if (!hasTokenLimit && !hasCostLimit) {
    return { exceeded: false };
  }

  try {
    const usage = await GetOrCreateDailyUsage(userId);
    const modelUsage = usage.models[model];

    if (!modelUsage) {
      return { exceeded: false };
    }

    if (hasTokenLimit) {
      const totalTokens = modelUsage.inputTokens + modelUsage.outputTokens;
      if (totalTokens >= config.dailyTokenLimit!) {
        return {
          exceeded: true,
          limitType: "tokens",
          currentUsage: totalTokens,
          limit: config.dailyTokenLimit!,
          fallbackModel: config.fallbackModel,
        };
      }
    }

    if (hasCostLimit) {
      if (modelUsage.costUsd >= config.dailyCostLimit!) {
        return {
          exceeded: true,
          limitType: "cost",
          currentUsage: modelUsage.costUsd,
          limit: config.dailyCostLimit!,
          fallbackModel: config.fallbackModel,
        };
      }
    }

    return { exceeded: false };
  } catch (error) {
    logError("Failed to check limits", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { exceeded: false };
  }
}
