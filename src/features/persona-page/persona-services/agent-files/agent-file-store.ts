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
import { getCodeInterpreterFileLimit } from "@/features/chat-page/chat-services/code-interpreter-constants";
import {
  PERSONA_CI_DOCUMENT_ATTRIBUTE,
  PERSONA_DOCUMENT_ATTRIBUTE,
  type DocumentMetadata,
  type PersonaCIDocument,
  type PersonaDocument,
  type PersonaModel,
} from "../models";
import { UpdateOrAddPersonaDocuments } from "../persona-documents-service";
import {
  DeletePersonaCIDocumentById,
  UpdateOrAddPersonaCIDocuments,
} from "../persona-ci-documents-service";
import { querySkillsByPersonaId, readPersonaRow, type SkillAccess } from "../skills/persona-skill-store";
import { SKILL_LIMITS, type PersonaSkillModel } from "../skills/skill-models";
import { fetchLinkedSkillZip } from "../skills/linked-skill-sync";
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
  AGENT_FILE_USE_TEXT,
  USE_OF_REF_KIND,
  type AddAgentFileResult,
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
    codeMaxBytes: positiveInt(
      env.MAX_PERSONA_CI_DOCUMENT_SIZE ?? env.NEXT_PUBLIC_MAX_PERSONA_CI_DOCUMENT_SIZE,
      536_870_912,
    ),
    onDemandMaxBytes: sharePoint.maxFileBytes,
  };
}

// ---------------------------------------------------------------------------
// Persona row: etag-checked change of the file lists
// ---------------------------------------------------------------------------

type StoredPersona = PersonaModel & { _etag?: string };

const isPreconditionFailed = (error: unknown) =>
  ((error as { code?: number })?.code ?? (error as { statusCode?: number })?.statusCode) === 412;

/**
 * Reads the persona row, applies `mutate` and writes it back only when the
 * row did not change meanwhile (If-Match etag); on a conflict it reads the
 * row again and retries. `mutate` returns null for "nothing to change".
 * Returns the stored row, or undefined when the agent is gone.
 */
export async function updatePersonaRow(
  personaId: string,
  mutate: (persona: PersonaModel) => PersonaModel | null,
): Promise<PersonaModel | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = (await readPersonaRow(personaId)) as StoredPersona | undefined;
    if (!current) return undefined;
    const next = mutate(current);
    if (!next) return current;
    try {
      const { resource } = await HistoryContainer()
        .item(current.id, current.userId)
        .replace<PersonaModel>(
          next,
          current._etag ? { accessCondition: { type: "IfMatch", condition: current._etag } } : undefined,
        );
      return resource ?? next;
    } catch (error) {
      if (isPreconditionFailed(error)) continue;
      throw error;
    }
  }
  throw new Error("The agent changed while saving. Try again.");
}

type IdList = "personaDocumentIds" | "codeInterpreterDocumentIds";

const withId = (field: IdList, id: string, codeInterpreterOn = false) => (p: PersonaModel) => ({
  ...p,
  [field]: [...(p[field] ?? []).filter((x) => x !== id), id],
  ...(codeInterpreterOn ? { defaultTools: { ...(p.defaultTools ?? {}), codeInterpreter: true } } : {}),
});

const withoutId = (field: IdList, id: string) => (p: PersonaModel) =>
  (p[field] ?? []).includes(id) ? { ...p, [field]: (p[field] ?? []).filter((x) => x !== id) } : null;

const withCodeInterpreterOn = (p: PersonaModel) =>
  p.defaultTools?.codeInterpreter === true
    ? null
    : { ...p, defaultTools: { ...(p.defaultTools ?? {}), codeInterpreter: true } };

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
      ? { ok: false, status: "no-access", message: "Ask the owner of this item in SharePoint for access." }
      : { ok: false, status: "unavailable", message: "SharePoint is busy. Try again later." };
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

const errorsText = (errors: { message: string }[]) =>
  errors.map((e) => e.message).join(" ") || "The file could not be added.";

