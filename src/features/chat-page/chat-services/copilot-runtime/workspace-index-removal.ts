import "server-only";

/**
 * The search index entries of workspace files the user deletes (Copilot
 * path). index_document indexes a file as document `name` = its path
 * relative to /workspace ("uploads/report.pdf"): the AI Search chunks carry
 * that name in `metadata`, and the CHAT_DOCUMENT row has it as `name` (and
 * the absolute path as `workspacePath`). Deleting the file deletes both, like
 * the "delete documents" action does for all documents of a thread: chunks
 * first, then the row is marked deleted.
 *
 * Only rows of this thread and this user, and only chunks of this thread and
 * user whose name is exactly the row's name.
 */
import { SqlQuerySpec } from "@azure/cosmos";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { DeleteChunksByIds, FindChatDocumentChunkIds } from "../azure-ai-search/azure-ai-search";
import { CHAT_DOCUMENT_ATTRIBUTE, type ChatDocumentModel } from "../models";
import { WORKSPACE_ROOT } from "./session-path";

/** Thrown when the index entries of a file could not be deleted (the file is then kept). */
export class WorkspaceIndexRemovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceIndexRemovalError";
  }
}

/**
 * Deletes the index chunks and marks the CHAT_DOCUMENT rows of the given
 * workspace files (paths relative to /workspace) deleted. Returns the number
 * of rows. Without a row there is no index read at all (no AI Search call for
 * files that were never indexed). Throws WorkspaceIndexRemovalError when the
 * chunks or the rows could not be deleted (the caller keeps the files); a
 * failed chunk delete changes no row.
 */
export async function removeWorkspaceIndexEntries(args: {
  threadId: string;
  userKey: string;
  paths: string[];
}): Promise<number> {
  const { threadId, userKey, paths } = args;
  if (paths.length === 0) return 0;
  const query: SqlQuerySpec = {
    query:
      "SELECT * FROM root r WHERE r.type=@type AND r.chatThreadId=@threadId AND r.userId=@userId AND r.isDeleted=false " +
      "AND (ARRAY_CONTAINS(@names, r.name) OR ARRAY_CONTAINS(@workspacePaths, r.workspacePath))",
    parameters: [
      { name: "@type", value: CHAT_DOCUMENT_ATTRIBUTE },
      { name: "@threadId", value: threadId },
      { name: "@userId", value: userKey },
      { name: "@names", value: paths },
      { name: "@workspacePaths", value: paths.map((p) => `${WORKSPACE_ROOT}/${p}`) },
    ],
  };
  const { resources: rows } = await HistoryContainer()
    .items.query<ChatDocumentModel>(query, { partitionKey: userKey })
    .fetchAll();
  if (!rows || rows.length === 0) return 0;

  try {
    for (const name of new Set(rows.map((r) => r.name))) {
      await DeleteChunksByIds(await FindChatDocumentChunkIds(threadId, userKey, name));
    }
  } catch (e) {
    throw new WorkspaceIndexRemovalError(
      `The search index entries could not be deleted: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    for (const row of rows) {
      await HistoryContainer().items.upsert<ChatDocumentModel>({ ...row, isDeleted: true });
    }
  } catch (e) {
    throw new WorkspaceIndexRemovalError(
      `The document entry could not be deleted: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return rows.length;
}
