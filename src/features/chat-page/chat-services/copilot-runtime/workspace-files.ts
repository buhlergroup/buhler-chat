import "server-only";

import { SqlQuerySpec } from "@azure/cosmos";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { uniqueId } from "@/features/common/util";
import { logInfo, logWarn } from "@/features/common/services/logger";
import { CHAT_DOCUMENT_ATTRIBUTE, type ChatDocumentModel } from "../models";
import { BlobSessionFs, sharedWorkspaceQuota, type BlobStore, type WorkspaceEntry } from "./blob-session-fs";
import { indexedWorkspacePath, unindexedUploadPaths } from "./search-documents-hint";
import { getAgentWorkspaceStore, getExistingAgentWorkspaceStore } from "./azure-blob-store";
import { buildNamespace, SESSION_STATE_ROOT } from "./session-path";
import { ThreadBusyError } from "./thread-lease";
import { extractDocumentText, indexDocument } from "./document-pipeline";
import { extractWorkspaceText, type ExtractTextDeps } from "./extract-text";
import type { IndexDocumentDeps } from "./index-document";
import {
  maxWorkspaceUploadBytes,
  storeUpload,
  UPLOADS_DIR,
  uploadsNote,
  type StoredUpload,
} from "./workspace-uploads";
import {
  listWorkspaceFiles,
  removeWorkspaceFile,
  summarizeWorkspace,
  type WorkspaceListing,
  type WorkspaceSummary,
} from "./workspace-listing";
import { removeWorkspaceIndexEntries } from "./workspace-index-removal";

/** True when this deployment can use the Copilot path at all (global or opt-in). */
export function copilotRuntimeConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return (
    env.AGENT_RUNTIME?.trim().toLowerCase() === "copilot" ||
    !!env.COPILOT_RUNTIME_USERS?.trim() ||
    !!env.COPILOT_RUNTIME_GROUP_ID?.trim()
  );
}

export async function threadWorkspace(userKey: string, threadId: string, store?: BlobStore) {
  const s = store ?? (await getAgentWorkspaceStore());
  return { store: s, fs: new BlobSessionFs(s, buildNamespace(userKey, threadId)) };
}

/** Stores one uploaded file in the thread's workspace, as it is (see workspace-uploads.ts). */
export async function uploadToThreadWorkspace(
  userKey: string,
  threadId: string,
  fileName: string,
  data: Buffer,
): Promise<StoredUpload> {
  const { fs } = await threadWorkspace(userKey, threadId);
  const result = await storeUpload({ fs }, fileName, data);
  logInfo("copilot-runtime: upload stored in the workspace", {
    threadId,
    kind: result.kind,
    bytes: result.bytes,
  });
  return result;
}

/** The upload chips and the file count of a thread's workspace (see workspace-listing.ts). */
export async function threadWorkspaceSummary(userKey: string, threadId: string): Promise<WorkspaceSummary> {
  const { fs } = await threadWorkspace(userKey, threadId);
  return summarizeWorkspace({ fs });
}

/** Every file under /workspace of a thread, for the Files panel (see workspace-listing.ts). */
export async function threadWorkspaceListing(userKey: string, threadId: string): Promise<WorkspaceListing> {
  const { fs } = await threadWorkspace(userKey, threadId);
  return listWorkspaceFiles({ fs });
}

/**
 * Removes one file under /workspace of a thread (a path relative to
 * /workspace, from the browser), its text extracts and their search index
 * entries (chunks and CHAT_DOCUMENT row). Returns the removed paths relative
 * to /workspace.
 */
export async function removeThreadWorkspaceFile(userKey: string, threadId: string, path: unknown): Promise<string[]> {
  const { fs } = await threadWorkspace(userKey, threadId);
  const removed = await removeWorkspaceFile(
    { fs, removeIndexEntries: (paths) => removeWorkspaceIndexEntries({ threadId, userKey, paths }) },
    path,
  );
  logInfo("copilot-runtime: workspace file removed by the user", { threadId, files: removed.length });
  return removed;
}

/**
 * Folder of SharePoint files the agent fetched (fetch_sharepoint_file). Kept
 * apart from /workspace/uploads so deleting the chat documents (the user's
 * uploads) does not delete them; they go with the thread.
 */
export const SHAREPOINT_DIR = "/workspace/sharepoint";

