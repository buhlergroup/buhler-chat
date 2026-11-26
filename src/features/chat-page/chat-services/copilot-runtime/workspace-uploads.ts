/**
 * Chat uploads into the agent workspace (Copilot path).
 *
 * An uploaded file lands at /workspace/uploads/<name> in the thread's Blob
 * namespace, through BlobSessionFs (same path jail as the runtime). The
 * upload only stores the file: no text extraction (the agent calls
 * extract_text) and no AI Search indexing (index_document). A name that is
 * taken gets a " (2)" suffix; for PDF/Office documents the name of the text
 * file extract_text writes (<name>.md) is kept free too.
 *
 * Pure orchestration; Blob access comes in as a dep.
 */
import type { WorkspaceEntry } from "./blob-session-fs";
import { DIR_MARKER_NAME } from "./session-path";

export const UPLOADS_DIR = "/workspace/uploads";
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Largest workspace upload in bytes (MAX_UPLOAD_DOCUMENT_SIZE, default 10 MB;
 * a file must be smaller). extract_text uses the same limit.
 */
export function maxWorkspaceUploadBytes(env: Record<string, string | undefined> = process.env): number {
  const configured = Number(env.MAX_UPLOAD_DOCUMENT_SIZE);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_BYTES;
}

/** Extensions Document Intelligence extracts text from (images go as images). */
const DOCUMENT_EXTENSIONS = new Set(["pdf", "docx", "xlsx", "pptx"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "heif", "heic"]);
const TEXT_EXTENSIONS = new Set([
  "txt", "log", "csv", "md", "rtf", "html", "htm", "css", "js", "ts", "json", "xml", "yml", "yaml",
  "php", "py", "java", "c", "cpp", "cs", "go", "rs", "sql", "sh", "ps1", "ini", "toml",
]);

export type UploadKind = "document" | "image" | "text" | "binary";

export function uploadKind(name: string): UploadKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "binary";
}

const MAX_NAME_CHARS = 120;

/**
 * A safe file name for the uploads folder: the last path segment only, no
 * control or reserved characters, no leading dots, at most 120 characters
 * (the extension is kept).
 */
export function sanitizeUploadName(raw: string): string {
  const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  let name = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (name === "" || name === ".." || name === DIR_MARKER_NAME) name = "file";
  if (name.length > MAX_NAME_CHARS) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, MAX_NAME_CHARS - ext.length) + ext;
  }
  return name;
}

/** "a.pdf" -> "a (2).pdf", "a (3).pdf", ... until neither the name nor its .md companion is taken. */
export function uniqueUploadName(name: string, taken: ReadonlySet<string>, withCompanion: boolean): string {
  const free = (n: string) => !taken.has(n) && (!withCompanion || !taken.has(`${n}.md`));
  if (free(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (free(candidate)) return candidate;
  }
}

export interface UploadDeps {
  /** The thread's workspace (BlobSessionFs). */
  fs: {
    listEntries(dir: string, literalPrefix?: string): Promise<WorkspaceEntry[]>;
    writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  };
}

export interface StoredUpload {
  path: string;
  kind: UploadKind;
  bytes: number;
}

export async function storeUpload(
  deps: UploadDeps,
  rawName: string,
  data: Buffer,
  dir: string = UPLOADS_DIR,
): Promise<StoredUpload> {
  const name = sanitizeUploadName(rawName);
  const kind = uploadKind(name);
  const entries = await deps.fs.listEntries(dir);
  const taken = new Set(entries.map((e) => e.path.slice(dir.length + 1)));
  const finalName = uniqueUploadName(name, taken, kind === "document");
  const path = `${dir}/${finalName}`;
  await deps.fs.writeFileBytes(path, data);
  return { path, kind, bytes: data.length };
}

/** How the model reads uploads: they are stored, not indexed. */
export const UPLOADS_RULE =
  "Uploaded files are stored, not indexed. Read them with extract_text (PDF and Office files; use pages for a long file), " +
  "view or rg (text files). Use index_document only when you need search over a long document; " +
  "search_documents only finds indexed documents.";

/** Uploads the per-turn note names: the newest ones. */
export const MAX_NOTED_UPLOADS = 20;

/**
 * The note for the model: which files are in the uploads folder (newest
 * first, bounded) and how to read them. Undefined when there are none.
 */
export function uploadsNote(entries: WorkspaceEntry[], max = MAX_NOTED_UPLOADS): string | undefined {
  if (entries.length === 0) return undefined;
  const paths = [...entries]
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime() || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => e.path);
  const shown = paths.slice(0, max);
  const more = paths.length > shown.length ? ` (+${paths.length - shown.length} older, list ${UPLOADS_DIR} to see them)` : "";
  return `Files the user uploaded to this chat: ${shown.join(", ")}${more}\n${UPLOADS_RULE}`;
}
