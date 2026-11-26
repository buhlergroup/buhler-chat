import "server-only";

// No "use server" here: every export of a "use server" module is a Server
// Action that any signed-in browser can call with its own arguments. This
// module is only for server code.

import {
  GetImageUrlPath,
  UploadImageToStore,
} from "./chat-image-service";
import { persistBase64Image } from "./chat-image-persistence-service";
import { isImageReference } from "./chat-image-persistence-utils";
import { DownloadContainerFile } from "./code-interpreter-service";
import { logError, logInfo } from "@/features/common/services/logger";
import { readContainerFileCitation } from "./chat-api/sandbox-rewrite-core";
import { toSafeBlobFileName } from "@/features/common/blob-path";

/**
 * The subset of AI SDK's `Source` discriminated union we actually use.
 * `Source` is not exported from `ai` (only by name) so we mirror the
 * `document` variant here — that's the only one carrying container-file
 * citations from Azure code_interpreter.
 */
type DocumentSource = {
  type: "source";
  sourceType: "document";
  id: string;
  mediaType: string;
  title: string;
  filename?: string;
  providerMetadata?: unknown;
};
type LooseSource = DocumentSource | { type: "source"; sourceType: string; [k: string]: unknown };

/**
 * Ingests a single container_file_citation source emitted by Azure's
 * code_interpreter into the chat file store (the same Azure-blob-backed
 * store used by images and persisted multimodal uploads). Returns
 * `{ filename, url }` on success, or null if the source isn't a
 * container citation or the round-trip fails.
 *
 * The returned URL is whatever `GetImageUrlPath` produces — the canonical
 * same-origin `/api/images?t=…&img=…` path. Callers MUST treat that URL
 * as the only download surface; no other code path constructs one.
 */
export async function ingestContainerFileSourceToChatStore(
  threadId: string,
  source: LooseSource,
): Promise<{ filename: string; url: string } | null> {
  if (source.type !== "source" || source.sourceType !== "document") return null;
  const doc = source as DocumentSource;
  const citation = readContainerFileCitation(
    doc.providerMetadata,
    doc.filename,
  );
  if (!citation) return null;

  const downloaded = await DownloadContainerFile(
    citation.containerId,
    citation.fileId,
    citation.filename,
  );
  if (downloaded.status !== "OK") {
    logError("ingestContainerFileSourceToChatStore: download failed", {
      threadId,
      fileId: citation.fileId,
      containerId: citation.containerId,
      filename: citation.filename,
      errors: downloaded.errors,
    });
    return null;
  }

  const { data, name, contentType } = downloaded.response;
  // The code interpreter chooses the file name: keep it as the download
  // name, but store the blob under a safe single file name.
  const blobName = toSafeBlobFileName(name);
  const upload = await UploadImageToStore(threadId, blobName, data, {
    contentType,
    originalFileName: name,
  });
  if (upload.status !== "OK") {
    logError("ingestContainerFileSourceToChatStore: upload failed", {
      threadId,
      filename: name,
      errors: upload.errors,
    });
    return null;
  }

  const url = await GetImageUrlPath(threadId, blobName);
  logInfo("ingestContainerFileSourceToChatStore: ingested", {
    threadId,
    filename: name,
    fileId: citation.fileId,
    url,
  });
  return { filename: name, url };
}

/**
 * Ingests every container_file_citation in `sources`. Returns a
 * filename → URL map suitable for handing to the sandbox-URL rewriter.
 * Failures are logged and skipped — the corresponding sandbox URL stays
 * `[blocked]` rather than poisoning the whole turn.
 */
export async function ingestContainerFileSourcesToChatStore(
  threadId: string,
  sources: ReadonlyArray<LooseSource>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const source of sources) {
    const result = await ingestContainerFileSourceToChatStore(threadId, source);
    if (result) map.set(result.filename, result.url);
  }
  return map;
}

