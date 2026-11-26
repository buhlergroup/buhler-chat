import "server-only";

/**
 * Deletes the stored data of Search and Code files an agent no longer uses:
 * when one file is removed (agent-files) and when the whole agent is deleted
 * (DeletePersona). Not a "use server" module: the callers check the edit
 * permission first.
 *
 * Each row is deleted in its own partition (row.userId), and for Search its
 * index chunks by the same id, so a row an admin wrote before the
 * owner-partition rule goes too. A row another agent still lists stays.
 */

import { HistoryContainer } from "@/features/common/services/cosmos";
import { logError, logInfo } from "@/features/common/services/logger";
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
 * Deletes the rows (and Search chunks) of one file id that the agent
 * `personaId` no longer uses, unless another agent lists the id. Returns the
 * error texts; empty when everything went (or nothing was to delete).
 */
export async function deleteFileRowsIfUnlisted(
  personaId: string,
  kind: FileRowKind,
  id: string,
): Promise<string[]> {
  try {
    if (await listedByAnotherAgent(LIST_OF[kind], id, personaId)) {
      logInfo("agent files: row kept, another agent lists it", { personaId, kind });
      return [];
    }
    const rows = await rowsById(TYPE_OF[kind], id);
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
  persona: Pick<PersonaModel, "id" | "personaDocumentIds" | "codeInterpreterDocumentIds">,
): Promise<number> {
  const work: Array<[FileRowKind, string]> = [
    ...[...new Set(persona.personaDocumentIds ?? [])].map((id): [FileRowKind, string] => ["document", id]),
    ...[...new Set(persona.codeInterpreterDocumentIds ?? [])].map((id): [FileRowKind, string] => ["ci-document", id]),
  ];
  let failed = 0;
  for (const [kind, id] of work) {
    const errors = await deleteFileRowsIfUnlisted(persona.id, kind, id);
    if (errors.length > 0) {
      failed++;
      logError("agent delete: stored data of a file not deleted", { personaId: persona.id, kind, errors });
    }
  }
  return failed;
}
