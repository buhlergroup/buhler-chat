/**
 * `index_document` (Copilot path only): puts workspace files into the
 * thread's AI Search index on request, with the app's existing chunking,
 * embedding and indexing (document-pipeline.ts), and the same CHAT_DOCUMENT
 * row the upload flow writes, so search_documents, the document list and
 * deletion keep working.
 *
 * Input text: the Markdown next to a document (<file>.md, written at upload,
 * so Document Intelligence never runs twice), else the file itself when it is
 * text. Indexing the same file again replaces its chunks and updates the row.
 */
import { tool } from "ai";
import { z } from "zod";
import type { WorkspaceEntry } from "./blob-session-fs";
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
}

export interface IndexResult {
  path: string;
  name?: string;
  chunks?: number;
  status: "indexed" | "replaced" | "error";
  error?: string;
}

const isText = (data: Buffer) => !data.subarray(0, 8192).includes(0);

async function findEntry(deps: IndexDocumentDeps, path: string): Promise<WorkspaceEntry | undefined> {
  const slash = path.lastIndexOf("/");
  return (await deps.fs.listEntries(path.slice(0, slash), path.slice(slash + 1))).find((e) => e.path === path);
}

export async function indexWorkspaceDocument(deps: IndexDocumentDeps, rawPath: string): Promise<IndexResult> {
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
  const companion = await findEntry(deps, `${docPath}.md`);
  const data = await deps.fs.readEntry(companion ?? entry);
  if (!isText(data)) {
    return {
      path,
      status: "error",
      error:
        "This file has no text to index. Documents uploaded to the chat get a .md with their text; index that, or write the text to a file first.",
    };
  }
  const name = docPath.slice(WORKSPACE_ROOT.length + 1);
  const text = data.toString("utf8");
  if (text.trim().length === 0) return { path: docPath, name, status: "error", error: "The file has no text." };

  const row = await deps.findRow(name);
  const chunks = await deps.index(name, text);
  await deps.saveRow({ ...(row ? { id: row.id } : {}), name, workspacePath: docPath, chunkCount: chunks });
  return { path: docPath, name, chunks, status: row ? "replaced" : "indexed" };
}

export const INDEX_DOCUMENT_DESCRIPTION =
  "Index workspace files for semantic search with search_documents. " +
  "Use it only when a file is too large to read with view or rg, or when you need semantic (meaning-based) search over it; " +
  "for short files and exact words, read them with view or rg instead. " +
  "Uploaded documents are indexed from their extracted text (<file>.md). Indexing a file again replaces its earlier index entries. " +
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
      for (const p of paths) results.push(await indexWorkspaceDocument(deps, p));
      return { results };
    },
  });
}
