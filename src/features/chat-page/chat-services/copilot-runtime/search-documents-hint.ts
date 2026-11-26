/**
 * search_documents on the Copilot path.
 *
 * An upload on this path is stored in /workspace/uploads/, not indexed, so
 * search_documents (AI Search over the indexed chat documents and the agent
 * documents) cannot find it. A model that took the upload for an "attached
 * document" searched, found nothing and told the user that no document
 * matched. Here the tool:
 *   - says in its description that it searches indexed documents only;
 *   - answers a search with no result, while the chat has uploads that are
 *     not indexed, with a hint that names them and the tools that read them
 *     (a result, not an error), so the model reads the file in the same turn.
 *
 * The AI SDK path keeps its own search_documents (tools/search-documents.ts).
 */
import type { Tool as AiTool } from "@ai-sdk/provider-utils";
import type { WorkspaceEntry } from "./blob-session-fs";
import { WORKSPACE_ROOT } from "./session-path";
import { MAX_NOTED_UPLOADS, UPLOADS_DIR, UPLOADS_RULE } from "./workspace-uploads";

export const COPILOT_SEARCH_DOCUMENTS_DESCRIPTION =
  "Search the indexed documents of this chat: chat documents indexed with index_document and the agent's documents. " +
  `It does not find the files in ${UPLOADS_DIR}/ that are not indexed: read those with extract_text, view or rg. ` +
  "Iterate using top (max results) and skip (offset) to paginate until you gather enough context.";

/**
 * The uploads that are not indexed, newest first and bounded. `indexedPaths`
 * are the workspace paths of the thread's indexed chat documents; a text
 * extract (<file>.md) counts as indexed when its document is.
 */
export function unindexedUploadPaths(
  entries: ReadonlyArray<Pick<WorkspaceEntry, "path" | "lastModified">>,
  indexedPaths: ReadonlySet<string>,
  max = MAX_NOTED_UPLOADS,
): string[] {
  const isIndexed = (p: string) => indexedPaths.has(p) || (p.endsWith(".md") && indexedPaths.has(p.slice(0, -3)));
  return [...entries]
    .filter((e) => e.path.startsWith(`${UPLOADS_DIR}/`) && !isIndexed(e.path))
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime() || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, max)
    .map((e) => e.path);
}

/** The hint of a search with no result while uploads are not indexed. */
export function unindexedUploadsHint(paths: ReadonlyArray<string>): string {
  return (
    `No indexed document matched. These uploads of the chat are not indexed, so search_documents cannot find them: ${paths.join(", ")}. ` +
    `${UPLOADS_RULE} Read the upload that fits the question now instead of saying that no document was found.`
  );
}

/** Workspace path of an indexed chat document row (rows store it absolute or relative). */
export function indexedWorkspacePath(row: { name?: string; workspacePath?: string }): string | undefined {
  const p = row.workspacePath ?? "";
  if (!p) return undefined;
  return p.startsWith("/") ? p : `${WORKSPACE_ROOT}/${p}`;
}

/**
 * search_documents is offered when there is something it can find or will
 * soon find: indexed chat documents or agent documents (the AI SDK path's
 * rule), or uploads the model may index. Offered always, it was called
 * again and again on an agent with no documents instead of the agent's own
 * extension tools.
 */
export function copilotOffersSearchDocuments(args: { hasIndexedDocuments: boolean; uploadCount: number }): boolean {
  return args.hasIndexedDocuments || args.uploadCount > 0;
}

export const SEARCH_NEXT_MESSAGE_NOTE =
  "search_documents is offered from the next user message on. For this answer, read the file with extract_text, view or rg.";

/**
 * index_document of a turn without search_documents: its result says when
 * the search is there (the toolset of a turn is fixed when it starts).
 */
export function withSearchNextMessageNote(indexTool: AiTool): AiTool {
  const execute = indexTool.execute;
  if (!execute) return indexTool;
  return {
    ...indexTool,
    execute: async (input: unknown, options: Parameters<NonNullable<AiTool["execute"]>>[1]) => {
      const out = (await execute(input, options)) as Record<string, unknown>;
      return out && typeof out === "object" ? { ...out, note: SEARCH_NEXT_MESSAGE_NOTE } : out;
    },
  } as AiTool;
}

type SearchOutput ={ documentCount?: unknown; summary?: unknown } & Record<string, unknown>;

/**
 * The app's search_documents with the Copilot description and the upload
 * hint on an empty result. `unindexedUploads` is read only for an empty
 * result; its failure leaves the result as it is.
 */
export function withUploadsSearchHint(
  search: AiTool,
  unindexedUploads: () => Promise<string[]>,
): AiTool {
  const execute = search.execute;
  if (!execute) return search;
  return {
    ...search,
    description: COPILOT_SEARCH_DOCUMENTS_DESCRIPTION,
    execute: async (input: unknown, options: Parameters<NonNullable<AiTool["execute"]>>[1]) => {
      const out = (await execute(input, options)) as SearchOutput;
      if (!out || typeof out !== "object" || out.documentCount !== 0) return out;
      const paths = await unindexedUploads().catch(() => [] as string[]);
      if (paths.length === 0) return out;
      return { ...out, unindexedUploads: paths, summary: unindexedUploadsHint(paths) };
    },
  } as AiTool;
}
