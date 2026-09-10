import "server-only";

/**
 * code-interpreter-container.ts
 *
 * Owns the ONE decision that keeps the code_interpreter tool definition
 * byte-identical across the turns of a thread: the container id.
 *
 * Why this exists. The Azure Responses code_interpreter tool is declared with
 * one of three container arguments:
 *
 *   container: "<id>"            reuse an existing container
 *   container: { fileIds: [..] } mint a new one with these files attached
 *   {}                           mint an empty one
 *
 * The route used to send the second or third shape on turn 1, harvest the
 * container id Azure stamped on the tool call, and only then send the first
 * shape from turn 2 onwards. The tool definition is part of the cached prompt
 * prefix, so turn 2 could never match turn 1's prefix: every code-interpreter
 * thread paid to rewrite its whole prefix on its second turn.
 *
 * Creating the container up front — before the first model call — puts the id
 * into the tool definition from turn 1, so it is the same string on every
 * subsequent turn.
 *
 * Failure is not fatal: on any error we return undefined and the caller falls
 * back to the old bootstrap-then-harvest behaviour, which still works, just
 * without the prefix stability.
 */

import { OpenAIV1Instance } from "@/features/common/services/openai";
import { logError, logInfo } from "@/features/common/services/logger";

/**
 * Idle window before Azure reclaims the container. This is the API default;
 * stated explicitly so a change of default cannot silently shorten the
 * lifetime of a thread's working directory.
 */
const CONTAINER_IDLE_MINUTES = 20;

export interface EnsureContainerArgs {
  threadId: string;
  /** Already-known container for this thread, if any. */
  existingContainerId?: string;
  /** OpenAI file ids the user attached for this turn. */
  fileIds: string[];
}

/**
 * Is this container still there?
 *
 * `true` alive, `false` definitely gone, `undefined` cannot tell — the three
 * cases are deliberately distinct, because "cannot tell" must reuse the id
 * rather than mint a container on every turn. A retrieve that fails for any
 * reason other than absence (a 500, a network blip, no retrieve method on
 * this surface) is "cannot tell": the container is probably fine and the tool
 * definition should not churn over a transient error.
 */
async function containerIsAlive(
  client: unknown,
  containerId: string,
): Promise<boolean | undefined> {
  const containers = (client as { containers?: { retrieve?: unknown } })
    .containers;
  if (typeof containers?.retrieve !== "function") return undefined;
  try {
    const got = await (
      containers as {
        retrieve: (id: string) => Promise<{ status?: string } | undefined>;
      }
    ).retrieve(containerId);
    if (!got) return undefined;
    // Azure reports a reclaimed container as "expired" when it still answers
    // at all; treat anything else as usable.
    return got.status !== "expired";
  } catch (err) {
    const status = (err as { status?: number; statusCode?: number })?.status
      ?? (err as { statusCode?: number })?.statusCode;
    const message =
      err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    // Absence is the one answer we act on.
    if (status === 404 || message.includes("expired") || message.includes("not found")) {
      return false;
    }
    return undefined;
  }
}

/**
 * Returns the container id to declare on the code_interpreter tool. Creates
 * one if the thread has none, and replaces the stored one if it has expired.
 * Returns undefined only when creation was not possible, in which case the
 * caller must keep its previous behaviour.
 */
export async function ensureCodeInterpreterContainer({
  threadId,
  existingContainerId,
  fileIds,
}: EnsureContainerArgs): Promise<string | undefined> {
  try {
    const client = OpenAIV1Instance();

    // A stored id is not proof the container still exists. Azure reclaims a
    // container CONTAINER_IDLE_MINUTES after its last activity, and the id
    // outlives it in Cosmos, so a thread that was idle over lunch came back
    // holding a dead id. Declaring it made every later turn fail on
    // "Container is expired." — permanently, because nothing ever replaced
    // it. Probe before reuse and mint a replacement when it has gone.
    if (existingContainerId) {
      const alive = await containerIsAlive(client, existingContainerId);
      if (alive !== false) {
        // Alive, or unknowable on this surface. Reuse: prefix stability is
        // the whole point, and re-minting on a false alarm would throw away
        // the working directory for nothing.
        return existingContainerId;
      }
      logInfo(
        "code-interpreter: stored container is gone, minting a replacement",
        { threadId, expiredContainerId: existingContainerId },
      );
      // Fall through and create a new one. Nothing is lost that could have
      // been saved: an expired container's files are already gone.
    }

    // Older/self-hosted surfaces may not expose /containers at all. Probe
    // rather than throwing a TypeError into the request path.
    const containers = (client as { containers?: { create?: unknown } })
      .containers;
    if (typeof containers?.create !== "function") {
      logInfo(
        "code-interpreter: containers API unavailable, falling back to inline container bootstrap",
        { threadId },
      );
      return undefined;
    }

    const created = await (
      containers as {
        create: (body: {
          name: string;
          file_ids?: string[];
          expires_after?: { anchor: "last_active_at"; minutes: number };
        }) => Promise<{ id?: string }>;
      }
    ).create({
      name: `chat-${threadId}`,
      ...(fileIds.length > 0 && { file_ids: [...new Set(fileIds)].sort() }),
      expires_after: {
        anchor: "last_active_at",
        minutes: CONTAINER_IDLE_MINUTES,
      },
    });

    if (!created?.id) {
      logError("code-interpreter: container create returned no id", { threadId });
      return undefined;
    }
    logInfo("code-interpreter: pre-created container for prefix stability", {
      threadId,
      containerId: created.id,
      fileCount: fileIds.length,
    });
    return created.id;
  } catch (err) {
    logError("code-interpreter: container create failed", {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
