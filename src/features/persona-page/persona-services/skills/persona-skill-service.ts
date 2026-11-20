"use server";
import "server-only";

/**
 * Server actions for agent skills (the agent editor calls these).
 *
 * Rules for this file: every export is an async function and nothing is
 * re-exported (a re-export in a "use server" file resolves to undefined in
 * the production build — see PR #199 and scripts/check-server-actions.mjs).
 */

import { ServerActionResponse } from "@/features/common/server-action-response";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { DeleteBlob, UploadBlob } from "@/features/common/services/azure-storage";
import { uniqueId } from "@/features/common/util";
import { logError, logInfo } from "@/features/common/services/logger";
import {
  PERSONA_SKILL_ATTRIBUTE,
  PersonaSkillModelSchema,
  SKILL_LIMITS,
  toSkillSummary,
  type PersonaSkillModel,
  type PersonaSkillSummary,
} from "./skill-models";
import { SkillZipError, validateSkillZip } from "./skill-zip";
import {
  deleteSkillOpenAiFile,
  querySkillsByPersonaId,
  resolveSkillAccess,
  skillBlobContainer,
  skillBlobName,
} from "./persona-skill-store";

const notAllowed = <T,>(): ServerActionResponse<T> => ({
  status: "UNAUTHORIZED",
  errors: [{ message: "Only the owner of the agent or an admin can change its skills." }],
});

const notFound = <T,>(): ServerActionResponse<T> => ({
  status: "NOT_FOUND",
  errors: [{ message: "Agent not found." }],
});

/**
 * Lists the skills of an agent for everyone who can open the agent, and
 * tells the editor whether the current user may change them.
 */
