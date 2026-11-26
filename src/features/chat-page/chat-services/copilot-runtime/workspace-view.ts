/**
 * `view` for the agent workspace, streamed from the Blob session filesystem,
 * with the runtime's own name, description, schema and output.
 *
 * Why: the built-in view of runtime 1.0.116 reads the WHOLE file through
 * sessionFs readFile, also for a view_range (measured: `stat` + `readFile`
 * of a 10 MB file for view_range [100, 103]), and it does not use the
 * provider's readFileRange even when that capability is declared. This view
 * streams the data blob and stops after the last requested line; it holds at
 * most the output (VIEW_OUTPUT_BYTES) and one line of it.
 *
 * Output, as measured on the built-in (builtin-view-tool.json holds its
 * metadata):
 *   - text: the file content as is, no line numbers, without a final CR;
 *     lines are split on "\n" only (a CR stays), so a file that ends with
 *     "\n" has one more, empty, line ("The file has 6 lines" for 5 lines and
 *     a final newline), and an empty file has none;
 *   - a whole file over 20 KB: "File too large to read at once (N KB)..."
 *     unless forceReadLargeFiles; over 10 MB: "File is too large to view";
 *   - a range: at most 20,480 bytes of whole lines, then
 *     "[Output truncated. Use view_range=[n, ...] ...]"; a first line over
 *     the cap is cut at 20,480 bytes ("Line n truncated after 20480 bytes");
 *   - the view_range errors of the built-in, word for word;
 *   - a directory: its non-hidden entries, one per line, sorted;
 *   - an image (png, jpeg, gif, webp): "Viewed image file successfully." plus
 *     the image as binaryResultsForLlm;
 *   - a missing path: "Path <path> does not exist. Please provide a valid path."
 * Differences: a truncated range says "File has at least <n> lines" with
 * the lines read so far; the built-in reads the whole file and counts all.
 * And forceReadLargeFiles returns at most 20,480 bytes like a range (then
 * "[Output truncated. Use view_range=[n, ...] ...]"); the built-in returns up
 * to 10 MB inline. Every view result is stored in the session journal, so a
 * big inline result would grow the journal by its size on every call.
 */
import type { Readable } from "node:stream";
import type { Tool as CopilotTool, ToolResultObject } from "@microsoft/copilot-sdk";
import builtinView from "./builtin-view-tool.json";
import { normalizeSessionPath } from "./session-path";
import { readAtMost, utf8Boundary } from "./stream-lines";
import { workspaceToolErrorText } from "./tool-error-text";

/** What the view tool needs from the filesystem (BlobSessionFs implements it). */
export interface ViewFiles {
  /** A file (size, and how to stream it), a directory, or undefined when the path does not exist. */
  viewTarget(path: string): Promise<
    | { kind: "file"; size: number; open: (signal?: AbortSignal) => Promise<Readable> }
    | { kind: "directory"; entries: () => Promise<string[]> }
    | undefined
  >;
}

/** Bytes of file content one view returns (whole file, forced or not, or a range). */
export const VIEW_OUTPUT_BYTES = 20 * 1024;
/** Biggest file view opens without view_range (also with forceReadLargeFiles), and biggest image. */
export const VIEW_MAX_FILE_BYTES = 10 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const LF = 0x0a;

export interface ViewArgs {
  path?: unknown;
  view_range?: unknown;
  forceReadLargeFiles?: unknown;
}

const ok = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "success" });
const failure = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "failure", error: text });
/** Size as the built-in prints it: "86.8 KB", "8.8 MB". */
const kb = (bytes: number) =>
  bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const mbShort = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

/** Result of streaming lines [start, end] (1-based, end -1 = to the end of the file). */
interface RangeRead {
  /** Bytes of the output, whole lines joined with "\n". */
  text: string;
  /** Lines seen so far (all lines when `eof`). */
  lines: number;
  eof: boolean;
  /** The output stopped before this line (cap reached). */
  nextLine?: number;
  /** The first line of the range alone was over the cap and is cut. */
  cutLine?: number;
}

/**
 * Streams the file and keeps only the lines in [start, end], at most `cap`
 * bytes of them. Lines before the range are only counted (newlines), never
 * decoded. Stops reading after the last line it needs.
 */
