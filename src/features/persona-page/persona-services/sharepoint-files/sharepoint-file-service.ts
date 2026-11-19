"use server";
import "server-only";

/**
 * Server actions for the SharePoint sources of an agent (the agent editor
 * calls these). Owner or admin only, the same rule as skills; checked here
 * on the server before any Graph call.
 *
 * Rules for this file: every export is an async function and nothing is
 * re-exported (a re-export in a "use server" file resolves to undefined in
 * the production build — see scripts/check-server-actions.mjs).
 */

import { ServerActionResponse } from "@/features/common/server-action-response";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { uniqueId } from "@/features/common/util";
import { logError, logInfo } from "@/features/common/services/logger";
import {
  getDriveItemInfo,
  isFileAccessDenied,
} from "@/features/common/services/sharepoint/graph-drive";
import { isGraphDriveId, isGraphItemId } from "@/features/common/services/sharepoint/graph-ids";
import { resolveSkillAccess } from "../skills/persona-skill-store";
import {
  PERSONA_FILE_SOURCE_ATTRIBUTE,
  PersonaFileSourceModelSchema,
  fileTypeRule,
  toFileSourceSummary,
  type PersonaFileSourceModel,
  type PersonaFileSourceSummary,
} from "./sharepoint-file-models";
import { queryFileSourcesByPersonaId } from "./sharepoint-file-store";
import { readSharePointFileLimits } from "./sharepoint-file-limits";

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

/**
 * The sources of an agent for the editor. Only the owner or an admin sees
 * them (they are a setting of the agent, like its instructions); everyone
 * else gets an empty list and canEdit=false.
 */
export async function FindPersonaFileSources(personaId: string): Promise<
  ServerActionResponse<{
    sources: PersonaFileSourceSummary[];
    canEdit: boolean;
    maxSources: number;
  }>
> {
  try {
    const { maxSources } = readSharePointFileLimits();
    const access = await resolveSkillAccess(personaId);
    if (!access) return notFound();
    if (!access.canEdit) {
      return { status: "OK", response: { sources: [], canEdit: false, maxSources } };
    }
    const sources = await queryFileSourcesByPersonaId(personaId);
    return {
      status: "OK",
      response: { sources: sources.map(toFileSourceSummary), canEdit: true, maxSources },
    };
  } catch (error) {
    logError("sharepoint files: list failed", {
      personaId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "ERROR", errors: [{ message: "Could not load the SharePoint files." }] };
  }
}

/**
 * Links a SharePoint folder or file to an agent. The client sends only the
 * drive and item id; name, link and kind (folder or file) come from Graph,
 * read with the current user's token.
 */
export async function AddPersonaFileSource(input: {
  personaId: string;
  driveId: string;
  itemId: string;
}): Promise<ServerActionResponse<PersonaFileSourceSummary>> {
  const personaId = typeof input?.personaId === "string" ? input.personaId : "";
  if (!personaId) return { status: "ERROR", errors: [{ message: "Save the agent first." }] };
  if (!isGraphDriveId(input.driveId) || !isGraphItemId(input.itemId)) {
    return { status: "ERROR", errors: [{ message: "Choose a folder or file from SharePoint." }] };
  }
  const { driveId, itemId } = input;

  try {
    // Owner check on the SERVER, before any Graph call.
    const access = await resolveSkillAccess(personaId);
    if (!access) return notFound();
    if (!access.canEdit) return notAllowed();

    const { maxSources } = readSharePointFileLimits();
    const existing = await queryFileSourcesByPersonaId(personaId);
    if (existing.length >= maxSources) {
      return {
        status: "ERROR",
        errors: [{ message: `An agent can have up to ${maxSources} SharePoint folders and files.` }],
      };
    }
    if (existing.some((s) => s.driveId === driveId && s.itemId === itemId)) {
      return { status: "ERROR", errors: [{ message: "The agent already uses this folder or file." }] };
    }

    const { token } = await getCurrentUser();
    let info;
    try {
      info = await getDriveItemInfo(token, driveId, itemId);
    } catch (error) {
      return {
        status: "ERROR",
        errors: [
          {
            message: isFileAccessDenied(error)
              ? "This folder or file is not available for you."
              : "SharePoint did not answer. Try again.",
          },
        ],
      };
    }
    if (!info.isFolder && !info.isFile) {
      return { status: "ERROR", errors: [{ message: "Choose a folder or a file." }] };
    }
    // The item must be in the drive the client named (Graph's answer, not
    // the client's, decides).
    if (info.parent && info.parent.driveId !== driveId) {
      return { status: "ERROR", errors: [{ message: "Choose a folder or file from SharePoint." }] };
    }
    if (info.isFile) {
      const rule = fileTypeRule(info.name);
      if (rule.kind === "refused") return { status: "ERROR", errors: [{ message: rule.message }] };
    }

    const model: PersonaFileSourceModel = {
      id: uniqueId(),
      type: PERSONA_FILE_SOURCE_ATTRIBUTE,
      // Partition with the agent's owner, like the persona row itself.
      userId: access.persona.userId,
      personaId,
      driveId,
      itemId,
      name: info.name.slice(0, 255),
      webUrl: info.webUrl,
      kind: info.isFolder ? "folder" : "file",
      createdAt: new Date(),
    };
    if (!PersonaFileSourceModelSchema.safeParse(model).success) {
      return { status: "ERROR", errors: [{ message: "The SharePoint source could not be saved." }] };
    }
    await HistoryContainer().items.upsert<PersonaFileSourceModel>(model);
    logInfo("sharepoint files: source added", { personaId, sourceId: model.id, kind: model.kind });
    return { status: "OK", response: toFileSourceSummary(model) };
  } catch (error) {
    logError("sharepoint files: add failed", {
      personaId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "ERROR", errors: [{ message: "The SharePoint source could not be saved." }] };
  }
}

/** Removes one source of an agent. Owner or admin only. */
export async function DeletePersonaFileSource(
  personaId: string,
  sourceId: string,
): Promise<ServerActionResponse<boolean>> {
  try {
    const access = await resolveSkillAccess(personaId);
    if (!access) return notFound();
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
