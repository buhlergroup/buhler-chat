'use server';
import "server-only";

import { metrics } from "@opentelemetry/api";
import { userHashedId, userSession } from "@/features/auth-page/helpers";

function getChatMeter(){
    const meter = metrics.getMeter("chat");
    return meter;
}

async function getAttributes(chatModel: string){
    const user = await userSession();
    const userId = await userHashedId();
    const attributes = { "email": user?.email, "name": user?.name, "userHashedId": userId, "chatModel": chatModel };
    return attributes;
}

/**
 * Turn-shape dimensions carried by every chat metric.
 *
 * `stepCount` is the number of model steps in the turn and `toolCallCount`
 * the number of tool calls across those steps. Both are always emitted, 0
 * when the caller has nothing to report, so a query can split cache hit
 * rates by tool turns vs plain turns without having to cope with a missing
 * dimension on half the series.
 */
export interface ChatTurnShape {
    stepCount?: number;
    toolCallCount?: number;
}

/**
 * Normalise the turn-shape dimensions: always present, always a
 * non-negative integer. A dimension that is sometimes a string and sometimes
 * a number splits the series in App Insights, so coerce rather than pass
 * through.
 */
function withTurnShape(attributes: any = {}) {
    const asCount = (value: unknown) => {
        const n = typeof value === "number" ? value : Number(value);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    };
    return {
        ...attributes,
        stepCount: asCount(attributes?.stepCount),
        toolCallCount: asCount(attributes?.toolCallCount),
    };
}

export async function reportPromptTokens(tokenCount: number, model: string, role: string, attributes: any = {}) {

    const meter = getChatMeter();

    const promptTokensUsed = meter.createHistogram("promptTokensUsed", {
        description: "Number of tokens used in the input prompt",
        unit: "tokens",
    });

    let defaultAttributes = <any>await getAttributes(model);

    // Do NOT write `role` onto the caller's object. persist-assistant hands the
    // same attribute reference to all five emitters inside one Promise.all;
    // mutating it here leaked `role` into whichever of the others had not yet
    // taken its own copy. It happened to be safe only because this function
    // awaited getAttributes first — a statement reorder was all it took to
    // start tagging cachedTokensUsed and cacheWriteTokensUsed with a role.
    let combinedAttributes = withTurnShape({
        ...defaultAttributes,
        ...attributes,
        role,
    });

    promptTokensUsed.record(tokenCount, combinedAttributes);
}

export async function reportCompletionTokens(tokenCount: number, model: string, attributes: any = {}) {

        const meter = getChatMeter();

        const completionsTokensUsed = meter.createHistogram("completionsTokensUsed", {
            description: "Number of tokens used in the completions",
            unit: "tokens",
        });

        let combinedAttributes = withTurnShape({ ...attributes, ...await getAttributes(model) });

        completionsTokensUsed.record(tokenCount, combinedAttributes);
}

export async function reportCachedTokens(tokenCount: number, model: string, attributes: any = {}) {

    const meter = getChatMeter();

    const cachedTokensUsed = meter.createHistogram("cachedTokensUsed", {
        description: "Number of prompt tokens served from the model's prompt cache",
        unit: "tokens",
    });

    let combinedAttributes = withTurnShape({ ...attributes, ...await getAttributes(model) });

    cachedTokensUsed.record(tokenCount, combinedAttributes);
}

export async function reportCacheWriteTokens(tokenCount: number, model: string, attributes: any = {}) {

    const meter = getChatMeter();

    const cacheWriteTokensUsed = meter.createHistogram("cacheWriteTokensUsed", {
        description: "Number of prompt tokens written into the model's prompt cache (billed at a premium on GPT-5.6+)",
        unit: "tokens",
    });

    let combinedAttributes = withTurnShape({ ...attributes, ...await getAttributes(model) });

    cacheWriteTokensUsed.record(tokenCount, combinedAttributes);
}

/**
 * Token usage of a history-summariser call.
 *
 * Its own metric, and deliberately NOT part of the promptTokensUsed series:
 * this is money the platform spends on its own housekeeping, not a turn the
 * user asked for, and it is excluded from the user's daily cost cap. Mixed
 * into the chat series it would inflate every per-user cost query; on its own
 * it answers "what does compaction cost us?" — the question nobody could
 * answer while the summariser was silently 404ing.
 *
 * Dimensions are the hashed user id, the model and the thread — no email and
 * no name. New metric, so there is no existing series to stay bug-compatible
 * with, and the PII the older chat metrics carry is already a follow-up.
 */
export async function reportHistorySummaryTokens(input: {
    inputTokens: number;
    outputTokens: number;
    chatModel: string;
    threadId: string;
}) {

    const meter = getChatMeter();

    const historySummaryTokens = meter.createHistogram("historySummaryTokens", {
        description: "Tokens spent by the history summariser (compaction). Not billed to the user's cap.",
        unit: "tokens",
    });

    const attributes = {
        userHashedId: await userHashedId(),
        chatModel: input.chatModel,
        threadId: input.threadId,
    };

    // One series, split by direction, so input and output can be summed
    // together or apart without two metric names to keep in step.
    historySummaryTokens.record(Math.max(0, Math.floor(input.inputTokens || 0)), {
        ...attributes,
        direction: "input",
    });
    historySummaryTokens.record(Math.max(0, Math.floor(input.outputTokens || 0)), {
        ...attributes,
        direction: "output",
    });
}

export async function reportTruncatedTurn(model: string, attributes: any = {}) {

    const meter = getChatMeter();

    // A COUNTER, not a histogram: the question is "how often", and one series
    // that can be compared against userChatMessage gives a truncation RATE.
    const truncatedTurns = meter.createCounter("truncatedTurns", {
        description: "Turns the provider cut short at the output token ceiling (finishReason=length)",
        unit: "turns",
    });

    let combinedAttributes = withTurnShape({ ...attributes, ...await getAttributes(model) });

    truncatedTurns.add(1, combinedAttributes);
}

export async function reportUserChatMessage(model: string, attributes: any = {}) {

    const meter = getChatMeter();

    const userChatMessage = meter.createCounter("userChatMessage", {
        description: "Number of messages",
        unit: "messages",
    });

    let combinedAttributes = withTurnShape({ ...attributes, ...await getAttributes(model) });

    userChatMessage.add(1, combinedAttributes);
}
