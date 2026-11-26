import "server-only";

// No "use server" here: every export of a "use server" module is a Server
// Action that any signed-in browser can call with its own arguments. This
// module is only for server code (chat persistence, the /api/images route).

import { ServerActionResponse } from "@/features/common/server-action-response";
import { BlobDownloadResult, GetBlob, UploadBlob } from "../../common/services/azure-storage";
import { isSafeBlobFileName, threadBlobPath } from "@/features/common/blob-path";
import { isValidId } from "@/features/common/odata-filter";
import { storableContentType } from "@/features/common/safe-content-type";

const IMAGE_CONTAINER_NAME = "images";
const IMAGE_API_PATH = process.env.NEXTAUTH_URL + "/api/images";

/**
 * `threadId/blobName` in the images container. Throws when the thread id is
 * not an id of this app or the name is not a safe single file name.
 */
export const GetBlobPath = async (threadId: string, blobName: string): Promise<string> => {
  return threadBlobPath(threadId, blobName);
};

const invalidPath = <T>(): ServerActionResponse<T> => ({
  status: "ERROR",
  errors: [{ message: "Invalid thread id or file name." }],
});

export const UploadImageToStore = async (
  threadId: string,
  fileName: string,
  imageData: Buffer,
  options?: {
    contentType?: string;
    originalFileName?: string;
  }
): Promise<ServerActionResponse<string>> => {
  let blobPath: string;
  try {
    blobPath = threadBlobPath(threadId, fileName);
  } catch {
    return invalidPath<string>();
  }
  return await UploadBlob(
    IMAGE_CONTAINER_NAME,
    blobPath,
    imageData,
    {
      // Only known types are kept; anything else (SVG, HTML, XML, ...) is
      // stored as application/octet-stream.
      contentType: storableContentType(options?.contentType),
      metadata: options?.originalFileName
        ? { originalfilename: options.originalFileName }
        : undefined,
    }
  );
};

export const GetImageFromStore = async (
  threadId: string,
  fileName: string
): Promise<ServerActionResponse<BlobDownloadResult>> => {
  let blobPath: string;
  try {
    blobPath = threadBlobPath(threadId, fileName);
  } catch {
    return invalidPath<BlobDownloadResult>();
  }
  return await GetBlob(IMAGE_CONTAINER_NAME, blobPath);
};

export const GetImageUrl = async (threadId: string, fileName: string): Promise<string> => {
  // add threadId and fileName as query parameters t and img respectively
  const params = `?t=${encodeURIComponent(threadId)}&img=${encodeURIComponent(fileName)}`;

  return `${IMAGE_API_PATH}${params}`;
};

/**
 * Same as GetImageUrl but returns a same-origin, leading-slash path
 * (`/api/images?...`). Use this when the URL will be rendered to the
 * browser (markdown links / <img src>) — Streamdown's link sanitizer
 * blocks absolute URLs that match the page origin, so relative is the
 * only form that round-trips through it. Use GetImageUrl when the URL
 * is consumed by the LLM (vision input) and must be fetchable from a
 * different host.
 */
export const GetImageUrlPath = async (
  threadId: string,
  fileName: string,
): Promise<string> => {
  return `/api/images?t=${encodeURIComponent(threadId)}&img=${encodeURIComponent(fileName)}`;
};

export const GetThreadAndImageFromUrl = async (
  urlString: string
): Promise<ServerActionResponse<{ threadId: string; imgName: string }>> => {
  // Get threadId and img from query parameters t and img
  const url = new URL(urlString);
  const threadId = url.searchParams.get("t");
  const imgName = url.searchParams.get("img");

  // Check if threadId and img are valid
  if (!threadId || !imgName) {
    return {
      status: "ERROR",
      errors: [
        {
          message:
            "Invalid URL, threadId and/or imgName not formatted correctly.",
        },
      ],
    };
  }

  // Extra measure: agent skill packages live in their own private container
  // (persona-skill-store.ts), but this route never serves an
  // "agent-skills/" path, and no "." / ".." segment may steer the blob path.
  const blobPath = `${threadId}/${imgName}`.replace(/\\/g, "/");
  const segments = blobPath.split("/");
  if (
    segments[0] === "agent-skills" ||
    segments.some((segment) => segment === "." || segment === "..") ||
    !isValidId(threadId) ||
    !isSafeBlobFileName(imgName)
  ) {
    return {
      status: "ERROR",
      errors: [{ message: "Invalid URL, threadId and/or imgName not formatted correctly." }],
    };
  }

  return {
    status: "OK",
    response: {
      threadId,
      imgName,
    },
  };
};
