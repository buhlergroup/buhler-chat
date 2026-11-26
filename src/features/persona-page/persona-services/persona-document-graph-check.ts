import "server-only";

/**
 * Graph checks of the Search files of an agent with the current user's
 * token: which files the user may read in SharePoint, and the requests for
 * their details. Server code only (the search tool of a chat and the
 * DocumentDetails action); nothing here is callable from the browser.
 *
 * Every list is capped at the per-agent Search file limit
 * (MAX_PERSONA_DOCUMENT_LIMIT), so a call never sends more Graph requests
 * than one agent can need. A drive or item id that is not a Graph id is
 * dropped before a URL is built.
 */

import { getGraphClient } from "@/features/common/services/microsoft-graph-client";
import {
  GraphBatchRequest,
  postGraphBatches,
} from "@/features/common/services/microsoft-graph-batch";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { logWarn } from "@/features/common/services/logger";
import {
  isGraphDriveId,
  isGraphItemId,
} from "@/features/common/services/sharepoint/graph-ids";
import {
  PERSONA_DOCUMENT_ATTRIBUTE,
  PersonaDocument,
  SharePointFile,
  convertPersonaDocumentToSharePointDocument,
} from "./models";
import {
  FindAccessiblePersonaDocument,
  PersonaAccessCache,
} from "./persona-document-access";

const positiveInt = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** The Search file limit of one agent (the same value as the editor). */
export const maxPersonaDocuments = (): number =>
  positiveInt(process.env.MAX_PERSONA_DOCUMENT_LIMIT, 25);

/** True when the drive and item id can go into a Graph URL. */
export const hasGraphIds = (document: SharePointFile): boolean =>
  isGraphDriveId(document?.parentReference?.driveId) &&
  isGraphItemId(document?.documentId);

/**
 * One GET per document (`/drives/{drive}/items/{item}`). A document whose
 * drive or item id is not a Graph id gets no request.
 */
export const documentDetailRequests = (
  documents: ReadonlyArray<SharePointFile>,
  filters: string[]
): GraphBatchRequest[] =>
  documents.filter(hasGraphIds).map((document) => ({
    id: document.documentId,
    method: "GET",
    url: `/drives/${document.parentReference.driveId}/items/${
      document.documentId
    }?$select=${filters.join(",")}`,
  }));

/** The first `max` items; logs when some are left out. */
const capped = <T>(items: ReadonlyArray<T>, what: string): T[] => {
  const max = maxPersonaDocuments();
  if (items.length > max) {
    logWarn("persona documents: list capped at the agent limit", {
      what,
      count: items.length,
      max,
    });
  }
  return items.slice(0, max);
};

/**
 * The ids (row ids) of the documents the current user may read in
 * SharePoint: only a 200 answer of Graph allows a document. At most the
 * agent limit of documents is checked; invalid ids are dropped.
 */
export const authorizedDocuments = async (
  documents: ReadonlyArray<SharePointFile>
): Promise<string[]> => {
  try {
    const checked = capped(Array.isArray(documents) ? documents : [], "authorized").filter(
      hasGraphIds
    );
    if (checked.length === 0) return [];
    const { token } = await getCurrentUser();
    const client = getGraphClient(token);
    // Graph takes at most 20 requests per batch: sent in chunks. A document
    // of a failed chunk is not allowed, the documents of the other chunks
    // still are.
    const batch = await postGraphBatches(
      client,
      documentDetailRequests(checked, ["id"])
    );

    const allowed: string[] = [];
    batch.responses.forEach((responseItem) => {
      if (responseItem.status === 200) {
        allowed.push(
          checked.find((doc) => doc.documentId === responseItem.id)?.id || ""
        );
      }
    });
    return allowed;
  } catch {
    return [];
  }
};

/**
 * The Search file row ids of a chat that the current user may use: the row
 * must be one the user can open (FindAccessiblePersonaDocument) and the
 * SharePoint file one the user can read (authorizedDocuments).
 */
export const allowedPersonaDocumentIds = async (
  personaDocumentIds: ReadonlyArray<string>
): Promise<string[]> => {
  try {
    if (!Array.isArray(personaDocumentIds) || personaDocumentIds.length === 0) {
      return [];
    }
    const cache: PersonaAccessCache = new Map();
    const rows = await Promise.all(
      capped(personaDocumentIds, "allowed").map((id) =>
        FindAccessiblePersonaDocument<PersonaDocument>(
          id,
          PERSONA_DOCUMENT_ATTRIBUTE,
          cache
        ).catch(() => undefined)
      )
    );
    const documents = rows
      .filter((row): row is PersonaDocument => row !== undefined)
      .map(convertPersonaDocumentToSharePointDocument);
    return await authorizedDocuments(documents);
  } catch {
    return [];
  }
};
