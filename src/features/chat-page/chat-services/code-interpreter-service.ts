import "server-only";

// No "use server" here: every export of a "use server" module is a Server
// Action that any signed-in browser can call with its own arguments. This
// module is only for server code.

import { OpenAIV1Instance } from "@/features/common/services/openai";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { logInfo, logError, logDebug } from "@/features/common/services/logger";
import { CODE_INTERPRETER_SUPPORTED_EXTENSIONS } from "./code-interpreter-constants";
import { storableContentType } from "@/features/common/safe-content-type";
import {
  contentStore,
  contentStoreTakesBuffer,
  openAiContentFiles,
} from "@/features/common/services/content-store";

/**
 * Upload a file to OpenAI for use with Code Interpreter
 */
export async function UploadFileForCodeInterpreter(
  file: File
): Promise<ServerActionResponse<{ id: string; name: string }>> {
  try {
    const fileExtension = file.name.split(".").pop()?.toUpperCase();
    
    if (!fileExtension || !CODE_INTERPRETER_SUPPORTED_EXTENSIONS.includes(fileExtension)) {
      return {
        status: "ERROR",
        errors: [{ message: `File type .${fileExtension} is not supported for Code Interpreter` }]
      };
    }

    logInfo("Uploading file for Code Interpreter", { 
      fileName: file.name, 
      fileSize: file.size,
      fileType: file.type 
    });

    const openai = OpenAIV1Instance();
    
    // Upload file with purpose "assistants" (required for Code Interpreter)
    const uploadedFile = await openai.files.create({
      file: file,
      purpose: "assistants"
    });

    logInfo("File uploaded successfully", { 
      fileId: uploadedFile.id, 
      fileName: file.name 
    });

    return {
      status: "OK",
      response: {
        id: uploadedFile.id,
        name: file.name
      }
    };
  } catch (error) {
    logError("Failed to upload file for Code Interpreter", {
      error: error instanceof Error ? error.message : String(error),
      fileName: file.name
    });
    
    return {
      status: "ERROR",
      errors: [{ message: `Failed to upload file: ${error instanceof Error ? error.message : String(error)}` }]
    };
  }
}

/**
 * Puts a file into OpenAI for the code interpreter once per content and
 * owner: the bytes go into the content store (scope = owner, hash computed
 * here), and the OpenAI file id cached there is reused while OpenAI still
 * has the file. `uploaded` is false when an existing OpenAI file was reused;
 * such a file may be referenced elsewhere and must not be deleted as an
 * orphan.
 *
 * `blob` (an upload) is streamed, never copied into one buffer. `bytes`
 * larger than CONTENT_STORE_MAX_BUFFERED_BYTES skip the content store and
 * are uploaded as before (no `sha256` then).
 */
export async function UploadFileForCodeInterpreterOnce(
  scope: string,
  file: { name: string; contentType?: string; bytes?: Buffer; blob?: Blob }
): Promise<
  ServerActionResponse<{ id: string; name: string; sha256?: string; uploaded: boolean }>
