import "server-only";

/**
 * Deletes the stored data of Search and Code files an agent no longer uses:
 * when one file is removed (agent-files) and when the whole agent is deleted
 * (DeletePersona). Not a "use server" module: the callers check the edit
 * permission first.
 *
 * Only rows in the agent OWNER's partition are deleted (row.userId equals
 * persona.userId), and for Search their index chunks by the same id. The one
 * exception: a row an admin wrote in the admin's own partition before the
 * owner-partition rule. It goes too when its partition is the caller's
 * (owner or admin) or the one of an admin (ADMIN_EMAIL_ADDRESS). A row in
 * the partition of any other user is never deleted from here, also with the
 * same id (logged and kept). A row another agent still lists stays.
 */

import { createHash } from "crypto";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { logError, logInfo, logWarn } from "@/features/common/services/logger";
import {
  PERSONA_ATTRIBUTE,
  PERSONA_CI_DOCUMENT_ATTRIBUTE,
  PERSONA_DOCUMENT_ATTRIBUTE,
  type PersonaModel,
} from "./models";
import { deleteSearchDocument } from "./persona-documents-store";
import { deleteCodeDocument } from "./persona-ci-documents-store";

/** The two kinds of file rows the persona lists by id. */
export type FileRowKind = "document" | "ci-document";

type IdList = "personaDocumentIds" | "codeInterpreterDocumentIds";

const LIST_OF: Record<FileRowKind, IdList> = {
  document: "personaDocumentIds",
  "ci-document": "codeInterpreterDocumentIds",
};

const TYPE_OF: Record<FileRowKind, typeof PERSONA_DOCUMENT_ATTRIBUTE | typeof PERSONA_CI_DOCUMENT_ATTRIBUTE> = {
  document: PERSONA_DOCUMENT_ATTRIBUTE,
  "ci-document": PERSONA_CI_DOCUMENT_ATTRIBUTE,
};

// The list field is fixed in code, never taken from input.
const LISTED_QUERY: Record<IdList, string> = {
  personaDocumentIds:
    "SELECT VALUE COUNT(1) FROM root r WHERE r.type=@type AND r.id!=@personaId AND ARRAY_CONTAINS(r.personaDocumentIds, @id)",
  codeInterpreterDocumentIds:
    "SELECT VALUE COUNT(1) FROM root r WHERE r.type=@type AND r.id!=@personaId AND ARRAY_CONTAINS(r.codeInterpreterDocumentIds, @id)",
};

/** Whether an agent other than `personaId` lists the id. */
async function listedByAnotherAgent(field: IdList, id: string, personaId: string): Promise<boolean> {
  const { resources } = await HistoryContainer()
    .items.query<number>({
      query: LISTED_QUERY[field],
      parameters: [
        { name: "@type", value: PERSONA_ATTRIBUTE },
        { name: "@personaId", value: personaId },
        { name: "@id", value: id },
      ],
    })
    .fetchAll();
  return (resources[0] ?? 0) > 0;
}

/** The rows with this id and type, in any partition. */
async function rowsById(
  type: typeof PERSONA_DOCUMENT_ATTRIBUTE | typeof PERSONA_CI_DOCUMENT_ATTRIBUTE,
  id: string,
): Promise<Array<{ id: string; userId: string }>> {
  const { resources } = await HistoryContainer()
    .items.query<{ id: string; userId: string; type: string }>({
      query: "SELECT r.id, r.userId, r.type FROM root r WHERE r.type=@type AND r.id=@id",
      parameters: [
        { name: "@type", value: type },
        { name: "@id", value: id },
      ],
    })
    .fetchAll();
  return resources.filter((r) => r?.id === id && r.type === type && typeof r.userId === "string");
}

/**
 * Partitions (hashed e-mail) of the admins (ADMIN_EMAIL_ADDRESS): the only
 * partitions besides the owner's and the caller's that may hold a row of
 * the agent (written by an admin before the owner-partition rule). Both the
 * address as written and in lower case, as the sign-in may keep its case.
 * The hash is the one of userHashedId (sha256 hex of the e-mail).
 */
function adminPartitions(): string[] {
  const hashValue = (value: string) => createHash("sha256").update(value).digest("hex");
  const emails = (process.env.ADMIN_EMAIL_ADDRESS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  return [...new Set(emails.flatMap((e) => [hashValue(e), hashValue(e.toLowerCase())]))];
}

/** The agent whose file rows are deleted, and the user who deletes them. */
export interface FileRowOwner {
  personaId: string;
  /** The agent owner's partition (persona.userId). */
  ownerUserId: string;
  /** The caller (owner or admin): its own partition may hold a legacy row. */
  callerUserId?: string;
}

/**
 * Deletes the rows (and Search chunks) of one file id that the agent no
 * longer uses, unless another agent lists the id. Only rows in the owner's
 * partition, or in the caller's own partition (a legacy admin row), are
 * deleted. Returns the error texts; empty when everything went (or nothing
 * was to delete).
 */
export async function deleteFileRowsIfUnlisted(
  owner: FileRowOwner,
  kind: FileRowKind,
  id: string,
): Promise<string[]> {
  const { personaId, ownerUserId, callerUserId } = owner;
  try {
    if (!ownerUserId) return ["The owner of the agent is not known."];
    if (await listedByAnotherAgent(LIST_OF[kind], id, personaId)) {
      logInfo("agent files: row kept, another agent lists it", { personaId, kind });
      return [];
    }
    const partitions = new Set([
      ownerUserId,
      ...(callerUserId ? [callerUserId] : []),
      ...adminPartitions(),
    ]);
    const found = await rowsById(TYPE_OF[kind], id);
    const rows = found.filter((row) => partitions.has(row.userId));
    if (rows.length < found.length) {
      logWarn("agent files: row in another partition kept", {
        personaId,
        kind,
        kept: found.length - rows.length,
      });
    }
    const results = await Promise.all(
      rows.map((row) => (kind === "document" ? deleteSearchDocument(row) : deleteCodeDocument(row))),
    );
    return results.flatMap((r) => (r.status === "OK" ? [] : r.errors.map((e) => e.message)));
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/**
 * Deletes the Search and Code file rows of an agent that is being deleted.
 * Never throws: a failure is logged and does not stop the agent delete.
 * Returns the number of file ids whose data could not be deleted.
 */
export async function deleteAgentFileRows(
  persona: Pick<PersonaModel, "id" | "userId" | "personaDocumentIds" | "codeInterpreterDocumentIds">,
  callerUserId?: string,
): Promise<number> {
  const work: Array<[FileRowKind, string]> = [
    ...[...new Set(persona.personaDocumentIds ?? [])].map((id): [FileRowKind, string] => ["document", id]),
    ...[...new Set(persona.codeInterpreterDocumentIds ?? [])].map((id): [FileRowKind, string] => ["ci-document", id]),
  ];
  let failed = 0;
  for (const [kind, id] of work) {
    const errors = await deleteFileRowsIfUnlisted(
      { personaId: persona.id, ownerUserId: persona.userId, callerUserId },
      kind,
      id,
    );
    if (errors.length > 0) {
      failed++;
      logError("agent delete: stored data of a file not deleted", { personaId: persona.id, kind, errors });
    }
  }
  return failed;
}
