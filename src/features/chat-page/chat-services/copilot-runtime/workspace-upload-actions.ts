"use server";
import "server-only";

import { userHashedId, userSession } from "@/features/auth-page/helpers";
import { isValidId } from "@/features/common/odata-filter";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { logError } from "@/features/common/services/logger";
import { FindChatThreadForCurrentUser } from "../chat-thread-service";
import { resolveAgentRuntimeForCurrentUser } from "./runtime-selection";
import { uploadToThreadWorkspace } from "./workspace-files";

const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Chat upload on the Copilot path: the file goes to /workspace/uploads/ of
 * the thread (documents also get their extracted text as <name>.md). No AI
 * Search indexing here; the agent indexes on request with index_document.
 *
 * Returns { handled: false } when the user is not on the Copilot path; the
 * client then runs the existing upload flow unchanged.
 *
 * Form fields: "file", "id" (the chat thread id).
 */
export async function UploadFileToAgentWorkspace(
  formData: FormData,
): Promise<ServerActionResponse<{ handled: boolean; path?: string; markdownPath?: string }>> {
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
    const configured = Number(process.env.MAX_UPLOAD_DOCUMENT_SIZE);
    const maxBytes = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_BYTES;
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
      response: {
        handled: true,
        path: stored.path,
        ...(stored.markdownPath ? { markdownPath: stored.markdownPath } : {}),
      },
    };
  } catch (e) {
    logError("UploadFileToAgentWorkspace failed", { error: e instanceof Error ? e.message : String(e) });
    return { status: "ERROR", errors: [{ message: "The file could not be stored in the chat workspace." }] };
  }
}
