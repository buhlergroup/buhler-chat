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
 *   - Blob: the original zip at `agent-skills/<personaId>/<skillId>-<ts>.zip`.
 */

import { SqlQuerySpec } from "@azure/cosmos";
import { userHashedId } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import {
  DeleteBlob,
  GetBlob,
} from "@/features/common/services/azure-storage";
import { logError, logInfo, logWarn } from "@/features/common/services/logger";
import { AccessGroupById } from "../access-group-service";
import { PERSONA_ATTRIBUTE, type PersonaModel } from "../models";
import type { AttachedFileModel } from "@/features/chat-page/chat-services/models";
import { UploadFileForCodeInterpreter } from "@/features/chat-page/chat-services/code-interpreter-service";
import {
  PERSONA_SKILL_ATTRIBUTE,
  canEditPersonaSkills,
  canUsePersonaSkills,
  skillArchiveFileName,
  type PersonaSkillModel,
} from "./skill-models";
import { readSkillZipFile } from "./skill-zip";

/**
 * Blob container for skill packages. Defaults to the existing images
 * container so no infrastructure change is needed; the `agent-skills/`
 * prefix is blocked in the public image route (chat-image-service.ts).
 */
export const skillBlobContainer = (): string =>
  process.env.AZURE_STORAGE_SKILL_CONTAINER_NAME || "images";

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
  const currentUserId = await userHashedId();
  let isMember = false;
  if (
    persona.userId !== currentUserId &&
    persona.accessGroup &&
    persona.accessGroup.id !== ""
  ) {
    const group = await AccessGroupById(persona.accessGroup.id);
    isMember = group.status === "OK";
  }
  return {
    persona,
    currentUserId,
    canUse: canUsePersonaSkills(persona, currentUserId, isMember),
    canEdit: canEditPersonaSkills(persona, currentUserId),
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

/**
 * The skills the CURRENT user may use on this agent: all of them when the
 * user can open the agent, none otherwise. Never throws: a failure means
 * "no skills", so a broken skill store cannot break a chat.
 */
export async function loadUsableSkills(personaId: string | undefined): Promise<PersonaSkillModel[]> {
  if (!personaId) return [];
  try {
    const skills = await querySkillsByPersonaId(personaId);
    if (skills.length === 0) return [];
    const access = await resolveSkillAccess(personaId);
    if (!access?.canUse) {
      logWarn("agent skills: user may not use this agent's skills", { personaId });
      return [];
    }
    return skills;
  } catch (error) {
    logError("agent skills: failed to load skills", {
      personaId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** Deletes every skill (rows and blobs) of an agent. Best effort. */
export async function deleteSkillsForPersona(personaId: string): Promise<void> {
  try {
    const skills = await querySkillsByPersonaId(personaId);
    for (const skill of skills) {
      await HistoryContainer().item(skill.id, skill.userId).delete();
      await DeleteBlob(skillBlobContainer(), skill.blobName);
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

/**
 * Uploads each skill zip as a code interpreter file, for a new chat with the
 * agent. Same mechanism as the agent's code interpreter documents
 * (persona-service CreatePersonaChat): the files become the thread's
 * attachedFiles and go into the code interpreter container with every turn.
 * A failed skill is logged and skipped; the chat still starts.
 */
export async function uploadSkillArchivesForCodeInterpreter(
  skills: PersonaSkillModel[],
): Promise<AttachedFileModel[]> {
  const results = await Promise.all(
    skills.map(async (skill): Promise<AttachedFileModel | undefined> => {
      try {
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
        logInfo("agent skills: archive uploaded for code interpreter", {
          skill: skill.name,
          fileId: uploaded.response.id,
          bytes: buf.length,
        });
        return {
          id: uploaded.response.id,
          name: uploaded.response.name,
          type: "code-interpreter",
          uploadedAt: new Date(),
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
