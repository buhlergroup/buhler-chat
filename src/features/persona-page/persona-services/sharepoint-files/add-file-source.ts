import "server-only";

/**
 * Links a SharePoint folder or file to an agent ("On demand" in the agent
 * editor). The caller sends only the drive and item id; name, link and kind
 * (folder or file) come from Graph, read with the current user's token.
 * Owner or admin only, checked here before any Graph call.
 *
 * Not a "use server" module: the agent files actions call it, and it takes
 * Graph metadata that was already read (`knownInfo`), which must never come
 * from the client.
 */

import { ServerActionResponse } from "@/features/common/server-action-response";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { uniqueId } from "@/features/common/util";
import { logError, logInfo } from "@/features/common/services/logger";
import {
  getDriveItemInfo,
  isFileAccessDenied,
  type DriveItemInfo,
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

export async function addPersonaFileSource(
  input: { personaId: string; driveId: string; itemId: string },
  knownInfo?: DriveItemInfo,
): Promise<ServerActionResponse<PersonaFileSourceSummary>> {
  const personaId = typeof input?.personaId === "string" ? input.personaId : "";
  if (!personaId) return { status: "ERROR", errors: [{ message: "Save the agent first." }] };
  if (!isGraphDriveId(input.driveId) || !isGraphItemId(input.itemId)) {
    return { status: "ERROR", errors: [{ message: "Choose a folder or file from SharePoint." }] };
  }
  const { driveId, itemId } = input;

  try {
    // Owner check on the SERVER, before any Graph call.
    const access = await resolveSkillAccess(personaId);
    if (!access) return { status: "NOT_FOUND", errors: [{ message: "Agent not found." }] };
    if (!access.canEdit) {
      return {
        status: "UNAUTHORIZED",
        errors: [
          { message: "Only the owner of the agent or an admin can change its SharePoint files." },
        ],
      };
    }

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

    let info = knownInfo;
    if (!info) {
      const { token } = await getCurrentUser();
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