/** Stores a fetched SharePoint file under /workspace/sharepoint, as it is (same naming rule as uploads). */
export async function storeSharePointFileInWorkspace(
  userKey: string,
  threadId: string,
  fileName: string,
  data: Buffer,
): Promise<StoredUpload> {
  const { fs } = await threadWorkspace(userKey, threadId);
  const result = await storeUpload({ fs }, fileName, data, SHAREPOINT_DIR);
  logInfo("copilot-runtime: SharePoint file stored in the workspace", { threadId, kind: result.kind, bytes: result.bytes });
  return result;
}

/** The files in /workspace/uploads (one listing; [] when it fails). */
export async function workspaceUploadEntries(fs: BlobSessionFs): Promise<WorkspaceEntry[]> {
  return fs.listEntries(UPLOADS_DIR).catch(() => []);
}

/** The note that tells the model what is in /workspace/uploads (undefined when empty). */
export function workspaceUploadsNote(entries: WorkspaceEntry[]): string | undefined {
  return uploadsNote(entries);
}

/**
 * The uploads of the thread that are not indexed (search_documents cannot
 * find them): the workspace paths of the thread's indexed chat documents
 * are left out.
 */
export async function unindexedWorkspaceUploads(args: {
  entries: WorkspaceEntry[];
  threadId: string;
  userKey: string;
}): Promise<string[]> {
  if (args.entries.length === 0) return [];
  const query: SqlQuerySpec = {
    query:
      "SELECT r.name, r.workspacePath FROM root r WHERE r.type=@type AND r.chatThreadId=@threadId AND r.userId=@userId AND r.isDeleted=false",
    parameters: [
      { name: "@type", value: CHAT_DOCUMENT_ATTRIBUTE },
      { name: "@threadId", value: args.threadId },
      { name: "@userId", value: args.userKey },
    ],
  };
  const { resources } = await HistoryContainer()
    .items.query<{ name?: string; workspacePath?: string }>(query)
    .fetchAll();
  const indexed = new Set(resources.flatMap((r) => indexedWorkspacePath(r) ?? []));
  return unindexedUploadPaths(args.entries, indexed);
}

export type WorkspaceScope = "uploads" | "session" | "all";

/**
 * Removes a thread's workspace files: "uploads" when the chat documents are
 * deleted, "session" (the runtime's session state) when messages are, "all"
 * (workspace files, tool results and session state) when the thread is deleted
 * or fully reset. Hard delete, like the AI Search chunks of deleted chat
 * documents. Never creates the container; does nothing in deployments
 * without the Copilot path.
 */
export async function removeThreadWorkspaceFiles(
  userKey: string,
  threadId: string,
  scope: WorkspaceScope,
  store?: BlobStore,
): Promise<number> {
  if (!store && !copilotRuntimeConfigured()) return 0;
  const s = store ?? (await getExistingAgentWorkspaceStore());
  if (!s) return 0;
  const ns = buildNamespace(userKey, threadId);
  let names: string[];
  if (scope === "all") {
    names = await s.listNames(`${ns}/`);
  } else {
    const dir = scope === "uploads" ? UPLOADS_DIR : SESSION_STATE_ROOT;
    const pointers = await s.listDetailed(`${ns}/f${dir}/`);
    names = pointers.flatMap((p) => {
      const target = p.metadata?.target;
      return typeof target === "string" && target.startsWith(`${ns}/d/`) ? [p.name, target] : [p.name];
    });
  }
  for (let i = 0; i < names.length; i += 32) {
    await Promise.all(names.slice(i, i + 32).map((n) => s.delete(n).catch(() => false)));
  }
  sharedWorkspaceQuota().forget(ns);
  return names.length;
}

/** The text for a reset or rewind that waits for a running reply. */
export const RESET_BUSY_TEXT = "A reply is still running in this chat. Stop it, then try again.";

export type ThreadResetLock = { ok: true; release(): Promise<void> } | { ok: false; message: string };

/**
 * Locks a thread for a reset / rewind (Copilot path; a no-op lock elsewhere):
 * stops this process's running turn of the thread, holds the thread lease
 * while the caller deletes, and drops the live sessions (copilot-session.ts
 * lockThreadSessions). `ok: false` while a reply runs on another instance:
 * the caller must not delete anything then. Release it after the deletion.
 */
