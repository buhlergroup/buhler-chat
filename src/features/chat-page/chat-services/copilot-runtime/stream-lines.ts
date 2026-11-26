/**
 * Incremental line splitting of a byte stream, for the workspace search tools.
 *
 * Memory: only the current line is held (at most `maxLineBytes`, copied only
 * when it spans chunks) plus the first BINARY_SNIFF_BYTES until the binary
 * check is done. A longer line is truncated at a UTF-8 character boundary;
 * the rest of it is skipped up to the next newline, never buffered.
 *
 * Lines are split on bytes: LF (0x0A) never occurs inside a multi-byte UTF-8
 * sequence, so a character split across two chunks stays in one line, and
 * each line is decoded on its own (Buffer.toString, invalid bytes become
 * U+FFFD like a whole-file decode). The result equals
 * `buffer.toString("utf8").split(/\r?\n/)` without the empty last element of
 * a text that ends with a newline (an empty file is one empty line).
 */
import type { Readable } from "node:stream";

/** Longest line kept for matching and output; the rest of the line is dropped. */
export const MAX_LINE_BYTES = 64 * 1024;
/** A NUL byte in the first BINARY_SNIFF_BYTES marks the file as binary. */
export const BINARY_SNIFF_BYTES = 8192;

const LF = 0x0a;
const CR = 0x0d;

/** End of the last complete UTF-8 character in buf[0, end). */
export function utf8Boundary(buf: Buffer, end: number): number {
  let i = end - 1;
  let continuation = 0;
  while (i >= 0 && continuation < 3 && (buf[i] & 0xc0) === 0x80) {
    i--;
    continuation++;
  }
  if (i < 0) return end;
  const lead = buf[i];
  const length = lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1;
  return i + length > end ? i : end;
}

/**
 * Called once per line with its text and 0-based index; `false` stops the
 * splitter (the caller then stops reading the stream).
 */
export type LineHandler = (text: string, index: number) => boolean | void;

export class LineSplitter {
  /** Bytes of the current line from earlier chunks (allocated on first use). */
  private carry: Buffer | undefined;
  private carryLength = 0;
  /** Bytes the current line has, including the dropped part. */
  private lineBytes = 0;
  /** The current line is longer than maxLineBytes; its rest is dropped. */
  private overflow = false;
  private sniff: Buffer[] = [];
  private sniffLength = 0;
  private sniffed = false;
  private sawBytes = false;
  private index = 0;
  /** True once the handler returned false or the input is binary. */
  stopped = false;
  /** True when the first BINARY_SNIFF_BYTES hold a NUL byte (no line was emitted). */
  binary = false;

  constructor(
    private readonly onLine: LineHandler,
    private readonly maxLineBytes = MAX_LINE_BYTES,
  ) {}

  /** Number of lines emitted so far. */
  get lines(): number {
    return this.index;
  }

  /** Feeds one chunk. Returns false when no more input is wanted. */
  push(chunk: Buffer): boolean {
    if (this.stopped) return false;
    if (chunk.length === 0) return true;
    this.sawBytes = true;
    if (!this.sniffed) {
      this.sniff.push(chunk);
      this.sniffLength += chunk.length;
      if (this.sniffLength < BINARY_SNIFF_BYTES) return true;
      return this.releaseSniff();
    }
    return this.feed(chunk);
  }

  /** End of input: emits the last line (also the one empty line of an empty input). */
  end(): void {
    if (this.stopped) return;
    if (!this.sniffed && !this.releaseSniff()) return;
    if (this.lineBytes > 0 || !this.sawBytes) this.emitCarry(false);
    this.stopped = true;
  }

  private releaseSniff(): boolean {
    this.sniffed = true;
    const held = this.sniff;
    this.sniff = [];
    let seen = 0;
    for (const c of held) {
      if (seen >= BINARY_SNIFF_BYTES) break;
      const n = Math.min(c.length, BINARY_SNIFF_BYTES - seen);
      if (c.subarray(0, n).includes(0)) {
        this.binary = true;
        this.stopped = true;
        return false;
      }
      seen += n;
    }
    for (const c of held) if (!this.feed(c)) return false;
    return true;
  }

