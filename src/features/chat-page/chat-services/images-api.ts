import "server-only";

import { userSession } from "@/features/auth-page/helpers";
import {
  GetImageFromStore,
  GetThreadAndImageFromUrl,
} from "./chat-image-service";
import { threadImageAccess } from "./image-access";
import {
  INLINE_IMAGE_TYPES,
  OCTET_STREAM,
  SNIFF_BYTES,
  contentDisposition,
  mediaTypeEssence,
  sniffRasterImageType,
} from "@/features/common/safe-content-type";
import { peekStream } from "@/features/common/peek-stream";

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

export const ImageAPIEntry = async (request: Request): Promise<Response> => {
  const urlPath = request.url;

  const response = await GetThreadAndImageFromUrl(urlPath);

  if (response.status !== "OK") {
    return textResponse(response.errors[0].message, 404);
  }

  const { threadId, imgName } = response.response;

  // One access decision per request, before the blob is read. A caller who
  // may not see the thread gets the same 404 as for a missing thread, so the
  // response does not tell whether the thread exists. Who may see a thread:
  // see image-access.ts.
  const user = await userSession();
  const access = await threadImageAccess(threadId, user);
  if (access === "unauthenticated") {
    return textResponse("Unauthorized", 401);
  }
  if (access !== "allowed") {
    return textResponse("Not found.", 404);
  }

  const imageData = await GetImageFromStore(threadId, imgName);

  if (imageData.status !== "OK") {
    // Copilot path: a file run_code / generate_image put into the caller's
    // own thread workspace, linked in the old /api/images form, goes to the
    // workspace download route (also repairs links in existing chats).
    if (imageData.status === "NOT_FOUND" && user) {
      const { workspaceOutputLocation } = await import("./copilot-runtime/workspace-output-redirect");
      const location = await workspaceOutputLocation(threadId, imgName, user);
      if (location) {
        return new Response(null, {
          status: 307,
          headers: { ...SECURITY_HEADERS, location, "cache-control": "private, no-store" },
        });
      }
    }
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
