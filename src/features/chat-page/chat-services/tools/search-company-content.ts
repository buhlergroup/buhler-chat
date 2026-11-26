import "server-only";

import { z } from "zod";
import { tool } from "ai";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { logInfo, logDebug, logError } from "@/features/common/services/logger";
import type { ToolContext } from "./tool-context";

function extractTitleFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split("/").filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1] ?? "Untitled";
    return decodeURIComponent(
      lastPart.replace(/\.[^/.]+$/, "").replace(/_/g, " ")
    );
  } catch {
    return "Untitled";
  }
}

/**
 * AI SDK v5 tool for Microsoft Graph Copilot Retrieval.
 *
 * JSON Schema matches function-registry.ts `search_company_content` definition
 * exactly for prompt-cache stability.
 */
export function searchCompanyContentTool(ctx: ToolContext) {
  return tool({
    description:
      "Search for relevant content from company SharePoint, OneDrive, and connected data sources. " +
      "Use this tool when the user asks questions about company policies, internal documents, " +
      "procedures, or any information that might be in corporate repositories. " +
      "This searches across all content the user has access to.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Natural language query to search for relevant company content. " +
            "Should be a clear, concise question or topic (max 1500 characters)."
        ),
      dataSource: z
        .string()
        .nullable()
        .optional()
        .describe(
          "The data source to search. Options: 'sharePoint' (SharePoint sites), " +
            "'oneDriveBusiness' (OneDrive for Business). Default: 'sharePoint'."
        ),
      maxResults: z
        .number()
        .nullable()
        .optional()
        .describe("Maximum number of results to return (1-25). Default: 10."),
    }),
    execute: async (
      args: { query: string; dataSource?: string | null; maxResults?: number | null },
      { abortSignal }: { abortSignal?: AbortSignal }
    ) => {
      logInfo("searchCompanyContentTool: executing", {
        queryLength: args.query?.length ?? 0,
        dataSource: args.dataSource ?? "sharePoint",
        maxResults: args.maxResults ?? 10,
        threadId: ctx.threadId,
      });
      logDebug("searchCompanyContentTool: query", { query: args.query });

      const user = await getCurrentUser();
      const token = user.token;

      if (!token) {
        logError("searchCompanyContentTool: no access token");
        throw new Error(
          "Unable to search company content: No access token available. Please sign in again."
        );
      }

      const dataSource = args.dataSource ?? "sharePoint";
      const maxResults = Math.min(Math.max(args.maxResults ?? 10, 1), 25);

      const response = await fetch(
        "https://graph.microsoft.com/v1.0/copilot/retrieval",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            queryString: args.query.substring(0, 1500),
            dataSource,
            resourceMetadata: ["title", "author"],
            maximumNumberOfResults: maxResults,
          }),
          signal: abortSignal,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        logError("searchCompanyContentTool: request failed", {
          status: response.status,
          error: errorText,
        });

        if (response.status === 401) {
          throw new Error(
            "Company content search failed: Authorization expired. Please sign in again."
          );
        }
        if (response.status === 403) {
          throw new Error(
            "Company content search failed: Insufficient permissions. " +
              "The required permission for content search is Files.Read.All."
          );
        }
        throw new Error(
          `Company content search failed: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();
      const hits: any[] = data.retrievalHits ?? [];

      logInfo("searchCompanyContentTool: completed", { resultCount: hits.length });

      const results = hits.map((hit: any, index: number) => {
        const title =
          hit.resourceMetadata?.title ?? extractTitleFromUrl(hit.webUrl);
        const author = hit.resourceMetadata?.author ?? "Unknown";
        const extracts: any[] = hit.extracts ?? [];

        return {
          index: index + 1,
          title,
          author,
          url: hit.webUrl,
          resourceType: hit.resourceType,
          sensitivityLabel: hit.sensitivityLabel?.displayName ?? null,
          content: extracts.map((e: any) => e.text).join("\n\n"),
          relevanceScores: extracts
            .map((e: any) => e.relevanceScore)
            .filter(Boolean),
        };
      });

      const contextText = results
        .map((r) => {
          const label = r.sensitivityLabel ? ` [${r.sensitivityLabel}]` : "";
          return `[${r.index}] ${r.title} (by ${r.author})${label}\nSource: ${r.url}\nContent:\n${r.content}\n`;
        })
        .join("\n---\n");

      return {
        query: args.query,
        dataSource,
        results,
        contextText,
        summary: `Found ${results.length} relevant company documents for: "${args.query}". Use this content to ground your response and cite sources when relevant.`,
        resultCount: results.length,
      };
    },
  });
}
