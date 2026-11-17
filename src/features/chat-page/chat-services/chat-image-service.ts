"use server";
import "server-only";

import { ServerActionResponse } from "@/features/common/server-action-response";
import { BlobDownloadResult, GetBlob, UploadBlob } from "../../common/services/azure-storage";

const IMAGE_CONTAINER_NAME = "images";
const IMAGE_API_PATH = process.env.NEXTAUTH_URL + "/api/images";

export const GetBlobPath = async (threadId: string, blobName: string): Promise<string> => {
  return `${threadId}/${blobName}`;
};

export const UploadImageToStore = async (
  threadId: string,
  fileName: string,
  imageData: Buffer,
  options?: {
    contentType?: string;
    originalFileName?: string;
  }
): Promise<ServerActionResponse<string>> => {
  return await UploadBlob(
    IMAGE_CONTAINER_NAME,
    `${threadId}/${fileName}`,
    imageData,
    {
      contentType: options?.contentType,
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
  const blobPath = await GetBlobPath(threadId, fileName);
  return await GetBlob(IMAGE_CONTAINER_NAME, blobPath);
};

export const GetImageUrl = async (threadId: string, fileName: string): Promise<string> => {
  // add threadId and fileName as query parameters t and img respectively
  const params = `?t=${threadId}&img=${fileName}`;

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

  // The images container also holds agent skill packages under
  // "agent-skills/" (persona-skill-store.ts). Those are served only through
  // the access-checked skill paths, never through this public image route,
  // and no "." / ".." segment may steer the blob path elsewhere.
  const blobPath = `${threadId}/${imgName}`.replace(/\\/g, "/");
  const segments = blobPath.split("/");
  if (
    segments[0] === "agent-skills" ||
    segments.some((segment) => segment === "." || segment === "..")
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