export async function lockThreadForReset(userKey: string, threadId: string): Promise<ThreadResetLock> {
  if (!copilotRuntimeConfigured()) return { ok: true, release: async () => undefined };
  const session = await import("./copilot-session");
  try {
    const lock = await session.lockThreadSessions(userKey, threadId);
    return {
      ok: true,
      release: () =>
        lock.release().catch((err) =>
          logWarn("copilot-runtime: thread lock release failed", {
            threadId,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
    };
  } catch (err) {
    if (err instanceof ThreadBusyError || (err as { name?: unknown })?.name === "ThreadBusyError") {
      return { ok: false, message: RESET_BUSY_TEXT };
    }
    // The lease store failed: no turn can start without it either. Delete
    // without the lock, after this process's live session is gone.
    logWarn("copilot-runtime: could not lock the thread for a reset", {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    await session.discardLiveSession(threadId).catch(() => undefined);
    return { ok: true, release: async () => undefined };
  }
}

/**
 * Same as removeThreadWorkspaceFiles, logging instead of failing the caller.
 * The session state goes only under the thread lock (lockThreadForReset), so
 * no running turn writes it back and no live session answers from deleted
 * turns; while a reply runs on another instance it is kept (logged). A caller
 * that holds the lock already passes `locked`.
 */
export async function removeThreadWorkspaceFilesQuietly(
  userKey: string,
  threadId: string,
  scope: WorkspaceScope,
  options: { locked?: boolean } = {},
): Promise<void> {
  let lock: ThreadResetLock | undefined;
  try {
    if (scope !== "uploads" && !options.locked) {
      lock = await lockThreadForReset(userKey, threadId);
      if (!lock.ok) {
        logWarn("copilot-runtime: session state kept, a reply is still running", { threadId, scope });
        return;
      }
    }
    const removed = await removeThreadWorkspaceFiles(userKey, threadId, scope);
    if (removed > 0) logInfo("copilot-runtime: removed workspace files", { threadId, scope, blobs: removed });
  } catch (err) {
    logWarn("copilot-runtime: workspace clean-up failed", {
      threadId,
      scope,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (lock?.ok) await lock.release();
  }
}

/** extract_text on a thread's workspace: Document Intelligence, cached per user in the content store. */
export function workspaceExtractDeps(args: { fs: BlobSessionFs; userKey: string }): ExtractTextDeps {
  const { fs, userKey } = args;
  return {
    fs,
    extract: (data, pages) => extractDocumentText(userKey, data, pages),
    maxBytes: maxWorkspaceUploadBytes(),
  };
}

/** index_document against the app's Cosmos rows and AI Search index, for one thread. */
export function chatDocumentIndexDeps(args: {
  fs: BlobSessionFs;
  threadId: string;
  userKey: string;
}): IndexDocumentDeps {
  const { fs, threadId, userKey } = args;
  const extractDeps = workspaceExtractDeps({ fs, userKey });
  return {
    fs,
    extractText: (path) => extractWorkspaceText(extractDeps, path),
    maxBytes: maxWorkspaceUploadBytes(),
    async findRow(name) {
      const query: SqlQuerySpec = {
        query:
          "SELECT * FROM root r WHERE r.type=@type AND r.chatThreadId=@threadId AND r.userId=@userId AND r.name=@name AND r.isDeleted=false",
        parameters: [
          { name: "@type", value: CHAT_DOCUMENT_ATTRIBUTE },
          { name: "@threadId", value: threadId },
          { name: "@userId", value: userKey },
          { name: "@name", value: name },
        ],
      };
      const { resources } = await HistoryContainer().items.query<ChatDocumentModel>(query).fetchAll();
      return resources[0] ? { id: resources[0].id } : undefined;
    },
    async saveRow(row) {
      const model: ChatDocumentModel = {
        id: row.id ?? uniqueId(),
        chatThreadId: threadId,
        userId: userKey,
        createdAt: new Date(),
        type: CHAT_DOCUMENT_ATTRIBUTE,
        isDeleted: false,
        name: row.name,
        workspacePath: row.workspacePath,
        chunkCount: row.chunkCount,
      };
      await HistoryContainer().items.upsert<ChatDocumentModel>(model);
    },
    index: (name, text) => indexDocument({ threadId, userKey, name, text }),
  };
}
