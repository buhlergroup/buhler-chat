/**
 * The files of a thread's workspace for the user (Copilot path): the upload
 * chips of the input field, the Files panel, and the removal of one file.
 *
 * Only /workspace is visible here: /session-state (the runtime's own state)
 * is never listed, served or deleted. Paths go to the browser relative to
 * /workspace ("uploads/report.pdf") and come back the same way; every path
 * from the browser goes through the session path jail again.
 *
 * Pure orchestration; the workspace (BlobSessionFs) comes in as a dep.
 */
import type { WorkspaceEntry } from "./blob-session-fs";
import { extractedTextPath, isExtractable } from "./extract-text";
import { normalizeSessionPath, SessionPathError, WORKSPACE_ROOT } from "./session-path";
import { UPLOADS_DIR } from "./workspace-uploads";
import type { WorkspaceFileInfo, WorkspaceListing, WorkspaceSummary } from "../workspace-file-model";

export type { WorkspaceFileInfo, WorkspaceListing, WorkspaceSummary };

export const MAX_LISTED_FILES = 500;
export const MAX_UPLOAD_CHIPS = 100;
/** Entries read from one listing at most (the workspace quota is 2,000 files by default). */
export const MAX_SCANNED_ENTRIES = 10_000;

const PAGE_RANGE = /^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$/;

/**
 * The file `path` is the text extract of (extract_text writes <file>.md and
 * <file>.p<pages>.md next to a PDF / Office file), when that file exists.
 */
export function extractSourceOf(path: string, existing: ReadonlySet<string>): string | undefined {
  if (!path.endsWith(".md")) return undefined;
  const stem = path.slice(0, -".md".length);
  if (isExtractable(stem) && existing.has(stem)) return stem;
  const ranged = /^(.*)\.p([^/]+)$/.exec(stem);
  if (ranged && PAGE_RANGE.test(ranged[2]) && isExtractable(ranged[1]) && existing.has(ranged[1])) {
    return ranged[1];
  }
  return undefined;
}

/** The extracts of `path` among `siblings` (absolute paths): <file>.md and <file>.p<pages>.md. */
export function derivedExtractPaths(path: string, siblings: Iterable<string>): string[] {
  if (!isExtractable(path)) return [];
  const whole = extractedTextPath(path);
  const prefix = `${path}.p`;
  const out: string[] = [];
  for (const s of siblings) {
    if (s === whole) out.push(s);
    else if (s.startsWith(prefix) && s.endsWith(".md") && PAGE_RANGE.test(s.slice(prefix.length, -".md".length))) {
      out.push(s);
    }
  }
  return out;
}

const relative = (absolute: string) => absolute.slice(WORKSPACE_ROOT.length + 1);
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const isDirectUpload = (path: string) =>
  path.startsWith(`${UPLOADS_DIR}/`) && !path.slice(UPLOADS_DIR.length + 1).includes("/");

function toInfo(entry: WorkspaceEntry, existing: ReadonlySet<string>): WorkspaceFileInfo {
  const uploaded = isDirectUpload(entry.path) && !extractSourceOf(entry.path, existing);
  return {
    path: relative(entry.path),
    name: baseName(entry.path),
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    modified: entry.lastModified.toISOString(),
    group: uploaded ? "uploaded" : "created",
  };
}

const newestFirst = (a: WorkspaceFileInfo, b: WorkspaceFileInfo) =>
  b.modified.localeCompare(a.modified) || a.path.localeCompare(b.path);

export interface ListingDeps {
  fs: { listEntryPages(dir: string, literalPrefix?: string): AsyncIterable<WorkspaceEntry[]> };
}

/** Every file under /workspace (recursive), at most MAX_SCANNED_ENTRIES, as browser entries. */
async function scanWorkspace(deps: ListingDeps): Promise<{ files: WorkspaceFileInfo[]; scanTruncated: boolean }> {
  const entries: WorkspaceEntry[] = [];
  let scanTruncated = false;
  for await (const page of deps.fs.listEntryPages(WORKSPACE_ROOT)) {
    for (const entry of page) {
      // listEntryPages stays inside /workspace; this keeps it so if it ever changes.
      if (!entry.path.startsWith(`${WORKSPACE_ROOT}/`)) continue;
      if (entries.length >= MAX_SCANNED_ENTRIES) {
        scanTruncated = true;
        break;
      }
      entries.push(entry);
    }
    if (scanTruncated) break;
  }
  const existing = new Set(entries.map((e) => e.path));
  return { files: entries.map((e) => toInfo(e, existing)), scanTruncated };
}

/** The Files panel: every file under /workspace, newest first, at most `limit`. */
export async function listWorkspaceFiles(deps: ListingDeps, limit = MAX_LISTED_FILES): Promise<WorkspaceListing> {
  const { files, scanTruncated } = await scanWorkspace(deps);
  files.sort(newestFirst);
  return {
    files: files.slice(0, limit),
    total: files.length,
    truncated: scanTruncated || files.length > limit,
  };
}

/** The chat page: the user's uploads (newest first, at most `limit`) and the file count. */
export async function summarizeWorkspace(deps: ListingDeps, limit = MAX_UPLOAD_CHIPS): Promise<WorkspaceSummary> {
  const { files } = await scanWorkspace(deps);
  const uploads = files.filter((f) => f.group === "uploaded").sort(newestFirst).slice(0, limit);
  return { uploads, fileCount: files.length };
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
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

export interface RemoveDeps {
  fs: {
    viewTarget(path: string): Promise<{ kind: "file" } | { kind: "directory" } | undefined>;
    listEntries(dir: string, literalPrefix?: string): Promise<WorkspaceEntry[]>;
    rm(path: string, recursive: boolean, force: boolean): Promise<void>;
  };
  /**
   * Deletes the search index entries of these files (paths relative to
   * /workspace), before the files go. Throws when it cannot: the files are
   * kept then.
   */
  removeIndexEntries?(paths: string[]): Promise<unknown>;
}

/** Thrown when the file to remove does not exist (or is a folder). */
export class WorkspaceFileNotFoundError extends Error {
  constructor() {
    super("File not found");
    this.name = "WorkspaceFileNotFoundError";
  }
}

/**
 * Removes one file under /workspace (never a folder) and, for a PDF / Office
 * file, its text extracts next to it (<file>.md, <file>.p<pages>.md), and
 * the search index entries of them (index_document). Index first: when that
 * fails nothing is deleted. Returns the removed paths relative to /workspace.
 */
export async function removeWorkspaceFile(deps: RemoveDeps, rawPath: unknown): Promise<string[]> {
  const path = workspacePathFromClient(rawPath);
  const target = await deps.fs.viewTarget(path);
  if (target?.kind !== "file") throw new WorkspaceFileNotFoundError();
  const removed = [path];
  if (isExtractable(path)) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    const name = baseName(path);
    // The listing refuses a prefix with "..": list the folder then.
    const siblings = (await deps.fs.listEntries(dir, name.includes("..") ? "" : `${name}.`))
      .map((e) => e.path)
      .filter((p) => p.slice(dir.length + 1).indexOf("/") === -1);
    removed.push(...derivedExtractPaths(path, siblings));
  }
  await deps.removeIndexEntries?.(removed.map(relative));
  for (const p of removed) await deps.fs.rm(p, false, true);
  return removed.map(relative);
}
