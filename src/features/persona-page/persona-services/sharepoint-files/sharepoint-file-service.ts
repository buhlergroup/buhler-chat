"use server";
import "server-only";

/**
 * Server actions for the SharePoint sources ("On demand" files) of an agent.
 * Owner or admin only, the same rule as skills; checked here on the server.
 * Adding a source is in add-file-source.ts (the agent files actions call it).
 *
 * Rules for this file: every export is an async function and nothing is
 * re-exported (a re-export in a "use server" file resolves to undefined in
 * the production build — see scripts/check-server-actions.mjs).
 */

import { ServerActionResponse } from "@/features/common/server-action-response";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { logError, logInfo } from "@/features/common/services/logger";
import { resolveSkillAccess } from "../skills/persona-skill-store";
import { queryFileSourcesByPersonaId } from "./sharepoint-file-store";

const notAllowed = <T,>(): ServerActionResponse<T> => ({
  status: "UNAUTHORIZED",
  errors: [
    { message: "Only the owner of the agent or an admin can change its SharePoint files." },
  ],
});

const notFound = <T,>(): ServerActionResponse<T> => ({
  status: "NOT_FOUND",
  errors: [{ message: "Agent not found." }],
});

/** Removes one source of an agent. Owner or admin only. */
export async function DeletePersonaFileSource(
  personaId: string,
  sourceId: string,
): Promise<ServerActionResponse<boolean>> {
  try {
    // Open rights first: for an agent the user cannot open, the answer is
    // the one of an unknown agent. Then edit rights.
    const access = await resolveSkillAccess(personaId);
    if (!access || !access.canUse) return notFound();
    if (!access.canEdit) return notAllowed();
    const source = (await queryFileSourcesByPersonaId(personaId)).find((s) => s.id === sourceId);
    if (!source) return { status: "NOT_FOUND", errors: [{ message: "Source not found." }] };
    await HistoryContainer().item(source.id, source.userId).delete();
    logInfo("sharepoint files: source removed", { personaId, sourceId });
    return { status: "OK", response: true };
  } catch (error) {
    logError("sharepoint files: remove failed", {
      personaId,
      sourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "ERROR", errors: [{ message: "The SharePoint source could not be removed." }] };
  }
}
