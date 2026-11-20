import "server-only";

/**
 * Files of an agent: one list over the four existing mechanisms, and the
 * add / remove / change-of-use operations behind the editor's Files section.
 *
 * Not a "use server" module: the callers (agent-file-service.ts) check the
 * edit permission first and pass the resolved access in. The existing
 * services do the work (indexing, code interpreter rows, skills, SharePoint
 * sources); this module only decides which one and keeps the persona row
 * in step.
 *
 * The persona row lists the ids of its Search and Code rows
 * (personaDocumentIds, codeInterpreterDocumentIds). Only this module changes
 * these lists, always with an etag-checked replace, so a concurrent agent
 * save (UpsertPersona, which keeps the stored lists) cannot drop an id.
 *
 * Every row is written in the agent OWNER's partition, also when an admin
 * adds the file: chats find a Search or Code row only there
 * (FindAccessiblePersonaDocument). A row is deleted in its own partition.
 */

import { SqlQuerySpec } from "@azure/cosmos";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { logError, logInfo, logWarn } from "@/features/common/services/logger";
import {
  getDriveItemInfo,
  isFileAccessDenied,
  type DriveItemInfo,
} from "@/features/common/services/sharepoint/graph-drive";
import { isGraphDriveId, isGraphItemId, isHttpsUrl } from "@/features/common/services/sharepoint/graph-ids";
import {
  getCodeInterpreterFileLimit,
  readCodeInterpreterMaxFileBytes,
} from "@/features/chat-page/chat-services/code-interpreter-constants";
import {
  PERSONA_CI_DOCUMENT_ATTRIBUTE,
  PERSONA_DOCUMENT_ATTRIBUTE,
  type DocumentMetadata,
  type PersonaCIDocument,
  type PersonaDocument,
  type PersonaModel,
} from "../models";
import { addSearchDocument, deleteSearchDocument } from "../persona-documents-store";
import { addCodeDocument, deleteCodeDocument } from "../persona-ci-documents-store";
import { updatePersonaRow, withCodeInterpreterOn } from "../persona-row";
import { deleteFileRowsIfUnlisted } from "../persona-file-rows";
import { querySkillsByPersonaId, readPersonaRow, type SkillAccess } from "../skills/persona-skill-store";
import { SKILL_LIMITS, type PersonaSkillModel } from "../skills/skill-models";
import { fetchLinkedSkillZip, type LinkedZipResult } from "../skills/linked-skill-sync";
import { linkSharePointSkill } from "../skills/link-sharepoint-skill";
import { DeletePersonaSkill } from "../skills/persona-skill-service";
import { queryFileSourcesByPersonaId } from "../sharepoint-files/sharepoint-file-store";
import { addPersonaFileSource } from "../sharepoint-files/add-file-source";
import { DeletePersonaFileSource } from "../sharepoint-files/sharepoint-file-service";
import { readSharePointFileLimits } from "../sharepoint-files/sharepoint-file-limits";
import type { PersonaFileSourceModel } from "../sharepoint-files/sharepoint-file-models";
import {
  allowedUses,
  automaticUse,
  type AgentFileCandidate,
  type AgentFileSizeLimits,
} from "./agent-file-classifier";
import {
  AGENT_FILE_STATUS_TEXT,
  AGENT_FILE_USE_TEXT,
  REMOVED_NOT_CLEANED_WARNING,
  USE_OF_REF_KIND,
  type AddAgentFileResult,
  type ChangeAgentFileUseResult,
  type RemoveAgentFileResult,
  type AgentFileItem,
  type AgentFilePick,
  type AgentFileRef,
  type AgentFilesList,
  type AgentFileStatus,
  type AgentFileUse,
} from "./agent-file-models";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface AgentFileLimits extends AgentFileSizeLimits {
  maxSearchFiles: number;
  maxCodeFiles: number;
  maxSkills: number;
  maxOnDemand: number;
}

const positiveInt = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** The existing limits of the four mechanisms (same environment variables). */
export function readAgentFileLimits(env: Record<string, string | undefined> = process.env): AgentFileLimits {
  const sharePoint = readSharePointFileLimits(env);
  return {
    maxSearchFiles: positiveInt(env.MAX_PERSONA_DOCUMENT_LIMIT, 25),
    maxCodeFiles: getCodeInterpreterFileLimit(env.MAX_PERSONA_CI_DOCUMENT_LIMIT),
    maxSkills: SKILL_LIMITS.maxSkillsPerAgent,
    maxOnDemand: sharePoint.maxSources,
    searchMaxBytes: positiveInt(env.MAX_PERSONA_DOCUMENT_SIZE, 10_485_760),
    // The same reader as the download at chat start.
    codeMaxBytes: readCodeInterpreterMaxFileBytes(env),
    onDemandMaxBytes: sharePoint.maxFileBytes,
  };
}

