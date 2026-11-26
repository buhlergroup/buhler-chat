/**
 * Chat uploads into the agent workspace (Copilot path).
 *
 * An uploaded file lands at /workspace/uploads/<name> in the thread's Blob
 * namespace, through BlobSessionFs (same path jail as the runtime). For
 * PDF/Office documents the extracted text is stored next to it as
 * <name>.md, so `rg` and `view` work on it. A name that is taken gets a
 * " (2)" suffix. No AI Search indexing here: the agent indexes on request
 * with index_document.
 *
 * Pure orchestration; Blob access and text extraction come in as deps
 * (document-pipeline.ts in production).
 */
import type { WorkspaceEntry } from "./blob-session-fs";
import { DIR_MARKER_NAME } from "./session-path";

export const UPLOADS_DIR = "/workspace/uploads";
const LF = String.fromCharCode(10);

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
  /** Text of a document as Markdown (document-pipeline.ts). */
  extractMarkdown(data: Buffer, name: string): Promise<string>;
}

export interface StoredUpload {
  path: string;
  /** The extracted text, for documents. */
  markdownPath?: string;
  kind: UploadKind;
  bytes: number;
}

/** Paragraphs from Document Intelligence as Markdown text. */
export const paragraphsToMarkdown = (paragraphs: string[]): string =>
  paragraphs.map((p) => p.trim()).filter((p) => p.length > 0).join(LF + LF) + LF;

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
  if (kind !== "document") return { path, kind, bytes: data.length };

  const markdownPath = `${path}.md`;
  const markdown = await deps.extractMarkdown(data, finalName);
  await deps.fs.writeFileBytes(markdownPath, Buffer.from(markdown, "utf8"));
  return { path, markdownPath, kind, bytes: data.length };
}

/** One line for the model: which files are in the uploads folder. */
export function uploadsNote(entries: WorkspaceEntry[], max = 50): string | undefined {
  const paths = entries.map((e) => e.path).sort();
  if (paths.length === 0) return undefined;
  const shown = paths.slice(0, max);
  const more = paths.length > shown.length ? ` (+${paths.length - shown.length} more)` : "";
  return `Files the user uploaded to this chat (read them with view or rg; a .md next to a document is its extracted text): ${shown.join(", ")}${more}`;
}
