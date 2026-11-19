import "server-only";

/**
 * What the model may do with the SharePoint sources of an agent during ONE
 * chat request: list the files inside them and fetch single files into the
 * code interpreter. One SharePointFileSession per request (the listing and
 * the fetch counter live here).
 *
 * Security rules (tool arguments are model output, so untrusted):
 *   - Graph is called with the chatting user's delegated token only; the
 *     drive id always comes from a stored source, never from the model.
 *   - A file may be fetched only when it is a linked file, or a descendant
 *     of a linked folder (at most SHAREPOINT_FILE_RULES.maxDepth levels
 *     down). That is proven with Graph: the file was enumerated from the
 *     linked folder downwards in this request, or its parent chain, read
 *     from Graph, reaches the linked folder in the same drive.
 *   - 401/403/404 from SharePoint means "not available for you". There is no
 *     cached copy to fall back to.
 *   - Item ids are validated before they go into a Graph URL.
 */

import { logInfo, logWarn } from "@/features/common/services/logger";
import {
  FileTooLargeError,
  GraphFileError,
  downloadDriveItem,
  getDriveItemInfo,
  isFileAccessDenied,
  listDriveItemChildren,
  type DriveItemInfo,
} from "@/features/common/services/sharepoint/graph-drive";
import { isGraphItemId } from "@/features/common/services/sharepoint/graph-ids";
import { fileTypeRule, type PersonaFileSourceModel } from "./sharepoint-file-models";
import { SHAREPOINT_FILE_RULES, type SharePointFileLimits } from "./sharepoint-file-limits";
import { FileConversionError, prepareFileForCodeInterpreter } from "./sharepoint-file-convert";

export interface ListedFile {
  id: string;
  name: string;
  /** Path below the linked folder ("sub/photo.jpg"); the name for a linked file. */
  relativePath: string;
  size: number;
  lastModifiedDateTime: string;
  source: PersonaFileSourceModel;
}

export interface SourceListing {
  files: ListedFile[];
  /** Per-source problems, for the model ("not available for you"). */
  problems: string[];
  truncated: boolean;
}

export interface SharePointFileSessionDeps {
  sources: PersonaFileSourceModel[];
  accessToken: string;
  limits: SharePointFileLimits;
  /** The container of this turn's code interpreter (read at call time). */
  getContainerId: () => string | undefined;
  /** Puts a file into the container; returns its path there. */
  uploadToContainer: (
    containerId: string,
    fileName: string,
    data: Buffer,
  ) => Promise<{ path: string }>;
  threadId?: string;
}

export const NOT_AVAILABLE_MESSAGE =
  "This file is not available for you in SharePoint (no access, or it was moved or deleted).";
export const OUTSIDE_SOURCES_MESSAGE =
  "This file is not in the SharePoint folders or files of this agent.";
const NO_ANSWER_MESSAGE = "SharePoint did not answer. Try again.";

const MAX_QUERY_CHARS = 200;
const MAX_NAME_CHARS = 400;

const sourceLabel = (s: PersonaFileSourceModel) => `${s.kind} "${s.name}"`;

/** One file entry as the model sees it. */
const describe = (f: ListedFile) => ({
  id: f.id,
  name: f.name,
  path: f.relativePath,
  source: f.source.name,
  size: f.size,
  lastModified: f.lastModifiedDateTime,
});

/** A file name that is safe as a single path segment in the container. */
export const containerFileName = (name: string): string => {
  const clean = name
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .replace(/^\.+/, "_")
    .trim();
  return (clean || "file").slice(0, 200);
};

const graphProblem = (error: unknown): string =>
  isFileAccessDenied(error) ? NOT_AVAILABLE_MESSAGE : NO_ANSWER_MESSAGE;

export class SharePointFileSession {
  private listing?: Promise<SourceListing>;
  /** Files proven to be inside a source, key `${driveId}|${itemId}`. */
  private readonly verified = new Map<string, ListedFile>();
  private downloads = 0;

  constructor(private readonly deps: SharePointFileSessionDeps) {}

  get sources(): PersonaFileSourceModel[] {
    return this.deps.sources;
  }

  get downloadCount(): number {
    return this.downloads;
  }