// ────────────────────────────────────────────────────────────────────────────
// image_generation tool-result ingest
//
// Azure's built-in `image_generation` tool emits its bytes as raw base64 in
// `output.result`. A 1024×1024 PNG is ~2 MB which on its own blows past
// Cosmos's 2 MB request-size limit when persisted inline on the tool row.
// The legacy code never hit this because it persisted base64 inside the
// assistant `content` and ran it through `processMessageForImagePersistence`
// (chat-image-persistence-service.ts) — that function uploaded to blob and
// swapped a `blob://thread/file` reference back into the content string.
//
// The AI-SDK migration moved tool results into a structured `output` field
// the legacy detector never inspects, so 2 MB rows started landing in
// Cosmos and failing. This ingest step is the symmetric fix: walk
// `toolResults`, upload every base64 image to the same chat-image-service
// store, and rewrite `output.result` to a same-origin `/api/images?...` URL
// (a few hundred bytes). The rest of the persistence pipeline doesn't need
// to change.
// ────────────────────────────────────────────────────────────────────────────

/** Minimal AI-SDK tool-result shape we care about. */
type ImageGenToolResult = {
  toolName: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
};

/** True for `output.result` strings that look like raw or data-URL base64. */
function extractBase64ImagePayload(
  output: unknown,
): { base64: string; contentType: string } | null {
  if (!output || typeof output !== "object") return null;
  const result = (output as { result?: unknown }).result;
  if (typeof result !== "string" || result.length === 0) return null;

  // `data:image/png;base64,xxxx…` → contentType + base64. Azure normally
  // emits bare base64 but we accept both forms so callers can't trip us up.
  const dataUrl = /^data:([^;]+);base64,(.*)$/i.exec(result);
  if (dataUrl) {
    return { contentType: dataUrl[1], base64: dataUrl[2] };
  }

  // Bare base64. Heuristic: length and alphabet. Skip anything implausibly
  // short so non-image string outputs aren't mistaken for image bytes.
  if (result.length < 256) return null;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(result.slice(0, 64))) return null;
  return { contentType: "image/png", base64: result };
}

/**
 * Walks `toolResults`. If the stream rewriter already swapped a tool
 * result's base64 for a `blob://` reference, this is a no-op for that
 * entry (the ref flows through verbatim to persistence). If a base64
 * payload still arrives — meaning the stream rewriter was bypassed or
 * failed — hand it to `persistBase64Image`, which uploads and returns
 * the canonical blob reference. Non-image-generation results pass
 * through unchanged. Failures leave that single result intact and are
 * logged.
 *
 * The image service (`persistBase64Image`) is the only thing that
 * constructs a `blob://` reference; this module never builds one.
 */
export async function ingestImageGenerationResults<
  T extends ImageGenToolResult,
>(threadId: string, toolResults: ReadonlyArray<T>): Promise<T[]> {
  const out: T[] = [];
  for (const r of toolResults) {
    if (r.toolName !== "image_generation") {
      out.push(r);
      continue;
    }
    const currentResult = (r.output as { result?: unknown } | undefined)?.result;
    // Stream rewriter already produced the canonical blob ref — pass through.
    if (typeof currentResult === "string" && isImageReference(currentResult)) {
      out.push(r);
      continue;
    }
    const payload = extractBase64ImagePayload(r.output);
    if (!payload) {
      logInfo("ingestImageGenerationResults: no base64 payload, leaving as-is", {
        threadId,
        toolCallId: r.toolCallId,
      });
      out.push(r);
      continue;
    }
    try {
      // persistBase64Image expects a `data:...;base64,...` URL. Wrap bare
      // base64 so the helper's metadata extractor accepts it.
      const dataUrl = payload.base64.startsWith("data:")
        ? payload.base64
        : `data:${payload.contentType};base64,${payload.base64}`;
      const persisted = await persistBase64Image(threadId, dataUrl);
      if (persisted.status !== "OK") {
        logError("ingestImageGenerationResults: persistBase64Image failed", {
          threadId,
          toolCallId: r.toolCallId,
          errors: persisted.errors,
        });
        out.push(r);
        continue;
      }
      const blobRef = persisted.response;
      logInfo("ingestImageGenerationResults: ingested", {
        threadId,
        toolCallId: r.toolCallId,
        blobRef,
      });
      out.push({
        ...r,
        output: { ...(r.output as object), result: blobRef },
      });
    } catch (err) {
      logError("ingestImageGenerationResults: unexpected failure", {
        threadId,
        toolCallId: r.toolCallId,
        error: err instanceof Error ? err.message : String(err),
      });
      out.push(r);
    }
  }
  return out;
}
