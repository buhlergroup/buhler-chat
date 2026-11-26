import { BlobServiceClient, RestError } from "@azure/storage-blob";
import { ServerActionResponse } from "../server-action-response";
import { logInfo, logError } from "./logger";
import { getAzureDefaultCredential } from "./azure-default-credential";
import { isSafeBlobPath } from "../blob-path";

// The storage SDK resolves "." and ".." segments in a blob URL. A blob name
// with such a segment (or a backslash or control character) is refused, so no
// name built from outside input can reach another prefix or container.
const invalidBlobName = <T>(blobName: string): ServerActionResponse<T> => {
  logError("Azure Storage: refused unsafe blob name", { blobNameLength: blobName?.length ?? 0 });
  return {
    status: "ERROR",
    errors: [{ message: "Invalid blob name" }],
  };
};

export interface UploadBlobOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface BlobDownloadResult {
  stream: ReadableStream<any>;
  contentType?: string;
  metadata?: Record<string, string>;
}

// initialize the blobServiceClient
const InitBlobServiceClient = () => {
  const acc = process.env.AZURE_STORAGE_ACCOUNT_NAME;

  if (!acc)
    throw new Error(
      "Azure Storage Account not configured correctly, check environment variables."
    );

  const endpoint = `https://${acc}.blob.core.windows.net`;
  const credential = getAzureDefaultCredential();

  const blobServiceClient = new BlobServiceClient(endpoint, credential);
  return blobServiceClient;
};

export const UploadBlob = async (
  containerName: string,
  blobName: string,
  blobData: Buffer,
  options?: UploadBlobOptions
): Promise<ServerActionResponse<string>> => {
  if (!isSafeBlobPath(blobName)) return invalidBlobName<string>(blobName);
  const blobServiceClient = InitBlobServiceClient();

  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  try{
    
  const response = await blockBlobClient.uploadData(blobData, {
    blobHTTPHeaders: options?.contentType
      ? { blobContentType: options.contentType }
      : undefined,
    metadata: options?.metadata,
  });

  // Check for upload success
  if (response.errorCode !== undefined) {
    logError("Azure Storage upload failed", { 
      errorCode: response.errorCode,
      blobName: blobName,
      containerName: containerName 
    });
    return {
      status: "ERROR",
      errors: [
        {
          message: `Error uploading blob to storage: ${response.errorCode}`,
        },
      ],
    };
  }

  logInfo("Azure Storage upload successful", { 
    blobName, 
    containerName,
    url: blockBlobClient.url 
  });

  return {
    status: "OK",
    response: blockBlobClient.url,
  };
  
  } catch (error){
    logError("Azure Storage upload error", { 
      error: error instanceof Error ? error.message : String(error),
      blobName,
      containerName 
    });
    throw error;
  }
};

export const GetBlob = async (
  containerName: string,
  blobPath: string
): Promise<ServerActionResponse<BlobDownloadResult>> => {
  if (!isSafeBlobPath(blobPath)) return invalidBlobName<BlobDownloadResult>(blobPath);
  const blobServiceClient = InitBlobServiceClient();

  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

  try {
    const downloadBlockBlobResponse = await blockBlobClient.download(0);

    // Passes stream to caller to decide what to do with
    if (!downloadBlockBlobResponse.readableStreamBody) {
      return {
        status: "ERROR",
        errors: [
          {
            message: `Error downloading blob: ${blobPath}`,
          },
        ],
      };
    }

    return {
      status: "OK",
      response: {
        stream:
          downloadBlockBlobResponse.readableStreamBody as unknown as ReadableStream<any>,
        contentType: downloadBlockBlobResponse.contentType,
        metadata: downloadBlockBlobResponse.metadata,
      },
    };
  } catch (error) {
    if (error instanceof RestError) {
      if (error.statusCode === 404) {
        return {
          status: "NOT_FOUND",
          errors: [
            {
              message: `Blob not found: ${blobPath}`,
            },
          ],
        };
      }
    }

    return {
      status: "ERROR",
      errors: [
        {
          message: `Error downloading blob: ${blobPath}`,
        },
      ],
    };
  }
};

/**
 * Deletes a blob. A missing blob counts as deleted (idempotent cleanup).
 */
export const DeleteBlob = async (
  containerName: string,
  blobPath: string
): Promise<ServerActionResponse<boolean>> => {
  if (!isSafeBlobPath(blobPath)) return invalidBlobName<boolean>(blobPath);
  const blobServiceClient = InitBlobServiceClient();
  const blockBlobClient = blobServiceClient
    .getContainerClient(containerName)
    .getBlockBlobClient(blobPath);
  try {
    await blockBlobClient.deleteIfExists();
    return { status: "OK", response: true };
  } catch (error) {
    logError("Azure Storage delete error", {
      error: error instanceof Error ? error.message : String(error),
      blobPath,
      containerName,
    });
    return {
      status: "ERROR",
      errors: [{ message: `Error deleting blob: ${blobPath}` }],
    };
  }
};
