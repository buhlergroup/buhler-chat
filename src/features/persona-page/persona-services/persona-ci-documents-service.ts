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
  PERSONA_CI_DOCUMENT_ATTRIBUTE,
  PersonaCIDocument,
  PersonaCIDocumentSchema,
  SharePointFile,
} from "./models";
import { uniqueId } from "@/features/common/util";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { SqlQuerySpec } from "@azure/cosmos";
import { logInfo, logError, logDebug } from "@/features/common/services/logger";
import { ResponseType } from "@microsoft/microsoft-graph-client";
import { DocumentDetails } from "./persona-documents-service";

// Re-export DocumentDetails for use in the UI component
export { DocumentDetails };

/**
 * Get a Code Interpreter persona document by ID
 */
export const PersonaCIDocumentById = async (
  id: string
): Promise<ServerActionResponse<PersonaCIDocument>> => {
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
      .items.query<PersonaCIDocument>(querySpec)
      .fetchAll();

    if (resources.length === 0) {
      return {
        status: "NOT_FOUND",
        errors: [{ message: "CI Document not found" }],
      };
    }

    return {
      status: "OK",
      response: resources[0],
    };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Error fetching CI document: ${error}` }],
    };
  }
};

/**
 * Get all Code Interpreter persona documents by IDs
 */
export const PersonaCIDocumentsByIds = async (
  ids: string[]
): Promise<ServerActionResponse<PersonaCIDocument[]>> => {
  if (!ids || ids.length === 0) {
    return { status: "OK", response: [] };
  }

  try {
    const results = await Promise.all(
      ids.map((id) => PersonaCIDocumentById(id))
    );

    const documents = results
      .filter((r) => r.status === "OK")
      .map((r) => (r as { status: "OK"; response: PersonaCIDocument }).response);

    return { status: "OK", response: documents };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Error fetching CI documents: ${error}` }],
    };
  }
};

/**
 * Delete a Code Interpreter persona document by ID
 */
export const DeletePersonaCIDocumentById = async (
  id: string
): Promise<ServerActionResponse<boolean>> => {
  try {
    await HistoryContainer().item(id, id).delete();
    return { status: "OK", response: true };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Error deleting CI document: ${error}` }],
    };
  }
};

/**
 * Delete all Code Interpreter persona documents for a persona
 */
export const DeletePersonaCIDocumentsByPersonaId = async (
  personaId: string,
  ciDocumentIds: string[]
): Promise<ServerActionResponse<boolean>> => {
  try {
    await Promise.all(
      ciDocumentIds.map((id) => DeletePersonaCIDocumentById(id))
    );
    return { status: "OK", response: true };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Error deleting CI documents: ${error}` }],
    };
  }
};

/**
 * Validate CI document schema
 */
const ValidatePersonaCIDocumentSchema = (
  documents: PersonaCIDocument[]
): ServerActionResponse => {
  for (const document of documents) {
    const validatedFields = PersonaCIDocumentSchema.safeParse(document);
    if (!validatedFields.success) {
      return {
        status: "ERROR",
        errors: zodErrorsToServerActionErrors(validatedFields.error.errors),
      };
    }
  }
  return { status: "OK", response: documents };
};

/**
 * Add or update Code Interpreter persona documents
 */
