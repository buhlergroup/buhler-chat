import type { TextStreamPart, ToolSet } from "ai";
import {
  harvestOutput,
  isSandboxEmittingToolName,
  rewriteSandboxText,
  type SandboxToolOutput,
} from "./sandbox-rewrite-core";
import { ingestContainerFileSourceToChatStore } from "../chat-file-store-ingest";
import { logInfo } from "@/features/common/services/logger";

/**
 * sandbox-url-transform.ts
 *
 * AI SDK stream transform that rewrites `sandbox:/mnt/data/<file>` URLs in
 * text-delta chunks using filename→URL pairs harvested from tool-result
 * chunks earlier in the stream. Because tool results arrive before the
 * model's prose references them, the map is populated by the time the
 * sandbox URLs flow through.
 *
 * Per-text-stream buffering handles the cross-delta case: Azure splits
 * sandbox URLs across many small text-delta chunks (e.g. `sandbox`, `:/`,
 * `mnt`, `/data`, `/random`, `_py`, `plot`, `.png`, `)`), so naive
 * per-delta substitution never sees the full pattern. The transform
 * keeps a `pendingTail` that holds back any suffix which COULD be the
 * start of a sandbox URL; once enough deltas accumulate to either
 * complete (terminator char) or rule out (different content) the
 * sequence, the buffered portion is rewritten and emitted.
 *
 * Used in addition to rewrite-sandbox-urls.ts: this one fixes the
 * in-session render; the other rewrites the persisted text on `onFinish`.
 * Both share `./sandbox-rewrite-core.ts` so the tool-name allowlist and
 * the rewrite rules cannot drift.
 */

/** Characters that terminate a URL in markdown (paren, quote, whitespace). */
const URL_TERMINATOR = /[\s)\]"'>]/;

const SANDBOX_PREFIXES = [
  "sandbox",
  "sandbo",
  "sandb",
  "sand",
  "san",
  "sa",
  "s",
];
// Only `data:` and longer — shorter prefixes ("data", "dat", "da", "d")
// collide with the literal "data" in `sandbox:/mnt/data/...`, which made
// the buffer hold mid-sandbox-URL and break reassembly.
const DATA_PREFIXES = [
  "data:image",
  "data:imag",
  "data:ima",
  "data:im",
  "data:i",
  "data:",
];

/** Pattern that finds COMPLETE sandbox URLs (with terminator visible). */
const SANDBOX_COMPLETE_PATTERN = /sandbox:\/mnt\/data\/([^\s)\]"'>]+)/g;

/**
 * Returns the index in `buffer` at which an URL must start being held back,
 * or -1 if the buffer can be emitted in full. Three cases trigger a hold:
 *
 *   1. A trailing literal prefix that might extend into a sandbox: or
 *      data:image/ URL on the next delta (e.g. "san", "data:ima").
 *   2. An in-flight URL — `sandbox:` or `data:image/` token whose URL
 *      hasn't yet terminated (no `)`, `]`, whitespace, or quote after).
 *   3. A COMPLETE `sandbox:/mnt/data/<filename>` URL whose filename is
 *      NOT yet in `fileMap`. The annotations that populate fileMap may
 *      arrive at `text-end` (after this text-delta) per Azure's
 *      Responses-API behaviour, so we keep waiting until we have a
 *      substitution to apply.
 *
 * The cases overlap, so the hold starts at the EARLIEST position any of
 * them asks for. Returning the first match instead released a URL that was
 * still in flight: Azure splits `sandbox:/mnt/data/sales3.csv` into deltas
 * such as `/data`, `/s`, `ales`, so the buffer ends in "s" — a case-1
 * prefix — while the case-2 URL starts much earlier. Holding only the "s"
 * sent `sandbox:/mnt/data/` to the client on its own; no later buffer then
 * held the whole URL, so it reached Streamdown unrewritten and rendered as
 * "[blocked]" until a reload read the persisted (rewritten) text.
 */
