/**
 * Shared core for sandbox-URL rewriting. Used by both:
 *   - sandbox-url-transform.ts (stream-time, AI SDK experimental_transform)
 *   - rewrite-sandbox-urls.ts (onFinish, UIMessage tree)
 *
 * Why this exists: an architect review flagged that the two callers had
 * slightly different ideas of which tool outputs to harvest and what
 * constitutes a "match" — divergent in-session vs persisted output for the
 * same conversation. This module is the single source of truth.
 */

import { toSafeBlobFileName } from "@/features/common/blob-path";

/**
 * The sandbox URLs Azure's Responses API emits look like:
 *   sandbox:/mnt/data/plot-3f7b.png
 * The pattern is greedy up to whitespace, paren, quote, or apostrophe so
 * the rewrite works inside markdown image links and inside HTML attrs.
 */
export const SANDBOX_PATTERN = /sandbox:\/mnt\/data\/([^\s)"']+)/g;

/** Tool names that emit sandbox URLs we know how to resolve. */
const SANDBOX_TOOL_NAMES = new Set([
  "code_interpreter",
  "image_generation",
]);

export interface SandboxImageOutput {
  type: "image";
  url: string;
  filename?: string;
}

export type SandboxToolOutputItem =
  | SandboxImageOutput
  | { type: "logs"; logs: string }
  | { type: string; [key: string]: unknown };

export interface SandboxToolOutput {
  outputs?: SandboxToolOutputItem[];
}

/** True for any tool-event/part that can legally emit sandbox file URLs. */
export function isSandboxEmittingToolName(name: string | undefined): boolean {
  return !!name && SANDBOX_TOOL_NAMES.has(name);
}

/**
 * Pulls every concrete `filename → url` pair out of a single tool output.
 * Mutates `fileMap` in place. Sandbox URLs are skipped because they're not
 * fetchable from a browser; only resolved (https) URLs are recorded.
 */
export function harvestOutput(
  output: SandboxToolOutput | undefined,
  fileMap: Map<string, string>,
): void {
  const outputs = output?.outputs ?? [];
  for (const out of outputs) {
    if (out.type !== "image") continue;
    const image = out as SandboxImageOutput;
    const filename =
      image.filename ?? image.url.split("/").pop()?.split("?")[0];
    if (filename && image.url && !image.url.startsWith("sandbox:")) {
      fileMap.set(filename, image.url);
    }
  }
}

/**
 * Returns `{ fileId, containerId, filename }` if `meta` carries the
 * `container_file_citation` shape `@ai-sdk/openai` attaches to document
 * sources, else null. Accepts the metadata under either the `openai` or
 * `azure` provider key since `@ai-sdk/azure` routes through the openai
 * responses provider.
 */
export function readContainerFileCitation(
  meta: unknown,
  filename: string | undefined,
): { fileId: string; containerId: string; filename: string } | null {
  if (!filename || !meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const inner = (m.openai ?? m.azure) as Record<string, unknown> | undefined;
  if (!inner || inner.type !== "container_file_citation") return null;
  const { fileId, containerId } = inner;
  if (typeof fileId !== "string" || typeof containerId !== "string") return null;
  return { fileId, containerId, filename };
}

/**
 * The canonical same-origin download path for a container file, keyed only by
 * threadId + filename. This MUST stay byte-for-byte identical to
 * `GetImageUrlPath` in chat-image-service.ts — that module is `server-only`
 * and cannot be imported into this shared/pure core, so the format is
 * duplicated here. The ingest pipeline always uploads a container file under
 * its citation `filename` and serves it at this exact path, so the URL is
 * correct even when emitted BEFORE the file has been ingested (the blob lands
 * by onFinish, before the user can click).
 */
export function sandboxFallbackUrl(threadId: string, filename: string): string {
  // The ingest stores the file under toSafeBlobFileName(filename); the same
  // transform here keeps both URLs identical.
  return `/api/images?t=${encodeURIComponent(threadId)}&img=${encodeURIComponent(toSafeBlobFileName(filename))}`;
}

/**
 * Rewrites every sandbox-URL occurrence in `text` using `fileMap`. For a
 * filename absent from the map:
 *   - if `fallbackThreadId` is given, the URL is rewritten to the deterministic
 *     `/api/images?t=…&img=…` path (see `sandboxFallbackUrl`). This is the
 *     normal production case: the model often emits the `sandbox:` download
 *     link in a "commentary" text part BEFORE code_interpreter runs, so no
 *     tool-result / source / citation exists when that part's text-end forces
 *     a flush. Leaving the raw `sandbox:` URL makes Streamdown render it as
 *     "[blocked]"; the deterministic path resolves once onFinish ingests the
 *     file under that filename.
 *   - otherwise the filename is appended to `unresolved` and left intact
 *     (markdown still renders, just with a broken link).
 * Returns the input string by reference when nothing changed.
 */
export function rewriteSandboxText(
  text: string,
  fileMap: Map<string, string>,
  unresolved: string[] = [],
  fallbackThreadId?: string,
): string {
  if (fileMap.size === 0 && !SANDBOX_PATTERN.test(text)) {
    // Reset lastIndex from the .test() above so the next .replace() works.
    SANDBOX_PATTERN.lastIndex = 0;
    return text;
  }
  SANDBOX_PATTERN.lastIndex = 0;
  const rewritten = text.replace(SANDBOX_PATTERN, (match, filename: string) => {
    const url = fileMap.get(filename);
    if (url) return url;
    if (fallbackThreadId) return sandboxFallbackUrl(fallbackThreadId, filename);
    unresolved.push(filename);
    return match;
  });
  return rewritten;
}
