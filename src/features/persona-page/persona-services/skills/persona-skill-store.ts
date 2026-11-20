import "server-only";

/**
 * persona-skill-store.ts — storage and access for agent skills.
 *
 * Not a "use server" module on purpose: it is reached only from server code
 * (the skill server actions, persona-service, the chat route and the
 * load_skill tool) and has sync exports. The client-callable surface is
 * persona-skill-service.ts.
 *
 * Storage:
 *   - Cosmos (history container, partition = agent owner's hashed id): one
 *     PERSONA_SKILL row per skill with name, description, SKILL.md text and
 *     the file manifest.
 *   - Blob: the original zip at `agent-skills/<personaId>/<skillId>-<ts>.zip`
 *     in the private skill container (AZURE_STORAGE_SKILL_CONTAINER_NAME,
 *     default "agent-skills"; infra/resources.bicep creates it).
 *   - Azure OpenAI files: one copy of each skill version's zip for the code
 *     interpreter, uploaded on first use; its id is cached on the row.
 *   - Linked skills (SharePoint) are stored the same way; each chat request
 *     checks their file once and stores a new version when it changed
 *     (linked-skill-sync.ts).
 */

import { SqlQuerySpec } from "@azure/cosmos";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { OpenAIV1Instance } from "@/features/common/services/openai";
import { HistoryContainer } from "@/features/common/services/cosmos";
import {
  DeleteBlob,
  GetBlob,
} from "@/features/common/services/azure-storage";
import { logError, logInfo, logWarn } from "@/features/common/services/logger";
import {
  canEditPersona,
  canOpenPersona,
  currentPersonaViewer,
  type PersonaAccessFields,
  type PersonaViewer,
} from "../persona-access";
import { PERSONA_ATTRIBUTE, type PersonaModel } from "../models";
import type { AttachedFileModel } from "@/features/chat-page/chat-services/models";
import { UploadFileForCodeInterpreter } from "@/features/chat-page/chat-services/code-interpreter-service";
import {
  PERSONA_SKILL_ATTRIBUTE,
  skillArchiveFileName,
  type PersonaSkillModel,
} from "./skill-models";
import { readSkillZipFile } from "./skill-zip";
import {
  syncLinkedSkills,
  type LinkedSkillDeps,
  type SyncedSkills,
} from "./linked-skill-sync";

/**
 * Private blob container for skill packages (no public access). The name
 * comes from AZURE_STORAGE_SKILL_CONTAINER_NAME, set by the Bicep; the
 * default matches the Bicep default.
 */
export const skillBlobContainer = (): string =>
  process.env.AZURE_STORAGE_SKILL_CONTAINER_NAME || "agent-skills";

export const SKILL_BLOB_PREFIX = "agent-skills";

export const skillBlobName = (personaId: string, skillId: string): string =>
  `${SKILL_BLOB_PREFIX}/${personaId}/${skillId}-${Date.now()}.zip`;

// ---------------------------------------------------------------------------
// Persona + access
// ---------------------------------------------------------------------------

/** Reads the persona row WITHOUT the access check of FindPersonaByID. */
export async function readPersonaRow(personaId: string): Promise<PersonaModel | undefined> {
  const querySpec: SqlQuerySpec = {
    query: "SELECT * FROM root r WHERE r.type=@type AND r.id=@id",
    parameters: [
      { name: "@type", value: PERSONA_ATTRIBUTE },
      { name: "@id", value: personaId },
    ],
  };
  const { resources } = await HistoryContainer()
    .items.query<PersonaModel>(querySpec)
    .fetchAll();
  return resources[0];
}

/**
 * Who may USE an agent's skills: everyone who can open the agent. The one
 * agent rule, canOpenPersona (owner, admin, share-group member, or everyone
 * for a published agent without a share group).
 */
export const canUsePersonaSkills = (
  viewer: PersonaViewer,
  persona: PersonaAccessFields,
  isGroupMember?: (groupId: string) => Promise<boolean>,
): Promise<boolean> => canOpenPersona(viewer, persona, isGroupMember);

/**
 * Who may ADD, REPLACE or DELETE skills: the same rule as editing the agent
 * itself, canEditPersona (owner or admin).
 */
