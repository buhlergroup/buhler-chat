/**
 * The download URL of one workspace file (Copilot path): GET
 * /api/workspace/file (workspace-file-api.ts) with the thread id and the path
 * relative to /workspace. Relative URL, so it works in chat markdown links.
 * Pure: no server-only imports (provider-tools.ts and the chat renderer use it).
 */
import { SESSION_STATE_ROOT, WORKSPACE_ROOT, workspacePathFromClient } from "./session-path";

export const WORKSPACE_FILE_ROUTE = "/api/workspace/file";

/** `path` is absolute under /workspace, e.g. /workspace/outputs/deck.pptx. */
export function workspaceFileUrl(threadId: string, path: string): string {
  if (!path.startsWith(`${WORKSPACE_ROOT}/`)) throw new Error("Not a workspace path");
  const relative = path.slice(WORKSPACE_ROOT.length + 1);
  return `${WORKSPACE_FILE_ROUTE}?t=${encodeURIComponent(threadId)}&p=${encodeURIComponent(relative)}`;
}

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const isUnder = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * Where a link or image in a chat message points, when the model wrote a
 * path in the chat workspace instead of a download URL. The model writes
 * the paths its file tools use: `/workspace/a.csv`, `sandbox:/workspace/a.csv`,
 * `sandbox:a.csv` (relative to /workspace) or `file:///workspace/a.csv`.
 * A bare relative href (`a.csv`, `www.example.com`) is not read as a
 * workspace path: it may be a mistyped web link.
 *
 * - a string: the download URL of that file in thread `threadId`.
 * - null: a workspace or session-state path the download route refuses
 *   (`..`, /session-state, ...). The caller blocks the link.
 * - undefined: not a workspace path (https:, /api/..., /mnt/data/...,
 *   bare relative hrefs). The markdown sanitizer decides, as before.
 *
 * The thread id comes from the page, never from the link.
 */
export function workspaceLinkTarget(threadId: string, href: string): string | null | undefined {
  let rest = href.trim();
  const scheme = URL_SCHEME.exec(rest)?.[0].toLowerCase();
  if (scheme === "sandbox:" || scheme === "file:") {
    rest = rest.slice(scheme.length);
    // file:///workspace/a.csv has an empty host; any other host is refused.
    if (scheme === "file:" && rest.startsWith("//")) rest = rest.slice(2);
    if (scheme === "file:" && !rest.startsWith("/")) return null;
  } else if (scheme) {
    return undefined;
  } else if (!isUnder(rest, WORKSPACE_ROOT) && !isUnder(rest, SESSION_STATE_ROOT)) {
    // No scheme: only the absolute /workspace and /session-state paths count.
    return undefined;
  }
  if (rest === "" || rest.startsWith("#") || rest.startsWith("?") || rest.startsWith("//")) {
    return null;
  }

  let path: string;
  try {
    path = decodeURIComponent(rest.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  let relative: string;
  if (path.startsWith("/")) {
    if (isUnder(path, SESSION_STATE_ROOT) || path === WORKSPACE_ROOT) return null;
    if (!path.startsWith(`${WORKSPACE_ROOT}/`)) return undefined;
    relative = path.slice(WORKSPACE_ROOT.length + 1);
  } else {
    relative = path.replace(/^(\.\/)+/, "");
  }
  try {
    return workspaceFileUrl(threadId, workspacePathFromClient(relative));
  } catch {
    return null;
  }
}
