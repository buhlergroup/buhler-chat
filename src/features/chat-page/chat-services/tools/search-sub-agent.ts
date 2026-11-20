import "server-only";

import { z } from "zod";
import { tool } from "ai";
import { logInfo, logError } from "@/features/common/services/logger";
import { FindAllPersonaForCurrentUser } from "@/features/persona-page/persona-services/persona-service";
import type { ToolContext } from "./tool-context";

/**
 * AI SDK v5 tool for searching available sub-agents by keyword.
 *
 * JSON Schema matches function-registry.ts `search_sub_agent` definition
 * exactly for prompt-cache stability.
 */
export function searchSubAgentTool(_ctx: ToolContext) {
  return tool({
    description:
      "Search for available specialized agents (personas) the user has access to. " +
      "Pass a topic keyword (e.g. 'python', 'docs', 'kubernetes') to narrow results, " +
      "or pass an empty string / '*' / 'all' to list every available agent. " +
      "Returns matching agents with their id, name, and description. " +
      "After finding a relevant agent, use call_sub_agent with the agent's id to delegate a task.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Topic keyword to filter agents. " +
            "Matches against agent names and descriptions (case-insensitive). " +
            "Pass an empty string, '*', or 'all' to list every available agent."
        ),
    }),
    execute: async (args: { query: string }) => {
      logInfo("searchSubAgentTool: executing", { query: args.query });

      const allPersonasResponse = await FindAllPersonaForCurrentUser();
      if (allPersonasResponse.status !== "OK") {
        logError("searchSubAgentTool: failed to fetch personas");
        throw new Error("Failed to search for agents. Please try again.");
      }

      const rawQuery = args.query?.trim() ?? "";
      const isListAll =
        rawQuery === "" ||
        rawQuery === "*" ||
        rawQuery.toLowerCase() === "all";
      const query = rawQuery.toLowerCase();

      const matchingAgents = allPersonasResponse.response
        .filter((persona) => {
          if (isListAll) return true;
          const nameMatch = persona.name.toLowerCase().includes(query);
          const descMatch = persona.description.toLowerCase().includes(query);
          return nameMatch || descMatch;
        })
        .map((persona) => ({
          id: persona.id,
          name: persona.name,
          description: persona.description,
        }));

      logInfo("searchSubAgentTool: completed", {
        query: args.query,
        resultCount: matchingAgents.length,
      });

      const summary = matchingAgents.length === 0
        ? `No agents found matching "${args.query}". Try a different keyword, or pass '*' to list every available agent.`
        : isListAll
          ? `Listed all ${matchingAgents.length} available agent(s). Use call_sub_agent with the agent's id to delegate a task.`
          : `Found ${matchingAgents.length} agent(s) matching "${args.query}". Use call_sub_agent with the agent's id to delegate a task.`;

      return {
        query: args.query,
        agents: matchingAgents,
        summary,
      };
    },
  });
}