function findHoldBackStart(
  buffer: string,
  fileMap: Map<string, string>,
): number {
  let holdFrom = -1;
  const holdAt = (index: number) => {
    if (index !== -1 && (holdFrom === -1 || index < holdFrom)) holdFrom = index;
  };

  // Case 1. The prefix lists run longest first, so the first match is the
  // earliest start for that list.
  const sandboxPrefix = SANDBOX_PREFIXES.find((p) => buffer.endsWith(p));
  if (sandboxPrefix) holdAt(buffer.length - sandboxPrefix.length);
  const dataPrefix = DATA_PREFIXES.find((p) => buffer.endsWith(p));
  if (dataPrefix) holdAt(buffer.length - dataPrefix.length);

  // Case 2.
  const sandboxIdx = buffer.lastIndexOf("sandbox:");
  if (sandboxIdx !== -1 && !URL_TERMINATOR.test(buffer.slice(sandboxIdx))) {
    holdAt(sandboxIdx);
  }
  const dataIdx = buffer.lastIndexOf("data:image/");
  if (dataIdx !== -1 && !URL_TERMINATOR.test(buffer.slice(dataIdx))) {
    holdAt(dataIdx);
  }

  // Case 3. Already-terminated sandbox URL still waiting on a filename → URL
  // pair from a citation annotation that hasn't arrived yet. Hold from that
  // URL's start so it can be retried once fileMap is populated.
  SANDBOX_COMPLETE_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SANDBOX_COMPLETE_PATTERN.exec(buffer)) !== null) {
    if (!fileMap.has(m[1])) holdAt(m.index);
  }
  return holdFrom;
}

/** Reads container_file_citation annotations off a text-end chunk's providerMetadata. */
function extractCitationAnnotations(
  chunk: unknown,
): Array<{ filename: string; fileId: string; containerId: string }> {
  const meta = (chunk as { providerMetadata?: { azure?: { annotations?: unknown[] } } })
    ?.providerMetadata?.azure?.annotations;
  if (!Array.isArray(meta)) return [];
  const out: Array<{ filename: string; fileId: string; containerId: string }> = [];
  for (const a of meta) {
    const ann = a as {
      type?: string;
      filename?: string;
      file_id?: string;
      container_id?: string;
    };
    if (
      ann?.type === "container_file_citation" &&
      typeof ann.filename === "string" &&
      typeof ann.file_id === "string" &&
      typeof ann.container_id === "string"
    ) {
      out.push({
        filename: ann.filename,
        fileId: ann.file_id,
        containerId: ann.container_id,
      });
    }
  }
  return out;
}

/**
 * Replaces complete data: URLs in `text` with the matching blob ref from
 * the shared map. Caller is responsible for buffering until the URL is
 * complete (terminator visible) — once it is, we look up the exact data:
 * URL string and swap if known. Unknown data: URLs pass through (the
 * post-render layer can still block them, but at least no spurious
 * substitution).
 */
function rewriteDataUrls(
  text: string,
  dataUrlMap: Map<string, string> | undefined,
): string {
  if (!dataUrlMap || dataUrlMap.size === 0) return text;
  let out = text;
  for (const [dataUrl, blobRef] of dataUrlMap) {
    if (out.includes(dataUrl)) {
      out = out.split(dataUrl).join(blobRef);
    }
  }
  return out;
}

