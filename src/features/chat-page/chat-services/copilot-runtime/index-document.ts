/**
 * `index_document` (Copilot path only): puts workspace files into the
 * thread's AI Search index on request, with the app's existing chunking,
 * embedding and indexing (document-pipeline.ts), and the same CHAT_DOCUMENT
 * row the upload flow writes, so search_documents, the document list and
 * deletion keep working.
 *
 * Input text: the Markdown next to a document (<file>.md, written by
 * extract_text; when it is missing, the extraction runs first through the
 * same code), else the file itself when it is text. Indexing the same file
 * again replaces its chunks and updates the row.
 */
import { tool } from "ai";
import { z } from "zod";
import { chunkTextWithOverlap, documentTooLongMessage, maxDocumentChunks } from "../chat-document-chunks";
import type { WorkspaceEntry } from "./blob-session-fs";
import { isExtractable, type ExtractTextResult } from "./extract-text";
import { normalizeSessionPath, WORKSPACE_ROOT } from "./session-path";

export interface IndexedRow {
  id: string;
}

export interface IndexDocumentDeps {
  fs: {
    listEntries(dir: string, literalPrefix?: string): Promise<WorkspaceEntry[]>;
    readEntry(entry: WorkspaceEntry): Promise<Buffer>;
  };
  /** The thread's CHAT_DOCUMENT row for this document name, if any (not deleted). */
  findRow(name: string): Promise<IndexedRow | undefined>;
  saveRow(row: { id?: string; name: string; workspacePath: string; chunkCount: number }): Promise<void>;
  /** Chunks + indexes `text` as document `name` of the thread, replacing earlier chunks. Returns the chunk count. */
  index(name: string, text: string): Promise<number>;
  /** extract_text for a PDF/Office file whose <file>.md is missing (extract-text.ts). */
  extractText?(path: string): Promise<ExtractTextResult>;
  /** Biggest file that is read for indexing (maxWorkspaceUploadBytes); none when unset. */
  maxBytes?: number;
  /** Bytes one index_document call reads in total; 4 x maxBytes when unset. */
  maxCallBytes?: number;
}

/**
 * What one index_document call may still use: bytes read and chunks indexed.
 * Chunks: one call indexes at most MAX_DOCUMENT_CHUNKS in total (the limit of
 * one document), so 20 paths cannot cost 20 times the embedding calls.
 */
export interface IndexBudget {
  bytes: number;
  chunks: number;
}

export function newIndexBudget(deps: Pick<IndexDocumentDeps, "maxBytes" | "maxCallBytes">): IndexBudget {
  const bytes = deps.maxCallBytes ?? (deps.maxBytes !== undefined ? deps.maxBytes * 4 : Infinity);
  return { bytes, chunks: maxDocumentChunks() };
}

const AGAIN = "Not indexed: this call reached its limit. Call index_document again with the remaining files.";

export interface IndexResult {
  path: string;
  name?: string;
  chunks?: number;
  status: "indexed" | "replaced" | "error";
  error?: string;
}

const isText = (data: Buffer) => !data.subarray(0, 8192).includes(0);
const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
const tooLarge = (bytes: number, limit: number) =>
  `The file is too large to index (${mb(bytes)}, the limit is ${mb(limit)}). Split it into smaller files first.`;

async function findEntry(deps: IndexDocumentDeps, path: string): Promise<WorkspaceEntry | undefined> {
  const slash = path.lastIndexOf("/");
  return (await deps.fs.listEntries(path.slice(0, slash), path.slice(slash + 1))).find((e) => e.path === path);
}