// ---------------------------------------------------------------------------
// Persona row: the file lists (etag-checked write in persona-row.ts)
// ---------------------------------------------------------------------------

type IdList = "personaDocumentIds" | "codeInterpreterDocumentIds";

/** The list of a use is full on the stored row: the add is undone. */
class UseLimitReached extends Error {}

/**
 * Lists the id on the persona. The limit is checked again on the row as it
 * is written (fresh, etag-checked), so adds of several requests at the same
 * time never exceed it together.
 */
const withId =
  (field: IdList, id: string, max: number, limitMessage: string, codeInterpreterOn = false) =>
  (p: PersonaModel) => {
    const list = p[field] ?? [];
    if (!list.includes(id) && list.length >= max) throw new UseLimitReached(limitMessage);
    return {
      ...p,
      [field]: [...list.filter((x) => x !== id), id],
      ...(codeInterpreterOn ? { defaultTools: { ...(p.defaultTools ?? {}), codeInterpreter: true } } : {}),
    };
  };

const withoutId = (field: IdList, id: string) => (p: PersonaModel) =>
  (p[field] ?? []).includes(id) ? { ...p, [field]: (p[field] ?? []).filter((x) => x !== id) } : null;

// ---------------------------------------------------------------------------
// Rows of an agent
// ---------------------------------------------------------------------------

interface AgentRows {
  persona: PersonaModel;
  documents: Map<string, PersonaDocument>;
  ciDocuments: Map<string, PersonaCIDocument>;
  skills: PersonaSkillModel[];
  sources: PersonaFileSourceModel[];
}

/**
 * The Search and Code rows the persona lists. A row counts only when it is
 * in the agent owner's partition or in the current user's own (the rule of
 * FindAccessiblePersonaDocument), so a listed id of someone else's row
 * shows nothing of it.
 */
async function queryDocumentRows(
  persona: PersonaModel,
  currentUserId: string,
): Promise<{ documents: Map<string, PersonaDocument>; ciDocuments: Map<string, PersonaCIDocument> }> {
  const docIds = persona.personaDocumentIds ?? [];
  const ciIds = persona.codeInterpreterDocumentIds ?? [];
  const documents = new Map<string, PersonaDocument>();
  const ciDocuments = new Map<string, PersonaCIDocument>();
  if (docIds.length + ciIds.length === 0) return { documents, ciDocuments };
  const querySpec: SqlQuerySpec = {
    query:
      "SELECT * FROM root r WHERE (r.type=@doc OR r.type=@ci) AND ARRAY_CONTAINS(@ids, r.id) AND ARRAY_CONTAINS(@owners, r.userId)",
    parameters: [
      { name: "@doc", value: PERSONA_DOCUMENT_ATTRIBUTE },
      { name: "@ci", value: PERSONA_CI_DOCUMENT_ATTRIBUTE },
      { name: "@ids", value: [...docIds, ...ciIds] },
      { name: "@owners", value: [...new Set([persona.userId, currentUserId])] },
    ],
  };
  const { resources } = await HistoryContainer()
    .items.query<PersonaDocument | PersonaCIDocument>(querySpec)
    .fetchAll();
  const owners = new Set([persona.userId, currentUserId]);
  for (const r of resources) {
    if (!r || !owners.has(r.userId)) continue;
    if (r.type === PERSONA_DOCUMENT_ATTRIBUTE && docIds.includes(r.id)) {
      documents.set(r.id, r as PersonaDocument);
    } else if (r.type === PERSONA_CI_DOCUMENT_ATTRIBUTE && ciIds.includes(r.id)) {
      ciDocuments.set(r.id, r as PersonaCIDocument);
    }
  }
  return { documents, ciDocuments };
}

async function loadAgentRows(access: SkillAccess): Promise<AgentRows> {
  const persona = access.persona;
  const [docs, skills, sources] = await Promise.all([
    queryDocumentRows(persona, access.currentUserId),
    querySkillsByPersonaId(persona.id),
    queryFileSourcesByPersonaId(persona.id),
  ]);
  return { persona, ...docs, skills, sources };
}

const itemKey = (driveId: string, itemId: string) => `${driveId}|${itemId}`;

/** The SharePoint item behind each row (uploaded skills have none). */
function usedItemKeys(rows: AgentRows): Set<string> {
  const keys = new Set<string>();
  for (const d of rows.documents.values()) {
    keys.add(itemKey(d.externalFile.parentReference.driveId, d.externalFile.documentId));
  }
  for (const d of rows.ciDocuments.values()) {
    keys.add(itemKey(d.externalFile.parentReference.driveId, d.externalFile.documentId));
  }
  for (const s of rows.skills) if (s.source) keys.add(itemKey(s.source.driveId, s.source.itemId));
  for (const s of rows.sources) keys.add(itemKey(s.driveId, s.itemId));
  return keys;
}

