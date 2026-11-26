"use server";
import "server-only";

import { userHashedId, userSession } from "@/features/auth-page/helpers";
import { isValidId } from "@/features/common/odata-filter";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { logError } from "@/features/common/services/logger";
import { FindChatThreadForCurrentUser } from "../chat-thread-service";
import { resolveAgentRuntimeForCurrentUser } from "./runtime-selection";
import {
  removeThreadWorkspaceFile,
  threadWorkspaceListing,
  uploadToThreadWorkspace,
} from "./workspace-files";
import type { WorkspaceListing } from "./workspace-listing";
import { maxWorkspaceUploadBytes } from "./workspace-uploads";

/**
 * Chat upload on the Copilot path: the file goes to /workspace/uploads/ of
 * the thread, as it is. No text extraction and no AI Search indexing here;
 * the agent calls extract_text and index_document on request.
 *
 * Returns { handled: false } when the user is not on the Copilot path; the
 * client then runs the existing upload flow unchanged.
 *
 * Form fields: "file", "id" (the chat thread id).
 */
export async function UploadFileToAgentWorkspace(
  formData: FormData,
): Promise<
  ServerActionResponse<{ handled: boolean; path?: string; size?: number; modified?: string }>
> {
  try {
    // Every export here is a Server Action: check the session here too, not
    // only in the proxy.
    if (!(await userSession())) {
      return { status: "UNAUTHORIZED", errors: [{ message: "Not signed in" }] };
    }
    if ((await resolveAgentRuntimeForCurrentUser()) !== "copilot") {
      return { status: "OK", response: { handled: false } };
    }
    const file = formData.get("file");
    const threadId = formData.get("id");
    if (!(file instanceof File) || !isValidId(threadId)) {
      return { status: "ERROR", errors: [{ message: "Invalid upload" }] };
    }
    const thread = await FindChatThreadForCurrentUser(threadId);
    if (thread.status !== "OK") return { status: "ERROR", errors: [{ message: "Chat thread not found" }] };

    // Same size limit as the chat document upload today.
    const maxBytes = maxWorkspaceUploadBytes();
    if (file.size >= maxBytes) {
      return {
        status: "ERROR",
        errors: [{ message: `File is too large and must be less than ${Math.round(maxBytes / 104857.6) / 10} MB.` }],
      };
    }

    const data = Buffer.from(await file.arrayBuffer());
    const stored = await uploadToThreadWorkspace(await userHashedId(), threadId, file.name, data);
    return {
      status: "OK",
      response: { handled: true, path: stored.path, size: stored.bytes, modified: new Date().toISOString() },
    };
  } catch (e) {
    logError("UploadFileToAgentWorkspace failed", { error: e instanceof Error ? e.message : String(e) });
    return { status: "ERROR", errors: [{ message: "The file could not be stored in the chat workspace." }] };
  }
}

/**
 * Session, thread id, Copilot path and thread owner, in this order.
 * Undefined when all hold; else the response to return.
 */
async function refuseWorkspaceAccess(threadId: unknown): Promise<ServerActionResponse<never> | undefined> {
  if (!(await userSession())) {
    return { status: "UNAUTHORIZED", errors: [{ message: "Not signed in" }] };
  }
  if (!isValidId(threadId)) return { status: "ERROR", errors: [{ message: "Invalid chat thread" }] };
  if ((await resolveAgentRuntimeForCurrentUser()) !== "copilot") {
    return { status: "NOT_FOUND", errors: [{ message: "This chat has no file workspace." }] };
  }
  const thread = await FindChatThreadForCurrentUser(threadId);
  if (thread.status !== "OK") return { status: "NOT_FOUND", errors: [{ message: "Chat thread not found" }] };
  return undefined;
}

/**
 * Every file under /workspace of the thread (Copilot path), newest first and
 * bounded (workspace-listing.ts). Never /session-state.
 */
export async function ListWorkspaceFiles(threadId: string): Promise<ServerActionResponse<WorkspaceListing>> {
  try {
    const refused = await refuseWorkspaceAccess(threadId);
    if (refused) return refused;
    return { status: "OK", response: await threadWorkspaceListing(await userHashedId(), threadId) };
  } catch (e) {
    logError("ListWorkspaceFiles failed", { error: e instanceof Error ? e.message : String(e) });
    return { status: "ERROR", errors: [{ message: "The files of this chat could not be listed." }] };
  }
}

/**
 * Deletes one file under /workspace of the thread (Copilot path): `path` is
 * relative to /workspace ("uploads/report.pdf"). For a PDF / Office file its
 * text extracts (<file>.md, <file>.p<pages>.md) go too. Never a folder,
 * never /session-state, never another thread's or user's files.
 */
export async function RemoveWorkspaceFile(
  threadId: string,
  path: string,
): Promise<ServerActionResponse<{ removed: string[] }>> {
  try {
    const refused = await refuseWorkspaceAccess(threadId);
    if (refused) return refused;
    const removed = await removeThreadWorkspaceFile(await userHashedId(), threadId, path);
    return { status: "OK", response: { removed } };
  } catch (e) {
    const name = (e as { name?: unknown })?.name;
    if (name === "SessionPathError") return { status: "ERROR", errors: [{ message: "Invalid file path" }] };
    if (name === "WorkspaceFileNotFoundError") return { status: "NOT_FOUND", errors: [{ message: "File not found" }] };
    if (name === "WorkspaceIndexRemovalError") {
      logError("RemoveWorkspaceFile: index entries not deleted, file kept", { error: (e as Error).message });
      return {
        status: "ERROR",
        errors: [{ message: "The search index entries of the file could not be deleted. The file is kept; try again." }],
      };
    }
    logError("RemoveWorkspaceFile failed", { error: e instanceof Error ? e.message : String(e) });
    return { status: "ERROR", errors: [{ message: "The file could not be deleted." }] };
  }
}
