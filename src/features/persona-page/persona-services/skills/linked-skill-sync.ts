import "server-only";

/**
 * linked-skill-sync.ts — skills linked to a SharePoint / OneDrive .zip.
 *
 * A linked skill is stored like an uploaded one (blob copy + PERSONA_SKILL
 * row + cached OpenAI file per version) and in addition remembers its
 * SharePoint file and the version (cTag) the copy was made from.
 *
 * Each chat request checks the file once, with the CHATTING user's token:
 *   - same cTag            -> the stored copy (and its cached OpenAI file);
 *   - new cTag             -> download, validate, store as a new version;
 *   - 401 / 403 / 404      -> the skill is not used for this user (no
 *                             fallback: the copy would leak a file the user
 *                             cannot open);
 *   - timeout, 5xx, other  -> the stored copy, with a warning in the log;
 *   - new file invalid     -> the stored copy; the error goes on the row, so
 *                             the editor shows it to the owner and chats do
 *                             not download that version again.
 *
 * Not a "use server" module (sync exports, server-only callers). Storage
 * helpers of persona-skill-store come in as `deps`, so the two modules do
 * not import each other.
 */

import { HistoryContainer } from "@/features/common/services/cosmos";
import { DeleteBlob, UploadBlob } from "@/features/common/services/azure-storage";
import { logError, logInfo, logWarn } from "@/features/common/services/logger";
import {
  PersonaSkillModelSchema,
  SKILL_LIMITS,
  type PersonaSkillModel,
  type SharePointSkillSource,
} from "./skill-models";
import {
  SkillZipError,
  validateSkillZip,
  type ValidatedSkillPackage,
} from "./skill-zip";
import {
  FileTooLargeError,
  GRAPH_METADATA_TIMEOUT_MS,
  GraphFileError,
  downloadDriveItem,
  getDriveItemVersion,
  isFileAccessDenied,
  type DriveItemVersion,
} from "./sharepoint-skill-graph";
import { checkDriveItem, rememberDriveItemVersion } from "./drive-item-check-cache";

export interface LinkedSkillDeps {
  blobContainer: string;
  newBlobName: (personaId: string, skillId: string) => string;
  deleteOpenAiFile: (fileId: string | undefined) => Promise<void>;
}

/** A row as Cosmos returns it: with the etag for optimistic concurrency. */
type StoredSkill = PersonaSkillModel & { _etag?: string };

export const NO_ACCESS_MESSAGE = "Your account cannot open this file in SharePoint.";
export const NOT_REACHABLE_MESSAGE = "SharePoint did not answer. Try again in a moment.";

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// Fetch + validate
// ---------------------------------------------------------------------------

export type LinkedZipResult =
  | { ok: true; meta: DriveItemVersion; buf: Buffer; pkg: ValidatedSkillPackage }
  | {
      ok: false;
      /** denied: 401/403/404; transient: timeout, 5xx; invalid: the file itself. */
      reason: "denied" | "transient" | "invalid";
      message: string;
      meta?: DriveItemVersion;
    };

/**
 * Reads the metadata (unless given), downloads the zip and validates it
 * with the same rules as an upload. Never throws.
 */
