import "server-only";

/**
 * image-access.ts — who may read a file of a thread through /api/images.
 *
 * A thread id is not a secret: it is in page URLs, in links and in logs. So
 * the route checks the caller against the thread, not only the session.
 *
 * Every page that renders `/api/images` URLs or `blob://threadId/...`
 * references, and so every legitimate viewer:
 *   - The thread owner. /chat/[id], /chat/temporary and /embed/chat/[id]
 *     read the thread with FindChatThreadForCurrentUser (a point read in the
 *     caller's partition). Agent chats (/agent/[personaId]/chat and
 *     /embed/agent/[personaId]/chat) start with CreatePersonaChat, which
 *     creates the thread in the caller's partition, and then open
 *     /chat/[id] or /embed/chat/[id]. The temporary chat is a thread row too
 *     (its id is the user id).
 *   - Administrators. /reporting/chat/[id] shows the messages of any thread,
 *     also of a deleted one (FindAllChatMessagesForAdmin, behind the proxy's
 *     admin rule and the isAdmin check of the service).
 * No page shows a thread to another, non-admin user: there are no shared
 * chats, and an agent shared with other users gives each user an own thread.
 *
 * Cost: an admin needs no read; everybody else costs one point read
 * (id + partition key), never a query. The route makes the decision once per
 * request, before it reads the blob.
 *
 * Not a "use server" module on purpose: nothing here may be callable from
 * the browser.
 */

import { hashValue, type UserModel } from "@/features/auth-page/helpers";
import { HistoryContainer } from "@/features/common/services/cosmos";
import { logWarn } from "@/features/common/services/logger";
import { CHAT_THREAD_ATTRIBUTE, type ChatThreadModel } from "./models";

export type ThreadImageAccess = "allowed" | "unauthenticated" | "not-found";

/**
 * "allowed" when `user` may see the files of thread `threadId`,
 * "unauthenticated" when there is no user, otherwise "not-found" (the caller
 * must answer as for a missing file, so the response does not tell whether
 * the thread exists).
 */
export const threadImageAccess = async (
  threadId: string,
  user: UserModel | null
): Promise<ThreadImageAccess> => {
  if (!user || !user.email) return "unauthenticated";

  // The reporting pages show every thread to an administrator.
  if (user.isAdmin) return "allowed";

  const userId = hashValue(user.email);
  try {
    // Point read in the caller's own partition: a thread of another user is
    // not in it, so it reads as "not found".
    const { resource } = await HistoryContainer()
      .item(threadId, userId)
      .read<ChatThreadModel>();
    if (
      resource &&
      resource.type === CHAT_THREAD_ATTRIBUTE &&
      resource.userId === userId &&
      !resource.isDeleted
    ) {
      return "allowed";
    }
  } catch (error) {
    // Fail closed. A missing item can also come as a thrown 404.
    if ((error as { code?: unknown })?.code !== 404) {
      logWarn("images: thread access check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return "not-found";
};
