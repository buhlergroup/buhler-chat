import "server-only";

/**
 * Code files of an agent (PERSONA_CI_DOCUMENT rows): add one, delete one,
 * and the bounded download used when a chat with the agent starts.
 *
 * Not a "use server" module: nothing here is callable from the browser. The
 * callers check the permission first (agent-files/agent-file-store.ts: edit
 * permission; persona-service.ts CreatePersonaChat: the rows come from
 * personaCodeDocumentsByIds, which applies the access rule).
 *
 * Partition rule: a row is written in the agent OWNER's partition, also when
 * an admin adds the file, and deleted in its own partition (row.userId).
 */

import {
  ServerActionResponse,
  zodErrorsToServerActionErrors,
} from "@/features/common/server-action-response";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { uniqueId } from "@/features/common/util";
import { logDebug, logError, logInfo } from "@/features/common/services/logger";
import { readCodeInterpreterMaxFileBytes } from "@/features/chat-page/chat-services/code-interpreter-constants";
import {
  GRAPH_DOWNLOAD_TIMEOUT_MS,
  downloadDriveItem,
  getDriveItemVersion,
} from "@/features/common/services/sharepoint/graph-drive";
import {
  DocumentMetadata,
  EXTERNAL_SOURCE,
  PERSONA_CI_DOCUMENT_ATTRIBUTE,
  PersonaCIDocument,
  PersonaCIDocumentSchema,
} from "./models";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isNotFound = (error: unknown) =>
  ((error as { code?: number })?.code ?? (error as { statusCode?: number })?.statusCode) === 404;

/** Adds one Code file: a PERSONA_CI_DOCUMENT row in the owner's partition. */
export async function addCodeDocument(
  file: DocumentMetadata,
  ownerUserId: string
): Promise<ServerActionResponse<string>> {
  const row: PersonaCIDocument = {
    id: uniqueId(),
    userId: ownerUserId,
    externalFile: {
      documentId: file.documentId,
      parentReference: { driveId: file.parentReference.driveId },
    },
    fileName: file.name || "unknown",
    source: EXTERNAL_SOURCE,
    type: PERSONA_CI_DOCUMENT_ATTRIBUTE,
  };
  const valid = PersonaCIDocumentSchema.safeParse(row);
  if (!valid.success) {
    return { status: "ERROR", errors: zodErrorsToServerActionErrors(valid.error.issues) };
  }
  try {
    await HistoryContainer().items.upsert<PersonaCIDocument>(row);
    return { status: "OK", response: row.id };
  } catch (error) {
    return { status: "ERROR", errors: [{ message: `Failed to upsert CI documents: ${errorText(error)}` }] };
  }
}

/**
 * Deletes one Code file row in its own partition (row.userId). A row that is
 * already gone is no error.
 */
export async function deleteCodeDocument(
  row: Pick<PersonaCIDocument, "id" | "userId">
): Promise<ServerActionResponse<true>> {
  try {
    await HistoryContainer().item(row.id, row.userId).delete();
    return { status: "OK", response: true };
  } catch (error) {
    if (isNotFound(error)) return { status: "OK", response: true };
    return { status: "ERROR", errors: [{ message: `Error deleting CI document: ${errorText(error)}` }] };
  }
}

/**
 * Stores the content hash of the file version a chat loaded on the row (in
 * its own partition), so the content store entry has a reference and the
 * cleanup keeps it. Rows written before the content store get their hash
 * here, on the first chat that loads the file. Best effort: a failure is
 * logged, the chat goes on.
 */
export async function recordCodeDocumentHash(
  row: Pick<PersonaCIDocument, "id" | "userId">,
  sha256: string
): Promise<void> {
  try {
    await HistoryContainer()
      .item(row.id, row.userId)
      .patch([{ op: "set", path: "/sha256", value: sha256 }]);
  } catch (error) {
    if (isNotFound(error)) return;
    logError("Code file hash could not be stored", { documentId: row.id, error: errorText(error) });
  }
}

/**
 * Error code of downloadCodeInterpreterFile when SharePoint did not show the
 * file to the user (no access, moved, deleted, or no answer). The caller
 * must not tell the user the file's name then.
 */
export const CODE_FILE_NOT_VISIBLE = "CODE_FILE_NOT_VISIBLE";

/**
 * Downloads a Code file from SharePoint with the current user's token.
 * Metadata first (5 s): the size is checked against the same limit as the
 * editor (readCodeInterpreterMaxFileBytes), then the download (60 s, at most
 * that many bytes). When the metadata read fails, the error has the code
 * CODE_FILE_NOT_VISIBLE.
 */
export async function downloadCodeInterpreterFile(
  driveId: string,
  itemId: string
): Promise<ServerActionResponse<{ buffer: Buffer; name: string; contentType: string }>> {
  try {
    const { token } = await getCurrentUser();

    let metadata: Awaited<ReturnType<typeof getDriveItemVersion>>;
    try {
      metadata = await getDriveItemVersion(token, driveId, itemId);
    } catch (error) {
      logError("SharePoint file metadata could not be read", {
        error: errorText(error),
        driveId,
        itemId,
      });
      return {
        status: "ERROR",
        errors: [{ message: "The file is not available.", code: CODE_FILE_NOT_VISIBLE }],
      };
    }
    const maxBytes = readCodeInterpreterMaxFileBytes();
    if (metadata.size > maxBytes) {
      logError("SharePoint file is larger than the code interpreter limit", {
        driveId,
        itemId,
        size: metadata.size,
        maxBytes,
      });
      return {
        status: "ERROR",
        errors: [{ message: `The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.` }],
      };
    }

    const fileName = metadata.name;
    const contentType = metadata.mimeType || "application/octet-stream";

    logDebug("Downloading SharePoint file", { driveId, itemId, fileName });

    const buffer = await downloadDriveItem(token, driveId, itemId, maxBytes, GRAPH_DOWNLOAD_TIMEOUT_MS);

    logInfo("SharePoint file downloaded successfully", { fileName, size: buffer.length });

    return { status: "OK", response: { buffer, name: fileName, contentType } };
  } catch (error) {
    logError("Failed to download SharePoint file", {
      error: errorText(error),
      driveId,
      itemId,
    });
    return { status: "ERROR", errors: [{ message: `Failed to download file: ${error}` }] };
  }
}
