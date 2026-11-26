import "server-only";

import { z } from "zod";
import { tool } from "ai";
import { logWarn } from "@/features/common/services/logger";
import type { SharePointFileSession } from "@/features/persona-page/persona-services/sharepoint-files/sharepoint-file-access";
import { supportedExtensionsText } from "@/features/persona-page/persona-services/sharepoint-files/sharepoint-file-models";
import { SHAREPOINT_FILE_RULES } from "@/features/persona-page/persona-services/sharepoint-files/sharepoint-file-limits";

/**
 * Model tools for the SharePoint files of an agent. Registered only when the
 * agent has linked SharePoint folders/files AND the code interpreter is on
 * (see buildToolset). Both share one SharePointFileSession per request.
 *
 * The descriptions depend only on the agent's sources (names, in a fixed
 * order) and the limits, so they stay byte-identical across the turns of a
 * thread (prompt-cache stability).
 */

const sourceList = (session: SharePointFileSession): string =>
  session.sources
    .map((s) => `"${s.name.replace(/["\r\n]/g, " ")}" (${s.kind})`)
    .join(", ");

export function findSharePointFilesTool(session: SharePointFileSession) {
  return tool({
    description:
      `List or search files in the SharePoint folders and files linked to this agent: ${sourceList(session)}. ` +
      `Searches file names and folder paths (case-insensitive, all words must match), up to ${SHAREPOINT_FILE_RULES.maxDepth} folder levels deep, at most ${SHAREPOINT_FILE_RULES.maxFindResults} results. ` +
      "Returns name, path, size, last change and id. " +
      "When your instructions or an index already give the exact file name, skip this and call fetch_sharepoint_file with that name.",
    inputSchema: z.object({
      query: z
        .string()
        .max(200)
        .optional()
        .describe("Words in the file name or path. Empty: list all files."),
      path: z
        .string()
        .max(200)
        .optional()
        .describe("Only files below this folder path, relative to a linked folder, e.g. 2024/events."),
    }),
    execute: async (args: { query?: string; path?: string }) => {
      try {
        return await session.find(args);
      } catch (error) {
        logWarn("find_sharepoint_files failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return { error: "The SharePoint files could not be listed. Try again." };
      }
    },
  });
}

export function fetchSharePointFileTool(
  session: SharePointFileSession,
  limits: { maxFetchesPerRequest: number; maxFileBytes: number; imageMaxPx: number },
  target: "code-interpreter" | "workspace" = "code-interpreter",
) {
  return tool({
    description:
      (target === "workspace"
        ? "Download ONE file from the SharePoint folders linked to this agent into the chat's file workspace (/workspace/uploads/). Returns its path; read it with view or rg (a document also gets its text as <path>.md). "
        : "Download ONE file from the SharePoint folders linked to this agent into the code interpreter (/mnt/data). Returns the file's path in the code interpreter. ") +
      "Use the exact file name from your instructions, a skill or an index, or the id from find_sharepoint_files. " +
      `Fetch only the files the task really needs: at most ${limits.maxFetchesPerRequest} per message. ` +
      `Images come as SharePoint's preview image: a JPEG that fits ${limits.imageMaxPx}x${limits.imageMaxPx} px, also for very large originals (TIFF, HEIC and PSD too; the name ends in .jpg). ` +
      `Other files, and images without a preview, may be up to ${limits.maxFileBytes / 1_000_000} MB. Supported types: ${supportedExtensionsText()}. ` +
      "If several files have the name, the candidates are returned: fetch one by id.",
    inputSchema: z.object({
      id: z.string().max(200).optional().describe("The file id from find_sharepoint_files."),
      name: z
        .string()
        .max(400)
        .optional()
        .describe("The exact file name, or its path below the linked folder (sub/name.jpg)."),
    }),
    execute: async (args: { id?: string; name?: string }) => {
      try {
        return await session.fetch(args);
      } catch (error) {
        logWarn("fetch_sharepoint_file failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return { error: "The file could not be fetched. Try again." };
      }
    },
  });
}
