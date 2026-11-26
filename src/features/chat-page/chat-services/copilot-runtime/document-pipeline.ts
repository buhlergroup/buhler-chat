import "server-only";

import { AzureAISearchInstance } from "@/features/common/services/ai-search";
import { odataEq } from "@/features/common/odata-filter";
import { IndexDocuments } from "../azure-ai-search/azure-ai-search";
import { ChunkDocumentWithOverlap } from "../chat-document-service";
import { extractDocumentParagraphs } from "../document-text-extraction";
import { paragraphsToMarkdown } from "./workspace-uploads";

/**
 * The ONE place where the Copilot path processes file content: text
 * extraction and search indexing. Everything else (uploads, index_document,
 * SharePoint fetches) goes through these two calls, so an app-wide content
 * store (dedupe and caching by content hash) can replace them here without
 * touching the callers.
 */

/** Text of a document (PDF / Office) as Markdown, with Document Intelligence. */
export async function extractMarkdown(bytes: Buffer, _name: string): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return paragraphsToMarkdown(await extractDocumentParagraphs(copy.buffer));
}

/**
 * Indexes `text` as the chat document `name` of a thread: chunk, embed, upload
 * to AI Search, with the app's existing code. Any earlier chunks of the same
 * document in the thread are removed first, so indexing again replaces them.
 * Returns the number of chunks stored.
 */
export async function indexDocument(args: {
  threadId: string;
  userKey: string;
  name: string;
  text: string;
}): Promise<number> {
  const { threadId, userKey, name, text } = args;
  const chunks = (await ChunkDocumentWithOverlap(text)).filter((c) => c.trim().length > 0);
  if (chunks.length === 0) return 0;

  // `metadata` (the document name) is not filterable in the index: filter by
  // thread and user, pick this document's chunks from the results.
  const instance = AzureAISearchInstance<{ id: string; metadata: string | null }>();
  const filter = `${odataEq("chatThreadId", threadId)} and ${odataEq("user", userKey)}`;
  const old: string[] = [];
  const found = await instance.search("*", { filter, select: ["id", "metadata"] });
  for await (const r of found.results) {
    if (r.document.metadata === name) old.push(r.document.id);
  }
  if (old.length > 0) await instance.deleteDocuments("id", old);

  const responses = await IndexDocuments(chunks, name, threadId);
  const failed = responses.find((r) => r.status === "ERROR");
  if (failed && failed.status === "ERROR") throw new Error(failed.errors.map((e) => e.message).join("; "));
  return responses.filter((r) => r.status === "OK").length;
}
