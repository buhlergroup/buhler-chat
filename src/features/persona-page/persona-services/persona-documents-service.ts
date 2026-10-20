"use server";
import "server-only";

import {
  ServerActionResponse,
  zodErrorsToServerActionErrors,
} from "@/features/common/server-action-response";
import { getGraphClient } from "../../common/services/microsoft-graph-client";
import { getCurrentUser, userHashedId } from "@/features/auth-page/helpers";
import {
  DocumentMetadata,
  EXTERNAL_SOURCE,
  PERSONA_DOCUMENT_ATTRIBUTE,
  PersonaDocument,
  PersonaDocumentSchema,
  SharePointFile,
  SharePointFileContent,
  convertPersonaDocumentToSharePointDocument,
} from "./models";
import { uniqueId } from "@/features/common/util";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { SqlQuerySpec } from "@azure/cosmos";
import { FindPersonaByID } from "./persona-service";
import {
  DeleteSearchDocumentByPersonaDocumentId,
  IndexDocuments,
  PersonaDocumentExistsInIndex,
} from "@/features/chat-page/chat-services/azure-ai-search/azure-ai-search";
import { DocumentIntelligenceInstance } from "@/features/common/services/document-intelligence";
import { ResponseType } from "@microsoft/microsoft-graph-client";
import { ChunkDocumentWithOverlap } from "@/features/chat-page/chat-services/chat-document-service";
import { SupportedFileExtensionsTextFiles } from "@/features/chat-page/chat-services/models";

export interface DocumentDetailsOptions {
  maxSize?: number;
  maxCount?: number;
}

export async function DocumentDetails(
  documents: SharePointFile[],
  options?: DocumentDetailsOptions
): Promise<
  ServerActionResponse<{
    successful: DocumentMetadata[];
    sizeToBig: DocumentMetadata[];
    unsuccessful: { documentId: string }[];
  }>
