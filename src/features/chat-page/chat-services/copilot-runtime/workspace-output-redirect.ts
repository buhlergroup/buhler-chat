import "server-only";

/**
 * /api/images safety net for the Copilot path: a link of the form
 * /api/images?t=<thread>&img=<name> to a file that run_code or generate_image
 * put into the thread workspace (not into the chat image store) leads to the
 * workspace download route instead of "Blob not found". Also repairs such
 * links already written in existing chats.
 *
 * Only for the caller's own thread, only on the Copilot path, only for a
 * safe single file name, and only when the file is in /workspace/outputs or
 * /workspace/images: otherwise undefined (the caller keeps its 404).
 */
import type { UserModel } from "@/features/auth-page/helpers";
import { hashValue } from "@/features/auth-page/helpers";
import { isSafeBlobFileName } from "@/features/common/blob-path";
import { isValidId } from "@/features/common/odata-filter";
import { logWarn } from "@/features/common/services/logger";
import { ownsThread } from "../image-access";
import type { BlobSessionFs } from "./blob-session-fs";
import { IMAGES_DIR, OUTPUTS_DIR } from "./provider-tools";
import { resolveAgentRuntimeForCurrentUser } from "./runtime-selection";
import { workspaceFileUrl } from "./workspace-file-url";
import { threadWorkspace } from "./workspace-files";

const OUTPUT_DIRS = [OUTPUTS_DIR, IMAGES_DIR] as const;

/**
 * Where a file named `name` is under /workspace/outputs or /workspace/images:
 * <dir>/<name> first, else the first file with that name in a subfolder
 * (path order). Undefined when there is none.
 */
export async function findWorkspaceOutput(
  fs: Pick<BlobSessionFs, "stat" | "listEntries">,
  name: string,
): Promise<string | undefined> {
  if (!isSafeBlobFileName(name)) return undefined;
  for (const dir of OUTPUT_DIRS) {
    const path = `${dir}/${name}`;
    try {
      if ((await fs.stat(path)).isFile) return path;
    } catch {
      // Not there (or a name the path jail refuses): look further.
    }
  }
  for (const dir of OUTPUT_DIRS) {
    const entries = await fs.listEntries(dir).catch(() => []);
    const match = entries
      .map((e) => e.path)
      .filter((p) => p.slice(p.lastIndexOf("/") + 1) === name)
      .sort()[0];
    if (match) return match;
  }
  return undefined;
}

/**
 * The relative /api/workspace/file URL for /api/images?t=`threadId`&img=`name`
 * when `user` owns the thread, is on the Copilot path and the file is in the
 * thread workspace; otherwise undefined. Never throws.
 */
export async function workspaceOutputLocation(
  threadId: string,
  name: string,
  user: UserModel,
): Promise<string | undefined> {
  if (!isValidId(threadId) || !isSafeBlobFileName(name) || !user.email) return undefined;
  try {
    if ((await resolveAgentRuntimeForCurrentUser()) !== "copilot") return undefined;
    // The workspace is per user: never another user's thread, also not for
    // an administrator.
    if (!(await ownsThread(threadId, user))) return undefined;
    const { fs } = await threadWorkspace(hashValue(user.email), threadId);
    const path = await findWorkspaceOutput(fs, name);
    return path ? workspaceFileUrl(threadId, path) : undefined;
  } catch (error) {
    logWarn("images: workspace output lookup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