  private remember(file: ListedFile): void {
    this.verified.set(`${file.source.driveId}|${file.id}`, file);
  }

  // ── listing ──────────────────────────────────────────────────────────────

  /** All files in all sources, once per request. */
  listAll(): Promise<SourceListing> {
    this.listing ??= this.buildListing();
    return this.listing;
  }

  private async buildListing(): Promise<SourceListing> {
    const results = await Promise.all(this.deps.sources.map((s) => this.listSource(s)));
    const files: ListedFile[] = [];
    const problems: string[] = [];
    let truncated = false;
    for (const r of results) {
      problems.push(...r.problems);
      truncated ||= r.truncated;
      for (const f of r.files) {
        if (files.length >= SHAREPOINT_FILE_RULES.maxListedFiles) {
          truncated = true;
          break;
        }
        files.push(f);
        this.remember(f);
      }
    }
    return { files, problems, truncated };
  }

  private async listSource(source: PersonaFileSourceModel): Promise<SourceListing> {
    const { accessToken } = this.deps;
    if (source.kind === "file") {
      try {
        const info = await getDriveItemInfo(accessToken, source.driveId, source.itemId);
        if (!info.isFile || (info.parent && info.parent.driveId !== source.driveId)) {
          return { files: [], problems: [`${sourceLabel(source)}: not a file.`], truncated: false };
        }
        return {
          files: [toListed(info, info.name, source)],
          problems: [],
          truncated: false,
        };
      } catch (error) {
        return { files: [], problems: [`${sourceLabel(source)}: ${graphProblem(error)}`], truncated: false };
      }
    }

    const files: ListedFile[] = [];
    const problems: string[] = [];
    let truncated = false;
    const queue: { folderId: string; prefix: string; depth: number }[] = [
      { folderId: source.itemId, prefix: "", depth: 1 },
    ];
    let foldersRead = 0;
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (foldersRead >= SHAREPOINT_FILE_RULES.maxFoldersPerSource) {
        truncated = true;
        break;
      }
      foldersRead++;
      let children: DriveItemInfo[];
      try {
        const res = await listDriveItemChildren(accessToken, source.driveId, next.folderId);
        children = res.items;
        truncated ||= res.truncated;
      } catch (error) {
        problems.push(
          next.depth === 1
            ? `${sourceLabel(source)}: ${graphProblem(error)}`
            : `${sourceLabel(source)}, folder "${next.prefix}": ${graphProblem(error)}`,
        );
        continue;
      }
      for (const child of children) {
        // Defensive: Graph lists children of a folder in the same drive.
        if (child.parent && child.parent.driveId !== source.driveId) continue;
        if (child.isFolder) {
          if (next.depth < SHAREPOINT_FILE_RULES.maxDepth) {
            queue.push({
              folderId: child.id,
              prefix: `${next.prefix}${child.name}/`,
              depth: next.depth + 1,
            });
          }
        } else if (child.isFile) {
          files.push(toListed(child, `${next.prefix}${child.name}`, source));
        }
      }
    }
    return { files, problems, truncated };
  }

  // ── find ─────────────────────────────────────────────────────────────────

  async find(args: { query?: unknown; path?: unknown }) {
    const query = typeof args?.query === "string" ? args.query.trim().slice(0, MAX_QUERY_CHARS) : "";
    const path =
      typeof args?.path === "string"
        ? args.path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").slice(0, MAX_QUERY_CHARS)
        : "";
    const listing = await this.listAll();
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const pathLower = path.toLowerCase();
    const matches = listing.files.filter((f) => {
      const rel = f.relativePath.toLowerCase();
      if (pathLower && !(rel.startsWith(`${pathLower}/`) || rel === pathLower)) return false;
      return tokens.every((t) => rel.includes(t));
    });
    matches.sort((a, b) =>
      a.source.name === b.source.name
        ? a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
        : a.source.name < b.source.name ? -1 : 1,
    );
    const max = SHAREPOINT_FILE_RULES.maxFindResults;
    return {
      files: matches.slice(0, max).map(describe),
      total: matches.length,
      ...(matches.length > max
        ? { note: `Only the first ${max} of ${matches.length} files are listed. Narrow the query or path.` }
        : {}),
      ...(listing.truncated
        ? { listingTruncated: "Not all files could be listed (too many files or folders)." }
        : {}),
      ...(listing.problems.length > 0 ? { problems: listing.problems } : {}),
    };
  }

  // ── resolve ──────────────────────────────────────────────────────────────

  /**
   * Resolves a model-supplied item id to a file inside a source. Files from
   * this request's listing are already proven; any other id is read from
   * Graph in each source drive and its parent chain must reach a linked
   * folder of that drive within maxDepth levels.
   */
  async resolveById(
    itemId: string,
  ): Promise<{ ok: true; file: ListedFile } | { ok: false; error: string }> {
    if (!isGraphItemId(itemId)) return { ok: false, error: "Invalid file id." };
    for (const [key, file] of this.verified) {
      if (key.endsWith(`|${itemId}`)) return { ok: true, file };
    }

    const drives = [...new Set(this.deps.sources.map((s) => s.driveId))];
    let denied = false;
    let transient = false;
    for (const driveId of drives) {
      const inDrive = this.deps.sources.filter((s) => s.driveId === driveId);
      let info: DriveItemInfo;
      try {
        info = await getDriveItemInfo(this.deps.accessToken, driveId, itemId);
      } catch (error) {
        if (error instanceof GraphFileError && error.status === 404) continue;
        if (isFileAccessDenied(error)) denied = true;
        else if (error instanceof GraphFileError && error.status === 400) continue;
        else transient = true;
        continue;
      }
      // The item must be in the drive of the source (Graph's answer).
      if (!info.parent || info.parent.driveId !== driveId) continue;

      const fileSource = inDrive.find((s) => s.kind === "file" && s.itemId === info.id);
      if (fileSource) {
        if (!info.isFile) return { ok: false, error: "This is not a file." };
        const file = toListed(info, info.name, fileSource);
        this.remember(file);
        return { ok: true, file };
      }

      const folders = new Map(
        inDrive.filter((s) => s.kind === "folder").map((s) => [s.itemId, s] as const),
      );
      if (folders.size === 0) continue;
      const names = [info.name];
      let parentId = info.parent.id;
      for (let level = 1; level <= SHAREPOINT_FILE_RULES.maxDepth && parentId; level++) {
        const source = folders.get(parentId);
        if (source) {
          if (!info.isFile) return { ok: false, error: "This is a folder. Fetch single files." };
          const file = toListed(info, [...names].reverse().join("/"), source);
          this.remember(file);
          return { ok: true, file };
        }
        if (level === SHAREPOINT_FILE_RULES.maxDepth) break;
        let parent: DriveItemInfo;
        try {
          parent = await getDriveItemInfo(this.deps.accessToken, driveId, parentId);
        } catch (error) {
          if (isFileAccessDenied(error)) denied = true;
          else transient = true;
          break;
        }
        if (!parent.parent || parent.parent.driveId !== driveId) break;
        names.push(parent.name);
        parentId = parent.parent.id;
      }
    }
    if (transient) return { ok: false, error: NO_ANSWER_MESSAGE };
    if (denied) return { ok: false, error: NOT_AVAILABLE_MESSAGE };
    return { ok: false, error: OUTSIDE_SOURCES_MESSAGE };
  }

  /**
   * Resolves an exact file name (or relative path) inside the sources. Must
   * be unique; otherwise the candidates are returned.
   */
  async resolveByName(
    name: string,
  ): Promise<
    | { ok: true; file: ListedFile }
    | { ok: false; error: string; candidates?: ReturnType<typeof describe>[] }
  > {
    const wanted = name.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!wanted) return { ok: false, error: "Give a file name or an id." };
    const listing = await this.listAll();
    const byPath = wanted.includes("/");
    const key = (f: ListedFile) => (byPath ? f.relativePath : f.name);
    let hits = listing.files.filter((f) => key(f) === wanted);
    if (hits.length === 0) {
      const lower = wanted.toLowerCase();
      hits = listing.files.filter((f) => key(f).toLowerCase() === lower);
    }
    if (hits.length === 1) return { ok: true, file: hits[0] };
    if (hits.length > 1) {
      return {
        ok: false,
        error: `${hits.length} files are named "${wanted}". Fetch one of them by id.`,
        candidates: hits.slice(0, SHAREPOINT_FILE_RULES.maxFindResults).map(describe),
      };
    }
    const problems = listing.problems.length > 0 ? ` Problems: ${listing.problems.join(" ")}` : "";
    return {
      ok: false,
      error: `No file named "${wanted}" in the SharePoint folders of this agent. Use find_sharepoint_files.${problems}`,
    };
  }

  // ── fetch ────────────────────────────────────────────────────────────────

  async fetch(args: { id?: unknown; name?: unknown }) {
    const id = typeof args?.id === "string" && args.id.trim() ? args.id.trim() : undefined;
    const name =
      typeof args?.name === "string" && args.name.trim()
        ? args.name.trim().slice(0, MAX_NAME_CHARS)
        : undefined;
    if (!id && !name) return { error: "Give the file id or the exact file name." };

    const { limits } = this.deps;
    if (this.downloads >= limits.maxFetchesPerRequest) {
      return {
        error: `The limit of ${limits.maxFetchesPerRequest} SharePoint files per message is reached. Use the files you have, or ask the user to continue in a new message.`,
      };
    }

    const resolved = id ? await this.resolveById(id) : await this.resolveByName(name!);
    if (!resolved.ok) {
      return {
        error: resolved.error,
        ...("candidates" in resolved && resolved.candidates ? { candidates: resolved.candidates } : {}),
      };
    }
    const file = resolved.file;

    const rule = fileTypeRule(file.name);
    if (rule.kind === "refused") return { error: rule.message, name: file.name };
    if (file.size > limits.maxFileBytes) {
      return {
        error: `The file is larger than ${limits.maxFileBytes / 1_000_000} MB and cannot be fetched.`,
        name: file.name,
      };
    }

    const containerId = this.deps.getContainerId();
    if (!containerId) {
      return {
        error:
          "The code interpreter is not ready in this message. Answer without the file, or try again in the next message.",
      };
    }

    this.downloads++;
    let data: Buffer;
    try {
      data = await downloadDriveItem(
        this.deps.accessToken,
        file.source.driveId,
        file.id,
        limits.maxFileBytes,
      );
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        return {
          error: `The file is larger than ${limits.maxFileBytes / 1_000_000} MB and cannot be fetched.`,
          name: file.name,
        };
      }
      logWarn("fetch_sharepoint_file: download failed", {
        threadId: this.deps.threadId,
        status: error instanceof GraphFileError ? error.status : undefined,
      });
      return { error: graphProblem(error), name: file.name };
    }

    let prepared;
    try {
      prepared = await prepareFileForCodeInterpreter(containerFileName(file.name), data, {
        imageMaxPx: limits.imageMaxPx,
      });
    } catch (error) {
      if (error instanceof FileConversionError) return { error: error.message, name: file.name };
      throw error;
    }

    try {
      const { path } = await this.deps.uploadToContainer(containerId, prepared.name, prepared.data);
      logInfo("fetch_sharepoint_file: file in the code interpreter", {
        threadId: this.deps.threadId,
        bytes: prepared.data.length,
        converted: Boolean(prepared.note),
        fetches: this.downloads,
      });
      return {
        path,
        name: prepared.name,
        sourcePath: file.relativePath,
        bytes: prepared.data.length,
        ...(prepared.width && prepared.height
          ? { width: prepared.width, height: prepared.height }
          : {}),
        ...(prepared.note ? { note: prepared.note } : {}),
        fetchesLeft: limits.maxFetchesPerRequest - this.downloads,
      };
    } catch (error) {
      logWarn("fetch_sharepoint_file: upload to the code interpreter failed", {
        threadId: this.deps.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { error: "The file could not be put into the code interpreter. Try again." };
    }
  }
}

function toListed(
  info: DriveItemInfo,
  relativePath: string,
  source: PersonaFileSourceModel,
): ListedFile {
  return {
    id: info.id,
    name: info.name,
    relativePath,
    size: info.size,
    lastModifiedDateTime: info.lastModifiedDateTime,
    source,
  };
}
