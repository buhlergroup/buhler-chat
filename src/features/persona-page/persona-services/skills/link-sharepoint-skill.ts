import "server-only";

/**
 * Links a skill to a .zip in SharePoint / OneDrive. Chats then use the
 * newest version of that file (see linked-skill-sync.ts). Owner/admin only.
 * The file is read with the current user's token and validated like an
 * upload; the caller sends only the drive and item id, everything else
 * (name, link, version) comes from Graph.
 *
 * Not a "use server" module: the agent files actions call it, and it takes
 * an already fetched zip (`prefetched`), which must never come from the
 * client.
 */

import { ServerActionResponse } from "@/features/common/server-action-response";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { DeleteBlob, UploadBlob } from "@/features/common/services/azure-storage";
import { uniqueId } from "@/features/common/util";
import { logError, logInfo } from "@/features/common/services/logger";
import { rememberDriveItemVersion } from "@/features/common/services/sharepoint/drive-item-check-cache";
import {
  PERSONA_SKILL_ATTRIBUTE,
  PersonaSkillModelSchema,
  SKILL_LIMITS,
  isGraphDriveId,
  isGraphItemId,
  toSkillSummary,
  type PersonaSkillModel,
  type PersonaSkillSummary,
} from "./skill-models";
import {
  querySkillsByPersonaId,
  resolveSkillAccess,
  skillBlobContainer,
  skillBlobName,
} from "./persona-skill-store";
import { withinSkillLimit } from "./skill-limit";
import {
  buildSharePointSource,
  fetchLinkedSkillZip,
  packageFields,
  type LinkedZipResult,
} from "./linked-skill-sync";

export type LinkedSkillResult = ServerActionResponse<PersonaSkillSummary>;

export async function linkSharePointSkill(
  input: { personaId: string; driveId: string; itemId: string },
  prefetched?: Extract<LinkedZipResult, { ok: true }>,
): Promise<LinkedSkillResult> {
  const personaId = typeof input?.personaId === "string" ? input.personaId : "";
  if (!personaId) return { status: "ERROR", errors: [{ message: "Save the agent first." }] };
  if (!isGraphDriveId(input.driveId) || !isGraphItemId(input.itemId)) {
    return { status: "ERROR", errors: [{ message: "Choose a .zip file from SharePoint." }] };
  }
  const { driveId, itemId } = input;

  try {
    const access = await resolveSkillAccess(personaId);
    if (!access || !access.canUse) {
      return { status: "NOT_FOUND", errors: [{ message: "Agent not found." }] };
    }
    if (!access.canEdit) {
      return {
        status: "UNAUTHORIZED",
        errors: [{ message: "Only the owner of the agent or an admin can change its skills." }],
      };
    }

    const existing = await querySkillsByPersonaId(personaId);
    if (existing.length >= SKILL_LIMITS.maxSkillsPerAgent) {
      return {
        status: "ERROR",
        errors: [{ message: `An agent can have up to ${SKILL_LIMITS.maxSkillsPerAgent} skills.` }],
      };
    }
    if (existing.some((s) => s.source?.driveId === driveId && s.source.itemId === itemId)) {
      return { status: "ERROR", errors: [{ message: "The agent already uses this file." }] };
    }

    let fetched: LinkedZipResult | undefined = prefetched;
    if (!fetched) {
      const { token } = await getCurrentUser();
      fetched = await fetchLinkedSkillZip(token, driveId, itemId);
    }
    if (!fetched.ok) {
      return { status: "ERROR", errors: [{ message: fetched.message }] };
    }
    const { meta, buf, pkg } = fetched;

    if (existing.some((s) => s.name === pkg.name)) {
      return {
        status: "ERROR",
        errors: [{ message: `The agent already has the skill "${pkg.name}".` }],
      };
    }

    const skillId = uniqueId();
    const blobName = skillBlobName(personaId, skillId);
    const stored = await UploadBlob(skillBlobContainer(), blobName, buf, {
      contentType: "application/zip",
      metadata: { personaid: personaId, skillname: pkg.name },
    });
    if (stored.status !== "OK") {
      return { status: "ERROR", errors: [{ message: "The skill could not be saved." }] };
    }

    const now = new Date();
    const model: PersonaSkillModel = {
      id: skillId,
      type: PERSONA_SKILL_ATTRIBUTE,
      userId: access.persona.userId,
      personaId,
      ...packageFields(pkg),
      zipFileName: meta.name.slice(0, 255),
      blobName,
      source: buildSharePointSource(meta, driveId, itemId),
      createdAt: now,
      updatedAt: now,
    };
    if (!PersonaSkillModelSchema.safeParse(model).success) {
      await DeleteBlob(skillBlobContainer(), blobName);
      return { status: "ERROR", errors: [{ message: "The skill could not be saved." }] };
    }
    await HistoryContainer().items.upsert<PersonaSkillModel>(model);

    // Adds of several requests at the same time each saw fewer skills than
    // the limit: counted again after the insert. Over the limit, this add is
    // undone (row and blob), so the agent never keeps more than the limit.
    if (!(await withinSkillLimit(personaId, model))) {
      return {
        status: "ERROR",
        errors: [{ message: `An agent can have up to ${SKILL_LIMITS.maxSkillsPerAgent} skills.` }],
      };
    }
    rememberDriveItemVersion(driveId, itemId, meta, access.currentUserId);

    logInfo("agent skills: SharePoint skill linked", {
      personaId,
      skillId,
      name: pkg.name,
      files: pkg.files.length,
      zipBytes: pkg.zipBytes,
    });
    return { status: "OK", response: toSkillSummary(model) };
  } catch (error) {
    logError("agent skills: link from SharePoint failed", {
      personaId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "ERROR", errors: [{ message: "The skill could not be saved." }] };
  }
}