export async function fetchLinkedSkillZip(
  token: string,
  driveId: string,
  itemId: string,
  knownMeta?: DriveItemVersion,
): Promise<LinkedZipResult> {
  let meta = knownMeta;
  try {
    meta ??= await getDriveItemVersion(token, driveId, itemId);
    if (!meta.isFile || !/\.zip$/i.test(meta.name)) {
      return { ok: false, reason: "invalid", message: "Choose a .zip file.", meta };
    }
    if (meta.size > SKILL_LIMITS.maxZipBytes) {
      return {
        ok: false,
        reason: "invalid",
        message: `The zip is larger than ${SKILL_LIMITS.maxZipBytes / 1_000_000} MB.`,
        meta,
      };
    }
    const buf = await downloadDriveItem(token, driveId, itemId, SKILL_LIMITS.maxZipBytes);
    try {
      return { ok: true, meta, buf, pkg: validateSkillZip(buf) };
    } catch (error) {
      if (error instanceof SkillZipError) {
        return { ok: false, reason: "invalid", message: error.message, meta };
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      return { ok: false, reason: "invalid", message: error.message, meta };
    }
    if (isFileAccessDenied(error)) {
      return { ok: false, reason: "denied", message: NO_ACCESS_MESSAGE, meta };
    }
    if (error instanceof GraphFileError && error.status === 400) {
      return { ok: false, reason: "invalid", message: "Choose a .zip file from SharePoint.", meta };
    }
    return { ok: false, reason: "transient", message: NOT_REACHABLE_MESSAGE, meta };
  }
}

export const buildSharePointSource = (
  meta: DriveItemVersion,
  driveId: string,
  itemId: string,
): SharePointSkillSource => ({
  kind: "sharepoint",
  driveId,
  itemId,
  webUrl: meta.webUrl,
  name: meta.name.slice(0, 255),
  version: meta.version,
  ...(meta.eTag ? { eTag: meta.eTag } : {}),
  lastModifiedDateTime: meta.lastModifiedDateTime,
  size: meta.size,
});

/** The fields of a row that come from the zip itself. */
export const packageFields = (pkg: ValidatedSkillPackage) => ({
  name: pkg.name,
  description: pkg.description,
  skillMd: pkg.skillMd,
  rootPrefix: pkg.rootPrefix,
  files: pkg.files,
  zipBytes: pkg.zipBytes,
  uncompressedBytes: pkg.uncompressedBytes,
});

// ---------------------------------------------------------------------------
// Row writes with optimistic concurrency
// ---------------------------------------------------------------------------

const isPreconditionFailed = (error: unknown): boolean =>
  (error as { code?: number })?.code === 412 ||
  (error as { statusCode?: number })?.statusCode === 412;

async function readRow(skill: PersonaSkillModel): Promise<StoredSkill | undefined> {
  try {
    const { resource } = await HistoryContainer()
      .item(skill.id, skill.userId)
      .read<StoredSkill>();
    return resource ?? undefined;
  } catch {
    return undefined;
  }
}

/** Replaces the row only when nobody wrote it since `expected` was read. */
async function replaceIfUnchanged(
  expected: StoredSkill,
  next: PersonaSkillModel,
): Promise<void> {
  await HistoryContainer()
    .item(expected.id, expected.userId)
    .replace<PersonaSkillModel>(
      next,
      expected._etag
        ? { accessCondition: { type: "IfMatch", condition: expected._etag } }
        : undefined,
    );
}

/** Notes on the row that `version` could not be used. Best effort. */
async function recordSyncError(
  skill: StoredSkill,
  version: string,
  message: string,
): Promise<PersonaSkillModel> {
  if (!skill.source) return skill;
  const next: PersonaSkillModel = {
    ...skill,
    source: {
      ...skill.source,
      syncError: { version, message, at: new Date().toISOString() },
    },
  };
  try {
    await replaceIfUnchanged(skill, next);
  } catch (error) {
    logWarn("agent skills: could not store the sync error", {
      skill: skill.name,
      error: errorText(error),
    });
  }
  return next;
}

/** Removes a sync error that no longer applies. Best effort. */
async function clearSyncError(skill: StoredSkill): Promise<PersonaSkillModel> {
  if (!skill.source?.syncError) return skill;
  const { syncError: _unused, ...source } = skill.source;
  const next: PersonaSkillModel = { ...skill, source };
  try {
    await replaceIfUnchanged(skill, next);
  } catch (error) {
    logWarn("agent skills: could not clear the sync error", {
      skill: skill.name,
      error: errorText(error),
    });
  }
  return next;
}

// ---------------------------------------------------------------------------
// Sync of one linked skill
// ---------------------------------------------------------------------------

export type LinkedSkillSyncResult =
  /** The stored copy is the current SharePoint version. */
  | { status: "current"; skill: PersonaSkillModel }
  /** A new version was stored (here or by a parallel request). */
  | { status: "updated"; skill: PersonaSkillModel }
  /** The stored copy stays in use; `invalid` when the new file is not a valid skill. */
  | { status: "kept"; skill: PersonaSkillModel; message: string; invalid: boolean }
  /** The user may not read the file: do not use the skill. */
  | { status: "denied"; skill: PersonaSkillModel; message: string }
  /** The row was deleted meanwhile. */
  | { status: "gone"; skill: PersonaSkillModel; message: string };

export interface SyncOptions {
  /** Check now: bypass the check cache and download a version that failed before. */
  force?: boolean;
  metadataTimeoutMs?: number;
  /** Hashed id of the user whose token is used; key of the check cache. */
  userId?: string;
}

/**
 * Brings one linked skill to the current SharePoint version, as far as the
 * current user can read it. `siblings` are the agent's other skills (name
 * clash check). Never throws.
 */
export async function syncLinkedSkill(
  skill: StoredSkill,
  token: string,
  siblings: ReadonlyArray<PersonaSkillModel>,
  deps: LinkedSkillDeps,
  options: SyncOptions = {},
): Promise<LinkedSkillSyncResult> {
  const src = skill.source;
  if (!src) return { status: "current", skill };
  const userId = options.userId ?? "";
  const timeoutMs = options.metadataTimeoutMs ?? GRAPH_METADATA_TIMEOUT_MS;

  let meta: DriveItemVersion;
  try {
    let check = await checkDriveItem(token, userId, src.driveId, src.itemId, {
      bypassCache: options.force,
      timeoutMs,
    });
    // A cached answer only settles "unchanged" (and "denied" above). A
    // different cached version may be stale: ask Graph before downloading.
    if (check.fromCache && check.meta.version !== src.version) {
      check = await checkDriveItem(token, userId, src.driveId, src.itemId, {
        bypassCache: true,
        timeoutMs,
      });
    }
    meta = check.meta;
  } catch (error) {
    if (isFileAccessDenied(error)) {
      logWarn("agent skills: user cannot read the linked SharePoint file, skill not used", {
        skill: skill.name,
        personaId: skill.personaId,
        status: (error as GraphFileError).status,
      });
      return { status: "denied", skill, message: NO_ACCESS_MESSAGE };
    }
    logWarn("agent skills: SharePoint check failed, using the stored version", {
      skill: skill.name,
      personaId: skill.personaId,
      error: errorText(error),
    });
    return { status: "kept", skill, message: NOT_REACHABLE_MESSAGE, invalid: false };
  }

  if (meta.version === src.version) {
    return { status: "current", skill: await clearSyncError(skill) };
  }
  if (!options.force && src.syncError?.version === meta.version) {
    return { status: "kept", skill, message: src.syncError.message, invalid: true };
  }

  try {
    const fetched = await fetchLinkedSkillZip(token, src.driveId, src.itemId, meta);
    if (!fetched.ok) {
      if (fetched.reason === "denied") {
        logWarn("agent skills: download of the linked SharePoint file denied, skill not used", {
          skill: skill.name,
          personaId: skill.personaId,
        });
        return { status: "denied", skill, message: fetched.message };
      }
      if (fetched.reason === "transient") {
        logWarn("agent skills: download of the new SharePoint version failed, using the stored version", {
          skill: skill.name,
          personaId: skill.personaId,
        });
        return { status: "kept", skill, message: fetched.message, invalid: false };
      }
      logWarn("agent skills: new SharePoint version is not a valid skill, keeping the last good version", {
        skill: skill.name,
        personaId: skill.personaId,
        error: fetched.message,
      });
      return {
        status: "kept",
        skill: await recordSyncError(skill, meta.version, fetched.message),
        message: fetched.message,
        invalid: true,
      };
    }

    const clash = siblings.find((s) => s.id !== skill.id && s.name === fetched.pkg.name);
    if (clash) {
      const message = `The new file is the skill "${fetched.pkg.name}", and the agent already has a skill with this name.`;
      return {
        status: "kept",
        skill: await recordSyncError(skill, meta.version, message),
        message,
        invalid: true,
      };
    }

    return await storeNewVersion(skill, fetched, deps, userId);
  } catch (error) {
    logError("agent skills: update from SharePoint failed, using the stored version", {
      skill: skill.name,
      personaId: skill.personaId,
      error: errorText(error),
    });
    return { status: "kept", skill, message: NOT_REACHABLE_MESSAGE, invalid: false };
  }
}

async function storeNewVersion(
  skill: StoredSkill,
  fetched: Extract<LinkedZipResult, { ok: true }>,
  deps: LinkedSkillDeps,
  userId: string,
): Promise<LinkedSkillSyncResult> {
  const src = skill.source!;
  const blobName = deps.newBlobName(skill.personaId, skill.id);
  const uploaded = await UploadBlob(deps.blobContainer, blobName, fetched.buf, {
    contentType: "application/zip",
    metadata: { personaid: skill.personaId, skillname: fetched.pkg.name },
  });
  if (uploaded.status !== "OK") {
    logWarn("agent skills: could not store the new SharePoint version, using the stored version", {
      skill: skill.name,
    });
    return { status: "kept", skill, message: NOT_REACHABLE_MESSAGE, invalid: false };
  }

  // Two tries: a parallel chat may have cached an OpenAI file id on the row
  // (new etag, same version) between our read and our write.
  let base: StoredSkill = skill;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { openAiFileId: _old, ...rest } = base;
    const next: PersonaSkillModel = {
      ...rest,
      ...packageFields(fetched.pkg),
      zipFileName: fetched.meta.name.slice(0, 255),
      blobName,
      source: buildSharePointSource(fetched.meta, src.driveId, src.itemId),
      updatedAt: new Date(),
    };
    if (!PersonaSkillModelSchema.safeParse(next).success) {
      await DeleteBlob(deps.blobContainer, blobName);
      return {
        status: "kept",
        skill: await recordSyncError(base, fetched.meta.version, "The skill could not be saved."),
        message: "The skill could not be saved.",
        invalid: true,
      };
    }
    try {
      await replaceIfUnchanged(base, next);
    } catch (error) {
      if (!isPreconditionFailed(error)) {
        await DeleteBlob(deps.blobContainer, blobName);
        throw error;
      }
      const current = await readRow(base);
      if (!current) {
        await DeleteBlob(deps.blobContainer, blobName);
        return { status: "gone", skill: base, message: "The skill was removed." };
      }
      if (current.source?.version === fetched.meta.version || current.blobName !== base.blobName) {
        // Another request stored this (or a newer) version: use theirs.
        await DeleteBlob(deps.blobContainer, blobName);
        return { status: "updated", skill: current };
      }
      base = current;
      continue;
    }

    if (base.blobName !== blobName) await DeleteBlob(deps.blobContainer, base.blobName);
    await deps.deleteOpenAiFile(base.openAiFileId);
    rememberDriveItemVersion(src.driveId, src.itemId, fetched.meta, userId);
    logInfo("agent skills: new SharePoint version stored", {
      skill: next.name,
      personaId: skill.personaId,
      version: fetched.meta.version,
      files: next.files.length,
      zipBytes: next.zipBytes,
    });
    return { status: "updated", skill: next };
  }

  await DeleteBlob(deps.blobContainer, blobName);
  return { status: "kept", skill: base, message: NOT_REACHABLE_MESSAGE, invalid: false };
}

