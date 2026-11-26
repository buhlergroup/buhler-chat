import "server-only";

// No "use server" here: every export of a "use server" module is a Server
// Action that any signed-in browser can call with its own arguments. This
// module is only for server code.

import { OpenAIV1Instance } from "@/features/common/services/openai";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { logInfo, logError, logDebug } from "@/features/common/services/logger";
import { CODE_INTERPRETER_SUPPORTED_EXTENSIONS } from "./code-interpreter-constants";
import { storableContentType } from "@/features/common/safe-content-type";

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