export const canEditPersonaSkills = (
  viewer: PersonaViewer,
  persona: Pick<PersonaAccessFields, "userId">,
): boolean => canEditPersona(viewer, persona);

export interface SkillAccess {
  persona: PersonaModel;
  currentUserId: string;
  canUse: boolean;
  canEdit: boolean;
}

/** Resolves what the current user may do with the skills of an agent. */
export async function resolveSkillAccess(personaId: string): Promise<SkillAccess | undefined> {
  const persona = await readPersonaRow(personaId);
  if (!persona) return undefined;
  const viewer = await currentPersonaViewer();
  return {
    persona,
    currentUserId: viewer.userId,
    canUse: await canUsePersonaSkills(viewer, persona),
    canEdit: canEditPersonaSkills(viewer, persona),
  };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const byName = (a: PersonaSkillModel, b: PersonaSkillModel) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** All skill rows of an agent, sorted by name. No access check. */
export async function querySkillsByPersonaId(personaId: string): Promise<PersonaSkillModel[]> {
  const querySpec: SqlQuerySpec = {
    query: "SELECT * FROM root r WHERE r.type=@type AND r.personaId=@personaId",
    parameters: [
      { name: "@type", value: PERSONA_SKILL_ATTRIBUTE },
      { name: "@personaId", value: personaId },
    ],
  };
  const { resources } = await HistoryContainer()
    .items.query<PersonaSkillModel>(querySpec)
    .fetchAll();
  return [...resources].sort(byName);
}

/** Storage helpers the SharePoint sync needs (passed in, no import cycle). */
export const linkedSkillDeps = (): LinkedSkillDeps => ({
  blobContainer: skillBlobContainer(),
  newBlobName: skillBlobName,
  deleteOpenAiFile: deleteSkillOpenAiFile,
});

/**
 * The skills the CURRENT user may use on this agent: all of them when the
 * user can open the agent, none otherwise. Skills linked to SharePoint are
 * checked here, once per call, with the user's token: brought to the newest
 * version, or left out (and named in `unavailable`) when SharePoint does not
 * let this user read the file. Never throws: a failure means "no skills", so
 * a broken skill store cannot break a chat.
 */
export async function loadUsableSkillsWithStatus(
  personaId: string | undefined,
): Promise<SyncedSkills> {
  const none: SyncedSkills = { skills: [], unavailable: [] };
  if (!personaId) return none;
  try {
    const skills = await querySkillsByPersonaId(personaId);
    if (skills.length === 0) return none;
    const access = await resolveSkillAccess(personaId);
    if (!access?.canUse) {
      logWarn("agent skills: user may not use this agent's skills", { personaId });
      return none;
    }
    if (!skills.some((s) => s.source)) return { skills, unavailable: [] };
    const { token } = await getCurrentUser();
    return await syncLinkedSkills(skills, token, linkedSkillDeps(), access.currentUserId);
  } catch (error) {
    logError("agent skills: failed to load skills", {
      personaId,
      error: error instanceof Error ? error.message : String(error),
    });
    return none;
  }
}

/** loadUsableSkillsWithStatus without the names of unavailable skills. */
export async function loadUsableSkills(personaId: string | undefined): Promise<PersonaSkillModel[]> {
  return (await loadUsableSkillsWithStatus(personaId)).skills;
}

/** Deletes every skill (rows and blobs) of an agent. Best effort. */
export async function deleteSkillsForPersona(personaId: string): Promise<void> {
  try {
    const skills = await querySkillsByPersonaId(personaId);
    for (const skill of skills) {
      await HistoryContainer().item(skill.id, skill.userId).delete();
      await DeleteBlob(skillBlobContainer(), skill.blobName);
      await deleteSkillOpenAiFile(skill.openAiFileId);
    }
  } catch (error) {
    logError("agent skills: cleanup after agent delete failed", {
      personaId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------

/**
 * Small in-process cache of skill zips, so a model that reads several files
 * of one skill in one turn downloads the zip once. Keyed by blob name (a new
 * upload gets a new blob name, so no invalidation is needed).
 */
const ARCHIVE_CACHE_MAX_BYTES = 150_000_000;
const ARCHIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const archiveCache = new Map<string, { buf: Buffer; at: number }>();

function cachePut(key: string, buf: Buffer) {
  archiveCache.delete(key);
  archiveCache.set(key, { buf, at: Date.now() });
  let total = 0;
  for (const v of archiveCache.values()) total += v.buf.length;
  for (const [k, v] of archiveCache) {
    if (total <= ARCHIVE_CACHE_MAX_BYTES) break;
    archiveCache.delete(k);
    total -= v.buf.length;
  }
}

async function streamToBuffer(stream: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function readSkillArchive(skill: PersonaSkillModel): Promise<Buffer> {
  const hit = archiveCache.get(skill.blobName);
  if (hit && Date.now() - hit.at < ARCHIVE_CACHE_TTL_MS) return hit.buf;
  const blob = await GetBlob(skillBlobContainer(), skill.blobName);
  if (blob.status !== "OK") {
    throw new Error(`Skill package not found for ${skill.name}.`);
  }
  const buf = await streamToBuffer(blob.response.stream);
  cachePut(skill.blobName, buf);
  return buf;
}

/** Reads one file of a skill (path relative to the skill root). */
export async function readSkillFile(
  skill: PersonaSkillModel,
  relPath: string,
): Promise<Buffer | undefined> {
  const buf = await readSkillArchive(skill);
  return readSkillZipFile(buf, skill.rootPrefix, relPath);
}

// ---------------------------------------------------------------------------
// Azure OpenAI file per skill version
// ---------------------------------------------------------------------------

const isNotFound = (error: unknown): boolean => {
  const status =
    (error as { status?: number })?.status ??
    (error as { statusCode?: number })?.statusCode;
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return status === 404 || message.includes("not found") || message.includes("no such file");
};

/**
 * Is this OpenAI file still there? `false` only on a clear "not found"; any
 * other error counts as "probably fine", so a transient failure does not
 * trigger a re-upload of a large zip.
 */
async function openAiFileExists(fileId: string): Promise<boolean> {
  try {
    const file = await OpenAIV1Instance().files.retrieve(fileId);
    return Boolean(file) && (file as { status?: string }).status !== "deleted";
  } catch (error) {
    if (isNotFound(error)) return false;
    logWarn("agent skills: could not check OpenAI file, reusing it", {
      fileId,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

/** Deletes an OpenAI file. Best effort: a failure is logged, never thrown. */
export async function deleteSkillOpenAiFile(fileId: string | undefined): Promise<void> {
  if (!fileId) return;
  try {
    await OpenAIV1Instance().files.delete(fileId);
    logInfo("agent skills: old OpenAI file deleted", { fileId });
  } catch (error) {
    if (isNotFound(error)) return;
    logWarn("agent skills: could not delete old OpenAI file", {
      fileId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Reads the current row, so a concurrent writer's file id is seen. */
async function readSkillRow(
  skill: PersonaSkillModel,
): Promise<(PersonaSkillModel & { _etag?: string }) | undefined> {
  try {
    const { resource } = await HistoryContainer()
      .item(skill.id, skill.userId)
      .read<PersonaSkillModel & { _etag?: string }>();
    return resource ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the OpenAI file id of this skill version, uploading the zip only
 * when there is none yet or (with `verify`) when the cached file is gone.
 * The id is stored on the PERSONA_SKILL row, so the next chat reuses it.
 * Returns undefined when the upload fails; the caller skips that skill.
 */
export async function ensureSkillOpenAiFile(
  skill: PersonaSkillModel,
  options: { verify?: boolean } = {},
): Promise<string | undefined> {
  if (skill.openAiFileId) {
    if (!options.verify || (await openAiFileExists(skill.openAiFileId))) {
      return skill.openAiFileId;
    }
    logInfo("agent skills: cached OpenAI file is gone, uploading again", {
      skill: skill.name,
      fileId: skill.openAiFileId,
    });
  }

  const buf = await readSkillArchive(skill);
  const file = new File([new Uint8Array(buf)], skillArchiveFileName(skill.name), {
    type: "application/zip",
  });
  const uploaded = await UploadFileForCodeInterpreter(file);
  if (uploaded.status !== "OK") {
    logError("agent skills: code interpreter upload failed", {
      skill: skill.name,
      errors: uploaded.errors,
    });
    return undefined;
  }
  const newId = uploaded.response.id;

  // Store it on the row, unless the row moved on meanwhile: the skill was
  // replaced or deleted, or another chat cached a different id first.
  const current = await readSkillRow(skill);
  if (!current || current.blobName !== skill.blobName) {
    await deleteSkillOpenAiFile(newId);
    return current ? ensureSkillOpenAiFile(current) : undefined;
  }
  if (current.openAiFileId && current.openAiFileId !== skill.openAiFileId) {
    await deleteSkillOpenAiFile(newId);
    skill.openAiFileId = current.openAiFileId;
    return current.openAiFileId;
  }
  // Only when the row is still the one read above: a linked skill can get a
  // new version from a parallel chat, which this write must not undo.
  let base = current;
  for (let attempt = 0; ; attempt++) {
    try {
      await HistoryContainer()
        .item(base.id, base.userId)
        .replace<PersonaSkillModel>(
          { ...base, openAiFileId: newId },
          base._etag
            ? { accessCondition: { type: "IfMatch", condition: base._etag } }
            : undefined,
        );
      break;
    } catch (error) {
      const code =
        (error as { code?: number })?.code ?? (error as { statusCode?: number })?.statusCode;
      if (code !== 412 && code !== 404) throw error;
      const latest = code === 412 ? await readSkillRow(skill) : undefined;
      // Same version, still no file id (another field changed, e.g. a sync
      // note): store this upload on the newer row.
      if (
        latest &&
        attempt === 0 &&
        latest.blobName === skill.blobName &&
        !latest.openAiFileId
      ) {
        base = latest;
        continue;
      }
      await deleteSkillOpenAiFile(newId);
      if (!latest) return undefined;
      if (latest.blobName === skill.blobName && latest.openAiFileId) {
        skill.openAiFileId = latest.openAiFileId;
        return latest.openAiFileId;
      }
      return ensureSkillOpenAiFile(latest);
    }
  }
  skill.openAiFileId = newId;
  logInfo("agent skills: archive uploaded for code interpreter", {
    skill: skill.name,
    fileId: newId,
    bytes: buf.length,
  });
  return newId;
}

/**
 * The code interpreter files for a new chat with the agent: one per skill,
 * reusing the cached OpenAI file of the skill version (checked once here,
 * re-uploaded when gone). Same mechanism as the agent's code interpreter
 * documents (persona-service CreatePersonaChat): the files become the
 * thread's attachedFiles. A failed skill is logged and skipped.
 */
export async function uploadSkillArchivesForCodeInterpreter(
  skills: PersonaSkillModel[],
): Promise<AttachedFileModel[]> {
  const results = await Promise.all(
    skills.map(async (skill): Promise<AttachedFileModel | undefined> => {
      try {
        const fileId = await ensureSkillOpenAiFile(skill, { verify: true });
        if (!fileId) return undefined;
        return {
          id: fileId,
          name: skillArchiveFileName(skill.name),
          type: "code-interpreter",
          uploadedAt: new Date(),
          source: "skill",
        };
      } catch (error) {
        logError("agent skills: archive upload failed", {
          skill: skill.name,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    }),
  );
  return results.filter((r): r is AttachedFileModel => r !== undefined);
}

/**
 * After a failed container creation: checks every cached skill file and
 * re-uploads the missing ones. Returns true when at least one id changed,
 * so the caller can retry once with the new ids.
 */
export async function refreshSkillOpenAiFiles(skills: PersonaSkillModel[]): Promise<boolean> {
  let changed = false;
  for (const skill of skills) {
    const before = skill.openAiFileId;
    try {
      const after = await ensureSkillOpenAiFile(skill, { verify: true });
      if (after && after !== before) changed = true;
    } catch (error) {
      logError("agent skills: refresh of OpenAI file failed", {
        skill: skill.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return changed;
}