// ---------------------------------------------------------------------------
// All skills of a chat request
// ---------------------------------------------------------------------------

export interface SyncedSkills {
  /** Skills the user may use in this request, linked ones at their newest usable version. */
  skills: PersonaSkillModel[];
  /** Names of linked skills the user cannot read in SharePoint. */
  unavailable: string[];
}

/**
 * Checks every linked skill once, in parallel (metadata timeout 5 s each).
 * Uploaded skills pass through unchanged. A linked skill whose check fails
 * unexpectedly is left out (fail closed).
 */
export async function syncLinkedSkills(
  skills: ReadonlyArray<PersonaSkillModel>,
  token: string,
  deps: LinkedSkillDeps,
  userId?: string,
): Promise<SyncedSkills> {
  const results = await Promise.all(
    skills.map(async (skill): Promise<LinkedSkillSyncResult> => {
      if (!skill.source) return { status: "current", skill };
      try {
        return await syncLinkedSkill(skill, token, skills, deps, { userId });
      } catch (error) {
        logError("agent skills: linked skill check failed, skill not used", {
          skill: skill.name,
          error: errorText(error),
        });
        return { status: "gone", skill, message: "" };
      }
    }),
  );
  return {
    skills: results
      .filter((r) => r.status === "current" || r.status === "updated" || r.status === "kept")
      .map((r) => r.skill),
    unavailable: results.filter((r) => r.status === "denied").map((r) => r.skill.name),
  };
}

/**
 * Can this user read the file of a linked skill? Uses the same cached check
 * as chats. Only a clear 401/403/404 says no; a timeout or 5xx says yes, as
 * chats then use the stored copy too. Uploaded skills: always yes.
 */
export async function canReadLinkedSkill(
  skill: PersonaSkillModel,
  token: string,
  userId: string,
): Promise<boolean> {
  if (!skill.source) return true;
  try {
    await checkDriveItem(token, userId, skill.source.driveId, skill.source.itemId);
    return true;
  } catch (error) {
    return !isFileAccessDenied(error);
  }
}
