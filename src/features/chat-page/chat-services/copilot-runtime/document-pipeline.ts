import "server-only";

import { AzureAISearchInstance } from "@/features/common/services/ai-search";
import { odataEq } from "@/features/common/odata-filter";
import {
  contentStore,
  contentStoreTakesBuffer,
  sha256Hex,
} from "@/features/common/services/content-store";
import { analyzeTextWithDocumentIntelligence } from "@/features/common/services/document-extraction";
import { logWarn } from "@/features/common/services/logger";
import { IndexDocuments } from "../azure-ai-search/azure-ai-search";
import { chunkTextWithOverlap } from "../chat-document-chunks";
import type { ExtractedText } from "./extract-text";

/**
 * The ONE place where the Copilot path processes file content: text
 * extraction and search indexing. Everything else (extract_text,
 * index_document) goes through these two calls.
 */

/**
 * Text of a document (PDF / Office) with Document Intelligence, cached in the
 * content store per owner (`userKey`), content hash and page range: the same
 * file content is extracted once, also across threads and the chat document
 * upload. `pageCount` is known only when Document Intelligence ran now.
 * A service error is logged; the thrown error has a text for the model only.
 */
export async function extractDocumentText(
  userKey: string,
  bytes: Buffer,
  pages?: string,
): Promise<ExtractedText> {
  let pageCount: number | undefined;
  const analyze = async () => {
    try {
      const result = await analyzeTextWithDocumentIntelligence(bytes, pages ? { pages } : {});
      pageCount = result.pageCount;
      return result.text;
    } catch (err) {
      logWarn("copilot-runtime: Document Intelligence failed", {
        bytes: bytes.length,
        pages,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error("Document Intelligence could not read the file.");
    }
  };
  if (!contentStoreTakesBuffer(bytes.length)) {
    const text = await analyze();
    return { text, cached: false, ...(pageCount !== undefined ? { pageCount } : {}) };
  }
  const md = await contentStore().markdown(userKey, sha256Hex(bytes), analyze, pages ? { pages } : {});
  return { text: md.markdown, cached: md.cached, ...(pageCount !== undefined ? { pageCount } : {}) };
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
  const chunks = chunkTextWithOverlap(text).filter((c) => c.trim().length > 0);
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

  const responses = await IndexDocuments(chunks, name, threadId, undefined, userKey);
  const failed = responses.find((r) => r.status === "ERROR");
  if (failed && failed.status === "ERROR") throw new Error(failed.errors.map((e) => e.message).join("; "));
  return responses.filter((r) => r.status === "OK").length;
}
