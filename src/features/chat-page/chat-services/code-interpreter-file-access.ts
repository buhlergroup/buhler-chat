import "server-only";

/**
 * code-interpreter-file-access.ts — the server's record of which code
 * interpreter files (OpenAI file ids) a user may use.
 *
 * An OpenAI file id says nothing about who may use the file: all files live
 * in one OpenAI resource. The thread's `attachedFiles` is the record, and
 * only the server writes code interpreter entries into it:
 *   - /api/code-interpreter/upload records an upload on the uploader's
 *     thread (source "upload"),
 *   - CreatePersonaChat records the agent's documents and skill archives
 *     when the chat starts (source "agent-document" / "skill").
 * Client-facing actions (UpsertChatThread, AddAttachedFile, ...) can remove
 * or reorder those entries, but never add one (mergeClientAttachedFiles).
 *
 * Not a "use server" module on purpose: nothing here may be callable from
 * the browser.
 */

import { userHashedId } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { logWarn } from "@/features/common/services/logger";
import {
  CHAT_THREAD_ATTRIBUTE,
  type AttachedFileModel,
  type ChatThreadModel,
} from "./models";

const isCodeInterpreterEntry = (f: Pick<AttachedFileModel, "type">) =>
  f.type !== "search-indexed";

/**
 * The attached-file list to store when a client sends `requested` for a
 * thread that has `stored`. Code interpreter entries are kept only when the
 * thread already has them, with the STORED data (so `source` cannot be
 * changed by the client); search-indexed entries pass through. `undefined`
 * stays `undefined` (the caller sent no list).
 */
export function mergeClientAttachedFiles(
  stored: ReadonlyArray<AttachedFileModel> | undefined,
  requested: ReadonlyArray<AttachedFileModel> | undefined,
): AttachedFileModel[] | undefined {
  if (requested === undefined) return undefined;
  const storedById = new Map(
    (stored ?? []).filter(isCodeInterpreterEntry).map((f) => [f.id, f]),
  );
  const out: AttachedFileModel[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const f of requested) {
    if (!f || typeof f.id !== "string") continue;
    if (!isCodeInterpreterEntry(f)) {
      out.push(f);
      continue;
    }
    const known = storedById.get(f.id);
    if (!known) {
      dropped++;
      continue;
    }
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(known);
  }
  if (dropped > 0) {
    logWarn("attached files: dropped code interpreter files the server did not record", {
      dropped,
    });
  }
  return out;
}

/** True when the caller may delete the file from OpenAI: only own uploads. */
export function mayDeleteCodeInterpreterFile(file: Pick<AttachedFileModel, "source">): boolean {
  return file.source === "upload";
}

/**
 * Finds a code interpreter file in the caller's own (not deleted) threads.
 * Returns the stored entry, preferring one the caller uploaded, or undefined.
 */
export async function findCodeInterpreterFileOfCurrentUser(
  fileId: string,
): Promise<{ threadId: string; file: AttachedFileModel } | undefined> {
  if (!fileId) return undefined;
  const userId = await userHashedId();
  const { resources } = await HistoryContainer()
    .items.query<Pick<ChatThreadModel, "id" | "attachedFiles">>(
      {
        query:
          "SELECT r.id, r.attachedFiles FROM root r WHERE r.type = @type AND r.userId = @userId AND r.isDeleted = @isDeleted AND ARRAY_CONTAINS(r.attachedFiles, { \"id\": @fileId }, true)",
        parameters: [
          { name: "@type", value: CHAT_THREAD_ATTRIBUTE },
          { name: "@userId", value: userId },
          { name: "@isDeleted", value: false },
          { name: "@fileId", value: fileId },
        ],
      },
      { partitionKey: userId },
    )
    .fetchAll();
  let found: { threadId: string; file: AttachedFileModel } | undefined;
  for (const thread of resources ?? []) {
    const file = (thread.attachedFiles ?? []).find(
      (f) => f.id === fileId && isCodeInterpreterEntry(f),
    );
    if (!file) continue;
    if (mayDeleteCodeInterpreterFile(file)) return { threadId: thread.id, file };
    found ??= { threadId: thread.id, file };
  }
  return found;
}

/**
 * Records an uploaded code interpreter file on the caller's thread
 * (source "upload"). Returns false when the thread is not the caller's or
 * the write failed. Retries on a concurrent write (etag).
 */
export async function recordCodeInterpreterUpload(
  threadId: string,
  file: { id: string; name: string },
): Promise<boolean> {
  const userId = await userHashedId();
  for (let attempt = 0; attempt < 3; attempt++) {
    const { resource } = await HistoryContainer()
      .item(threadId, userId)
      .read<ChatThreadModel & { _etag?: string }>();
    if (
      !resource ||
      resource.type !== CHAT_THREAD_ATTRIBUTE ||
      resource.isDeleted ||
      resource.userId !== userId
    ) {
      return false;
    }
    const existing = resource.attachedFiles ?? [];
    if (existing.some((f) => f.id === file.id)) return true;
    const entry: AttachedFileModel = {
      id: file.id,
      name: file.name,
      type: "code-interpreter",
      uploadedAt: new Date(),
      source: "upload",
    };
    try {
      await HistoryContainer().items.upsert<ChatThreadModel>(
        { ...resource, attachedFiles: [...existing, entry] },
        resource._etag
          ? { accessCondition: { type: "IfMatch", condition: resource._etag } }
          : undefined,
      );
      return true;
    } catch (error) {
      const code = (error as { code?: number })?.code;
      if (code === 412) continue; // changed meanwhile: read again
      throw error;
    }
  }
  return false;
}

/**
 * Creates a NEW chat thread for the caller with server-built attached files
 * (the agent's documents and skill archives). Server code only: the thread
 * is always written to the caller's partition, and an existing id fails.
 */
export async function createChatThreadWithServerFiles(
  thread: ChatThreadModel,
): Promise<ChatThreadModel | undefined> {
  const userId = await userHashedId();
  const { resource } = await HistoryContainer().items.create<ChatThreadModel>({
    ...thread,
    userId,
  });
  return resource;
}