> {
  try {
    const fileExtension = file.name.split(".").pop()?.toUpperCase();
    if (!fileExtension || !CODE_INTERPRETER_SUPPORTED_EXTENSIONS.includes(fileExtension)) {
      return {
        status: "ERROR",
        errors: [{ message: `File type .${fileExtension} is not supported for Code Interpreter` }],
      };
    }
    if (!file.blob && (!file.bytes || !contentStoreTakesBuffer(file.bytes.length))) {
      if (!file.bytes) throw new Error("No file content");
      const id = await openAiContentFiles().upload(
        file.bytes,
        file.name,
        file.contentType || "application/octet-stream"
      );
      logInfo("Code Interpreter file uploaded without the content store (large buffer)", {
        fileId: id,
        fileName: file.name,
        size: file.bytes.length,
      });
      return { status: "OK", response: { id, name: file.name, uploaded: true } };
    }
    let fileId: string;
    let uploaded: boolean;
    let sha256: string | undefined;
    try {
      const store = contentStore();
      const stored = file.blob
        ? await store.putBlob(scope, file.blob, { contentType: file.contentType })
        : await store.put(scope, file.bytes!, { contentType: file.contentType });
      const opened = await store.openAiFile(scope, stored.sha256, {
        name: file.name,
        contentType: file.contentType,
        ...(file.blob ? { blob: file.blob } : { bytes: file.bytes }),
      });
      fileId = opened.fileId;
      uploaded = opened.uploaded;
      sha256 = stored.sha256;
    } catch (storeError) {
      // A storage problem (container, permission, network) must not stop
      // Code Interpreter: upload directly, as before the content store.
      logInfo("Code Interpreter: content store failed, uploading directly", {
        error: storeError instanceof Error ? storeError.message : String(storeError),
        fileName: file.name,
      });
      fileId = await openAiContentFiles().upload(
        (file.blob ?? file.bytes)!,
        file.name,
        file.contentType || "application/octet-stream"
      );
      uploaded = true;
      sha256 = undefined;
    }
    logInfo("Code Interpreter file ready", {
      fileId,
      fileName: file.name,
      sha256,
      uploaded,
    });
    return {
      status: "OK",
      response: { id: fileId, name: file.name, ...(sha256 ? { sha256 } : {}), uploaded },
    };
  } catch (error) {
    logError("Failed to upload file for Code Interpreter", {
      error: error instanceof Error ? error.message : String(error),
      fileName: file.name,
    });
    return {
      status: "ERROR",
      errors: [
        {
          message: `Failed to upload file: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

/**
 * Download a file from OpenAI (e.g., output from Code Interpreter)
 */
export async function DownloadFileFromCodeInterpreter(
  fileId: string
): Promise<ServerActionResponse<{ data: Buffer; name: string; contentType: string }>> {
  try {
    logDebug("Downloading file from Code Interpreter", { fileId });

    const openai = OpenAIV1Instance();
    
    // Get file metadata
    const fileInfo = await openai.files.retrieve(fileId);
    
    // Download file content
    const fileContent = await openai.files.content(fileId);
    const arrayBuffer = await fileContent.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Determine content type from filename
    const extension = fileInfo.filename.split(".").pop()?.toLowerCase() || "";
    const contentTypeMap: Record<string, string> = {
      "csv": "text/csv",
      "json": "application/json",
      "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "pdf": "application/pdf",
      "png": "image/png",
      "jpg": "image/jpeg",
      "jpeg": "image/jpeg",
      "gif": "image/gif",
      "txt": "text/plain",
      "webp": "image/webp",
      "zip": "application/zip"
    };
    
    // Unknown extensions (svg, html, ...) never get a type a browser renders.
    const contentType = storableContentType(contentTypeMap[extension]);

    logInfo("File downloaded successfully", { 
      fileId, 
      fileName: fileInfo.filename,
      size: buffer.length 
    });

    return {
      status: "OK",
      response: {
        data: buffer,
        name: fileInfo.filename,
        contentType
      }
    };
  } catch (error) {
    logError("Failed to download file from Code Interpreter", {
      error: error instanceof Error ? error.message : String(error),
      fileId
    });
    
    return {
      status: "ERROR",
      errors: [{ message: `Failed to download file: ${error instanceof Error ? error.message : String(error)}` }]
    };
  }
}

/**
 * Delete a file from OpenAI
 */
export async function DeleteFileFromCodeInterpreter(
  fileId: string
): Promise<ServerActionResponse<boolean>> {
  try {
    logDebug("Deleting file from OpenAI", { fileId });

    const openai = OpenAIV1Instance();
    await openai.files.delete(fileId);

    logInfo("File deleted successfully", { fileId });

    return {
      status: "OK",
      response: true
    };
  } catch (error) {
    logError("Failed to delete file from OpenAI", {
      error: error instanceof Error ? error.message : String(error),
      fileId
    });
    
    return {
      status: "ERROR",
      errors: [{ message: `Failed to delete file: ${error instanceof Error ? error.message : String(error)}` }]
    };
  }
}

/**
 * Download a file from a Code Interpreter container
 * Uses the OpenAI SDK's containers.files.content.retrieve() method
 */
export async function DownloadContainerFile(
  containerId: string,
  fileId: string,
  filename: string
): Promise<ServerActionResponse<{ data: Buffer; name: string; contentType: string }>> {
  try {
    logInfo("Starting container file download", { containerId, fileId, filename });

    const openai = OpenAIV1Instance();
    
    logDebug("OpenAI V1 instance created, calling containers.files.content.retrieve", {
      containerId,
      fileId
    });
    
    // Use the SDK's containers API to download the file
    const response = await openai.containers.files.content.retrieve(fileId, {
      container_id: containerId
    });
    
    logDebug("Container file API response received", {
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length')
    });
    
    // The response is a binary Response object
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    logDebug("Container file buffer created", {
      bufferSize: buffer.length,
      filename
    });

    // Determine content type from filename
    const extension = filename.split(".").pop()?.toLowerCase() || "";
    const contentTypeMap: Record<string, string> = {
      "csv": "text/csv",
      "json": "application/json",
      "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "pdf": "application/pdf",
      "png": "image/png",
      "jpg": "image/jpeg",
      "jpeg": "image/jpeg",
      "gif": "image/gif",
      "txt": "text/plain",
      "webp": "image/webp",
      "zip": "application/zip"
    };
    
    // Only the extension map decides the type; the upstream content-type is
    // not trusted. Unknown extensions (svg, html, ...) become octet-stream.
    const contentType = storableContentType(contentTypeMap[extension]);

    logInfo("Container file downloaded successfully", { 
      containerId,
      fileId, 
      filename,
      size: buffer.length,
      contentType,
      extension
    });

    return {
      status: "OK",
      response: {
        data: buffer,
        name: filename,
        contentType
      }
    };
  } catch (error) {
    logError("Failed to download container file", {
      error: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
      containerId,
      fileId,
      filename
    });
    
    return {
      status: "ERROR",
      errors: [{ message: `Failed to download container file: ${error instanceof Error ? error.message : String(error)}` }]
    };
  }
}

