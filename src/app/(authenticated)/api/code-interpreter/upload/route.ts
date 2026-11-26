import {
  DeleteFileFromCodeInterpreter,
  UploadFileForCodeInterpreterOnce,
} from "@/features/chat-page/chat-services/code-interpreter-service";
import { recordCodeInterpreterUpload } from "@/features/chat-page/chat-services/code-interpreter-file-access";
import { FindChatThreadForCurrentUser } from "@/features/chat-page/chat-services/chat-thread-service";
import { isCodeInterpreterSupportedFile } from "@/features/chat-page/chat-services/code-interpreter-constants";
import { getCurrentUser, userHashedId } from "@/features/auth-page/helpers";
import { logError, logInfo } from "@/features/common/services/logger";

export async function POST(request: Request) {
  try {
    // Verify user is authenticated
    const user = await getCurrentUser();
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const threadIdField = formData.get("threadId");
    const threadId = typeof threadIdField === "string" ? threadIdField : "";

    if (!file) {
      return new Response(JSON.stringify({ error: "No file provided" }), { 
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Check file size (max 512MB for Code Interpreter)
    const maxSize = 512 * 1024 * 1024; // 512MB
    if (file.size > maxSize) {
      return new Response(JSON.stringify({ 
        error: `File size exceeds maximum allowed (512MB)` 
      }), { 
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Check if file type is supported
    if (!isCodeInterpreterSupportedFile(file.name)) {
      return new Response(JSON.stringify({ 
        error: `File type not supported for Code Interpreter` 
      }), { 
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // The upload is recorded on the caller's thread, which is what later
    // lets the chat (and the file route) use this file id. Check the thread
    // first, so a bad id costs no upload.
    if (!threadId) {
      return new Response(JSON.stringify({ error: "No chat thread given" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    const thread = await FindChatThreadForCurrentUser(threadId);
    if (thread.status !== "OK") {
      return new Response(JSON.stringify({ error: "Chat thread not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    logInfo("Uploading file for Code Interpreter", { 
      fileName: file.name, 
      fileSize: file.size,
      userEmail: user.email 
    });

    // One OpenAI file per content and user: the same bytes again (in this
    // or another thread of the user) reuse the stored file id.
    const result = await UploadFileForCodeInterpreterOnce(await userHashedId(), {
      name: file.name,
      contentType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });

    if (result.status !== "OK") {
      return new Response(JSON.stringify({ 
        error: result.errors[0].message 
      }), { 
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const recorded = await recordCodeInterpreterUpload(threadId, {
      id: result.response.id,
      name: result.response.name,
      sha256: result.response.sha256,
    }).catch(
      (error) => {
        logError("Failed to record the Code Interpreter upload on the thread", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      },
    );
    if (!recorded) {
      // Not usable without the record: remove the orphan (best effort). A
      // reused file may be attached elsewhere and stays.
      if (result.response.uploaded) {
        await DeleteFileFromCodeInterpreter(result.response.id).catch(() => undefined);
      }
      return new Response(JSON.stringify({ error: "The file could not be attached to the chat" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ 
      id: result.response.id,
      name: result.response.name
    }), { 
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    logError("Error uploading file for Code Interpreter", {
      error: error instanceof Error ? error.message : String(error)
    });
    return new Response(JSON.stringify({ 
      error: "Internal Server Error" 
    }), { 
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