export async function readLineRange(stream: Readable, start: number, end: number, cap: number): Promise<RangeRead> {
  const out: Buffer[] = [];
  let outBytes = 0;
  let wroteLine = false;
  // The current line, only while it is in the range: at most cap + 1 bytes.
  let line: Buffer[] = [];
  let lineBytes = 0;
  let lineNo = 1;
  let result: RangeRead | undefined;
  const inRange = () => lineNo >= start && (end === -1 || lineNo <= end);
  const keep = (chunk: Buffer, from: number, to: number) => {
    if (!inRange() || to <= from) return;
    const room = cap + 1 - lineBytes;
    if (room <= 0) return;
    const take = Math.min(room, to - from);
    line.push(chunk.subarray(from, from + take));
    lineBytes += take;
  };
  /** Ends line `lineNo`; returns false when the output is complete. */
  const finish = (): boolean => {
    if (inRange()) {
      const sep = wroteLine ? 1 : 0;
      if (outBytes + sep + lineBytes > cap) {
        if (!wroteLine) {
          const bytes = Buffer.concat(line, lineBytes);
          out.push(bytes.subarray(0, utf8Boundary(bytes, cap)));
          result = { text: "", lines: lineNo, eof: false, cutLine: lineNo };
        } else {
          result = { text: "", lines: lineNo, eof: false, nextLine: lineNo };
        }
        return false;
      }
      if (sep) out.push(Buffer.from([LF]));
      out.push(...line);
      outBytes += sep + lineBytes;
      wroteLine = true;
    }
    line = [];
    lineBytes = 0;
    if (end !== -1 && lineNo >= end) {
      result = { text: "", lines: lineNo, eof: false };
      return false;
    }
    lineNo++;
    return true;
  };
  let sawBytes = false;
  outer: for await (const raw of stream) {
    const chunk = raw as Buffer;
    if (chunk.length > 0) sawBytes = true;
    let pos = 0;
    while (pos < chunk.length) {
      const nl = chunk.indexOf(LF, pos);
      const stop = nl === -1 ? chunk.length : nl;
      keep(chunk, pos, stop);
      if (nl === -1) break;
      if (!finish()) break outer;
      pos = nl + 1;
    }
  }
  let done = result as RangeRead | undefined;
  if (!done) {
    if (!sawBytes) return { text: "", lines: 0, eof: true }; // an empty file has no lines
    // End of file: the last line (empty after a final newline) is a line too,
    // as in split("\n").
    if (finish()) done = { text: "", lines: lineNo - 1, eof: true };
    else {
      done = result as unknown as RangeRead;
      if (done.nextLine === undefined && done.cutLine === undefined) done.eof = true;
    }
  }
  return { ...done, text: Buffer.concat(out).toString("utf8") };
}

function parseRange(raw: unknown): { start: number; end: number } | { error: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length !== 2 || !raw.every((n) => Number.isInteger(n))) {
    return { error: "Invalid view_range: expected [start, end] with integer line numbers." };
  }
  const [start, end] = raw as [number, number];
  if (start < 1) return { error: `Invalid view_range: start line (${start}) must be greater than or equal to 1.` };
  if (end !== -1 && end < start) {
    return { error: `Invalid view_range: end line (${end}) must be greater than or equal to start line (${start}).` };
  }
  return { start, end };
}

