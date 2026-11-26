/**
 * Seeding a NEW Copilot session from the stored thread history (Cosmos rows):
 * for a thread that started on the AI SDK path, after a model or path switch,
 * or when the session state is gone.
 *
 * Text and tool calls are imported as they are. Images of earlier turns:
 *
 *   - A user image goes on the imported `user.message` as an inline `blob`
 *     attachment (the history import accepts attachments on user messages
 *     only), when the model accepts image input.
 *   - Every other image (a generated image, or a user image for a model
 *     without image input) is copied into the thread's workspace under
 *     HISTORY_IMAGES_DIR, named by the SHA-256 of its bytes (the same image is
 *     written once), and the imported message gets a short marker with the
 *     exact path. A generate_image result whose workspace file still exists
 *     keeps that path and is not copied.
 *
 * Caps (SEED_IMAGE_LIMITS): the newest 8 images, each at most 8 MB, at most
 * 16 MB in all. Older or larger images get an "omitted" marker. Workspace
 * writes go through the thread's BlobSessionFs, so the workspace quota (bytes
 * and file count) applies; a write over the quota also ends as "omitted".
 *
 * Access: images come from this thread only. A stored reference to another
 * thread is never read, and workspace files are read and written through the
 * thread's own namespace ({userKey}/{threadId}).
 *
 * Pure orchestration; the image store and the workspace come in as deps, so
 * this file stays free of server-only imports and the tests use fakes.
 */
import { createHash } from "node:crypto";
import type { CopilotSession } from "@microsoft/copilot-sdk";
import type { UIMessage } from "ai";
import { sniffRasterImageType } from "@/features/common/safe-content-type";
import { normalizeSessionPath } from "./session-path";

export type HistoryImportConversationEvent = Parameters<
  CopilotSession["rpc"]["history"]["importConversation"]
>[0]["events"][number];

type UserMessageEvent = Extract<HistoryImportConversationEvent, { type: "user.message" }>;
export type HistoryImportAttachment = NonNullable<UserMessageEvent["data"]["attachments"]>[number];

/** Workspace folder of the images copied from earlier turns. */
export const HISTORY_IMAGES_DIR = "/workspace/images/earlier";

export interface SeedImageLimits {
  /** Newest images carried over (attachments and workspace copies together). */
  maxImages: number;
  /** An image larger than this is not carried over. */
  maxImageBytes: number;
  /** Bytes read for all carried-over images together. */
  maxTotalBytes: number;
}

export const SEED_IMAGE_LIMITS: SeedImageLimits = {
  maxImages: 8,
  maxImageBytes: 8 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
};

const MAX_SEED_TOOL_CHARS = 20_000;

/** What an earlier image becomes in the seeded session. */
export type SeedImage =
  | { kind: "attachment"; attachment: HistoryImportAttachment }
  | { kind: "workspace"; path: string }
  | { kind: "omitted" };

/** Seed images by part key (see userImageKey / toolImageKey). */
export type SeedImages = ReadonlyMap<string, SeedImage[]>;

export interface SeedImageDeps {
  /** The thread being seeded: only images of this thread are read. */
  threadId: string;
  /** True when the session's model accepts image input. */
  vision: boolean;
  /** The thread's workspace (BlobSessionFs of {userKey}/{threadId}). */
  fs: {
    exists(path: string): Promise<boolean>;
    writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  };
  /**
   * Bytes of an image of THIS thread in the chat image store, or undefined
   * when it is missing or larger than `maxBytes`.
   */
  readThreadImage(fileName: string, maxBytes: number): Promise<Uint8Array | undefined>;
  limits?: Partial<SeedImageLimits>;
  /** Called for an image that is not carried over (logging). */
  onSkip?: (reason: string) => void;
}

const userImageKey = (message: number, part: number) => `u:${message}:${part}`;
const toolImageKey = (message: number, toolCallId: string) => `t:${message}:${toolCallId}`;

type ImageSource =
  | { type: "data"; mimeType: string; base64: string }
  | { type: "ref"; threadId: string; fileName: string }
  | { type: "foreign" };

interface FoundImage {
  key: string;
  origin: "user" | "generated";
  source?: ImageSource;
  /** Workspace file the tool already wrote (generate_image `path`). */
  workspacePath?: string;
}

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is;
const BLOB_REF = /^blob:\/\/([^/]+)\/([^/]+)$/;

/**
 * An image reference of the chat image store: `blob://thread/file`, or the
 * `/api/images?t=thread&img=file` URL (relative or absolute) older rows hold.
 */
