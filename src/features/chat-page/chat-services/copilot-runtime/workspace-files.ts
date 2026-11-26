import "server-only";

import { SqlQuerySpec } from "@azure/cosmos";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { uniqueId } from "@/features/common/util";
import { logInfo, logWarn } from "@/features/common/services/logger";
import { CHAT_DOCUMENT_ATTRIBUTE, type ChatDocumentModel } from "../models";
import { BlobSessionFs, sharedWorkspaceQuota, type BlobStore } from "./blob-session-fs";
import { getAgentWorkspaceStore, getExistingAgentWorkspaceStore } from "./azure-blob-store";
import { buildNamespace, SESSION_STATE_ROOT } from "./session-path";
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

/**
 * Same as removeThreadWorkspaceFiles, logging instead of failing the caller.
 * When the session state goes, this process's live session of the thread goes
 * first, so it cannot write the state back or answer from deleted turns.
 */
export async function removeThreadWorkspaceFilesQuietly(
  userKey: string,
  threadId: string,
  scope: WorkspaceScope,
): Promise<void> {
  try {
    if (scope !== "uploads" && copilotRuntimeConfigured()) {
      // Drops this process's live session and gives the thread's lease a new
      // generation, so another instance's live session is dropped too.
      const { invalidateThreadSessions } = await import("./copilot-session");
      await invalidateThreadSessions(userKey, threadId).catch((err) =>
        logWarn("copilot-runtime: could not invalidate the live session", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
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
