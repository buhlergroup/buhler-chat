import "server-only";

/**
 * GET /api/workspace/file?t=<threadId>&p=<path relative to /workspace>
 *
 * Streams one file of the caller's own thread workspace (Copilot path) for
 * the Files panel. Same response rules as /api/images: nosniff and a CSP
 * sandbox on every response; inline only for PNG / JPEG / WebP / GIF that the
 * file name AND the first bytes agree on; everything else is an attachment
 * of opaque bytes. Never /session-state, never another user's or thread's
 * files: the namespace is {current user}/{thread the user owns}, and the
 * path goes through the session path jail.
 */
import { userHashedId, userSession } from "@/features/auth-page/helpers";
import { isValidId } from "@/features/common/odata-filter";
import { peekStream } from "@/features/common/peek-stream";
import {
  INLINE_IMAGE_TYPES,
  OCTET_STREAM,
  SNIFF_BYTES,
  contentDisposition,
  sniffRasterImageType,
} from "@/features/common/safe-content-type";
import { logError } from "@/features/common/services/logger";
import { FindChatThreadForCurrentUser } from "../chat-thread-service";
import { resolveAgentRuntimeForCurrentUser } from "./runtime-selection";
import { threadWorkspace } from "./workspace-files";
import { workspacePathFromClient } from "./workspace-listing";

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'",
};

const textResponse = (message: string, status: number) =>
  new Response(message, {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
  });

const IMAGE_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** The raster image type a file name claims, when it is one that may be shown inline. */
const claimedImageType = (name: string): string | undefined => {
  const type = IMAGE_TYPE_BY_EXTENSION[name.split(".").pop()?.toLowerCase() ?? ""];
  return type && INLINE_IMAGE_TYPES.has(type) ? type : undefined;
};

export async function WorkspaceFileAPIEntry(request: Request): Promise<Response> {
  if (!(await userSession())) return textResponse("Unauthorized", 401);

  const params = new URL(request.url).searchParams;
  const threadId = params.get("t");
  if (!isValidId(threadId)) return textResponse("Not found.", 404);
  let path: string;
  try {
    path = workspacePathFromClient(params.get("p"));
  } catch {
    return textResponse("Invalid file path.", 400);
  }

  try {
    // A thread the caller may not see gets the same 404 as a missing one.
    if ((await resolveAgentRuntimeForCurrentUser()) !== "copilot") return textResponse("Not found.", 404);
    const thread = await FindChatThreadForCurrentUser(threadId);
    if (thread.status !== "OK") return textResponse("Not found.", 404);

    const { fs } = await threadWorkspace(await userHashedId(), threadId);
    const target = await fs.viewTarget(path);
    if (target?.kind !== "file") return textResponse("Not found.", 404);

    const name = path.slice(path.lastIndexOf("/") + 1);
    const stream = await target.open(request.signal);
    // Only the first bytes are read here; the rest streams to the client.
    const { head, body } = await peekStream(stream, SNIFF_BYTES);
    const claimed = claimedImageType(name);
    const inline = !!claimed && sniffRasterImageType(head) === claimed;
    return new Response(body, {
      headers: {
        ...SECURITY_HEADERS,
        "content-type": inline ? claimed! : OCTET_STREAM,
        "content-disposition": contentDisposition(inline ? "inline" : "attachment", name),
        "content-length": String(target.size),
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    logError("workspace file download failed", { error: e instanceof Error ? e.message : String(e) });
    return textResponse("The file could not be read.", 500);
  }
}
