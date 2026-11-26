import "server-only";

// No "use server" here: every export of a "use server" module is a Server
// Action that any signed-in browser can call with its own arguments. This
// module is only for server code.

import { ServerActionResponse } from "@/features/common/server-action-response";
import { UploadImageToStore, GetImageUrl, GetImageFromStore } from "./chat-image-service";
import { uniqueId } from "@/features/common/util";
import { logInfo, logError, logDebug } from "@/features/common/services/logger";
import { 
  isBase64Image, 
  extractImageMetadata, 
  base64ToBuffer, 
  isImageReference, 
  parseImageReference, 
  getImageRefFromUrl
} from "./chat-image-persistence-utils";

/**
 * Stores base64 image to blob storage and returns a reference
 */
export const persistBase64Image = async (
  threadId: string,
  base64Image: string
): Promise<ServerActionResponse<string>> => {
  try {
    const metadata = extractImageMetadata(base64Image);
    if (!metadata) {
      logError("Invalid base64 image format", { threadId });
      return {
        status: "ERROR",
        errors: [{ message: "Invalid base64 image format" }]
      };
    }

    const { mimeType, data } = metadata;
    const imageBuffer = base64ToBuffer(data);
    const imageId = uniqueId();
    const fileName = `${imageId}.${mimeType}`;
    const normalizedContentType =
      mimeType.toLowerCase() === "jpg"
        ? "image/jpeg"
        : `image/${mimeType.toLowerCase()}`;

    logDebug("Persisting base64 image to blob storage", {
      threadId,
      imageId,
      fileName,
      mimeType,
      dataSize: imageBuffer.length
    });

    const uploadResult = await UploadImageToStore(threadId, fileName, imageBuffer, {
      contentType: normalizedContentType,
      originalFileName: fileName,
    });
    
    if (uploadResult.status !== "OK") {
      logError("Failed to upload image to blob storage", {
        threadId,
        imageId,
        errors: uploadResult.errors
      });
      return uploadResult;
    }

    // Create reference format: blob://threadId/fileName (with extension)
    const reference = `blob://${threadId}/${fileName}`;
    
    logInfo("Successfully persisted base64 image", {
      threadId,
      imageId,
      fileName,
      reference
    });

    return {
      status: "OK",
      response: reference
    };

  } catch (error) {
    logError("Error persisting base64 image", {
      error: error instanceof Error ? error.message : String(error),
      threadId
    });
    return {
      status: "ERROR",
      errors: [{ message: `Failed to persist image: ${error}` }]
    };
  }
};

/**
 * Converts image reference back to URL for API consumption
 */
export const resolveImageReference = async (reference: string): Promise<ServerActionResponse<string>> => {
  try {
    const imageRef = parseImageReference(reference);
    if (!imageRef) {
      return {
        status: "ERROR",
        errors: [{ message: "Invalid image reference format" }]
      };
    }

    // Get the blob URL for the image
    const imageUrl = await GetImageUrl(imageRef.threadId, imageRef.fileName);
    
    logDebug("Resolved image reference", {
      reference,
      imageUrl,
      threadId: imageRef.threadId,
      imageId: imageRef.imageId
    });

    return {
      status: "OK",
      response: imageUrl
    };

  } catch (error) {
    logError("Error resolving image reference", {
      error: error instanceof Error ? error.message : String(error),
      reference
    });
    return {
      status: "ERROR",
      errors: [{ message: `Failed to resolve image reference: ${error}` }]
    };
  }
};

/**
 * Processes message content to detect and persist base64 images
 */
