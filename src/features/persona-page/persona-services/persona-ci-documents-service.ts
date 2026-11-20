"use server";
import "server-only";

import {
  ServerActionResponse,
  zodErrorsToServerActionErrors,
} from "@/features/common/server-action-response";
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
import {
  FindAccessiblePersonaDocument,
  PersonaAccessCache,
  ResolvePersonaDocumentIds,
} from "./persona-document-access";
import { logInfo, logError, logDebug } from "@/features/common/services/logger";
import {
  getCodeInterpreterFileLimit,
  getCodeInterpreterMaxFileBytes,
} from "@/features/chat-page/chat-services/code-interpreter-constants";
import {
  GRAPH_DOWNLOAD_TIMEOUT_MS,
  downloadDriveItem,
  getDriveItemVersion,
} from "@/features/common/services/sharepoint/graph-drive";
import { checkPersonaEdit } from "./persona-access";

const FindCIDocumentForCurrentUser = async (
  id: string,
  cache?: PersonaAccessCache
): Promise<ServerActionResponse<PersonaCIDocument>> => {
  try {
    const document = await FindAccessiblePersonaDocument<PersonaCIDocument>(
      id,
      PERSONA_CI_DOCUMENT_ATTRIBUTE,
      cache
    );

    if (!document) {
      return {
        status: "NOT_FOUND",
        errors: [{ message: "CI Document not found" }],
      };
    }

    return {
      status: "OK",
      response: document,
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
    const cache: PersonaAccessCache = new Map();
    const results = await Promise.all(
      ids.map((id) => FindCIDocumentForCurrentUser(id, cache))
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
 * Delete a Code Interpreter persona document by ID.
 *
 * The delete runs in the caller's partition (/userId), so a user can delete
 * only CI documents that the user created. An id of another user's document
 * is not found there and the delete fails.
 */
export const DeletePersonaCIDocumentById = async (
  id: string
): Promise<ServerActionResponse<boolean>> => {
  try {
    await HistoryContainer().item(id, await userHashedId()).delete();
    return { status: "OK", response: true };
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Error deleting CI document: ${error}` }],
    };
  }
};

/**
 * Delete Code Interpreter persona documents of a persona. Needs edit rights
 * on the persona (owner or admin, the rule of EnsurePersonaOperation), and
 * only ids that the persona references are deleted.
 */
export const DeletePersonaCIDocumentsByPersonaId = async (
  personaId: string,
  ciDocumentIds: string[]
): Promise<ServerActionResponse<boolean>> => {
  try {
    const persona = await checkPersonaEdit(personaId);
    if (persona.status !== "OK") {
      return persona;
    }
    const ownIds = new Set(persona.response.codeInterpreterDocumentIds || []);
    await Promise.all(
      ciDocumentIds
        .filter((id) => ownIds.has(id))
        .map((id) => DeletePersonaCIDocumentById(id))
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
        errors: zodErrorsToServerActionErrors(validatedFields.error.issues),
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
  fileNames: string[],
  currentCIDocuments: string[]
): Promise<ServerActionResponse<string[]>> => {
  // Keep a client id only for a document of this persona in the caller's own
  // partition; every other document gets a new id from the server.
  const ids = await ResolvePersonaDocumentIds(
    sharePointFiles.map((file) => file.id),
    currentCIDocuments,
    PERSONA_CI_DOCUMENT_ATTRIBUTE,
    uniqueId
  );
  const ciDocuments: PersonaCIDocument[] = await Promise.all(
    sharePointFiles.map(async (file, index) => ({
      id: ids[index],
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
  const documentLimit = getCodeInterpreterFileLimit(
    process.env.MAX_PERSONA_CI_DOCUMENT_LIMIT
  );

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
    fileNames,
    currentCIDocuments
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

    // Metadata first (short timeout): the size is checked before the
    // download, with the same limit as the editor (512 MB by default).
    const metadata = await getDriveItemVersion(token, driveId, itemId);
    const maxBytes = getCodeInterpreterMaxFileBytes(
      process.env.NEXT_PUBLIC_MAX_PERSONA_CI_DOCUMENT_SIZE
    );
    if (metadata.size > maxBytes) {
      logError("SharePoint file is larger than the code interpreter limit", {
        driveId,
        itemId,
        size: metadata.size,
        maxBytes,
      });
      return {
        status: "ERROR",
        errors: [
          {
            message: `The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`,
          },
        ],
      };
    }

    const fileName = metadata.name;
    const contentType = metadata.mimeType || "application/octet-stream";

    logDebug("Downloading SharePoint file", { driveId, itemId, fileName });

    // The download stops after the time limit (60 s) and after maxBytes.
    const buffer = await downloadDriveItem(
      token,
      driveId,
      itemId,
      maxBytes,
      GRAPH_DOWNLOAD_TIMEOUT_MS
    );

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