const asMetadata = (item: ResolvedItem): DocumentMetadata => ({
  documentId: item.itemId,
  parentReference: { driveId: item.driveId },
  name: item.info.name,
  createdBy: "",
  createdDateTime: "",
});

/** Rolls back a mechanism add when the persona row could not follow. */
async function undoAdd(personaId: string, ref: AgentFileRef): Promise<void> {
  try {
    switch (ref.kind) {
      case "document":
        await UpdateOrAddPersonaDocuments([], [ref.id]);
        break;
      case "ci-document":
        await DeletePersonaCIDocumentById(ref.id);
        break;
      case "skill":
        await DeletePersonaSkill(personaId, ref.id);
        break;
      case "file-source":
        await DeletePersonaFileSource(personaId, ref.id);
        break;
    }
  } catch (error) {
    logWarn("agent files: rollback failed", {
      personaId,
      kind: ref.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Search: index the text (PERSONA_DOCUMENT) and list the row on the persona. */
async function addAsSearch(personaId: string, item: ResolvedItem, limits: AgentFileLimits): Promise<AddOutcome> {
  const persona = await readPersonaRow(personaId);
  if (!persona) return { ok: false, message: "Agent not found." };
  if ((persona.personaDocumentIds?.length ?? 0) >= limits.maxSearchFiles) {
    return { ok: false, message: `An agent can have up to ${limits.maxSearchFiles} Search files.` };
  }
  if (item.info.size > limits.searchMaxBytes) {
    return {
      ok: false,
      message: `The file is larger than ${Math.round(limits.searchMaxBytes / 1_048_576)} MB, the limit for Search files.`,
    };
  }
  const res = await UpdateOrAddPersonaDocuments([asMetadata(item)], []);
  if (res.status !== "OK" || !res.response[0]) {
    return { ok: false, message: res.status === "OK" ? "The file could not be indexed." : errorsText(res.errors) };
  }
  const ref: AgentFileRef = { kind: "document", id: res.response[0] };
  return attachToPersona(personaId, ref, withId("personaDocumentIds", ref.id));
}

/** Code: a PERSONA_CI_DOCUMENT row, listed on the persona; code interpreter on. */
async function addAsCode(personaId: string, item: ResolvedItem, limits: AgentFileLimits): Promise<AddOutcome> {
  const persona = await readPersonaRow(personaId);
  if (!persona) return { ok: false, message: "Agent not found." };
  if ((persona.codeInterpreterDocumentIds?.length ?? 0) >= limits.maxCodeFiles) {
    return { ok: false, message: `An agent can have up to ${limits.maxCodeFiles} Code files.` };
  }
  if (item.info.size > limits.codeMaxBytes) {
    return {
      ok: false,
      message: `The file is larger than ${Math.round(limits.codeMaxBytes / 1_048_576)} MB, the limit for Code files.`,
    };
  }
  const res = await UpdateOrAddPersonaCIDocuments([asMetadata(item)], []);
  if (res.status !== "OK" || !res.response[0]) {
    return { ok: false, message: res.status === "OK" ? "The file could not be added." : errorsText(res.errors) };
  }
  const ref: AgentFileRef = { kind: "ci-document", id: res.response[0] };
  return attachToPersona(personaId, ref, withId("codeInterpreterDocumentIds", ref.id, true));
}

/** Skill: a skill linked to the zip; code interpreter on. */
async function addAsSkill(personaId: string, item: ResolvedItem): Promise<AddOutcome> {
  const { token } = await getCurrentUser();
  const fetched = await fetchLinkedSkillZip(token, item.driveId, item.itemId);
  if (!fetched.ok) {
    return {
      ok: false,
      message: fetched.reason === "invalid" ? `The zip is not a skill: ${fetched.message}` : fetched.message,
    };
  }
  const res = await linkSharePointSkill({ personaId, driveId: item.driveId, itemId: item.itemId }, fetched);
  if (res.status !== "OK") return { ok: false, message: errorsText(res.errors) };
  const ref: AgentFileRef = { kind: "skill", id: res.response.id };
  return attachToPersona(personaId, ref, withCodeInterpreterOn);
}

/** On demand: a SharePoint source row; code interpreter on. */
async function addAsOnDemand(personaId: string, item: ResolvedItem): Promise<AddOutcome> {
  const res = await addPersonaFileSource({ personaId, driveId: item.driveId, itemId: item.itemId }, item.info);
  if (res.status !== "OK") return { ok: false, message: errorsText(res.errors) };
  const ref: AgentFileRef = { kind: "file-source", id: res.response.id };
  return attachToPersona(personaId, ref, withCodeInterpreterOn);
}

/**
 * Writes the persona side of an add (id list, code interpreter switch). When
 * that fails, the mechanism add is undone, so the item is not half added.
 */
async function attachToPersona(
  personaId: string,
  ref: AgentFileRef,
  mutate: (p: PersonaModel) => PersonaModel | null,
): Promise<AddOutcome> {
  try {
    const stored = await updatePersonaRow(personaId, mutate);
    if (!stored) throw new Error("Agent not found.");
    return { ok: true, ref };
  } catch (error) {
    logError("agent files: persona update failed, add undone", {
      personaId,
      kind: ref.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    await undoAdd(personaId, ref);
    return { ok: false, message: "The agent could not be saved. Try again." };
  }
}

async function addWithUse(
  personaId: string,
  item: ResolvedItem,
  use: AgentFileUse,
  limits: AgentFileLimits,
): Promise<AddOutcome> {
  switch (use) {
    case "search":
      return addAsSearch(personaId, item, limits);
    case "code":
      return addAsCode(personaId, item, limits);
    case "skill":
      return addAsSkill(personaId, item);
    case "on-demand":
      return addAsOnDemand(personaId, item);
  }
}

// ---------------------------------------------------------------------------
// Add (several items, one pick)
// ---------------------------------------------------------------------------

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
 * does not stop the others.
 */
export async function addAgentFiles(
  access: SkillAccess,
  picks: AgentFilePick[],
): Promise<AddAgentFileResult[]> {
  const personaId = access.persona.id;
  const limits = readAgentFileLimits();
  const { token } = await getCurrentUser();
  const rows = await loadAgentRows(access);
  const used = usedItemKeys(rows);

  const infos = await mapLimit(picks, GRAPH_PARALLEL, (p) =>
    isGraphDriveId(p.driveId) && isGraphItemId(p.itemId)
      ? readItemInfo(token, p.driveId, p.itemId)
      : Promise.resolve<InfoResult>({ ok: false, status: "missing", message: "Choose a file or folder from SharePoint." }),
  );

  const results: AddAgentFileResult[] = [];
  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i];
    const res = infos[i];
    if (!res.ok) {
      results.push(rejected(pick, res.message));
      continue;
    }
    const { info } = res;
    const key = itemKey(pick.driveId, pick.itemId);
    if (used.has(key)) {
      results.push(rejected(pick, "The agent already uses this item.", info.name));
      continue;
    }
    // The item must be in the drive the client named (Graph decides).
    if ((info.parent && info.parent.driveId !== pick.driveId) || (!info.isFile && !info.isFolder)) {
      results.push(rejected(pick, "Choose a file or folder from SharePoint.", info.name));
      continue;
    }

    const item: ResolvedItem = { driveId: pick.driveId, itemId: pick.itemId, info };
    let outcome: AddOutcome;
    let use: AgentFileUse;
    if (!info.isFolder && /\.zip$/i.test(info.name)) {
      // A zip is a skill when it passes the skill validation, else a Code file.
      const fetched = await fetchLinkedSkillZip(token, pick.driveId, pick.itemId);
      if (fetched.ok) {
        use = "skill";
        const linked = await linkSharePointSkill({ personaId, ...pick }, fetched);
        outcome =
          linked.status === "OK"
            ? await attachToPersona(personaId, { kind: "skill", id: linked.response.id }, withCodeInterpreterOn)
            : { ok: false, message: errorsText(linked.errors) };
      } else if (fetched.reason === "invalid") {
        const auto = automaticUse({ ...candidate(info), validSkillZip: false }, limits);
        if ("rejected" in auto) {
          results.push(rejected(pick, auto.rejected, info.name));
          continue;
        }
        use = auto.use;
        outcome = await addWithUse(personaId, item, use, limits);
      } else {
        results.push(rejected(pick, fetched.message, info.name));
        continue;
      }
    } else {
      const auto = automaticUse(candidate(info), limits);
      if ("rejected" in auto) {
        results.push(rejected(pick, auto.rejected, info.name));
        continue;
      }
      use = auto.use;
      outcome = await addWithUse(personaId, item, use, limits);
    }

    if (outcome.ok) {
      used.add(key);
      results.push({ ...pick, status: "added", name: info.name, use, ref: outcome.ref });
    } else {
      results.push(rejected(pick, outcome.message, info.name));
    }
  }

  logInfo("agent files: added", {
    personaId,
    added: results.filter((r) => r.status === "added").length,
    rejected: results.filter((r) => r.status === "rejected").length,
  });
  return results;
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/**
 * Removes one item from the agent. For Search and Code the persona list is
 * changed first (then chats no longer use the file), then the row and the
 * index entry go (best effort).
 */
export async function removeAgentFile(
  access: SkillAccess,
  ref: AgentFileRef,
): Promise<ServerActionResponse<true>> {
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
      try {
        if (ref.kind === "document") await UpdateOrAddPersonaDocuments([], [ref.id]);
        else await DeletePersonaCIDocumentById(ref.id);
      } catch (error) {
        logWarn("agent files: row cleanup failed", {
          personaId,
          kind: ref.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { status: "OK", response: true };
    }
    case "skill": {
      const res = await DeletePersonaSkill(personaId, ref.id);
      return res.status === "OK" ? { status: "OK", response: true } : res;
    }
    case "file-source": {
      const res = await DeletePersonaFileSource(personaId, ref.id);
      return res.status === "OK" ? { status: "OK", response: true } : res;
    }
  }
}

// ---------------------------------------------------------------------------
// Change of use
// ---------------------------------------------------------------------------

/** The SharePoint item behind a ref, from the stored row. */
async function sharePointItemOf(
  access: SkillAccess,
  ref: AgentFileRef,
): Promise<{ driveId: string; itemId: string } | { error: string; notFound?: true }> {
  const rows = await loadAgentRows(access);
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

/**
 * Moves an item to another use: the new mechanism first, then the old one
 * goes. When the add fails, nothing changed; when the removal fails, the
 * new entry is undone, so the item keeps its old use.
 */
export async function changeAgentFileUse(
  access: SkillAccess,
  ref: AgentFileRef,
  use: AgentFileUse,
): Promise<ServerActionResponse<{ ref: AgentFileRef; use: AgentFileUse }>> {
  const personaId = access.persona.id;
  const current = USE_OF_REF_KIND[ref.kind];
  const located = await sharePointItemOf(access, ref);
  if ("error" in located) {
    return { status: located.notFound ? "NOT_FOUND" : "ERROR", errors: [{ message: located.error }] };
  }
  if (use === current) return { status: "OK", response: { ref, use } };

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

  const added = await addWithUse(personaId, { ...located, info: res.info }, use, limits);
  if (!added.ok) return { status: "ERROR", errors: [{ message: added.message }] };

  // The old entry goes; the access passed in still lists the old ids.
  const fresh = await readPersonaRow(personaId);
  const removed = fresh
    ? await removeAgentFile({ ...access, persona: fresh }, ref).catch(
        (error): ServerActionResponse<true> => ({
          status: "ERROR",
          errors: [{ message: error instanceof Error ? error.message : String(error) }],
        }),
      )
    : ({ status: "NOT_FOUND", errors: [{ message: "Agent not found." }] } as ServerActionResponse<true>);
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
  return { status: "OK", response: { ref: added.ref, use } };
}