export const processMessageForImagePersistence = async (
  threadId: string,
  content: string,
  multiModalImage?: string,
  multiModalImages?: string[]
): Promise<{ content: string; multiModalImage?: string; multiModalImages?: string[] }> => {
  let processedContent = content;
  let processedMultiModalImage = multiModalImage;

  // Process main content for base64 images
  if (isBase64Image(content)) {
    logDebug("Detected base64 image in message content", { threadId });
    const persistResult = await persistBase64Image(threadId, content);
    if (persistResult.status === "OK") {
      processedContent = persistResult.response;
    }
  }

  // Process multiModalImages array if present
  let processedMultiModalImages: string[] | undefined;
  if (multiModalImages && multiModalImages.length > 0) {
    processedMultiModalImages = [];
    for (const img of multiModalImages) {
      if (isBase64Image(img)) {
        logDebug("Detected base64 image in multiModalImages", { threadId });
        const persistResult = await persistBase64Image(threadId, img);
        if (persistResult.status === "OK") {
          processedMultiModalImages.push(persistResult.response);
        } else {
          processedMultiModalImages.push(img);
        }
      } else {
        processedMultiModalImages.push(img);
      }
    }
    // Keep single-image field in sync with first image
    processedMultiModalImage = processedMultiModalImages[0];
  } else if (multiModalImage && isBase64Image(multiModalImage)) {
    // Back-compat: process single image if no array provided
    logDebug("Detected base64 image in multiModalImage", { threadId });
    const persistResult = await persistBase64Image(threadId, multiModalImage);
    if (persistResult.status === "OK") {
      processedMultiModalImage = persistResult.response;
    }
  }

  return {
    content: processedContent,
    multiModalImage: processedMultiModalImage,
    multiModalImages: processedMultiModalImages
  };
};

export const getBase64ImageReference = async (
  ref: string
): Promise<string> => {
  try {
    if (ref.startsWith("http")){
      ref = getImageRefFromUrl(ref) || "";
    }

    const image = parseImageReference(ref || "");
    if (!image) {
      throw new Error("Invalid image reference format");
    }
    
    // Extract mime type from fileName (already parsed in parseImageReference)
    let { mimeType } = image;
    
    const response = await GetImageFromStore(image.threadId, image.fileName);
    if (response.status !== "OK") {
      throw new Error("Failed to retrieve image from store");
    }

    if (response.response.contentType) {
      mimeType = response.response.contentType;
    }

    const readableStream = response.response.stream as any; // Node.js ReadableStream from Azure SDK
    
    // Convert Node.js stream to Buffer
    const chunks: Buffer[] = [];
    
    await new Promise<void>((resolve, reject) => {
      readableStream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      
      readableStream.on('end', () => {
        resolve();
      });
      
      readableStream.on('error', (error: Error) => {
        reject(error);
      });
    });
    
    const buffer = Buffer.concat(chunks);
    const base64Data = buffer.toString('base64');
    const base64Image = `data:${mimeType};base64,${base64Data}`;

    return base64Image;
  } catch (error) {
    logError("Error retrieving base64 image from reference", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(`Failed to retrieve base64 image: ${error}`);
  }
};

/**
 * Processes message content to resolve image references back to URLs
 */
export const processMessageForImageResolution = async (
  content: string,
  multiModalImage?: string,
  multiModalImages?: string[]
): Promise<{ content: string; multiModalImage?: string; multiModalImages?: string[] }> => {
  let resolvedContent = content;
  let resolvedMultiModalImage = multiModalImage;

  // Resolve image references in main content
  if (isImageReference(content)) {
    logDebug("Resolving image reference in message content");
    const resolveResult = await resolveImageReference(content);
    if (resolveResult.status === "OK") {
      resolvedContent = resolveResult.response;
    }
  }

  // Resolve image references in multiModalImages array
  let resolvedMultiModalImages: string[] | undefined;
  if (multiModalImages && multiModalImages.length > 0) {
    resolvedMultiModalImages = [];
    for (const img of multiModalImages) {
      if (isImageReference(img)) {
        logDebug("Resolving image reference in multiModalImages");
        const resolveResult = await resolveImageReference(img);
        if (resolveResult.status === "OK") {
          resolvedMultiModalImages.push(resolveResult.response);
        } else {
          resolvedMultiModalImages.push(img);
        }
      } else {
        resolvedMultiModalImages.push(img);
      }
    }
    resolvedMultiModalImage = resolvedMultiModalImages[0];
  } else if (multiModalImage && isImageReference(multiModalImage)) {
    // Back-compat: resolve single image if no array provided
    logDebug("Resolving image reference in multiModalImage");
    const resolveResult = await resolveImageReference(multiModalImage);
    if (resolveResult.status === "OK") {
      resolvedMultiModalImage = resolveResult.response;
    }
  }

  return {
    content: resolvedContent,
    multiModalImage: resolvedMultiModalImage,
    multiModalImages: resolvedMultiModalImages
  };
};