  private feed(chunk: Buffer): boolean {
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(LF, start);
      const end = nl === -1 ? chunk.length : nl;
      if (nl !== -1 && this.lineBytes === 0) {
        // The whole line is in this chunk: decode it in place, no copy.
        if (!this.emit(this.decode(chunk, start, end, true))) return false;
      } else {
        this.append(chunk, start, end);
        if (nl !== -1 && !this.emitCarry(true)) return false;
      }
      if (nl === -1) break;
      start = nl + 1;
    }
    return true;
  }

  private append(chunk: Buffer, start: number, end: number): void {
    const n = end - start;
    if (n === 0) return;
    this.lineBytes += n;
    if (this.overflow) return;
    const room = this.maxLineBytes - this.carryLength;
    this.carry ??= Buffer.allocUnsafe(this.maxLineBytes + 1);
    if (n <= room) {
      chunk.copy(this.carry, this.carryLength, start, end);
      this.carryLength += n;
      return;
    }
    // Keep one byte over the cap: a CR there is the line's own CR of a CRLF.
    chunk.copy(this.carry, this.carryLength, start, start + room + 1);
    this.carryLength += room + 1;
    this.overflow = true;
  }

  private emitCarry(beforeNewline: boolean): boolean {
    const text = this.carry ? this.decode(this.carry, 0, this.carryLength, beforeNewline) : "";
    this.carryLength = 0;
    this.lineBytes = 0;
    this.overflow = false;
    return this.emit(text);
  }

  /**
   * Text of buf[start, end): without the CR of a CRLF, at most maxLineBytes,
   * cut at a character boundary when longer.
   */
  private decode(buf: Buffer, start: number, end: number, beforeNewline: boolean): string {
    let stop = end;
    if (beforeNewline && stop > start && buf[stop - 1] === CR) stop--;
    if (stop - start > this.maxLineBytes) stop = utf8Boundary(buf, start + this.maxLineBytes);
    return buf.toString("utf8", start, stop);
  }

  private emit(text: string): boolean {
    const keepGoing = this.onLine(text, this.index++);
    if (keepGoing === false) {
      this.stopped = true;
      return false;
    }
    return true;
  }
}

/** How a stream scan ended. */
export type ScanEnd = "eof" | "stopped" | "binary";

type ByteStream = Readable | AsyncIterable<Buffer | Uint8Array | string>;

const asBuffer = (raw: Buffer | Uint8Array | string): Buffer =>
  typeof raw === "string"
    ? Buffer.from(raw, "utf8")
    : Buffer.isBuffer(raw)
      ? raw
      : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);

/** Bytes after which a scan yields to the event loop (a fast stream resolves as microtasks only). */
const YIELD_EVERY_BYTES = 1024 * 1024;
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Feeds a byte stream to a splitter until the end, the handler stops, or
 * `beforeChunk` returns false (budgets, deadline). Leaving the loop early
 * destroys the stream, which aborts the download.
 */
export async function scanLines(
  stream: ByteStream,
  splitter: LineSplitter,
  beforeChunk?: (bytes: number) => boolean,
): Promise<ScanEnd> {
  let sinceYield = 0;
  for await (const raw of stream) {
    const chunk = asBuffer(raw);
    if (beforeChunk && !beforeChunk(chunk.length)) return "stopped";
    if (!splitter.push(chunk)) return splitter.binary ? "binary" : "stopped";
    if ((sinceYield += chunk.length) >= YIELD_EVERY_BYTES) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }
  splitter.end();
  return splitter.binary ? "binary" : "eof";
}

/**
 * Reads a stream into one Buffer of at most `maxBytes`. Returns undefined
 * (and stops the download) when the stream is longer, "stopped" when
 * `beforeChunk` said so.
 */
export async function readAtMost(
  stream: ByteStream,
  maxBytes: number,
  beforeChunk?: (bytes: number) => boolean,
): Promise<Buffer | undefined | "stopped"> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of stream) {
    const chunk = asBuffer(raw);
    if (beforeChunk && !beforeChunk(chunk.length)) return "stopped";
    total += chunk.length;
    if (total > maxBytes) return undefined;
    chunks.push(chunk);
  }
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
}