export async function runView(
  fs: ViewFiles,
  args: ViewArgs,
  options: { searchToolName?: string } = {},
): Promise<ToolResultObject> {
  if (typeof args.path !== "string" || args.path.length === 0) return failure("A path parameter is required, and must be a non-empty string.");
  let path: string;
  try {
    path = normalizeSessionPath(args.path);
  } catch {
    return failure(`Path ${args.path} does not exist. Please provide a valid path.`);
  }
  const range = parseRange(args.view_range);
  if (range && "error" in range) return failure(range.error);

  const target = await fs.viewTarget(path);
  if (!target) return failure(`Path ${path} does not exist. Please provide a valid path.`);
  if (target.kind === "directory") {
    const names = (await target.entries()).filter((n) => !n.startsWith("."));
    return ok(names.join("\n"));
  }

  const ext = path.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
  const imageType = path.includes(".") ? IMAGE_TYPES[ext] : undefined;
  if (imageType) {
    if (target.size > VIEW_MAX_FILE_BYTES) {
      return failure(`File is too large to view (${mbShort(target.size)}). Maximum file size is ${VIEW_MAX_FILE_BYTES / (1024 * 1024)}MB.`);
    }
    const stream = await target.open();
    try {
      const data = await readAtMost(stream, VIEW_MAX_FILE_BYTES);
      if (!Buffer.isBuffer(data)) return failure(`File is too large to view. Maximum file size is ${VIEW_MAX_FILE_BYTES / (1024 * 1024)}MB.`);
      return {
        textResultForLlm: "Viewed image file successfully.",
        binaryResultsForLlm: [
          { data: data.toString("base64"), mimeType: imageType, type: "image", description: `Image file at path ${path}` },
        ],
        resultType: "success",
      };
    } finally {
      stream.destroy();
    }
  }

  const search = options.searchToolName ?? "grep";
  const force = args.forceReadLargeFiles === true;
  if (!range && target.size > VIEW_MAX_FILE_BYTES) {
    return failure(
      `File is too large to view (${mbShort(target.size)}). Maximum file size is ${VIEW_MAX_FILE_BYTES / (1024 * 1024)}MB. ` +
        `Specify a line range with view_range parameter to view specific sections, or use the ${search} tool to search within the file.`,
    );
  }
  if (!range && !force && target.size > VIEW_OUTPUT_BYTES) {
    return failure(
      `File too large to read at once (${kb(target.size)}). Consider using the ${search} tool to search within the file, ` +
        "or view with view_range to read specific sections.",
    );
  }

  const stream = await target.open();
  let read: RangeRead;
  try {
    // Also a forced whole-file read: the output goes into the journal.
    read = await readLineRange(stream, range?.start ?? 1, range?.end ?? -1, VIEW_OUTPUT_BYTES);
  } finally {
    stream.destroy();
  }
  if (range && read.eof && range.start > read.lines) {
    return failure(`Invalid view_range: start line (${range.start}) is beyond the end of the file. The file has ${read.lines} lines.`);
  }
  if (read.cutLine !== undefined) {
    return ok(
      `${read.text}\n\n[Output truncated. Line ${read.cutLine} truncated after ${VIEW_OUTPUT_BYTES} bytes. Use other tools to examine the rest of this line.]`,
    );
  }
  if (read.nextLine !== undefined) {
    return ok(
      `${read.text}\n\n[Output truncated. Use view_range=[${read.nextLine}, ...] to continue reading. ` +
        `In your next response, you may batch this with other view calls. File has at least ${read.lines} lines.]`,
    );
  }
  // The output drops a final CR (measured on the built-in: CRLF lines 2-3 give "two\r\nthree").
  return ok(read.text.endsWith("\r") ? read.text.slice(0, -1) : read.text);
}

/**
 * The view tool (overrides the built-in): streamed reads, the built-in's
 * name, description and schema. `family` picks the search tool named in
 * messages (rg for GPT models, grep for Claude, as the runtime offers them).
 */
export function workspaceViewTool(
  fs: ViewFiles,
  family: "gpt" | "claude",
  options: { onError?: (err: unknown) => void } = {},
): CopilotTool {
  const searchToolName = family === "gpt" ? "rg" : "grep";
  return {
    name: builtinView.name,
    description: builtinView.description,
    parameters: builtinView.parameters as Record<string, unknown>,
    overridesBuiltInTool: true,
    skipPermission: true,
    defer: "never" as const,
    // skipLargeOutputProcessing: the runtime does not spill its own view
    // output (measured: a 20 KB range and a forced 87 KB file came inline),
    // but it would spill a custom tool's result over 16 KB.
    handler: async (args: unknown) => {
      try {
        const result = await runView(fs, (args ?? {}) as ViewArgs, { searchToolName });
        return { ...result, skipLargeOutputProcessing: true };
      } catch (err) {
        options.onError?.(err);
        return { ...failure(workspaceToolErrorText(err)), skipLargeOutputProcessing: true };
      }
    },
  };
}
