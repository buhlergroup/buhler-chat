/**
 * Memory of the workspace search tools (rg / grep on the Blob session
 * filesystem): peak and retained heap + array buffers of search calls on a
 * large workspace.
 *
 *   cd src
 *   npx tsx --expose-gc scripts/workspace-search-memory.ts
 *
 * or without tsx (esbuild comes with the dev dependencies):
 *
 *   npx esbuild scripts/workspace-search-memory.ts --bundle --platform=node \
 *     --format=cjs --packages=external --outfile=node_modules/.cache/mem.cjs
 *   node --expose-gc node_modules/.cache/mem.cjs
 *
 * Add --max-semi-space-size=1 to see live memory rather than young-generation
 * garbage that the next scavenge frees.
 *
 * The store is a FAKE that holds no file data: 100 files of 2,000,000 bytes
 * (200 MB, text lines of about 100 characters, one "needle" line per file),
 * generated from one shared 2 MB template and served as 64 KB chunked
 * streams (openRead) or whole buffers (download), like the Blob SDK. Memory
 * is sampled every millisecond and at every store call and stream chunk;
 * the numbers are deltas against the heap after a full GC before the calls.
 *
 * Scenarios: one call alone, then 4 parallel calls (content -n, count,
 * files_with_matches without a match, content -C 2), each scanning all
 * 200 MB. "retained" is the delta after the calls and a full GC.
 *
 * Only sizes and timings are printed.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { BlobSessionFs } from "../features/chat-page/chat-services/copilot-runtime/blob-session-fs";
import { runRipgrep } from "../features/chat-page/chat-services/copilot-runtime/workspace-tools";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) {
  console.error("run with --expose-gc (npx tsx --expose-gc scripts/workspace-search-memory.ts)");
  process.exit(1);
}

const NS = "memtest/thread";
const FILES = Number(process.env.MEM_FILES) || 100;
const FILE_BYTES = 2_000_000;
const CHUNK = 64 * 1024;

/** One 2 MB text template; each file is a copy of it (the store keeps nothing per file). */
const template = (() => {
  const lines: string[] = [];
  let bytes = 0;
  for (let i = 0; bytes < FILE_BYTES; i++) {
    const line =
      i === 10_000
        ? `${String(i).padStart(6, "0")} needle in the middle of the file`
        : `${String(i).padStart(6, "0")} lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor`;
    lines.push(line);
    bytes += line.length + 1;
  }
  return Buffer.from(`${lines.join("\n")}\n`).subarray(0, FILE_BYTES);
})();

let peak = 0;
let base = 0;
const used = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};
const sample = () => {
  const u = used() - base;
  if (u > peak) peak = u;
};

type Detailed = { name: string; metadata: Record<string, string>; lastModified: Date };

/** Fake BlobStore: listing + reads only, content generated on the fly. */
class GeneratedStore {
  private readonly listing: Detailed[] = Array.from({ length: FILES }, (_, i) => ({
    name: `${NS}/f/workspace/data/f${String(i).padStart(3, "0")}.txt`,
    metadata: { target: `${NS}/d/${i}`, size: String(FILE_BYTES) },
    lastModified: new Date(1_700_000_000_000 + i),
  }));
  async getProperties(name: string) {
    sample();
    const hit = this.listing.find((b) => b.name === name);
    if (hit) return { etag: "e", metadata: hit.metadata, contentLength: 0, lastModified: hit.lastModified };
    if (name.startsWith(`${NS}/d/`)) return { etag: "e", metadata: {}, contentLength: FILE_BYTES, lastModified: new Date() };
    return undefined;
  }
  async download(): Promise<Buffer> {
    sample();
    const copy = Buffer.from(template);
    sample();
    return copy;
  }
  async openRead(_name: string, options: { offset?: number; count?: number } = {}) {
    sample();
    let pos = options.offset ?? 0;
    const end = options.count === undefined ? FILE_BYTES : Math.min(FILE_BYTES, pos + options.count);
    const stream = new Readable({
      read() {
        sample();
        if (pos >= end) return void this.push(null);
        const next = Math.min(end, pos + CHUNK);
        const chunk = Buffer.from(template.subarray(pos, next));
        pos = next;
        this.push(chunk);
      },
    });
    return { stream, size: FILE_BYTES };
  }
  async listDetailed(prefix: string) {
    sample();
    return this.listing.filter((b) => b.name.startsWith(prefix));
  }
  async *listDetailedPages(prefix: string) {
    sample();
    yield this.listing.filter((b) => b.name.startsWith(prefix));
  }
  async createAppendBlob(): Promise<void> {
    throw new Error("read-only");
  }
  async appendBlock(): Promise<void> {
    throw new Error("read-only");
  }
  async upload(): Promise<string> {
    throw new Error("read-only");
  }
  async delete(): Promise<boolean> {
    throw new Error("read-only");
  }
  async listNames(prefix: string) {
    return this.listing.filter((b) => b.name.startsWith(prefix)).map((b) => b.name);
  }
  async listHierarchy(): Promise<{ prefixes: string[]; names: string[] }> {
    return { prefixes: [], names: [] };
  }
}

const MB = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

async function measure(label: string, calls: Array<Record<string, unknown>>) {
  // A fresh filesystem per scenario; the process-wide state (if any) stays.
  const fs = new BlobSessionFs(new GeneratedStore() as never, NS);
  gc!();
  gc!();
  base = used();
  peak = 0;
  const timer = setInterval(sample, 1);
  const started = Date.now();
  const results = await Promise.all(calls.map((args) => runRipgrep(fs as never, args, { timeBudgetMs: 600_000 })));
  const ms = Date.now() - started;
  clearInterval(timer);
  sample();
  const lines = results.map((r) => r.textResultForLlm.split("\n").length);
  const digests = results.map((r) => createHash("sha256").update(r.textResultForLlm).digest("hex").slice(0, 8));
  results.length = 0;
  gc!();
  gc!();
  await new Promise((r) => setImmediate(r));
  gc!();
  const retained = used() - base;
  console.log(
    `${label}: calls=${calls.length} scanned=${MB(calls.length * FILES * FILE_BYTES)} time=${ms} ms ` +
      `peak=${MB(peak)} (per call ${MB(peak / calls.length)}) retained=${MB(retained)} outputLines=${lines.join(",")} sha256=${digests.join(",")} ` +
      `rss=${MB(process.memoryUsage().rss)}`,
  );
}

async function main() {
  console.log(`node ${process.version}; ${FILES} files x ${FILE_BYTES} bytes`);
  await measure("single (content -n)", [{ pattern: "needle", output_mode: "content", "-n": true }]);
  await measure("4 parallel", [
    { pattern: "needle", output_mode: "content", "-n": true },
    { pattern: "lorem", output_mode: "count" },
    { pattern: "no-such-text-anywhere" },
    { pattern: "needle", output_mode: "content", "-C": 2 },
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
