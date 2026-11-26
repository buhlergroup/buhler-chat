import "server-only";

import { SqlQuerySpec } from "@azure/cosmos";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { uniqueId } from "@/features/common/util";
import { logInfo, logWarn } from "@/features/common/services/logger";
import { CHAT_DOCUMENT_ATTRIBUTE, type ChatDocumentModel } from "../models";
import { BlobSessionFs, sharedWorkspaceQuota, type BlobStore } from "./blob-session-fs";
import { getAgentWorkspaceStore, getExistingAgentWorkspaceStore } from "./azure-blob-store";
import { buildNamespace, SESSION_STATE_ROOT, WORKSPACE_ROOT } from "./session-path";
import { extractMarkdown, indexDocument } from "./document-pipeline";
import type { IndexDocumentDeps } from "./index-document";
import { storeUpload, UPLOADS_DIR, uploadsNote, type StoredUpload } from "./workspace-uploads";

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

/** Stores one uploaded file in the thread's workspace (see workspace-uploads.ts). */
export async function uploadToThreadWorkspace(
  userKey: string,
  threadId: string,
  fileName: string,
  data: Buffer,
): Promise<StoredUpload> {
  const { fs } = await threadWorkspace(userKey, threadId);
  const result = await storeUpload({ fs, extractMarkdown }, fileName, data);
  logInfo("copilot-runtime: upload stored in the workspace", {
    threadId,
    kind: result.kind,
    bytes: result.bytes,
  });
  return result;
}

/** The line that tells the model what is in /workspace/uploads (undefined when empty). */
export async function workspaceUploadsNote(fs: BlobSessionFs): Promise<string | undefined> {
  return uploadsNote(await fs.listEntries(UPLOADS_DIR));
}

/** What a clean-up removes: see removeThreadWorkspaceFiles. */
export type WorkspaceCleanupScope = "uploads" | "all" | "session-state" | "workspace";

const SCOPE_ROOTS: Record<Exclude<WorkspaceCleanupScope, "all">, string> = {
  uploads: UPLOADS_DIR,
  "session-state": SESSION_STATE_ROOT,
  workspace: WORKSPACE_ROOT,
};

/**
 * Removes a thread's workspace files: "uploads" when the chat documents are
 * deleted, "session-state" (the runtime journal) on a rewind, "workspace"
 * (all model files) on a reset, "all" (workspace files, tool results,
 * session state, lease) when the thread is deleted. Hard delete, like the AI
 * Search chunks of deleted chat documents. Never creates the container; does
 * nothing in deployments without the Copilot path.
 */
export async function removeThreadWorkspaceFiles(
  userKey: string,
  threadId: string,
  scope: WorkspaceCleanupScope,
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
    const pointers = await s.listDetailed(`${ns}/f${SCOPE_ROOTS[scope]}/`);
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

/** Same as removeThreadWorkspaceFiles, logging instead of failing the caller. */
export async function removeThreadWorkspaceFilesQuietly(
  userKey: string,
  threadId: string,
  scope: WorkspaceCleanupScope,
): Promise<void> {
  try {
    const removed = await removeThreadWorkspaceFiles(userKey, threadId, scope);
    if (removed > 0) logInfo("copilot-runtime: removed workspace files", { threadId, scope, blobs: removed });
  } catch (err) {
    logWarn("copilot-runtime: workspace clean-up failed", {
      threadId,
      scope,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * After a rewind ("rewind") or reset ("reset") of a chat: the runtime must
 * not continue the deleted history. Drops the live session in every
 * instance (the lease blob gets a new generation, see
 * invalidateThreadSessions), and deletes the journal under /session-state;
 * a reset also deletes /workspace. The next turn creates a new session and
 * seeds it from the Cosmos rows that are left. Never fails the caller.
 */
export async function resetThreadRuntimeQuietly(
  userKey: string,
  threadId: string,
  mode: "rewind" | "reset",
): Promise<void> {
  if (!copilotRuntimeConfigured()) return;
  try {
    const { invalidateThreadSessions } = await import("./copilot-session");
    await invalidateThreadSessions(userKey, threadId);
  } catch (err) {
    logWarn("copilot-runtime: could not invalidate the live session", {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await removeThreadWorkspaceFilesQuietly(userKey, threadId, "session-state");
  if (mode === "reset") await removeThreadWorkspaceFilesQuietly(userKey, threadId, "workspace");
}

/** index_document against the app's Cosmos rows and AI Search index, for one thread. */
export function chatDocumentIndexDeps(args: {
  fs: BlobSessionFs;
  threadId: string;
  userKey: string;
}): IndexDocumentDeps {
  const { fs, threadId, userKey } = args;
  return {
    fs,
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
