/**
 * `extract_text` (Copilot path only): the text of a PDF or Office file in the
 * workspace, on request. Uploads only store the file; this tool runs
 * Document Intelligence ("prebuilt-read") and writes the text next to the
 * file as <file>.md, or <file>.p<pages>.md for a page range. The result is
 * cached in the content store per content hash and page range, so the same
 * file is extracted once. index_document calls the same code when the .md is
 * missing.
 *
 * Pure orchestration; the workspace and the extraction come in as deps
 * (document-pipeline.ts in production).
 */
import { tool } from "ai";
import { z } from "zod";
import { WorkspaceQuotaError, type WorkspaceEntry } from "./blob-session-fs";
import { normalizeSessionPath, WORKSPACE_ROOT } from "./session-path";
import { uploadKind } from "./workspace-uploads";

export interface ExtractedText {
  text: string;
  /** True when the text came from the cache (no Document Intelligence call). */
  cached: boolean;
  /** Pages Document Intelligence analysed; only known when it ran now. */
  pageCount?: number;
}

export interface ExtractTextDeps {
  fs: {
    listEntries(dir: string, literalPrefix?: string): Promise<WorkspaceEntry[]>;
    readEntry(entry: WorkspaceEntry): Promise<Buffer>;
    writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  };
  /** Document Intelligence through the content store cache (document-pipeline.ts). */
  extract(data: Buffer, pages?: string): Promise<ExtractedText>;
  /** Largest file it extracts, in bytes (the upload limit). */
  maxBytes: number;
}

export type ExtractTextResult =
  | {
      status: "extracted";
      path: string;
      source: string;
      pages?: string;
      pageCount?: number;
      characters: number;
      cached: boolean;
    }
  | { status: "not-needed"; path: string; message: string }
  | { status: "error"; path: string; error: string };

const MAX_PAGE_RANGE_CHARS = 100;
const MAX_PAGE_NUMBER = 100_000;

/**
 * Validates a page range in Document Intelligence syntax ("1-20",
 * "1,3,5-7") and returns it without spaces. Throws on anything else: page
 * numbers start at 1, a range runs upwards, at most 100 characters.
 */
export function parsePageRange(raw: string): string {
  const range = String(raw ?? "").replace(/\s+/g, "");
  if (range.length === 0 || range.length > MAX_PAGE_RANGE_CHARS) {
    throw new Error(`pages must be a page range such as "1-20" or "1,3,5-7".`);
  }
  if (!/^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$/.test(range)) {
    throw new Error(`Invalid pages "${raw}": use page numbers and ranges such as "1-20" or "1,3,5-7".`);
  }
  const parts = range.split(",");
  for (const part of parts) {
    const [from, to = from] = part.split("-").map(Number);
    if (from < 1 || to > MAX_PAGE_NUMBER) {
      throw new Error(`Invalid pages "${raw}": page numbers run from 1 to ${MAX_PAGE_NUMBER}.`);
    }
    if (to < from) throw new Error(`Invalid pages "${raw}": a range must run upwards (e.g. 5-7).`);
  }
  return parts.map((p) => p.split("-").map((n) => String(Number(n))).join("-")).join(",");
}

const isText = (data: Buffer) => !data.subarray(0, 8192).includes(0);

async function findEntry(fs: ExtractTextDeps["fs"], path: string): Promise<WorkspaceEntry | undefined> {
  const slash = path.lastIndexOf("/");
  return (await fs.listEntries(path.slice(0, slash), path.slice(slash + 1))).find((e) => e.path === path);
}

const mb = (bytes: number) => `${Math.round(bytes / 104857.6) / 10} MB`;

/** Path of the text file extract_text writes for `path` (and a page range). */
export const extractedTextPath = (path: string, pages?: string): string =>
  pages ? `${path}.p${pages}.md` : `${path}.md`;

/** True when extract_text runs Document Intelligence on this file (PDF / Office, by extension). */
export const isExtractable = (path: string): boolean => uploadKind(path) === "document";

const NOT_NEEDED = "This is a text file: no extraction needed. Read it with view or rg.";

export async function extractWorkspaceText(
  deps: ExtractTextDeps,
  rawPath: string,
  rawPages?: string,
): Promise<ExtractTextResult> {
  let path: string;
  try {
    path = normalizeSessionPath(rawPath);
  } catch (err) {
    return { path: rawPath, status: "error", error: (err as Error).message };
  }
  if (!path.startsWith(`${WORKSPACE_ROOT}/`)) {
    return { path, status: "error", error: "Only files in /workspace can be read." };
  }
  let pages: string | undefined;
  if (rawPages !== undefined && String(rawPages).trim() !== "") {
    try {
      pages = parsePageRange(rawPages);
    } catch (err) {
      return { path, status: "error", error: (err as Error).message };
    }
  }

  const entry = await findEntry(deps.fs, path);
  if (!entry) return { path, status: "error", error: "File not found." };

  if (!isExtractable(path)) {
    const kind = uploadKind(path);
    if (kind === "text") return { path, status: "not-needed", message: NOT_NEEDED };
    // Unknown extension: text content needs no extraction either.
    if (kind === "binary" && (entry.size ?? 0) < deps.maxBytes && isText(await deps.fs.readEntry(entry))) {
      return { path, status: "not-needed", message: NOT_NEEDED };
    }
    return { path, status: "error", error: "extract_text reads PDF, Word, Excel and PowerPoint files only." };
  }

  const tooLarge = `The file is too large to extract (limit ${mb(deps.maxBytes)}).`;
  if (entry.size !== undefined && entry.size >= deps.maxBytes) return { path, status: "error", error: tooLarge };
  const data = await deps.fs.readEntry(entry);
  if (data.length >= deps.maxBytes) return { path, status: "error", error: tooLarge };

  let extracted: ExtractedText;
  try {
    extracted = await deps.extract(data, pages);
  } catch (err) {
    return { path, status: "error", error: `Text extraction failed: ${(err as Error).message}` };
  }

  const out = extractedTextPath(path, pages);
  try {
    await deps.fs.writeFileBytes(out, Buffer.from(extracted.text, "utf8"));
  } catch (err) {
    // A quota error carries a message for the model; other storage errors stay generic.
    const error = err instanceof WorkspaceQuotaError ? err.message : "The text could not be written to the workspace.";
    return { path, status: "error", error };
  }
  return {
    status: "extracted",
    path: out,
    source: path,
    ...(pages ? { pages } : {}),
    ...(extracted.pageCount !== undefined ? { pageCount: extracted.pageCount } : {}),
    characters: extracted.text.length,
    cached: extracted.cached,
  };
}

export const EXTRACT_TEXT_DESCRIPTION =
  "Extract the text of a PDF, Word, Excel or PowerPoint file in the workspace (OCR included). " +
  "Writes it to <file>.md (with pages: <file>.p<pages>.md); then read that file with view or rg. " +
  'For a large document, pass pages (e.g. "1-20" or "1,3,5-7") and continue with the next range when needed. ' +
  "Text files need no extraction. Returns the output path, page count and character count.";

export function extractTextTool(deps: ExtractTextDeps) {
  return tool({
    description: EXTRACT_TEXT_DESCRIPTION,
    inputSchema: z.object({
      path: z.string().max(500).describe("Workspace path, e.g. /workspace/uploads/report.pdf"),
      pages: z
        .string()
        .max(MAX_PAGE_RANGE_CHARS)
        .optional()
        .describe('Page range, e.g. "1-20" or "1,3,5-7". Omit for the whole document.'),
    }),
    execute: async ({ path, pages }: { path: string; pages?: string }) => extractWorkspaceText(deps, path, pages),
  });
}