> {
  const maxCount =
    options?.maxCount ?? Number(process.env.MAX_PERSONA_DOCUMENT_LIMIT);
  const maxSize =
    options?.maxSize ??
    (Number(process.env.MAX_PERSONA_DOCUMENT_SIZE) || 10485760);

  try {
    if (documents.length === 0) {
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

    const { token } = await getCurrentUser();
    const client = getGraphClient(token);
    const body = CreateDocumentDetailBody(documents, [
      "id",
      "name",
      "createdBy",
      "createdDateTime",
      "parentReference",
      "size",
    ]);
    const response = await client.api("/$batch").post(body);

    let successful: DocumentMetadata[] = [];
    let unsuccessful: { documentId: string }[] = [];
    let sizeToBig: DocumentMetadata[] = [];

    // Create a map to look up the original document by SharePoint documentId
    const documentIdMap = new Map<string, SharePointFile>();
    for (const doc of documents) {
      documentIdMap.set(doc.documentId, doc);
    }

    for (const responseItem of response.responses) {
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

function IsDocumentLimitExceeded(sharePointFiles: DocumentMetadata[]): boolean {
  return (
    sharePointFiles.length > Number(process.env.MAX_PERSONA_DOCUMENT_LIMIT)
  );
}

async function RemoveUnselectedPersonaDocuments(removeDocuments: string[]) {
  try {
    await Promise.all(
      removeDocuments.map(async (id) => {
        await HistoryContainer()
          .item(id, await userHashedId())
          .delete();
      })
    );
    await Promise.all(
      removeDocuments.map(async (oldDocumentId) => {
        await DeleteSearchDocumentByPersonaDocumentId(oldDocumentId);
      })
    );
  } catch (error) {
    // Fail silently because we don't want to block the process if we can't delete the document
  }
}

async function GetNewNotIndexedDocuments(sharePointFiles: DocumentMetadata[]) {
  const newDocuments = [];
  for (const file of sharePointFiles) {
    if (!file.id) {
      return { error: { message: `Document ID is missing.` } };
    }
    const documentResponse = await PersonaDocumentExistsInIndex(file.id);
    if (documentResponse.status === "NOT_FOUND") {
      newDocuments.push(file);
    } else if (documentResponse.status === "ERROR") {
      return { error: documentResponse.errors };
    }
  }
  return { newDocuments };
}

export const UpdateOrAddPersonaDocuments = async (
  sharePointFiles: DocumentMetadata[],
  currentPersonaDocuments: string[]
): Promise<ServerActionResponse<string[]>> => {
  if (IsDocumentLimitExceeded(sharePointFiles)) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Document limit exceeded. Maximum is ${process.env.MAX_PERSONA_DOCUMENT_LIMIT}.`,
        },
      ],
    };
  }

  const removeDocuments = currentPersonaDocuments.filter((id) => {
    return !sharePointFiles.map((e) => e.id).includes(id);
  });

  await RemoveUnselectedPersonaDocuments(removeDocuments);

  // create or update documents in the database
  const addOrUpdateResponse = await AddOrUpdatePersonaDocuments(
    sharePointFiles
  );

  if (addOrUpdateResponse.status !== "OK") {
    return {
      status: "ERROR",
      errors: addOrUpdateResponse.errors,
    };
  }

  sharePointFiles.forEach((file, index) => {
    file.id = addOrUpdateResponse.response[index];
  });

  const { newDocuments, error } = await GetNewNotIndexedDocuments(
    sharePointFiles
  );

  if (error) {
    return {
      status: "ERROR",
      errors: Array.isArray(error) ? error : [error],
    };
  }

  const handleNewDocumentsResponse = await IndexNewPersonaDocuments(
    newDocuments
  );

  if (handleNewDocumentsResponse.status !== "OK") {
    // Remove documents from Cosmos DB because something went wrong with indexing
    await Promise.all(
      newDocuments.map(async (oldDocumentId) => {
        if (oldDocumentId.id) {
          return await DeletePersonaDocumentById(oldDocumentId.id);
        }
      })
    );

    return {
      status: "ERROR",
      errors: handleNewDocumentsResponse.errors,
    };
  }

  return {
    status: "OK",
    response: addOrUpdateResponse.response,
  };
};

export const PersonaDocumentById = async (
  id: string
): Promise<ServerActionResponse<PersonaDocument>> => {
  const querySpec: SqlQuerySpec = {
    query: "SELECT * FROM root r WHERE r.id=@id",
    parameters: [
      {
        name: "@id",
        value: id,
      },
    ],
  };
  try {
    const { resources } = await HistoryContainer()
      .items.query<PersonaDocument>(querySpec)
      .fetchAll();

    if (resources.length === 0) {
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
      response: resources[0],
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

export const DeletePersonaDocumentsByPersonaId = async (personaId: string) => {
  const persona = await FindPersonaByID(personaId);

  if (persona.status !== "OK") {
    throw new Error("Persona not found");
  }

  const personaDocuments = persona.response.personaDocumentIds;
  if (!personaDocuments || personaDocuments.length === 0) {
    return;
  }

  // Delete Documents from Azure Search
  await Promise.all(
    personaDocuments.map(async (oldDocumentId) => {
      return await DeleteSearchDocumentByPersonaDocumentId(oldDocumentId);
    })
  );

  // Delete Documents from Cosmos DB
  for (const id of persona.response.personaDocumentIds || []) {
    DeletePersonaDocumentById(id);
  }
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
    const body = CreateDocumentDetailBody(documents, ["id"]);
    const response = await client.api("/$batch").post(body);

    let allowed: string[] = [];
    response.responses.map((responseItem: any) => {
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

    const personaDocumentsResponses = await Promise.all(
      personaDocumentIds.map(async (id) => {
        try {
          return await PersonaDocumentById(id);
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

const CreateDocumentDetailBody = (
  documents: SharePointFile[],
  filters: string[]
) => {
  return {
    requests: documents.map((document) => ({
      id: document.documentId,
      method: "GET",
      url: `/drives/${document.parentReference.driveId}/items/${
        document.documentId
      }?$select=${filters.join(",")}`,
    })),
  };
};

const AddOrUpdatePersonaDocuments = async (
  sharePointFiles: SharePointFile[]
): Promise<ServerActionResponse<string[]>> => {
  const personaDocuments: PersonaDocument[] = await Promise.all(
    sharePointFiles.map(async (file) => ({
      id: file.id || uniqueId(),
      userId: await userHashedId(),
      externalFile: {
        documentId: file.documentId,
        parentReference: {
          driveId: file.parentReference.driveId,
        },
      },
      source: EXTERNAL_SOURCE,
      type: PERSONA_DOCUMENT_ATTRIBUTE,
    }))
  );

  const documentIds: string[] = [];

  const validationResponse = ValidatePersonaDocumentSchema(personaDocuments);
  if (validationResponse.status !== "OK") {
    return validationResponse;
  }

  try {
    for (const document of personaDocuments) {
      const upsertedDoc =
        await HistoryContainer().items.upsert<PersonaDocument>(document);
      documentIds.push(upsertedDoc.item.id);
    }
  } catch (error) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Failed to upsert persona documents. Error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    };
  }

  return {
    status: "OK",
    response: documentIds,
  };
};

const IndexNewPersonaDocuments = async (
  documents: DocumentMetadata[]
): Promise<ServerActionResponse<void>> => {
  // download documents from sharepoint to the server and check access with that
  const downloadFilesFromSharePointResponse = await SharePointFileToText(
    documents
  );

  if (downloadFilesFromSharePointResponse.status !== "OK") {
    return {
      status: downloadFilesFromSharePointResponse.status,
      errors: downloadFilesFromSharePointResponse.errors,
    };
  }

  const splitDocuments = await Promise.all(
    downloadFilesFromSharePointResponse.response.map(async (file) => {
      const result = await ChunkDocumentWithOverlap(file.paragraphs.join("\n"));
      file.chunks = result;
      return file;
    })
  );

  const successfullyIndexedPersonaDocuments: string[] = [];

  const documentIndexResponses = await Promise.all(
    splitDocuments.map(async (doc) => {
      const emptyDocumentError: ServerActionResponse<boolean> = {
        status: "ERROR",
        errors: [
          {
            message: `${doc.name}: Document contains no text that can be indexed.`,
          },
        ],
      };

      if (!doc.chunks) {
        return [emptyDocumentError];
      }

      const results = await IndexDocuments(
        doc.chunks,
        doc.name,
        undefined,
        doc.id
      );

      if (results.length === 0) {
        return [emptyDocumentError];
      }

      if (results.some((r) => r.status === "OK") && doc.id) {
        successfullyIndexedPersonaDocuments.push(doc.id);
      }

      return results.map((r) =>
        r.status === "OK"
          ? r
          : {
              ...r,
              errors: r.errors.map((e) => ({
                ...e,
                message: `${doc.name}: ${e.message}`,
              })),
            }
      );
    })
  );

  const flatResponses = documentIndexResponses.flat();
  const failedResponses = flatResponses.flatMap((r) =>
    r.status === "OK" ? [] : [r]
  );

  if (failedResponses.length > 0) {
    // If any document failed to index, delete all successfully indexed documents
    await Promise.all(
      successfullyIndexedPersonaDocuments.map(async (id) => {
        await DeleteSearchDocumentByPersonaDocumentId(id);
      })
    );

    const messages = failedResponses.flatMap((r) =>
      r.errors.map((e) => e.message)
    );

    return {
      status: "ERROR",
      errors: [...new Set(messages)].map((message) => ({ message })),
    };
  }

  return {
    status: "OK",
    response: undefined,
  };
};

const SharePointFileToText = async (
  documents: DocumentMetadata[]
): Promise<ServerActionResponse<SharePointFileContent[]>> => {
  const { token } = await getCurrentUser();
  const client = getGraphClient(token);

  try {
    const documentPromises = documents.map(async (document) => {
      const response = await DownloadSharePointFile(client, document);
      ValidateSharePointFileSize(response, document);
      if (IsTextFile(document.name)) {
        return ExtractTextFromArrayBuffer(response, document);
      }
      return ExtractTextFromNonTextFile(response, document);
    });

    try {
      const documentsContent = await Promise.all(documentPromises);
      return {
        status: "OK",
        response: documentsContent,
      };
    } catch (error) {
      return {
        status: "ERROR",
        errors: [
          {
            message: `Failed to download files from SharePoint. Error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  } catch (error) {
    return {
      status: "ERROR",
      errors: [
        {
          message: `Failed to download files from SharePoint. Error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    };
  }
};

const DownloadSharePointFile = async (
  client: any,
  document: DocumentMetadata
): Promise<ArrayBuffer> => {
  const response = (await client
    .api(
      `/drives/${document.parentReference.driveId}/items/${document.documentId}/content`
    )
    .responseType(ResponseType.ARRAYBUFFER)
    .get()) as ArrayBuffer;
  if (response.byteLength === 0) {
    throw new Error(`Document is empty.`);
  }
  return response;
};

const ValidateSharePointFileSize = (
  response: ArrayBuffer,
  document: DocumentMetadata
) => {
  if (
    response.byteLength >
    (Number(process.env.MAX_PERSONA_DOCUMENT_SIZE) || 10485760)
  ) {
    throw new Error(
      `Document ${document.name} is too big. Maximum is ${(
        Number(process.env.MAX_PERSONA_DOCUMENT_SIZE) /
        (1024 * 1024)
      ).toFixed(
        2
      )} MB. Choose a smaller document or split the document into two documents.`
    );
  }
};

const ExtractTextFromArrayBuffer = (
  response: ArrayBuffer,
  document: DocumentMetadata
): SharePointFileContent => {
  const decoder = new TextDecoder();
  const textContent = decoder.decode(response);
  return {
    ...document,
    paragraphs: [textContent],
  };
};

const ExtractTextFromNonTextFile = async (
  response: ArrayBuffer,
  document: DocumentMetadata
): Promise<SharePointFileContent> => {
  const diClient = DocumentIntelligenceInstance();
  const poller = await diClient.beginAnalyzeDocument("prebuilt-read", response);
  const { paragraphs } = await poller.pollUntilDone();
  const docs: Array<string> = [];
  if (paragraphs) {
    for (const paragraph of paragraphs) {
      docs.push(paragraph.content);
    }
  }
  return {
    ...document,
    paragraphs: docs,
  };
};

const IsTextFile = (fileName: string) => {
  const fileExtension = fileName.split(".").pop();

  if (!fileExtension) return false;
  return Object.values(SupportedFileExtensionsTextFiles).includes(
    fileExtension.toUpperCase() as SupportedFileExtensionsTextFiles
  );
};

const ValidatePersonaDocumentSchema = (
  models: PersonaDocument[]
): ServerActionResponse => {
  const errors = [];
  const validModels: PersonaDocument[] = [];

  for (const model of models) {
    const validatedFields = PersonaDocumentSchema.safeParse(model);

    if (!validatedFields.success) {
      errors.push(
        ...zodErrorsToServerActionErrors(validatedFields.error.issues)
      );
    } else {
      validModels.push(validatedFields.data);
    }
  }

  if (errors.length > 0) {
    return {
      status: "ERROR",
      errors,
    };
  }

  return {
    status: "OK",
    response: validModels,
  };
};
