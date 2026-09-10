import "server-only";

import { z } from "zod";
import { tool, generateText, isStepCount } from "ai";
import { logInfo, logDebug, logError } from "@/features/common/services/logger";
import { FindPersonaByID } from "@/features/persona-page/persona-services/persona-service";
import { MODEL_CONFIGS, DEFAULT_MODEL, type ChatModel } from "../models";
import { resolveProvider } from "../models/provider-seam";
import { resolveMaxOutputTokens } from "../models/max-output-tokens";
import { resolveReasoningEffort } from "../models/reasoning-effort";
import { stabilizeToolset } from "./stabilize-toolset";
import { computeTokenCostUsd } from "../chat-api/usage-data";
import type { ToolContext } from "./tool-context";

const MAX_SUB_AGENT_DEPTH = 2;

/**
 * AI SDK v5 tool that delegates a task to a specialized sub-agent persona.
 *
 * Recursion guard: each nested context increments depth; at MAX_SUB_AGENT_DEPTH
 * the sub-agent's toolset is empty (fail-closed) so no infinite loop can form.
 *
 * JSON Schema matches function-registry.ts `call_sub_agent` definition
 * exactly for prompt-cache stability.
 */
export function callSubAgentTool(ctx: ToolContext) {
  return tool({
    description:
      "Delegate a task to a specialized sub-agent. " +
      "Use this when a question or task is better handled by another agent with specific expertise. " +
      "The sub-agent will process the task independently and return its response.",
    inputSchema: z.object({
      agent_id: z
        .string()
        .describe("The unique identifier of the sub-agent to call."),
      task: z
        .string()
        .describe(
          "The task or question to delegate to the sub-agent. " +
            "Be specific and provide all necessary context."
        ),
    }),
    execute: async (
      args: { agent_id: string; task: string },
      { abortSignal }: { abortSignal?: AbortSignal }
    ) => {
      logInfo("callSubAgentTool: executing", {
        agentId: args.agent_id,
        taskLength: args.task?.length ?? 0,
        threadId: ctx.threadId,
        depth: ctx.depth ?? 0,
      });

      // Resolve persona
      const personaResponse = await FindPersonaByID(args.agent_id);
      if (personaResponse.status !== "OK") {
        logError("callSubAgentTool: persona not found", {
          agentId: args.agent_id,
          status: personaResponse.status,
        });
        throw new Error(
          `Agent "${args.agent_id}" was not found or you do not have access to it.`
        );
      }

      const persona = personaResponse.response;

      // Resolve model
      const modelId =
        (persona.selectedModel as ChatModel | undefined) ?? DEFAULT_MODEL;
      const modelConfig = MODEL_CONFIGS[modelId];
      if (!modelConfig?.deploymentName) {
        throw new Error(
          `The model "${modelId}" configured for agent "${persona.name}" is not available.`
        );
      }

      // Build sub-context and tools (recursion-guarded)
      const currentDepth = ctx.depth ?? 0;
      let subToolset: Record<string, any> = {};

      if (currentDepth < MAX_SUB_AGENT_DEPTH) {
        // Lazy import to avoid a circular dependency at module load time.
        const { buildToolset } = await import("./registry");

        const subCtx: ToolContext = {
          user: ctx.user,
          threadId: ctx.threadId,
          threadDocumentIds: ctx.threadDocumentIds,
          personaDocumentIds: persona.personaDocumentIds ?? [],
          defaultTools: persona.defaultTools ?? {},
          extensions: [], // Sub-agents don't inherit thread extensions
          // A sub-agent's own sub-agents are read off the persona; the
          // tool only registers when the persona declares them, matching
          // the top-level behaviour.
          subAgentIds: persona.subAgentIds,
          depth: currentDepth + 1,
        };

        subToolset = await buildToolset(subCtx);
      } else {
        logInfo(
          "callSubAgentTool: max recursion depth reached, running sub-agent with no tools",
          { depth: currentDepth, agentId: args.agent_id }
        );
      }

      // Resolve the model AND its provider options through the same seam the
      // main /api/chat path uses. Before this the tool called
      // resolveAzureModel directly and sent NO providerOptions at all, which
      // meant: no promptCacheKey (so a repeated delegation never hit the
      // prompt cache and re-wrote its whole prefix every time), no
      // store: false (the turn was retained server-side), no reasoning
      // effort — the model fell back to its provider default — and Claude /
      // Foundry personas were wrongly resolved as Azure models.
      //
      // Built-in tool toggles stay off: a sub-agent has never had access to
      // code_interpreter / image_generation / web_search, and turning them on
      // here would be a behaviour change, not a cache fix.
      const resolved = resolveProvider({
        modelId,
        thread: { id: ctx.threadId, codeInterpreterContainerId: undefined },
        toggles: {
          codeInterpreter: false,
          imageGeneration: false,
          webSearch: false,
        },
        reasoning: {
          supported: modelConfig.supportsReasoning,
          // Same resolution as the main path minus the user pick (a sub-agent
          // turn has no picker): REASONING_EFFORT_OVERRIDES → model default.
          effort: resolveReasoningEffort({ modelId }),
        },
        // A sub-agent's prefix is its own persona message plus the delegated
        // task — nothing in common with the parent thread's prefix, so it
        // gets its own cache key namespace rather than polluting the
        // parent's.
        promptCacheKey: `${ctx.threadId}:sub:${args.agent_id}`,
      });

      logDebug("callSubAgentTool: calling generateText", {
        agentName: persona.name,
        model: modelConfig.deploymentName,
        taskPreview: args.task.substring(0, 200),
        toolCount: Object.keys(subToolset).length,
      });

      const result = await generateText({
        model: resolved.model,
        instructions: persona.personaMessage,
        messages: [{ role: "user", content: args.task }],
        // Same canonical tool order as the main path — a sub-agent's prefix
        // is cached under its own key and has to be just as stable.
        tools: stabilizeToolset(subToolset, Object.keys(resolved.builtInTools)),
        // Via the resolver, so MAX_OUTPUT_TOKENS_OVERRIDES reaches the
        // sub-agent too. Reading modelConfig directly here and in the route
        // was two call sites for one decision.
        maxOutputTokens: resolveMaxOutputTokens({
          modelId,
          modelValue: modelConfig.maxOutputTokens,
        }),
        stopWhen: isStepCount(8),
        providerOptions: resolved.providerOptions,
        abortSignal,
      });

      // ai@7's LanguageModelUsage keeps cache accounting under
      // inputTokenDetails (cacheReadTokens / cacheWriteTokens) only — the flat
      // `cachedInputTokens` alias v6 also exposed is gone, so there is no
      // second field left to probe.
      //
      // `result.usage` is now the roll-up over ALL steps. In v6 it was the
      // FINAL step's usage, so a sub-agent that used its 8-step budget
      // reported only its last step here and the delegation looked cheaper
      // than it was. Nothing to do but take the new number: it is the one the
      // provider billed.
      const inputTokens = result.usage?.inputTokens ?? 0;
      const outputTokens = result.usage?.outputTokens ?? 0;
      const cachedTokens =
        result.usage?.inputTokenDetails?.cacheReadTokens ?? 0;
      const cacheWriteTokens =
        result.usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
      const totalTokens =
        result.usage?.totalTokens ?? inputTokens + outputTokens;

      const costUsd = computeTokenCostUsd({
        inputTokens,
        outputTokens,
        cachedTokens,
        cacheWriteTokens,
        pricing: modelConfig.pricing,
      });

      logInfo("callSubAgentTool: completed", {
        agentId: args.agent_id,
        agentName: persona.name,
        responseLength: result.text.length,
        inputTokens,
        outputTokens,
        cachedTokens,
        cacheWriteTokens,
        costUsd,
      });

      return {
        agentName: persona.name,
        agentId: args.agent_id,
        model: modelId,
        response: result.text,
        summary: `Agent "${persona.name}" responded successfully.`,
        usage: {
          inputTokens,
          outputTokens,
          cachedTokens,
          cacheWriteTokens,
          totalTokens,
          costUsd,
        },
      };
    },
  });
}