export async function indexWorkspaceDocument(
  deps: IndexDocumentDeps,
  rawPath: string,
  budget: IndexBudget = newIndexBudget(deps),
): Promise<IndexResult> {
  let path: string;
  try {
    path = normalizeSessionPath(rawPath);
  } catch (err) {
    return { path: rawPath, status: "error", error: (err as Error).message };
  }
  if (!path.startsWith(`${WORKSPACE_ROOT}/`)) {
    return { path, status: "error", error: "Only files in /workspace can be indexed." };
  }
  // "<doc>.md" of an uploaded document indexes as the document itself.
  let docPath = path;
  if (path.endsWith(".md") && (await findEntry(deps, path.slice(0, -3)))) docPath = path.slice(0, -3);
  const entry = await findEntry(deps, docPath);
  if (!entry) return { path, status: "error", error: "File not found." };
  let companion = await findEntry(deps, `${docPath}.md`);
  if (!companion && deps.extractText && isExtractable(docPath)) {
    const extracted = await deps.extractText(docPath);
    if (extracted.status === "error") return { path, status: "error", error: extracted.error };
    companion = await findEntry(deps, `${docPath}.md`);
  }
  const source = companion ?? entry;
  // Sizes come from the listing: a file that is too big is never downloaded.
  if (deps.maxBytes !== undefined && source.size !== undefined && source.size > deps.maxBytes) {
    return { path, status: "error", error: tooLarge(source.size, deps.maxBytes) };
  }
  if (source.size !== undefined && source.size > budget.bytes) return { path, status: "error", error: AGAIN };
  const data = await deps.fs.readEntry(source);
  if (deps.maxBytes !== undefined && data.length > deps.maxBytes) {
    return { path, status: "error", error: tooLarge(data.length, deps.maxBytes) };
  }
  if (data.length > budget.bytes) return { path, status: "error", error: AGAIN };
  budget.bytes -= data.length;
  if (!isText(data)) {
    return {
      path,
      status: "error",
      error:
        "This file has no text to index. Run extract_text on a PDF or Office file first, or write the text to a file.",
    };
  }
  const name = docPath.slice(WORKSPACE_ROOT.length + 1);
  const text = data.toString("utf8");
  if (text.trim().length === 0) return { path: docPath, name, status: "error", error: "The file has no text." };

  // Refused before any embedding call, and before the earlier chunks are replaced.
  const chunkCount = chunkTextWithOverlap(text).filter((c) => c.trim().length > 0).length;
  const maxChunks = maxDocumentChunks();
  if (chunkCount > maxChunks) {
    return { path: docPath, name, status: "error", error: documentTooLongMessage(chunkCount, maxChunks) };
  }
  if (chunkCount > budget.chunks) return { path: docPath, name, status: "error", error: AGAIN };
  budget.chunks -= chunkCount;

  const row = await deps.findRow(name);
  const chunks = await deps.index(name, text);
  await deps.saveRow({ ...(row ? { id: row.id } : {}), name, workspacePath: docPath, chunkCount: chunks });
  return { path: docPath, name, chunks, status: row ? "replaced" : "indexed" };
}

export const INDEX_DOCUMENT_DESCRIPTION =
  "Index workspace files for semantic search with search_documents. " +
  "Call it when the user asks to index or search a document (also again, when asked again), " +
  "when a document is long (more than about 20 pages or 50,000 characters), " +
  "or when you need meaning-based search across several documents. " +
  "Otherwise read files directly with view or rg (extract_text for PDF and Office files). " +
  "A PDF or Office file is indexed from its extracted text (<file>.md), extracted first when missing. Indexing a file again replaces its earlier index entries. " +
  "Returns the file name and the number of chunks.";

export function indexDocumentTool(deps: IndexDocumentDeps) {
  return tool({
    description: INDEX_DOCUMENT_DESCRIPTION,
    inputSchema: z.object({
      paths: z
        .array(z.string().max(500))
        .min(1)
        .max(20)
        .describe("Workspace paths, e.g. /workspace/uploads/report.pdf"),
    }),
    execute: async ({ paths }: { paths: string[] }) => {
      const results: IndexResult[] = [];
      const budget = newIndexBudget(deps);
      for (const p of paths) results.push(await indexWorkspaceDocument(deps, p, budget));
      return { results };
    },
  });
}