export function createSandboxUrlTransform<TOOLS extends ToolSet>(
  /**
   * Thread id, used to ingest container_file_citation `source` chunks
   * via the chat-file-store so the resulting filename → URL pairs land
   * in `fileMap` BEFORE the model's text-delta with the corresponding
   * `sandbox:/mnt/data/<filename>` URL arrives. Without this, the
   * onFinish-time ingest fires too late to inform the live text rewrite,
   * and the assistant text reaches Streamdown still containing the raw
   * sandbox URL → link sanitiser rejects it.
   */
  threadId?: string,
  /**
   * Shared map populated by the code-interpreter rewriter when it
   * persists a data: URL. The text-delta substitution above looks up
   * matching data: URLs the model echoed in its prose and swaps them
   * for the blob ref already stored. Pass the same Map instance to
   * both transform factories in route.ts.
   */
  dataUrlToBlobRef?: Map<string, string>,
) {
  return (): TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>> => {
    const fileMap = new Map<string, string>();
    // Per-text-stream pending tails. Keyed by text-part id so multiple
    // concurrent text parts (rare, but the spec allows it) don't smear
    // into each other.
    const pendingByPartId = new Map<string, string>();

    return new TransformStream({
      async transform(chunk, controller) {
        if (chunk.type === "tool-result") {
          const { toolName, output } = chunk as TextStreamPart<TOOLS> & {
            toolName?: string;
            output?: SandboxToolOutput;
          };
          if (isSandboxEmittingToolName(toolName)) {
            harvestOutput(output, fileMap);
          }
        }

        // container_file_citation source chunks carry the real filename
        // (e.g. "random_pie_chart.png") + file_id that downloadContainerFile
        // can fetch. Ingest immediately so when the model's text-delta
        // says `[Download](sandbox:/mnt/data/random_pie_chart.png)` a few
        // chunks later, fileMap already has the substitution ready.
        if (chunk.type === "source" && threadId) {
          const result = await ingestContainerFileSourceToChatStore(
            threadId,
            chunk as unknown as Parameters<typeof ingestContainerFileSourceToChatStore>[1],
          );
          if (result) {
            fileMap.set(result.filename, result.url);
            logInfo("sandbox-url-transform: ingested container file", {
              threadId,
              filename: result.filename,
            });
          }
        }

        if (chunk.type === "text-delta") {
          const partId = (chunk as { id: string }).id;
          const buffered = (pendingByPartId.get(partId) ?? "") + chunk.text;
          const holdFrom = findHoldBackStart(buffered, fileMap);
          const emittable =
            holdFrom === -1 ? buffered : buffered.slice(0, holdFrom);
          const newPending =
            holdFrom === -1 ? "" : buffered.slice(holdFrom);
          pendingByPartId.set(partId, newPending);
          if (emittable.length === 0) {
            // Nothing emittable yet — entire buffer is mid-URL or
            // waiting on a citation to populate fileMap. Don't forward
            // anything; wait for the next delta or text-end to resolve.
            return;
          }
          const sandboxRewritten = rewriteSandboxText(
            emittable,
            fileMap,
            [],
            threadId,
          );
          const fullyRewritten = rewriteDataUrls(sandboxRewritten, dataUrlToBlobRef);
          controller.enqueue({ ...chunk, text: fullyRewritten });
          return;
        }

        if (chunk.type === "text-end") {
          // Azure's Responses API attaches container_file_citation
          // entries to the text-end chunk's providerMetadata. Ingest
          // them now (last chance before we flush) so the buffered text
          // can be rewritten with the real filename → URL pairs.
          if (threadId) {
            const annotations = extractCitationAnnotations(chunk);
            for (const ann of annotations) {
              try {
                const result = await ingestContainerFileSourceToChatStore(
                  threadId,
                  {
                    type: "source",
                    sourceType: "document",
                    id: ann.fileId,
                    mediaType: "text/plain",
                    title: ann.filename,
                    filename: ann.filename,
                    providerMetadata: {
                      openai: {
                        type: "container_file_citation",
                        fileId: ann.fileId,
                        containerId: ann.containerId,
                      },
                    },
                  } as Parameters<typeof ingestContainerFileSourceToChatStore>[1],
                );
                if (result) {
                  fileMap.set(result.filename, result.url);
                  logInfo("sandbox-url-transform: ingested citation at text-end", {
                    threadId,
                    filename: result.filename,
                  });
                }
              } catch {
                /* best-effort; persist-time ingest is the safety net */
              }
            }
          }

          const partId = (chunk as { id: string }).id;
          const tail = pendingByPartId.get(partId) ?? "";
          if (tail.length > 0) {
            // Last chance to flush this part. If a `sandbox:` URL is still
            // unresolved here (e.g. a commentary-phase download link emitted
            // before code_interpreter ran), `threadId` lets rewriteSandboxText
            // fall back to the deterministic /api/images path instead of
            // leaking the raw sandbox URL → Streamdown "[blocked]".
            const sandboxRewritten = rewriteSandboxText(tail, fileMap, [], threadId);
            const fullyRewritten = rewriteDataUrls(sandboxRewritten, dataUrlToBlobRef);
            controller.enqueue({
              type: "text-delta",
              id: partId,
              text: fullyRewritten,
            } as TextStreamPart<TOOLS>);
          }
          pendingByPartId.delete(partId);
        }

        controller.enqueue(chunk);
      },
    });
  };
}
