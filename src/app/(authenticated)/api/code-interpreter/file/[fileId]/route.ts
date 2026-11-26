import { DeleteFileFromCodeInterpreter, DownloadFileFromCodeInterpreter } from "@/features/chat-page/chat-services/code-interpreter-service";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { logError, logDebug } from "@/features/common/services/logger";
import { NextRequest } from "next/server";
import {
  findCodeInterpreterFileOfCurrentUser,
  mayDeleteCodeInterpreterFile,
} from "@/features/chat-page/chat-services/code-interpreter-file-access";

// One answer for "no such file" and "not yours", so ids cannot be probed.
const notFound = () => new Response("File not found", { status: 404 });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    // Verify user is authenticated
    // getCurrentUser() throws without a session; answer 401, not 500.
    const user = await getCurrentUser().catch(() => null);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { fileId } = await params;

    if (!fileId) {
      return new Response("File ID is required", { status: 400 });
    }

    // Only files on the caller's own threads: own uploads, and the agent's
    // documents and skill archives of chats the caller started.
    const owned = await findCodeInterpreterFileOfCurrentUser(fileId);
    if (!owned) return notFound();

    logDebug("Downloading Code Interpreter file", { fileId, userEmail: user.email });

    const result = await DownloadFileFromCodeInterpreter(fileId);

    if (result.status !== "OK") {
      return new Response(result.errors[0].message, { status: 404 });
    }

    const { data, name, contentType } = result.response;

    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${name}"`,
        "Content-Length": data.length.toString()
      }
    });
  } catch (error) {
    logError("Error downloading Code Interpreter file", {
      error: error instanceof Error ? error.message : String(error)
    });
    return new Response("Internal Server Error", { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    // Verify user is authenticated
    // getCurrentUser() throws without a session; answer 401, not 500.
    const user = await getCurrentUser().catch(() => null);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { fileId } = await params;
    if (!fileId) {
      return new Response("File ID is required", { status: 400 });
    }

    // Only files the caller uploaded. Agent documents and skill archives are
    // never deleted here (a skill archive is shared by every chat with it).
    const owned = await findCodeInterpreterFileOfCurrentUser(fileId);
    if (!owned || !mayDeleteCodeInterpreterFile(owned.file)) return notFound();

    logDebug("Deleting Code Interpreter file", { fileId, userEmail: user.email });

    const result = await DeleteFileFromCodeInterpreter(fileId);
    if (result.status !== "OK") {
      return new Response(result.errors[0].message, { status: 500 });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    logError("Error deleting Code Interpreter file", {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response("Internal Server Error", { status: 500 });
  }
}