export async function FindPersonaSkills(
  personaId: string,
): Promise<ServerActionResponse<{ skills: PersonaSkillSummary[]; canEdit: boolean }>> {
  try {
    const access = await resolveSkillAccess(personaId);
    if (!access) return notFound();
    if (!access.canUse) {
      return { status: "UNAUTHORIZED", errors: [{ message: "You do not have access to this agent." }] };
    }
    const skills = await querySkillsByPersonaId(personaId);
    return {
      status: "OK",
      response: { skills: skills.map(toSkillSummary), canEdit: access.canEdit },
    };
  } catch (error) {
    logError("agent skills: list failed", {
      personaId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "ERROR", errors: [{ message: "Could not load the skills." }] };
  }
}

/**
 * Adds a skill from a .zip, or replaces one (`replaceSkillId`).
 * FormData fields: personaId, file, replaceSkillId (optional).
 */
export async function UploadPersonaSkill(
  formData: FormData,
): Promise<ServerActionResponse<PersonaSkillSummary>> {
  const personaId = String(formData.get("personaId") ?? "");
  const replaceSkillId = String(formData.get("replaceSkillId") ?? "") || undefined;
  // Duck-typed: the runtime's File class differs between Node and test DOMs.
  const entry = formData.get("file");
  const file =
    entry && typeof entry === "object" && typeof (entry as Blob).arrayBuffer === "function"
      ? (entry as Blob & { name?: string })
      : undefined;

  if (!personaId) return { status: "ERROR", errors: [{ message: "Save the agent first." }] };
  if (!file || file.size === 0) {
    return { status: "ERROR", errors: [{ message: "Choose a .zip file." }] };
  }
  if (file.size > SKILL_LIMITS.maxZipBytes) {
    return {
      status: "ERROR",
      errors: [{ message: `The zip is larger than ${SKILL_LIMITS.maxZipBytes / 1_000_000} MB.` }],
    };
  }

  try {
    // Owner check on the SERVER, before any work on the upload.
    const access = await resolveSkillAccess(personaId);
    if (!access) return notFound();
    if (!access.canEdit) return notAllowed();

    const existing = await querySkillsByPersonaId(personaId);
    const replaced = replaceSkillId
      ? existing.find((s) => s.id === replaceSkillId)
      : undefined;
    if (replaceSkillId && !replaced) {
      return { status: "NOT_FOUND", errors: [{ message: "Skill not found." }] };
    }
    if (!replaced && existing.length >= SKILL_LIMITS.maxSkillsPerAgent) {
      return {
        status: "ERROR",
        errors: [{ message: `An agent can have up to ${SKILL_LIMITS.maxSkillsPerAgent} skills.` }],
      };
    }

    const buf = Buffer.from(await file.arrayBuffer());
    let pkg;
    try {
      pkg = await validateSkillZip(buf);
    } catch (error) {
      if (error instanceof SkillZipError) {
        return { status: "ERROR", errors: [{ message: error.message }] };
      }
      throw error;
    }

    const clash = existing.find((s) => s.name === pkg.name && s.id !== replaced?.id);
    if (clash) {
      return {
        status: "ERROR",
        errors: [{ message: `The agent already has the skill "${pkg.name}". Use Replace on it.` }],
      };
    }

    const skillId = replaced?.id ?? uniqueId();
    const blobName = skillBlobName(personaId, skillId);
    await UploadBlob(skillBlobContainer(), blobName, buf, {
      contentType: "application/zip",
      metadata: { personaid: personaId, skillname: pkg.name },
    });

    const now = new Date();
    const fileName = typeof file.name === "string" && file.name ? file.name : `${pkg.name}.zip`;
    const model: PersonaSkillModel = {
      id: skillId,
      type: PERSONA_SKILL_ATTRIBUTE,
      // Partition with the agent's owner, like the persona row itself.
      userId: access.persona.userId,
      personaId,
      name: pkg.name,
      description: pkg.description,
      skillMd: pkg.skillMd,
      rootPrefix: pkg.rootPrefix,
      files: pkg.files,
      zipFileName: fileName.slice(0, 255),
      zipBytes: pkg.zipBytes,
      uncompressedBytes: pkg.uncompressedBytes,
      blobName,
      createdAt: replaced ? new Date(replaced.createdAt) : now,
      updatedAt: now,
    };
    const parsed = PersonaSkillModelSchema.safeParse(model);
    if (!parsed.success) {
      await DeleteBlob(skillBlobContainer(), blobName);
      return { status: "ERROR", errors: [{ message: "The skill could not be saved." }] };
    }

    await HistoryContainer().items.upsert<PersonaSkillModel>(model);
    if (replaced && replaced.blobName !== blobName) {
      await DeleteBlob(skillBlobContainer(), replaced.blobName);
    }
    // The new version gets its own OpenAI file on first use; the old one
    // goes (best effort). Running chats are mapped onto the new file by
    // resolveSkillCodeInterpreterFiles.
    if (replaced) await deleteSkillOpenAiFile(replaced.openAiFileId);

    logInfo("agent skills: skill saved", {
      personaId,
      skillId,
      name: pkg.name,
      files: pkg.files.length,
      zipBytes: pkg.zipBytes,
      replaced: Boolean(replaced),
    });
    return { status: "OK", response: toSkillSummary(model) };
  } catch (error) {
    logError("agent skills: upload failed", {
      personaId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "ERROR", errors: [{ message: "The skill could not be saved." }] };
  }
}

/** Deletes one skill of an agent. Owner only. */
export async function DeletePersonaSkill(
  personaId: string,
  skillId: string,
): Promise<ServerActionResponse<boolean>> {
  try {
    const access = await resolveSkillAccess(personaId);
    if (!access) return notFound();
    if (!access.canEdit) return notAllowed();

    const skill = (await querySkillsByPersonaId(personaId)).find((s) => s.id === skillId);
    if (!skill) return { status: "NOT_FOUND", errors: [{ message: "Skill not found." }] };

    await HistoryContainer().item(skill.id, skill.userId).delete();
    await DeleteBlob(skillBlobContainer(), skill.blobName);
    await deleteSkillOpenAiFile(skill.openAiFileId);
    logInfo("agent skills: skill deleted", { personaId, skillId, name: skill.name });
    return { status: "OK", response: true };
  } catch (error) {
    logError("agent skills: delete failed", {
      personaId,
      skillId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "ERROR", errors: [{ message: "The skill could not be deleted." }] };
  }
}
