/**
 * The download URL of one workspace file (Copilot path): GET
 * /api/workspace/file (workspace-file-api.ts) with the thread id and the path
 * relative to /workspace. Relative URL, so it works in chat markdown links.
 * Pure: no server-only imports (provider-tools.ts uses it).
 */
import { WORKSPACE_ROOT } from "./session-path";

export const WORKSPACE_FILE_ROUTE = "/api/workspace/file";

/** `path` is absolute under /workspace, e.g. /workspace/outputs/deck.pptx. */
export function workspaceFileUrl(threadId: string, path: string): string {
  if (!path.startsWith(`${WORKSPACE_ROOT}/`)) throw new Error("Not a workspace path");
  const relative = path.slice(WORKSPACE_ROOT.length + 1);
  return `${WORKSPACE_FILE_ROUTE}?t=${encodeURIComponent(threadId)}&p=${encodeURIComponent(relative)}`;
}
