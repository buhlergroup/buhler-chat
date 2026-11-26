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
import { contentStore } from "@/features/common/services/content-store";
import { extractTextWithDocumentIntelligence } from "@/features/common/services/document-extraction";
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
 * Adds one Search file: the bytes from SharePoint into the content store
 * (scope = owner), a PERSONA_DOCUMENT row with the content hash in the
 * owner's partition, then the text chunks in the index (user = owner). The
 * text is extracted once per content: the same file added again (to this or
 * another agent of the owner) reuses the stored Markdown. When the indexing
 * fails, the row and the chunks written so far are deleted again. Returns the
 * row id.
 */
export async function addSearchDocument(
  file: DocumentMetadata,
  ownerUserId: string
): Promise<ServerActionResponse<string>> {
  let bytes: Buffer;
  try {
    bytes = await sharePointFileBytes(file);
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `Failed to download files from SharePoint. Error: ${errorText(error)}` }],
    };
  }
  let sha256: string;
  try {
    ({ sha256 } = await contentStore().put(ownerUserId, bytes));
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `The file could not be stored. Error: ${errorText(error)}` }],
    };
  }

  const row: PersonaDocument = {
    id: uniqueId(),
    userId: ownerUserId,
    externalFile: {
      documentId: file.documentId,
      parentReference: { driveId: file.parentReference.driveId },
    },
    sha256,
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

  const indexed = await indexSearchDocument(row.id, file, ownerUserId, bytes, sha256);
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

/**
 * Extracts the text (once per content, cached in the content store) and
 * indexes its chunks for the persona document.
 */
async function indexSearchDocument(
  personaDocumentId: string,
  file: DocumentMetadata,
  ownerUserId: string,
  bytes: Buffer,
  sha256: string
): Promise<ServerActionResponse<void>> {
  const store = contentStore();
  const noText: ServerActionResponse<void> = {
    status: "ERROR",
    errors: [{ message: `${file.name}: Document contains no text that can be indexed.` }],
  };
  let outcome: ServerActionResponse<void> = { status: "OK", response: undefined };

  try {
    await store.ensureIndexed(
      ownerUserId,
      sha256,
      // A new row id has no chunks yet: the target is always indexed once.
      { key: `persona-document:${personaDocumentId}`, isIndexed: async () => false },
      async () => {
        const text = isTextFile(file.name)
          ? new TextDecoder().decode(bytes)
          : (
              await store.markdown(ownerUserId, sha256, () =>
                extractTextWithDocumentIntelligence(bytes)
              )
            ).markdown;

        const chunks = await ChunkDocumentWithOverlap(text);
        if (!chunks) {
          outcome = noText;
          return;
        }

        const results = await IndexDocuments(chunks, file.name, undefined, personaDocumentId, ownerUserId);
        if (results.length === 0) {
          outcome = noText;
          return;
        }

        const failed = results.flatMap((r) => (r.status === "OK" ? [] : r.errors));
        if (failed.length > 0) {
          const messages = failed.map((e) => `${file.name}: ${e.message}`);
          outcome = {
            status: "ERROR",
            errors: [...new Set(messages)].map((message) => ({ message })),
          };
        }
      }
    );
  } catch (error) {
    return {
      status: "ERROR",
      errors: [{ message: `The text of ${file.name} could not be extracted. Error: ${errorText(error)}` }],
    };
  }
  return outcome;
}

/** The file's bytes from SharePoint (current user's token), size checked. */
async function sharePointFileBytes(document: DocumentMetadata): Promise<Buffer> {
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
  return Buffer.from(response);
}

const isTextFile = (fileName: string) => {
  const fileExtension = fileName.split(".").pop();
  if (!fileExtension) return false;
  return Object.values(SupportedFileExtensionsTextFiles).includes(
    fileExtension.toUpperCase() as SupportedFileExtensionsTextFiles
  );
};