export function parseImageSource(value: string): ImageSource | undefined {
  const data = DATA_URL.exec(value);
  if (data) return { type: "data", mimeType: data[1].toLowerCase(), base64: data[2] };
  const ref = BLOB_REF.exec(value);
  if (ref) return { type: "ref", threadId: ref[1], fileName: ref[2] };
  if (value.startsWith("/api/images") || /^https?:\/\/[^/]+\/api\/images/i.test(value)) {
    try {
      const url = new URL(value, "http://local");
      const threadId = url.searchParams.get("t");
      const fileName = url.searchParams.get("img");
      if (url.pathname.replace(/\/$/, "") === "/api/images" && threadId && fileName) {
        return { type: "ref", threadId, fileName };
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

type ToolPart = { toolCallId: string; toolName?: string; type: string; input?: unknown; output?: unknown; state?: string };

const toolPartsOf = (message: UIMessage): ToolPart[] =>
  message.parts.filter((p) => p.type === "dynamic-tool" || p.type.startsWith("tool-")) as unknown as ToolPart[];

/** Every image of the history, oldest first. */
function findImages(history: UIMessage[]): FoundImage[] {
  const found: FoundImage[] = [];
  history.forEach((message, m) => {
    if (message.role === "user") {
      message.parts.forEach((part, p) => {
        if (part.type !== "file") return;
        const file = part as { url?: string; mediaType?: string };
        const source = typeof file.url === "string" ? parseImageSource(file.url) : undefined;
        if (!source && !file.mediaType?.startsWith("image/")) return;
        found.push({ key: userImageKey(m, p), origin: "user", source: source ?? { type: "foreign" } });
      });
      return;
    }
    if (message.role !== "assistant") return;
    for (const tool of toolPartsOf(message)) {
      const output = tool.output;
      if (!output || typeof output !== "object") continue;
      const o = output as { result?: unknown; images?: unknown; path?: unknown };
      const values = [
        ...(typeof o.result === "string" ? [o.result] : []),
        ...(Array.isArray(o.images) ? o.images.filter((v): v is string => typeof v === "string") : []),
      ];
      const workspacePath = typeof o.path === "string" ? workspaceImagePath(o.path) : undefined;
      const sources = values.map(parseImageSource).filter((s): s is ImageSource => !!s);
      if (sources.length === 0 && workspacePath) {
        found.push({ key: toolImageKey(m, tool.toolCallId), origin: "generated", workspacePath });
        continue;
      }
      sources.forEach((source, i) =>
        found.push({
          key: toolImageKey(m, tool.toolCallId),
          origin: "generated",
          source,
          // A single image with a workspace file (generate_image).
          ...(i === 0 && sources.length === 1 && workspacePath ? { workspacePath } : {}),
        }),
      );
    }
  });
  return found;
}

/**
 * The bytes of a stream (a Node readable or a web stream, both async
 * iterable), or undefined once they pass `maxBytes` (reading stops there).
 */
export async function readCapped(stream: AsyncIterable<unknown>, maxBytes: number): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : ArrayBuffer.isView(chunk)
          ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : Buffer.alloc(0);
    size += bytes.length;
    // Leaving the loop ends the stream (the iterator's return()).
    if (size > maxBytes) return undefined;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** A normalised /workspace image path, or undefined. */
function workspaceImagePath(raw: string): string | undefined {
  try {
    const path = normalizeSessionPath(raw);
    return path.startsWith("/workspace/") && /\.(png|jpe?g|gif|webp)$/i.test(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/**
 * Decides what each earlier image becomes, newest first within the caps,
 * and copies the workspace ones into the thread's workspace.
 */
export async function prepareHistoryImages(history: UIMessage[], deps: SeedImageDeps): Promise<SeedImages> {
  const limits = { ...SEED_IMAGE_LIMITS, ...deps.limits };
  const found = findImages(history);
  const out = new Map<string, SeedImage[]>();
  // Oldest first within a message part, so a later push keeps the order.
  const results: Array<{ key: string; image: SeedImage }> = [];
  let carried = 0;
  let totalBytes = 0;
  const skip = (reason: string): SeedImage => {
    deps.onSkip?.(reason);
    return { kind: "omitted" };
  };

  for (let i = found.length - 1; i >= 0; i--) {
    const image = found[i];
    const done = (seed: SeedImage) => results.push({ key: image.key, image: seed });
    if (carried >= limits.maxImages) {
      done(skip("count"));
      continue;
    }
    // A generate_image file that is still in the workspace: its path as it is.
    if (image.workspacePath && (await deps.fs.exists(image.workspacePath).catch(() => false))) {
      carried++;
      done({ kind: "workspace", path: image.workspacePath });
      continue;
    }
    const source = image.source;
    if (!source || source.type === "foreign") {
      done(skip("unsupported source"));
      continue;
    }
    if (source.type === "ref" && source.threadId !== deps.threadId) {
      // Never read an image of another thread, whatever the stored row says.
      done(skip("other thread"));
      continue;
    }
    const budget = Math.min(limits.maxImageBytes, limits.maxTotalBytes - totalBytes);
    if (budget <= 0) {
      done(skip("total size"));
      continue;
    }
    let bytes: Uint8Array | undefined;
    if (source.type === "data") {
      // Size from the base64 length first: no decode of an image over the cap.
      if (Math.floor((source.base64.length * 3) / 4) > budget + 3) {
        done(skip("size"));
        continue;
      }
      bytes = Buffer.from(source.base64, "base64");
    } else {
      bytes = await deps.readThreadImage(source.fileName, budget).catch(() => undefined);
    }
    if (!bytes || bytes.length === 0 || bytes.length > budget) {
      done(skip(bytes ? "size" : "not found"));
      continue;
    }
    const mimeType = sniffRasterImageType(bytes);
    if (!mimeType) {
      done(skip("not a PNG, JPEG, GIF or WebP image"));
      continue;
    }

    if (image.origin === "user" && deps.vision) {
      carried++;
      totalBytes += bytes.length;
      done({
        kind: "attachment",
        attachment: {
          type: "blob",
          mimeType,
          displayName: `image-${i + 1}.${EXT[mimeType]}`,
          data: Buffer.from(bytes).toString("base64"),
        },
      });
      continue;
    }

    const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    const path = `${HISTORY_IMAGES_DIR}/${sha}.${EXT[mimeType]}`;
    try {
      if (!(await deps.fs.exists(path))) await deps.fs.writeFileBytes(path, bytes);
    } catch (err) {
      // Over the workspace quota (bytes or files), or a Blob error.
      done(skip(err instanceof Error && err.name === "WorkspaceQuotaError" ? "workspace quota" : "workspace write"));
      continue;
    }
    carried++;
    totalBytes += bytes.length;
    done({ kind: "workspace", path });
  }

  for (const { key, image } of results.reverse()) {
    const list = out.get(key) ?? [];
    list.push(image);
    out.set(key, list);
  }
  return out;
}

const LF = "\n";

/** The marker line of one image in the imported text. */
function markerOf(seed: SeedImage, origin: "user" | "generated", vision: boolean): string | undefined {
  if (seed.kind === "attachment") return undefined;
  if (seed.kind === "omitted") {
    return origin === "user"
      ? "[An image the user attached here is not available any more.]"
      : "[An image from this tool call is not available any more.]";
  }
  const what = origin === "user" ? "Image the user attached here" : "Image from this tool call";
  return vision
    ? `[${what}, saved in the workspace: ${seed.path} (open it with the view tool to look at it)]`
    : `[${what}, saved in the workspace: ${seed.path}]`;
}

const textOf = (message: UIMessage): string =>
  message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(LF);

/**
 * The thread history as history-import events. `images` (prepareHistoryImages)
 * adds the earlier images; without it, text and tool calls only.
 */
export function historyToImportEvents(
  history: UIMessage[],
  images?: SeedImages,
  options: { vision?: boolean } = {},
): HistoryImportConversationEvent[] {
  const vision = options.vision === true;
  const events: HistoryImportConversationEvent[] = [];
  let n = 0;
  history.forEach((message, m) => {
    if (message.role === "user") {
      const attachments: HistoryImportAttachment[] = [];
      const markers: string[] = [];
      message.parts.forEach((_part, p) => {
        for (const seed of images?.get(userImageKey(m, p)) ?? []) {
          if (seed.kind === "attachment") attachments.push(seed.attachment);
          const marker = markerOf(seed, "user", vision);
          if (marker) markers.push(marker);
        }
      });
      const text = [textOf(message), ...markers].filter(Boolean).join(LF + LF);
      // Some providers refuse an empty text block next to an image.
      const content = text || (attachments.length > 0 ? "(image)" : "");
      if (content) {
        events.push({
          type: "user.message",
          data: { content, ...(attachments.length > 0 ? { attachments } : {}) },
        });
      }
      return;
    }
    if (message.role !== "assistant") return;
    const tools = toolPartsOf(message);
    const toolRequests = tools.map((t) => ({
      toolCallId: t.toolCallId,
      name: t.toolName ?? t.type.replace(/^tool-/, ""),
      arguments: (t.input ?? {}) as Record<string, unknown>,
    }));
    if (toolRequests.length > 0) {
      events.push({
        type: "assistant.message",
        data: { messageId: `seed-${n++}`, content: "", toolRequests },
      } as HistoryImportConversationEvent);
      for (const t of toolRequests) {
        const part = tools.find((p) => p.toolCallId === t.toolCallId);
        const json = JSON.stringify(part?.output ?? null) ?? "null";
        // The markers go first: the output text may be cut.
        const markers = (images?.get(toolImageKey(m, t.toolCallId)) ?? [])
          .map((seed) => markerOf(seed, "generated", vision))
          .filter((x): x is string => !!x);
        const text = [...markers, json].join(LF);
        events.push({
          type: "tool.execution_start",
          data: { toolCallId: t.toolCallId, toolName: t.name, arguments: t.arguments },
        } as HistoryImportConversationEvent);
        events.push({
          type: "tool.execution_complete",
          data: {
            toolCallId: t.toolCallId,
            success: true,
            result: { content: text.slice(0, MAX_SEED_TOOL_CHARS) },
          },
        } as HistoryImportConversationEvent);
      }
    }
    const content = textOf(message);
    if (content) {
      events.push({ type: "assistant.message", data: { messageId: `seed-${n++}`, content } } as HistoryImportConversationEvent);
    }
  });
  return events;
}
