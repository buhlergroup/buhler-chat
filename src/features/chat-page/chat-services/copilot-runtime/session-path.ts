/**
 * Path jail for the Copilot runtime's session filesystem.
 *
 * Every file operation of the runtime (its own session state AND the model's
 * file tools: view, create, edit, glob, grep) arrives at our sessionFs
 * provider as a path string. The provider maps it into ONE user/thread
 * namespace in Blob Storage, so this function is the only thing that decides
 * which paths exist for the agent at all. It never touches the server's disk.
 *
 * Rules:
 *   - Back-slashes are read as separators (the runtime sends Windows-style
 *     paths for some of its own files, e.g. `\session-state\workspace.yaml`).
 *   - A relative path is read against the workspace root.
 *   - Any `..` segment is rejected, also when the result would stay inside.
 *   - Drive letters (`C:\...`), UNC paths (`\\host\share`) and every absolute
 *     path outside the two virtual roots are rejected.
 *   - Control characters and the reserved directory-marker name are rejected.
 */

/** Where the model's files live (the session's working directory). */
export const WORKSPACE_ROOT = "/workspace";
/** Where the runtime keeps its own session state (events, workspace.yaml, ...). */
export const SESSION_STATE_ROOT = "/session-state";
/** Name of the marker blob that makes an empty directory exist. */
export const DIR_MARKER_NAME = ".~dir";

const ROOTS = [WORKSPACE_ROOT, SESSION_STATE_ROOT] as const;

/** Thrown for a path the agent may not use. `code` maps to a sessionFs error. */
export class SessionPathError extends Error {
  readonly code = "EACCES";
  constructor(message: string) {
    super(message);
    this.name = "SessionPathError";
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Normalises a runtime path to a canonical posix path inside one of the
 * virtual roots, or throws SessionPathError.
 */
export function normalizeSessionPath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new SessionPathError("Empty path");
  }
  if (CONTROL_CHARS.test(raw)) {
    throw new SessionPathError("Path contains control characters");
  }
  const slashed = raw.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(slashed)) {
    throw new SessionPathError(`Path is outside the agent workspace: ${raw}`);
  }
  if (slashed.startsWith("//")) {
    throw new SessionPathError(`Path is outside the agent workspace: ${raw}`);
  }
  const absolute = slashed.startsWith("/") ? slashed : `${WORKSPACE_ROOT}/${slashed}`;
  const segments = absolute.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) {
    throw new SessionPathError(`Path may not contain "..": ${raw}`);
  }
  if (segments.includes(DIR_MARKER_NAME)) {
    throw new SessionPathError(`Reserved name in path: ${raw}`);
  }
  const normalized = `/${segments.join("/")}`;
  const insideRoot = ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
  if (!insideRoot) {
    throw new SessionPathError(`Path is outside the agent workspace: ${raw}`);
  }
  return normalized;
}

/** True when the path is one of the virtual roots (they always exist). */
export function isRootPath(normalized: string): boolean {
  return (ROOTS as readonly string[]).includes(normalized);
}

/** Parent of a normalised path, or undefined for a root. */
export function parentPath(normalized: string): string | undefined {
  if (isRootPath(normalized)) return undefined;
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? undefined : normalized.slice(0, idx);
}

const MAX_PATH_CHARS = 1024;

/**
 * A workspace path from the browser (relative to /workspace) as an absolute
 * path under /workspace, or a SessionPathError. Refused: empty, absolute,
 * backslashes, control characters, "." / ".." / empty segments, /workspace
 * itself, and anything the session path jail refuses.
 */
export function workspacePathFromClient(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PATH_CHARS) {
    throw new SessionPathError("Invalid file path");
  }
  if (raw.startsWith("/") || raw.includes("\\") || CONTROL_CHARS.test(raw)) {
    throw new SessionPathError("Invalid file path");
  }
  if (raw.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new SessionPathError("Invalid file path");
  }
  const absolute = normalizeSessionPath(`${WORKSPACE_ROOT}/${raw}`);
  if (!absolute.startsWith(`${WORKSPACE_ROOT}/`)) throw new SessionPathError("Invalid file path");
  return absolute;
}

const NAMESPACE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,199}$/;

/**
 * Builds the blob namespace `{userKey}/{threadId}` and validates both parts,
 * so a crafted id can never point into another user's prefix.
 */
export function buildNamespace(userKey: string, threadId: string): string {
  for (const part of [userKey, threadId]) {
    if (!NAMESPACE_SEGMENT.test(part) || part.includes("..")) {
      throw new SessionPathError("Invalid namespace segment");
    }
  }
  return `${userKey}/${threadId}`;
}