/** Number of files of an agent (the viewer's "This agent uses N files."). */
function countFiles(rows: Pick<AgentRows, "persona" | "skills" | "sources">): number {
  return (
    (rows.persona.personaDocumentIds?.length ?? 0) +
    (rows.persona.codeInterpreterDocumentIds?.length ?? 0) +
    rows.skills.length +
    rows.sources.length
  );
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

type InfoResult = { ok: true; info: DriveItemInfo } | { ok: false; status: AgentFileStatus; message: string };

async function readItemInfo(token: string, driveId: string, itemId: string): Promise<InfoResult> {
  try {
    return { ok: true, info: await getDriveItemInfo(token, driveId, itemId) };
  } catch (error) {
    return isFileAccessDenied(error)
      ? { ok: false, status: "no-access", message: AGENT_FILE_STATUS_TEXT["no-access"] }
      : { ok: false, status: "unavailable", message: AGENT_FILE_STATUS_TEXT.unavailable };
  }
}

/** Runs `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const GRAPH_PARALLEL = 8;

const candidate = (info: DriveItemInfo, validSkillZip?: boolean): AgentFileCandidate => ({
  name: info.name,
  isFolder: info.isFolder,
  sizeBytes: info.isFolder ? undefined : info.size,
  validSkillZip,
});

const withCurrent = (uses: AgentFileUse[], current: AgentFileUse): AgentFileUse[] =>
  uses.includes(current) ? uses : [current, ...uses];

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * The files of an agent for the editor. An editor (canEdit) gets every item
 * with name, link, use, status and the uses it may switch to; anyone else
 * who can use the agent gets the count only.
 */
export async function listAgentFiles(access: SkillAccess): Promise<AgentFilesList> {
  const rows = await loadAgentRows(access);
  const count = countFiles(rows);
  const items = access.canEdit ? await buildItems(rows) : [];
  const needsCodeInterpreter =
    (rows.persona.codeInterpreterDocumentIds?.length ?? 0) > 0 ||
    rows.skills.length > 0 ||
    rows.sources.length > 0;
  return access.canEdit
    ? { canEdit: true, count, items, needsCodeInterpreter }
    : { canEdit: false, count, items: [], needsCodeInterpreter };
}

async function buildItems(rows: AgentRows): Promise<AgentFileItem[]> {
  const limits = readAgentFileLimits();
  const { token } = await getCurrentUser();

  type Linked = {
    ref: AgentFileRef;
    driveId: string;
    itemId: string;
    fallbackName: string;
    isFolder: boolean;
  };
  const linked: Linked[] = [];
  const missing: AgentFileItem[] = [];

  for (const id of rows.persona.personaDocumentIds ?? []) {
    const d = rows.documents.get(id);
    if (!d) {
      missing.push(missingItem({ kind: "document", id }));
      continue;
    }
    linked.push({
      ref: { kind: "document", id },
      driveId: d.externalFile.parentReference.driveId,
      itemId: d.externalFile.documentId,
      fallbackName: "Unknown file",
      isFolder: false,
    });
  }
  for (const id of rows.persona.codeInterpreterDocumentIds ?? []) {
    const d = rows.ciDocuments.get(id);
    if (!d) {
      missing.push(missingItem({ kind: "ci-document", id }));
      continue;
    }
    linked.push({
      ref: { kind: "ci-document", id },
      driveId: d.externalFile.parentReference.driveId,
      itemId: d.externalFile.documentId,
      fallbackName: d.fileName || "Unknown file",
      isFolder: false,
    });
  }
  for (const s of rows.sources) {
    linked.push({
      ref: { kind: "file-source", id: s.id },
      driveId: s.driveId,
      itemId: s.itemId,
      fallbackName: s.name,
      isFolder: s.kind === "folder",
    });
  }

  const infos = await mapLimit(linked, GRAPH_PARALLEL, (l) =>
    isGraphDriveId(l.driveId) && isGraphItemId(l.itemId)
      ? readItemInfo(token, l.driveId, l.itemId)
      : Promise.resolve<InfoResult>({ ok: false, status: "missing", message: "The item is not valid." }),
  );

  const items: AgentFileItem[] = linked.map((l, i) => {
    const use = USE_OF_REF_KIND[l.ref.kind];
    const res = infos[i];
    if (!res.ok) {
      return {
        ref: l.ref,
        name: l.fallbackName,
        isFolder: l.isFolder,
        use,
        status: res.status,
        statusMessage: res.message,
        allowedUses: [use],
      };
    }
    const { info } = res;
    return {
      ref: l.ref,
      name: info.name,
      ...(isHttpsUrl(info.webUrl) ? { webUrl: info.webUrl } : {}),
      isFolder: info.isFolder,
      use,
      status: "ok",
      ...(info.isFolder ? {} : { sizeBytes: info.size }),
      allowedUses: withCurrent(allowedUses(candidate(info), limits), use),
    };
  });

  for (const s of rows.skills) {
    const linkedSkill = Boolean(s.source);
    items.push({
      ref: { kind: "skill", id: s.id },
      name: s.source?.name ?? (s.zipFileName || `${s.name}.zip`),
      ...(s.source && isHttpsUrl(s.source.webUrl) ? { webUrl: s.source.webUrl } : {}),
      isFolder: false,
      use: "skill",
      status: s.source?.syncError ? "sync-error" : "ok",
      statusMessage: s.source?.syncError
        ? `The latest file is not in use: ${s.source.syncError.message} Chats use the last good version.`
        : `Skill "${s.name}"`,
      sizeBytes: s.zipBytes,
      // A linked skill is a zip in SharePoint: Skill or Code. An uploaded
      // skill has no SharePoint item to move.
      allowedUses: linkedSkill
        ? withCurrent(allowedUses({ name: s.source!.name, isFolder: false, sizeBytes: s.source!.size, validSkillZip: true }, limits), "skill")
        : ["skill"],
      ...(linkedSkill ? { linkedSkill: true } : { uploadedSkill: true }),
    });
  }

  const sorted = items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return [...sorted, ...missing];
}

const missingItem = (ref: AgentFileRef): AgentFileItem => ({
  ref,
  name: "File not found",
  isFolder: false,
  use: USE_OF_REF_KIND[ref.kind],
  status: "missing",
  statusMessage: "The file is no longer available. Remove it from the agent.",
  allowedUses: [USE_OF_REF_KIND[ref.kind]],
});


// ---------------------------------------------------------------------------
// Mechanisms: add one SharePoint item with one use
// ---------------------------------------------------------------------------

type AddOutcome = { ok: true; ref: AgentFileRef } | { ok: false; message: string };

interface ResolvedItem {
  driveId: string;
  itemId: string;
  info: DriveItemInfo;
}

/** The agent an item is added to: its id and its owner's partition. */
interface Target {
  personaId: string;
  ownerUserId: string;
}

const targetOf = (access: SkillAccess): Target => ({
  personaId: access.persona.id,
  ownerUserId: access.persona.userId,
});

const errorsText = (errors: { message: string }[]) =>
  errors.map((e) => e.message).join(" ") || "The file could not be added.";

const asMetadata = (item: ResolvedItem): DocumentMetadata => ({
  documentId: item.itemId,
  parentReference: { driveId: item.driveId },
  name: item.info.name,
  createdBy: "",
  createdDateTime: "",
});

/**
 * Runs a mechanism that returns a ServerActionResponse; a throw becomes an
 * ERROR, so one failing item does not stop the other items of a pick.
 */
async function runMechanism<T>(fn: () => Promise<ServerActionResponse<T>>): Promise<ServerActionResponse<T>> {
  try {
    return await fn();
  } catch (error) {
    logError("agent files: mechanism failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "ERROR", errors: [{ message: "Try again." }] };
  }
}

/** Rolls back a mechanism add when the persona row could not follow. */
async function undoAdd(target: Target, ref: AgentFileRef): Promise<void> {
  const { personaId, ownerUserId } = target;
  try {
    let res: ServerActionResponse<unknown>;
    switch (ref.kind) {
      case "document":
        res = await deleteSearchDocument({ id: ref.id, userId: ownerUserId });
        break;
      case "ci-document":
        res = await deleteCodeDocument({ id: ref.id, userId: ownerUserId });
        break;
      case "skill":
        res = await DeletePersonaSkill(personaId, ref.id);
        break;
      case "file-source":
        res = await DeletePersonaFileSource(personaId, ref.id);
        break;
    }
    if (res.status !== "OK") throw new Error(errorsText(res.errors));
  } catch (error) {
    logWarn("agent files: rollback failed", {
      personaId,
      kind: ref.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Search: index the text (PERSONA_DOCUMENT) and list the row on the persona. */
async function addAsSearch(target: Target, item: ResolvedItem, limits: AgentFileLimits): Promise<AddOutcome> {
  const persona = await readPersonaRow(target.personaId);
  if (!persona) return { ok: false, message: "Agent not found." };
  if ((persona.personaDocumentIds?.length ?? 0) >= limits.maxSearchFiles) {
    return { ok: false, message: limitText("search", limits.maxSearchFiles) };
  }
  if (item.info.size > limits.searchMaxBytes) {
    return {
      ok: false,
      message: `The file is larger than ${Math.round(limits.searchMaxBytes / 1_048_576)} MB, the limit for Search files.`,
    };
  }
  // When the indexing fails, the item is rejected and the persona row is not
  // touched: its stored ids stay as they were.
  const res = await runMechanism(() => addSearchDocument(asMetadata(item), target.ownerUserId));
  if (res.status !== "OK") {
    return {
      ok: false,
      message: `The file could not be indexed for Search, so it was not added. ${errorsText(res.errors)}`,
    };
  }
  const ref: AgentFileRef = { kind: "document", id: res.response };
  return attachToPersona(
    target,
    ref,
    withId("personaDocumentIds", ref.id, limits.maxSearchFiles, limitText("search", limits.maxSearchFiles)),
  );
}

/** Code: a PERSONA_CI_DOCUMENT row, listed on the persona; code interpreter on. */
async function addAsCode(target: Target, item: ResolvedItem, limits: AgentFileLimits): Promise<AddOutcome> {
  const persona = await readPersonaRow(target.personaId);
  if (!persona) return { ok: false, message: "Agent not found." };
  if ((persona.codeInterpreterDocumentIds?.length ?? 0) >= limits.maxCodeFiles) {
    return { ok: false, message: limitText("code", limits.maxCodeFiles) };
  }
  if (item.info.size > limits.codeMaxBytes) {
    return {
      ok: false,
      message: `The file is larger than ${Math.round(limits.codeMaxBytes / 1_048_576)} MB, the limit for Code files.`,
    };
  }
  const res = await runMechanism(() => addCodeDocument(asMetadata(item), target.ownerUserId));
  if (res.status !== "OK") {
    return { ok: false, message: `The file could not be added as a Code file. ${errorsText(res.errors)}` };
  }
  const ref: AgentFileRef = { kind: "ci-document", id: res.response };
  return attachToPersona(
    target,
    ref,
    withId("codeInterpreterDocumentIds", ref.id, limits.maxCodeFiles, limitText("code", limits.maxCodeFiles), true),
  );
}

type SkillZip = Extract<LinkedZipResult, { ok: true }>;

/** Skill: a skill linked to the zip (fetched here unless given); code interpreter on. */
async function addAsSkill(
  target: Target,
  item: ResolvedItem,
  prefetched?: SkillZip,
): Promise<AddOutcome> {
  let fetched = prefetched;
  if (!fetched) {
    const { token } = await getCurrentUser();
    const res = await fetchLinkedSkillZip(token, item.driveId, item.itemId);
    if (!res.ok) {
      return {
        ok: false,
        message: res.reason === "invalid" ? `The zip is not a skill: ${res.message}` : res.message,
      };
    }
    fetched = res;
  }
  const res = await linkSharePointSkill(
    { personaId: target.personaId, driveId: item.driveId, itemId: item.itemId },
    fetched,
  );
  if (res.status !== "OK") return { ok: false, message: errorsText(res.errors) };
  const ref: AgentFileRef = { kind: "skill", id: res.response.id };
  return attachToPersona(target, ref, withCodeInterpreterOn);
}

/** On demand: a SharePoint source row; code interpreter on. */
async function addAsOnDemand(target: Target, item: ResolvedItem): Promise<AddOutcome> {
  const res = await addPersonaFileSource(
    { personaId: target.personaId, driveId: item.driveId, itemId: item.itemId },
    item.info,
  );
  if (res.status !== "OK") return { ok: false, message: errorsText(res.errors) };
  const ref: AgentFileRef = { kind: "file-source", id: res.response.id };
  return attachToPersona(target, ref, withCodeInterpreterOn);
}

/**
 * Writes the persona side of an add (id list, code interpreter switch). When
 * that fails, the mechanism add is undone, so the item is not half added.
 */
async function attachToPersona(
  target: Target,
  ref: AgentFileRef,
  mutate: (p: PersonaModel) => PersonaModel | null,
): Promise<AddOutcome> {
  try {
    const stored = await updatePersonaRow(target.personaId, mutate);
    if (!stored) throw new Error("Agent not found.");
    return { ok: true, ref };
  } catch (error) {
    (error instanceof UseLimitReached ? logInfo : logError)("agent files: persona update failed, add undone", {
      personaId: target.personaId,
      kind: ref.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    await undoAdd(target, ref);
    return {
      ok: false,
      message: error instanceof UseLimitReached ? error.message : "The agent could not be saved. Try again.",
    };
  }
}

async function addWithUse(
  target: Target,
  item: ResolvedItem,
  use: AgentFileUse,
  limits: AgentFileLimits,
): Promise<AddOutcome> {
  switch (use) {
    case "search":
      return addAsSearch(target, item, limits);
    case "code":
      return addAsCode(target, item, limits);
    case "skill":
      return addAsSkill(target, item);
    case "on-demand":
      return addAsOnDemand(target, item);
  }
}

// ---------------------------------------------------------------------------
// Limits per use (also while several items are added at the same time)
// ---------------------------------------------------------------------------

type UseCounts = Record<AgentFileUse, number>;

const maxOfUse = (limits: AgentFileLimits): UseCounts => ({
  search: limits.maxSearchFiles,
  code: limits.maxCodeFiles,
  skill: limits.maxSkills,
  "on-demand": limits.maxOnDemand,
});

function limitText(use: AgentFileUse, max: number): string {
  switch (use) {
    case "search":
      return `An agent can have up to ${max} Search files.`;
    case "code":
      return `An agent can have up to ${max} Code files.`;
    case "skill":
      return `An agent can have up to ${max} skills.`;
    case "on-demand":
      return `An agent can have up to ${max} SharePoint folders and files.`;
  }
}

/**
 * The slots of each use. An item takes its slot before its add starts and
 * gives it back when the add fails, so items added at the same time never
 * take more than the limit together. When every slot is taken but some adds
 * of that use are still running, an item waits for them: a slot one of them
 * gives back can still be used.
 */
function useSlots(rows: AgentRows, limits: AgentFileLimits) {
  const max = maxOfUse(limits);
  const taken: UseCounts = {
    search: rows.persona.personaDocumentIds?.length ?? 0,
    code: rows.persona.codeInterpreterDocumentIds?.length ?? 0,
    skill: rows.skills.length,
    "on-demand": rows.sources.length,
  };
  const running: UseCounts = { search: 0, code: 0, skill: 0, "on-demand": 0 };
  let wake: () => void = () => {};
  let settled = new Promise<void>((resolve) => (wake = resolve));
  return {
    /** Takes a slot; the limit text when there is none (and none can come back). */
    async take(use: AgentFileUse): Promise<string | undefined> {
      for (;;) {
        if (taken[use] < max[use]) {
          taken[use]++;
          running[use]++;
          return undefined;
        }
        if (running[use] === 0) return limitText(use, max[use]);
        await settled;
      }
    },
    /** The add of an item with a slot ended; a failed add gives the slot back. */
    done(use: AgentFileUse, added: boolean) {
      running[use]--;
      if (!added) taken[use]--;
      const wakeAll = wake;
      settled = new Promise<void>((resolve) => (wake = resolve));
      wakeAll();
    },
  };
}

// ---------------------------------------------------------------------------
// Add (several items, one pick)
// ---------------------------------------------------------------------------

/** Items of one pick that are added at the same time. */
const ADD_PARALLEL = 4;

const rejected = (pick: AgentFilePick, reason: string, name = ""): AddAgentFileResult => ({
  driveId: pick.driveId,
  itemId: pick.itemId,
  status: "rejected",
  name,
  reason,
});

/**
 * Adds the picked SharePoint items. Each item gets its use from Graph
 * metadata (agent-file-classifier) and is added on its own: a rejected item
 * does not stop the others. Up to 4 items are added at the same time; the
 * results are in the order of the pick.
 */
export async function addAgentFiles(
  access: SkillAccess,
  picks: AgentFilePick[],
): Promise<AddAgentFileResult[]> {
  const target = targetOf(access);
  const limits = readAgentFileLimits();
  const { token } = await getCurrentUser();
  const rows = await loadAgentRows(access);
  const used = usedItemKeys(rows);
  const slots = useSlots(rows, limits);

  const infos = await mapLimit(picks, GRAPH_PARALLEL, (p) =>
    isGraphDriveId(p.driveId) && isGraphItemId(p.itemId)
      ? readItemInfo(token, p.driveId, p.itemId)
      : Promise.resolve<InfoResult>({ ok: false, status: "missing", message: "Choose a file or folder from SharePoint." }),
  );

  const addOne = async (i: number): Promise<AddAgentFileResult> => {
    const pick = picks[i];
    const res = infos[i];
    if (!res.ok) return rejected(pick, res.message);
    const { info } = res;
    const key = itemKey(pick.driveId, pick.itemId);
    if (used.has(key)) return rejected(pick, "The agent already uses this item.", info.name);
    // The item must be in the drive the client named (Graph decides).
    if ((info.parent && info.parent.driveId !== pick.driveId) || (!info.isFile && !info.isFolder)) {
      return rejected(pick, "Choose a file or folder from SharePoint.", info.name);
    }
    // Taken now, so the same item is not added twice at the same time.
    used.add(key);

    const item: ResolvedItem = { driveId: pick.driveId, itemId: pick.itemId, info };
    let use: AgentFileUse;
    let skillZip: SkillZip | undefined;
    if (!info.isFolder && /\.zip$/i.test(info.name)) {
      // A zip is a skill when it passes the skill validation, else a Code file.
      const fetched = await fetchLinkedSkillZip(token, pick.driveId, pick.itemId);
      if (fetched.ok) {
        use = "skill";
        skillZip = fetched;
      } else if (fetched.reason === "invalid") {
        const auto = automaticUse({ ...candidate(info), validSkillZip: false }, limits);
        if ("rejected" in auto) {
          used.delete(key);
          return rejected(pick, auto.rejected, info.name);
        }
        use = auto.use;
      } else {
        used.delete(key);
        return rejected(pick, fetched.message, info.name);
      }
    } else {
      const auto = automaticUse(candidate(info), limits);
      if ("rejected" in auto) {
        used.delete(key);
        return rejected(pick, auto.rejected, info.name);
      }
      use = auto.use;
    }

    const full = await slots.take(use);
    if (full) {
      used.delete(key);
      return rejected(pick, full, info.name);
    }
    let outcome: AddOutcome = { ok: false, message: "The file could not be added. Try again." };
    try {
      outcome = skillZip
        ? await addAsSkill(target, item, skillZip)
        : await addWithUse(target, item, use, limits);
    } finally {
      slots.done(use, outcome.ok);
    }
    if (!outcome.ok) {
      used.delete(key);
      return rejected(pick, outcome.message, info.name);
    }
    return { ...pick, status: "added", name: info.name, use, ref: outcome.ref };
  };

  const results = await mapLimit(
    picks.map((_, i) => i),
    ADD_PARALLEL,
    (i) =>
      addOne(i).catch((error): AddAgentFileResult => {
        logError("agent files: add of one item failed", {
          personaId: target.personaId,
          error: error instanceof Error ? error.message : String(error),
        });
        return rejected(picks[i], "The file could not be added. Try again.");
      }),
  );

  logInfo("agent files: added", {
    personaId: target.personaId,
    added: results.filter((r) => r.status === "added").length,
    rejected: results.filter((r) => r.status === "rejected").length,
  });
  return results;
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/**
 * Deletes the stored data of a Search or Code file the agent no longer
 * lists (persona-file-rows.ts). Returns a warning when something could not
 * be deleted (logged; the file is no longer used either way).
 */
async function deleteUnlistedRows(personaId: string, ref: AgentFileRef): Promise<string | undefined> {
  if (ref.kind !== "document" && ref.kind !== "ci-document") return undefined;
  const errors = await deleteFileRowsIfUnlisted(personaId, ref.kind, ref.id);
  if (errors.length === 0) return undefined;
  logError("agent files: stored data of a removed file not deleted", {
    personaId,
    kind: ref.kind,
    errors,
  });
  return REMOVED_NOT_CLEANED_WARNING;
}

/**
 * Removes one item from the agent. For Search and Code the persona list is
 * changed first (then chats no longer use the file), then the row and the
 * index entries go, in the row's own partition. When that cleanup fails, the
 * result is OK with a warning.
 */
export async function removeAgentFile(
  access: SkillAccess,
  ref: AgentFileRef,
): Promise<ServerActionResponse<RemoveAgentFileResult>> {
  const personaId = access.persona.id;
  switch (ref.kind) {
    case "document":
    case "ci-document": {
      const field: IdList = ref.kind === "document" ? "personaDocumentIds" : "codeInterpreterDocumentIds";
      if (!(access.persona[field] ?? []).includes(ref.id)) {
        return { status: "NOT_FOUND", errors: [{ message: "The file is not part of this agent." }] };
      }
      const stored = await updatePersonaRow(personaId, withoutId(field, ref.id));
      if (!stored) return { status: "NOT_FOUND", errors: [{ message: "Agent not found." }] };
      const warning = await deleteUnlistedRows(personaId, ref);
      return { status: "OK", response: warning ? { warning } : {} };
    }
    case "skill": {
      const res = await DeletePersonaSkill(personaId, ref.id);
      return res.status === "OK" ? { status: "OK", response: {} } : res;
    }
    case "file-source": {
      const res = await DeletePersonaFileSource(personaId, ref.id);
      return res.status === "OK" ? { status: "OK", response: {} } : res;
    }
  }
}

// ---------------------------------------------------------------------------
// Change of use
// ---------------------------------------------------------------------------

/** The SharePoint item behind a ref, from the stored row. */
function sharePointItemOf(
  rows: AgentRows,
  ref: AgentFileRef,
): { driveId: string; itemId: string } | { error: string; notFound?: true } {
  switch (ref.kind) {
    case "document":
    case "ci-document": {
      const row = (ref.kind === "document" ? rows.documents : rows.ciDocuments).get(ref.id);
      if (!row) return { error: "The file is not part of this agent.", notFound: true };
      return { driveId: row.externalFile.parentReference.driveId, itemId: row.externalFile.documentId };
    }
    case "skill": {
      const skill = rows.skills.find((s) => s.id === ref.id);
      if (!skill) return { error: "Skill not found.", notFound: true };
      if (!skill.source) return { error: "An uploaded skill can only be a skill." };
      return { driveId: skill.source.driveId, itemId: skill.source.itemId };
    }
    case "file-source": {
      const source = rows.sources.find((s) => s.id === ref.id);
      if (!source) return { error: "The item is not part of this agent.", notFound: true };
      return { driveId: source.driveId, itemId: source.itemId };
    }
  }
}

/** Whether the agent has this SharePoint item in this use already. */
function usesItemAs(rows: AgentRows, use: AgentFileUse, driveId: string, itemId: string): boolean {
  const key = itemKey(driveId, itemId);
  const docKey = (d: PersonaDocument | PersonaCIDocument) =>
    itemKey(d.externalFile.parentReference.driveId, d.externalFile.documentId);
  switch (use) {
    case "search":
      return [...rows.documents.values()].some((d) => docKey(d) === key);
    case "code":
      return [...rows.ciDocuments.values()].some((d) => docKey(d) === key);
    case "skill":
      return rows.skills.some((s) => s.source && itemKey(s.source.driveId, s.source.itemId) === key);
    case "on-demand":
      return rows.sources.some((s) => itemKey(s.driveId, s.itemId) === key);
  }
}

/**
 * Moves an item to another use: the new mechanism first, then the old one
 * goes. When the add fails, nothing changed; when the removal fails, the
 * new entry is undone, so the item keeps its old use. An item the agent has
 * in the new use already (an older agent can have one file twice) is
 * refused.
 */
export async function changeAgentFileUse(
  access: SkillAccess,
  ref: AgentFileRef,
  use: AgentFileUse,
): Promise<ServerActionResponse<ChangeAgentFileUseResult>> {
  const target = targetOf(access);
  const personaId = target.personaId;
  const current = USE_OF_REF_KIND[ref.kind];
  const rows = await loadAgentRows(access);
  const located = sharePointItemOf(rows, ref);
  if ("error" in located) {
    return { status: located.notFound ? "NOT_FOUND" : "ERROR", errors: [{ message: located.error }] };
  }
  if (use === current) return { status: "OK", response: { ref, use } };
  if (usesItemAs(rows, use, located.driveId, located.itemId)) {
    return {
      status: "ERROR",
      errors: [{ message: `This file is already used as ${AGENT_FILE_USE_TEXT[use].label}.` }],
    };
  }

  const { token } = await getCurrentUser();
  const res = await readItemInfo(token, located.driveId, located.itemId);
  if (!res.ok) return { status: "ERROR", errors: [{ message: res.message }] };
  const limits = readAgentFileLimits();
  const allowed = allowedUses(candidate(res.info, ref.kind === "skill" ? true : undefined), limits);
  if (!allowed.includes(use)) {
    return {
      status: "ERROR",
      errors: [{ message: `This item cannot be used as ${AGENT_FILE_USE_TEXT[use].label}.` }],
    };
  }

  const added = await addWithUse(target, { ...located, info: res.info }, use, limits);
  if (!added.ok) return { status: "ERROR", errors: [{ message: added.message }] };

  // The old entry goes; the access passed in still lists the old ids.
  const fresh = await readPersonaRow(personaId);
  const removed = fresh
    ? await removeAgentFile({ ...access, persona: fresh }, ref).catch(
        (error): ServerActionResponse<RemoveAgentFileResult> => ({
          status: "ERROR",
          errors: [{ message: error instanceof Error ? error.message : String(error) }],
        }),
      )
    : ({ status: "NOT_FOUND", errors: [{ message: "Agent not found." }] } as ServerActionResponse<RemoveAgentFileResult>);
  if (removed.status !== "OK") {
    logError("agent files: change of use failed, new entry undone", {
      personaId,
      from: current,
      to: use,
    });
    await removeAgentFile({ ...access, persona: (await readPersonaRow(personaId)) ?? access.persona }, added.ref).catch(
      () => undefined,
    );
    return { status: "ERROR", errors: [{ message: "The use could not be changed. Try again." }] };
  }
  logInfo("agent files: use changed", { personaId, from: current, to: use });
  return {
    status: "OK",
    response: { ref: added.ref, use, ...(removed.response.warning ? { warning: removed.response.warning } : {}) },
  };
}
