"use server";
import "server-only";

// Server action for Search files of an agent: the details for the agent
// panel of a chat. The access checks of a chat (persona-document-graph-check.ts)
// and adding and removing a file, also when the agent is deleted, are server
// code only (persona-documents-store.ts, persona-file-rows.ts).
//
// Rules for this file: every export is an async function and is callable
// from the browser. Helpers that only server code uses do not belong here.

import { ServerActionResponse } from "@/features/common/server-action-response";
import { getGraphClient } from "../../common/services/microsoft-graph-client";
import { postGraphBatches } from "@/features/common/services/microsoft-graph-batch";
import { getCurrentUser } from "@/features/auth-page/helpers";
import {
  DocumentMetadata,
  PERSONA_DOCUMENT_ATTRIBUTE,
  PersonaDocument,
  SharePointFile,
  SharePointFileSchema,
  convertPersonaDocumentToSharePointDocument,
} from "./models";
import {
  FindAccessiblePersonaDocument,
  PersonaAccessCache,
} from "./persona-document-access";
import {
  documentDetailRequests,
  maxPersonaDocuments,
} from "./persona-document-graph-check";
import { findPersonaForCurrentUser } from "./persona-lookup";
import { FindChatThreadForCurrentUser } from "@/features/chat-page/chat-services/chat-thread-service";

const positiveInt = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * SharePoint details of the Search files of an agent, for the agent panel of
 * a chat. The client sends the Search file row ids (`id`) only. Only files
 * the caller may use are looked up: each `id` must be a Search file row the
 * caller can open (FindAccessiblePersonaDocument), and the drive and item
 * come from that row, not from the client; a row whose drive or item id is
 * not a Graph id gets no request. Any other file counts as unsuccessful. At
 * most the per-agent Search file limit of ids per call.
 */
export async function DocumentDetails(
  documents: Array<Pick<SharePointFile, "id"> & Partial<SharePointFile>>
): Promise<
  ServerActionResponse<{
    successful: DocumentMetadata[];
    sizeToBig: DocumentMetadata[];
    unsuccessful: { documentId: string }[];
  }>
> {
  const maxCount = maxPersonaDocuments();
  const maxSize = positiveInt(process.env.MAX_PERSONA_DOCUMENT_SIZE, 10485760);

  try {
    if (!Array.isArray(documents) || documents.length === 0) {
      return {
        status: "OK",
        response: {
          successful: [],
          unsuccessful: [],
          sizeToBig: [],
        },
      };
    }

    if (documents.length > maxCount) {
      return {
        status: "ERROR",
        errors: [
          {
            message: `Document IDs limit exceeded. Maximum is ${maxCount}.`,
          },
        ],
      };
    }

    const cache: PersonaAccessCache = new Map();
    const rows = await Promise.all(
      documents.map((doc) =>
        typeof doc?.id === "string"
          ? FindAccessiblePersonaDocument<PersonaDocument>(
              doc.id,
              PERSONA_DOCUMENT_ATTRIBUTE,
              cache
            ).catch(() => undefined)
          : Promise.resolve(undefined)
      )
    );
    const allowed: SharePointFile[] = [];
    const denied: { documentId: string }[] = [];
    rows.forEach((row, i) => {
      // The stored drive and item id must be Graph ids (SharePointFileSchema)
      // before they go into a URL.
      if (row && SharePointFileSchema.safeParse(row.externalFile).success) {
        allowed.push(convertPersonaDocumentToSharePointDocument(row));
      } else {
        denied.push({ documentId: String(documents[i]?.documentId ?? "") });
      }
    });
    if (allowed.length === 0) {
      return {
        status: "OK",
        response: { successful: [], unsuccessful: denied, sizeToBig: [] },
      };
    }

    const { token } = await getCurrentUser();
    const client = getGraphClient(token);
    const requests = documentDetailRequests(allowed, [
      "id",
      "name",
      "createdBy",
      "createdDateTime",
      "parentReference",
      "size",
    ]);
    // Graph takes at most 20 requests per batch: sent in chunks.
    const batch = await postGraphBatches(client, requests);
    if (requests.length > 0 && batch.failedIds.length === requests.length) {
      throw batch.errors[0];
    }

    let successful: DocumentMetadata[] = [];
    // A document of a failed chunk has no answer: it counts as unsuccessful.
    let unsuccessful: { documentId: string }[] = [
      ...denied,
      ...batch.failedIds.map((documentId) => ({ documentId })),
    ];
    let sizeToBig: DocumentMetadata[] = [];

    // Create a map to look up the original document by SharePoint documentId
    const documentIdMap = new Map<string, SharePointFile>();
    for (const doc of allowed) {
      documentIdMap.set(doc.documentId, doc);
    }

    for (const responseItem of batch.responses) {
      if (responseItem.status === 200) {
        const document = responseItem.body;
        // Get the original document to preserve its id
        const originalDoc = documentIdMap.get(document.id);

        if (document.size > maxSize) {
          sizeToBig.push({
            id: originalDoc?.id, // Preserve the PersonaDocument id
            documentId: document.id,
            name: document.name,
            createdBy: document.createdBy.user.displayName,
            createdDateTime: document.createdDateTime,
            parentReference: {
              driveId: document.parentReference?.driveId,
            },
          } as DocumentMetadata);
          continue;
        }

        successful.push({
          id: originalDoc?.id, // Preserve the PersonaDocument id
          documentId: document.id,
          name: document.name,
          createdBy: document.createdBy.user.displayName,
          createdDateTime: document.createdDateTime,
          parentReference: {
            driveId: document.parentReference?.driveId,
          },
        } as DocumentMetadata);
      } else {
        unsuccessful.push({
          documentId: responseItem.id,
        });
      }
    }

    return {
      status: "OK",
      response: {
        successful,
        unsuccessful,
        sizeToBig,
      },
    };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Failed to fetch document details: ${error}`,
        },
      ],
    };
  }
}

/**
 * The agent's Search files for the agent panel of a chat thread. The thread
 * stores only the agent id (personaId), not the agent's file ids: this action
 * reads the thread from the caller's own partition, loads the agent with the
 * open rule (findPersonaForCurrentUser) and returns the details of the files
 * the caller may use (DocumentDetails). The answer holds no Search file row
 * ids, which are editor-only fields of the agent, and only the NUMBER of the
 * files the caller cannot use.
 */
export async function AgentDocumentDetailsForThread(
  chatThreadId: string
): Promise<
  ServerActionResponse<{
    documents: DocumentMetadata[];
    notAvailableCount: number;
  }>
> {
  const none = {
    status: "OK" as const,
    response: { documents: [], notAvailableCount: 0 },
  };
  if (typeof chatThreadId !== "string" || chatThreadId.length === 0) {
    return none;
  }
  const thread = await FindChatThreadForCurrentUser(chatThreadId);
  if (thread.status !== "OK") return thread;
  const personaId = thread.response.personaId;
  if (!personaId) return none;

  const persona = await findPersonaForCurrentUser(personaId);
  if (persona.status !== "OK") return none;
  const ids = [...new Set(persona.response.personaDocumentIds ?? [])];
  if (ids.length === 0) return none;

  const details = await DocumentDetails(ids.map((id) => ({ id })));
  if (details.status !== "OK") return details;
  return {
    status: "OK",
    response: {
      // Without `id` (the Search file row id).
      documents: details.response.successful.map(({ id: _rowId, ...doc }) => doc),
      notAvailableCount: details.response.unsuccessful.length,
    },
  };
}
