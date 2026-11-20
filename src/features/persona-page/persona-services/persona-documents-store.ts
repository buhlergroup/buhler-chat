import "server-only";

/**
 * Search files of an agent (PERSONA_DOCUMENT rows and their AI Search
 * chunks): add one, delete one.
 *
 * Not a "use server" module: nothing here is callable from the browser. The
 * caller (agent-files/agent-file-store.ts) checks the edit permission first.
 *
 * Partition rule: a row is written in the agent OWNER's partition and its
 * chunks carry the owner's id in `user`, also when an admin adds the file.
 * Chats find the row by that rule (FindAccessiblePersonaDocument: the row and
 * the agent are in the same partition). A row is deleted in its own partition
 * (row.userId) and its chunks by the same id, so a row an admin wrote before
 * this rule is deleted too.
 */

import { ResponseType } from "@microsoft/microsoft-graph-client";
import {
  ServerActionResponse,
  zodErrorsToServerActionErrors,
} from "@/features/common/server-action-response";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { getGraphClient } from "@/features/common/services/microsoft-graph-client";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { uniqueId } from "@/features/common/util";
import { DocumentIntelligenceInstance } from "@/features/common/services/document-intelligence";
import {
  DeleteSearchDocumentByPersonaDocumentId,
  IndexDocuments,
} from "@/features/chat-page/chat-services/azure-ai-search/azure-ai-search";
import { ChunkDocumentWithOverlap } from "@/features/chat-page/chat-services/chat-document-service";
import { SupportedFileExtensionsTextFiles } from "@/features/chat-page/chat-services/models";
import {
  DocumentMetadata,
  EXTERNAL_SOURCE,
  PERSONA_DOCUMENT_ATTRIBUTE,
  PersonaDocument,
  PersonaDocumentSchema,
} from "./models";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isNotFound = (error: unknown) =>
  ((error as { code?: number })?.code ?? (error as { statusCode?: number })?.statusCode) === 404;

const maxSearchFileBytes = () => Number(process.env.MAX_PERSONA_DOCUMENT_SIZE) || 10485760;

/**
 * Adds one Search file: a PERSONA_DOCUMENT row in the owner's partition, then
 * the text chunks in the index (user = owner). When the indexing fails, the
 * row and the chunks written so far are deleted again. Returns the row id.
 */
export async function addSearchDocument(
  file: DocumentMetadata,
  ownerUserId: string
): Promise<ServerActionResponse<string>> {
  const row: PersonaDocument = {
    id: uniqueId(),
    userId: ownerUserId,
    externalFile: {
      documentId: file.documentId,
      parentReference: { driveId: file.parentReference.driveId },
    },
    source: EXTERNAL_SOURCE,
    type: PERSONA_DOCUMENT_ATTRIBUTE,
  };
  const valid = PersonaDocumentSchema.safeParse(row);
  if (!valid.success) {
    return { status: "ERROR", errors: zodErrorsToServerActionErrors(valid.error.issues) };
  }

  try {
    await HistoryContainer().items.upsert<PersonaDocument>(row);
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Failed to upsert persona documents. Error: ${errorText(error)}` }],
    };
  }

  const indexed = await indexSearchDocument(row.id, file, ownerUserId);
  if (indexed.status !== "OK") {
    await deleteSearchDocument(row);
    return indexed;
  }
  return { status: "OK", response: row.id };
}

/**
 * Deletes one Search file: the row in its own partition (row.userId) and its
 * index chunks (user = row.userId). Every step is checked; an ERROR names the
 * step that failed. A row or chunk that is already gone is no error.
 */
export async function deleteSearchDocument(
  row: Pick<PersonaDocument, "id" | "userId">
): Promise<ServerActionResponse<true>> {
  const errors: { message: string }[] = [];
  const chunks = await DeleteSearchDocumentByPersonaDocumentId(row.id, row.userId);
  if (chunks.status !== "OK") {
    errors.push({
      message: `The index entries could not be deleted: ${chunks.errors.map((e) => e.message).join(" ")}`,
    });
  }
  try {
    await HistoryContainer().item(row.id, row.userId).delete();
  } catch (error) {
    if (!isNotFound(error)) {
      errors.push({ message: `The document row could not be deleted: ${errorText(error)}` });
    }
  }
  return errors.length === 0 ? { status: "OK", response: true } : { status: "ERROR", errors };
}

/** Downloads the file, extracts the text and indexes its chunks. */
async function indexSearchDocument(
  personaDocumentId: string,
  file: DocumentMetadata,
  ownerUserId: string
): Promise<ServerActionResponse<void>> {
  let paragraphs: string[];
  try {
    paragraphs = await sharePointFileToText(file);
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Failed to download files from SharePoint. Error: ${errorText(error)}` }],
    };
  }

  const noText: ServerActionResponse<void> = {
    status: "ERROR",
    errors: [{ message: `${file.name}: Document contains no text that can be indexed.` }],
  };
  const chunks = await ChunkDocumentWithOverlap(paragraphs.join("\n"));
  if (!chunks) return noText;

  const results = await IndexDocuments(chunks, file.name, undefined, personaDocumentId, ownerUserId);
  if (results.length === 0) return noText;

  const failed = results.flatMap((r) => (r.status === "OK" ? [] : r.errors));
  if (failed.length > 0) {
    const messages = failed.map((e) => `${file.name}: ${e.message}`);
    return {
      status: "ERROR",
      errors: [...new Set(messages)].map((message) => ({ message })),
    };
  }
  return { status: "OK", response: undefined };
}

async function sharePointFileToText(document: DocumentMetadata): Promise<string[]> {
  const { token } = await getCurrentUser();
  const client = getGraphClient(token);
  const response = (await client
    .api(`/drives/${document.parentReference.driveId}/items/${document.documentId}/content`)
    .responseType(ResponseType.ARRAYBUFFER)
    .get()) as ArrayBuffer;
  if (response.byteLength === 0) {
    throw new Error(`Document is empty.`);
  }
  const maxBytes = maxSearchFileBytes();
  if (response.byteLength > maxBytes) {
    throw new Error(
      `Document ${document.name} is too big. Maximum is ${(maxBytes / (1024 * 1024)).toFixed(
        2
      )} MB. Choose a smaller document or split the document into two documents.`
    );
  }
  if (isTextFile(document.name)) {
    return [new TextDecoder().decode(response)];
  }
  const poller = await DocumentIntelligenceInstance().beginAnalyzeDocument("prebuilt-read", response);
  const { paragraphs } = await poller.pollUntilDone();
  return (paragraphs ?? []).map((p) => p.content);
}

const isTextFile = (fileName: string) => {
  const fileExtension = fileName.split(".").pop();
  if (!fileExtension) return false;
  return Object.values(SupportedFileExtensionsTextFiles).includes(
    fileExtension.toUpperCase() as SupportedFileExtensionsTextFiles
  );
};
