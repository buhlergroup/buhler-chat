import "server-only";

/**
 * The workspace part of a chat page (server components only). Not a
 * "use server" module: every export of such a module is a Server Action, and
 * this read takes a thread id without an owner check. It reads only the
 * current user's own namespace ({userKey}/{threadId}), so a foreign thread id
 * gives an empty workspace, never another user's files; the page checks the
 * thread itself.
 */
import { userHashedId } from "@/features/auth-page/helpers";
import { isValidId } from "@/features/common/odata-filter";
import { logWarn } from "@/features/common/services/logger";
import { resolveAgentRuntimeForCurrentUser } from "./runtime-selection";
import { copilotRuntimeConfigured, threadWorkspaceSummary } from "./workspace-files";
import type { WorkspaceSummary } from "./workspace-listing";
import { inlineResultLimit } from "./inline-limit";

/**
 * The upload chips, the file count and the paste limit for the chat page, or
 * null when the current user is not on the Copilot path (no chips, no Files
 * panel, no workspace read, a big paste stays text). A failed read gives an
 * empty workspace, not an error page.
 */
export async function FindWorkspaceSummaryForCurrentUser(threadId: string): Promise<WorkspaceSummary | null> {
  if (!copilotRuntimeConfigured() || !isValidId(threadId)) return null;
  if ((await resolveAgentRuntimeForCurrentUser()) !== "copilot") return null;
  // A bigger paste becomes a text file upload (chat-page.tsx).
  const pastedTextLimitBytes = inlineResultLimit();
  try {
    return { ...(await threadWorkspaceSummary(await userHashedId(), threadId)), pastedTextLimitBytes };
  } catch (e) {
    logWarn("copilot-runtime: workspace summary failed", {
      threadId,
      error: e instanceof Error ? e.message : String(e),
    });
    return { uploads: [], fileCount: 0, pastedTextLimitBytes };
  }
}
