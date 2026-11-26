import "server-only";

import {
  GetImageFromStore,
  GetThreadAndImageFromUrl,
} from "./chat-image-service";
import {
  INLINE_IMAGE_TYPES,
  OCTET_STREAM,
  SNIFF_BYTES,
  contentDisposition,
  mediaTypeEssence,
  sniffRasterImageType,
} from "@/features/common/safe-content-type";

// Set on every response of this route. The CSP sandbox also covers a file a
// browser opens directly (no script, no same-origin access).
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'",
};

const textResponse = (message: string, status: number) =>
  new Response(message, {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
  });

const toBytes = (chunk: unknown): Uint8Array => {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return new Uint8Array(0);
};

/**
 * Reads the first `count` bytes of a stream (a web ReadableStream or a Node
 * readable, both async-iterable) and returns them plus a stream with the
 * whole content again.
 */
async function peekStream(
  source: unknown,
  count: number
): Promise<{ head: Uint8Array; body: ReadableStream<Uint8Array> }> {
  const iterator = (source as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let done = false;
  while (length < count) {
    const next = await iterator.next();
    if (next.done) {
      done = true;
      break;
    }
    const bytes = toBytes(next.value);
    chunks.push(bytes);
    length += bytes.length;
  }
  const head = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    head.set(chunk, offset);
    offset += chunk.length;
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length > 0) controller.enqueue(head);
      if (done) controller.close();
    },
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(toBytes(next.value));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  return { head, body };
}

export const ImageAPIEntry = async (request: Request): Promise<Response> => {
  const urlPath = request.url;

  const response = await GetThreadAndImageFromUrl(urlPath);

  if (response.status !== "OK") {
    return textResponse(response.errors[0].message, 404);
  }

  const { threadId, imgName } = response.response;
  const imageData = await GetImageFromStore(threadId, imgName);

  if (imageData.status !== "OK") {
    return textResponse(imageData.errors[0].message, 404);
  }

  const { stream, contentType, metadata } = imageData.response;
  const downloadName = metadata?.originalfilename || imgName;
  const storedType = mediaTypeEssence(contentType);

  // Inline only for an allowed raster type that the stored type names AND
  // the first bytes confirm. Everything else is a download of opaque bytes.
  if (INLINE_IMAGE_TYPES.has(storedType)) {
    const { head, body } = await peekStream(stream, SNIFF_BYTES);
    if (sniffRasterImageType(head) === storedType) {
      return new Response(body, {
        headers: {
          ...SECURITY_HEADERS,
          "content-type": storedType,
          "content-disposition": contentDisposition("inline", downloadName),
        },
      });
    }
    return new Response(body, {
      headers: {
        ...SECURITY_HEADERS,
        "content-type": OCTET_STREAM,
        "content-disposition": contentDisposition("attachment", downloadName),
      },
    });
  }

  return new Response(stream, {
    headers: {
      ...SECURITY_HEADERS,
      "content-type": OCTET_STREAM,
      "content-disposition": contentDisposition("attachment", downloadName),
    },
  });
};