const AddOrUpdateCIDocuments = async (
  sharePointFiles: SharePointFile[],
  fileNames: string[]
): Promise<ServerActionResponse<string[]>> => {
  const ciDocuments: PersonaCIDocument[] = await Promise.all(
    sharePointFiles.map(async (file, index) => ({
      id: file.id || uniqueId(),
      userId: await userHashedId(),
      externalFile: {
        documentId: file.documentId,
        parentReference: {
          driveId: file.parentReference.driveId,
        },
      },
      fileName: fileNames[index] || "unknown",
      source: EXTERNAL_SOURCE,
      type: PERSONA_CI_DOCUMENT_ATTRIBUTE,
    }))
  );

  const documentIds: string[] = [];

  const validationResponse = ValidatePersonaCIDocumentSchema(ciDocuments);
  if (validationResponse.status !== "OK") {
    return validationResponse as ServerActionResponse<string[]>;
  }

  try {
    for (const document of ciDocuments) {
      const upsertedDoc =
        await HistoryContainer().items.upsert<PersonaCIDocument>(document);
      documentIds.push(upsertedDoc.item.id);
    }
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Failed to upsert CI documents: ${error}` }],
    };
  }

  return { status: "OK", response: documentIds };
};

/**
 * Update or add Code Interpreter persona documents
 */
export const UpdateOrAddPersonaCIDocuments = async (
  sharePointFiles: DocumentMetadata[],
  currentCIDocuments: string[]
): Promise<ServerActionResponse<string[]>> => {
  const documentLimit = Number(process.env.MAX_PERSONA_CI_DOCUMENT_LIMIT) || 25;

  if (sharePointFiles.length > documentLimit) {
    return {
      status: "ERROR",
      errors: [
        { message: `CI Document limit exceeded. Maximum is ${documentLimit}.` },
      ],
    };
  }

  // Remove documents that are no longer selected
  const removeDocuments = currentCIDocuments.filter((id) => {
    return !sharePointFiles.map((e) => e.id).includes(id);
  });

  await Promise.all(removeDocuments.map((id) => DeletePersonaCIDocumentById(id)));

  // Get file names for the documents
  const fileNames = sharePointFiles.map((file) => file.name);

  // Create or update documents in the database
  const addOrUpdateResponse = await AddOrUpdateCIDocuments(
    sharePointFiles,
    fileNames
  );

  if (addOrUpdateResponse.status !== "OK") {
    return addOrUpdateResponse;
  }

  return addOrUpdateResponse;
};

/**
 * Download a file from SharePoint
 * Returns the file as a Buffer with its metadata
 */
export const DownloadSharePointFile = async (
  driveId: string,
  itemId: string
): Promise<ServerActionResponse<{ buffer: Buffer; name: string; contentType: string }>> => {
  try {
    const { token } = await getCurrentUser();
    const client = getGraphClient(token);

    // First get file metadata
    const metadata = await client
      .api(`/drives/${driveId}/items/${itemId}`)
      .select("name,file")
      .get();

    const fileName = metadata.name;
    const contentType = metadata.file?.mimeType || "application/octet-stream";

    logDebug("Downloading SharePoint file", { driveId, itemId, fileName });

    // Download the file content
    const response = await client
      .api(`/drives/${driveId}/items/${itemId}/content`)
      .responseType(ResponseType.ARRAYBUFFER)
      .get();

    const buffer = Buffer.from(response);

    logInfo("SharePoint file downloaded successfully", {
      fileName,
      size: buffer.length,
    });

    return {
      status: "OK",
      response: { buffer, name: fileName, contentType },
    };
  } catch (error) {
    logError("Failed to download SharePoint file", {
      error: error instanceof Error ? error.message : String(error),
      driveId,
      itemId,
    });
    return {
      status: "ERROR",
      errors: [{ message: `Failed to download file: ${error}` }],
    };
  }
};

/**
 * Download multiple files from SharePoint for Code Interpreter
 */
export const DownloadCIDocumentsFromSharePoint = async (
  ciDocuments: PersonaCIDocument[]
): Promise<ServerActionResponse<Array<{ buffer: Buffer; name: string; contentType: string }>>> => {
  try {
    const results = await Promise.all(
      ciDocuments.map(async (doc) => {
        const result = await DownloadSharePointFile(
          doc.externalFile.parentReference.driveId,
          doc.externalFile.documentId
        );
        return result;
      })
    );

    const successful = results
      .filter((r) => r.status === "OK")
      .map((r) => (r as { status: "OK"; response: { buffer: Buffer; name: string; contentType: string } }).response);

    if (successful.length === 0 && results.length > 0) {
      return {
        status: "ERROR",
        errors: [{ message: "Failed to download any CI documents" }],
      };
    }

    return { status: "OK", response: successful };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Failed to download CI documents: ${error}` }],
    };
  }
};
