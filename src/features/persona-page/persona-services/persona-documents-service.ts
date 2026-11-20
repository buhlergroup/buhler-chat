"use server";
import "server-only";

// Server actions for Search files of an agent: reads, the access check of a
// chat, and the delete of a whole agent's rows. Adding and removing one file
// is server code only (persona-documents-store.ts).

import { ServerActionResponse } from "@/features/common/server-action-response";
import { getGraphClient } from "../../common/services/microsoft-graph-client";
import {
  GraphBatchRequest,
  postGraphBatches,
} from "@/features/common/services/microsoft-graph-batch";
import { getCurrentUser, userHashedId } from "@/features/auth-page/helpers";
import {
  DocumentMetadata,
  PERSONA_DOCUMENT_ATTRIBUTE,
  PersonaDocument,
  SharePointFile,
  convertPersonaDocumentToSharePointDocument,
} from "./models";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { checkPersonaEdit } from "./persona-access";
import {
  FindAccessiblePersonaDocument,
  PersonaAccessCache,
} from "./persona-document-access";
import { DeleteSearchDocumentByPersonaDocumentId } from "@/features/chat-page/chat-services/azure-ai-search/azure-ai-search";

const positiveInt = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * SharePoint details of the Search files of an agent, for the agent panel of
 * a chat. Only files the caller may use are looked up: each `id` must be a
 * Search file row the caller can open (FindAccessiblePersonaDocument), and
 * the drive and item come from that row, not from the client. Any other
 * file counts as unsuccessful.
 */
export async function DocumentDetails(
  documents: SharePointFile[]
): Promise<
  ServerActionResponse<{
    successful: DocumentMetadata[];
    sizeToBig: DocumentMetadata[];
    unsuccessful: { documentId: string }[];
  }>
> {
  const maxCount = positiveInt(process.env.MAX_PERSONA_DOCUMENT_LIMIT, 25);
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
      if (row) allowed.push(convertPersonaDocumentToSharePointDocument(row));
      else denied.push({ documentId: String(documents[i]?.documentId ?? "") });
    });
    if (allowed.length === 0) {
      return {
        status: "OK",
        response: { successful: [], unsuccessful: denied, sizeToBig: [] },
      };
    }

    const { token } = await getCurrentUser();
    const client = getGraphClient(token);
    const requests = CreateDocumentDetailRequests(allowed, [
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

export const PersonaDocumentById = async (
  id: string
): Promise<ServerActionResponse<PersonaDocument>> => {
  return FindPersonaDocumentForCurrentUser(id);
};

const FindPersonaDocumentForCurrentUser = async (
  id: string,
  cache?: PersonaAccessCache
): Promise<ServerActionResponse<PersonaDocument>> => {
  try {
    const document = await FindAccessiblePersonaDocument<PersonaDocument>(
      id,
      PERSONA_DOCUMENT_ATTRIBUTE,
      cache
    );

    if (!document) {
      return {
        status: "NOT_FOUND",
        errors: [
          {
            message: "Persona Document not found",
          },
        ],
      };
    }

    return {
      status: "OK",
      response: document,
    };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Error creating persona: ${error}`,
        },
      ],
    };
  }
};

export const DeletePersonaDocumentsByPersonaId = async (
  personaId: string
): Promise<ServerActionResponse<void>> => {
  // Edit rights (owner or admin), the same rule as EnsurePersonaOperation.
  // Being able to open (use) a shared or published agent is not enough.
  const persona = await checkPersonaEdit(personaId);

  if (persona.status !== "OK") {
    return persona;
  }

  const personaDocuments = persona.response.personaDocumentIds;
  if (!personaDocuments || personaDocuments.length === 0) {
    return { status: "OK", response: undefined };
  }

  // Delete Documents from Azure Search
  await Promise.all(
    personaDocuments.map(async (oldDocumentId) => {
      return await DeleteSearchDocumentByPersonaDocumentId(oldDocumentId);
    })
  );

  // Delete Documents from Cosmos DB
  await Promise.all(
    personaDocuments.map((id) =>
      DeletePersonaDocumentById(id).catch(() => {
        // Best effort, as before: a missing document does not block the delete.
      })
    )
  );

  return { status: "OK", response: undefined };
};

const DeletePersonaDocumentById = async (personaDocumentId: string) => {
  await HistoryContainer()
    .item(personaDocumentId, await userHashedId())
    .delete();
};

export const AuthorizedDocuments = async (
  documents: SharePointFile[]
): Promise<string[]> => {
  try {
    const { token } = await getCurrentUser();
    const client = getGraphClient(token);
    // Graph takes at most 20 requests per batch: sent in chunks. Only a 200
    // answer allows a document; a document of a failed chunk is not allowed,
    // the documents of the other chunks still are.
    const batch = await postGraphBatches(
      client,
      CreateDocumentDetailRequests(documents, ["id"])
    );

    let allowed: string[] = [];
    batch.responses.forEach((responseItem) => {
      if (responseItem.status === 200) {
        allowed.push(
          documents.find((doc) => doc.documentId === responseItem.id)?.id || ""
        );
      }
    });

    return allowed;
  } catch (error) {
    return [];
  }
};

// Compute persona document IDs that the current user can access
export const AllowedPersonaDocumentIds = async (
  personaDocumentIds: string[]
): Promise<string[]> => {
  try {
    if (!personaDocumentIds || personaDocumentIds.length === 0) return [];

    const cache: PersonaAccessCache = new Map();
    const personaDocumentsResponses = await Promise.all(
      personaDocumentIds.map(async (id) => {
        try {
          return await FindPersonaDocumentForCurrentUser(id, cache);
        } catch {
          return null;
        }
      })
    );

    const okPersonaDocs = personaDocumentsResponses.filter(
      (response) => response !== null && (response as any).status === "OK"
    ) as Array<{ status: "OK"; response: PersonaDocument }>;

    const allowed = await AuthorizedDocuments(
      okPersonaDocs.map((e) => convertPersonaDocumentToSharePointDocument(e.response))
    );

    return allowed || [];
  } catch {
    return [];
  }
};

const CreateDocumentDetailRequests = (
  documents: SharePointFile[],
  filters: string[]
): GraphBatchRequest[] =>
  documents.map((document) => ({
    id: document.documentId,
    method: "GET",
    url: `/drives/${document.parentReference.driveId}/items/${
      document.documentId
    }?$select=${filters.join(",")}`,
  }));
