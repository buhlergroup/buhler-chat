import "server-only";

/**
 * Microsoft Graph drive calls shared by the SharePoint features of an agent:
 * linked skills (persona-services/skills) and the SharePoint files the model
 * may fetch into the code interpreter (persona-services/sharepoint-files).
 *
 * Always with the token of the CURRENT user (delegated, Files.Read.All), so
 * SharePoint decides who can read the file — the same model as the agent's
 * code interpreter documents (downloadCodeInterpreterFile).
 *
 * Only graph.microsoft.com is called: the base URL is fixed here and the ids
 * are checked against the Graph id patterns before they go into the path.
 * `/content` answers with a redirect to a pre-authenticated download URL;
 * fetch follows it (and drops the Authorization header on the way, as the
 * Fetch standard requires for a cross-origin redirect).
 */

import { isGraphDriveId, isGraphItemId, isHttpsUrl } from "./graph-ids";

export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

/** Metadata check at chat time: small, so a slow Graph cannot hold a chat. */
export const GRAPH_METADATA_TIMEOUT_MS = 5_000;
/** Download of one file (a changed skill zip, a file for the model). */
export const GRAPH_DOWNLOAD_TIMEOUT_MS = 60_000;

export interface DriveItemVersion {
  name: string;
  webUrl: string;
  /** cTag (content version); eTag when Graph sends no cTag. */
  version: string;
  eTag?: string;
  lastModifiedDateTime: string;
  size: number;
  isFile: boolean;
  /** MIME type of a file, when Graph sends one. */
  mimeType?: string;
}

export class GraphFileError extends Error {
  constructor(
    message: string,
    /** HTTP status; undefined for a timeout or a network error. */
    readonly status: number | undefined,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "GraphFileError";
  }
}

export class FileTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The file is larger than ${maxBytes / 1_000_000} MB.`);
    this.name = "FileTooLargeError";
  }
}

/**
 * True when SharePoint says the user may not read the file (or it is gone):
 * 401, 403, 404. Then the skill is NOT used for this user — no fallback to
 * the stored copy, which would show content the user cannot open. The same
 * rule holds for the files the model fetches.
 */
export const isFileAccessDenied = (error: unknown): boolean =>
  error instanceof GraphFileError &&
  (error.status === 401 || error.status === 403 || error.status === 404);

function itemUrl(driveId: string, itemId: string, suffix = ""): string {
  if (!isGraphDriveId(driveId) || !isGraphItemId(itemId)) {
    throw new GraphFileError("Invalid SharePoint file reference.", 400);
  }
  return `${GRAPH_BASE_URL}/drives/${driveId}/items/${itemId}${suffix}`;
}

async function graphFetch(
  url: string,
  token: string,
  timeoutMs: number,
): Promise<Response> {
  if (!token) throw new GraphFileError("No access token.", 401);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      cache: "no-store",
    });
    if (!res.ok) {
      // Drain the body so the socket is freed.
      await res.body?.cancel().catch(() => {});
      throw new GraphFileError(`Graph returned ${res.status}.`, res.status);
    }
    return res;
  } catch (error) {
    if (error instanceof GraphFileError) throw error;
    const name = (error as { name?: string })?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    throw new GraphFileError(
      timedOut
        ? `Graph did not answer within ${timeoutMs} ms.`
        : `Graph request failed: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      timedOut,
    );
  }
}

/** Reads name, version and size of a drive item. */
export async function getDriveItemVersion(
  token: string,
  driveId: string,
  itemId: string,
  timeoutMs = GRAPH_METADATA_TIMEOUT_MS,
): Promise<DriveItemVersion> {
  const url =
    itemUrl(driveId, itemId) +
    "?$select=name,webUrl,cTag,eTag,lastModifiedDateTime,size,file";
  const res = await graphFetch(url, token, timeoutMs);
  const body = (await res.json()) as {
    name?: unknown;
    webUrl?: unknown;
    cTag?: unknown;
    eTag?: unknown;
    lastModifiedDateTime?: unknown;
    size?: unknown;
    file?: { mimeType?: unknown } | null;
  };
  const cTag = typeof body.cTag === "string" && body.cTag ? body.cTag : undefined;
  const eTag = typeof body.eTag === "string" && body.eTag ? body.eTag : undefined;
  const version = cTag ?? eTag;
  if (typeof body.name !== "string" || !version) {
    throw new GraphFileError("Graph returned no file version.", 502);
  }
  return {
    name: body.name,
    webUrl: isHttpsUrl(body.webUrl) ? body.webUrl : "",
    version,
    eTag,
    lastModifiedDateTime:
      typeof body.lastModifiedDateTime === "string" ? body.lastModifiedDateTime : "",
    size: typeof body.size === "number" ? body.size : 0,
    isFile: Boolean(body.file),
    ...(typeof body.file?.mimeType === "string" && body.file.mimeType
      ? { mimeType: body.file.mimeType }
      : {}),
  };
}

/** Reads a response body; stops reading after `maxBytes`. */
async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new FileTooLargeError(maxBytes);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > maxBytes) throw new FileTooLargeError(maxBytes);
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof FileTooLargeError) throw error;
    const name = (error as { name?: string })?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    throw new GraphFileError(
      timedOut ? "Download timed out." : "Download failed.",
      undefined,
      timedOut,
    );
  }
  return Buffer.concat(chunks);
}

/** Downloads a drive item; stops reading after `maxBytes`. */
export async function downloadDriveItem(
  token: string,
  driveId: string,
  itemId: string,
  maxBytes: number,
  timeoutMs = GRAPH_DOWNLOAD_TIMEOUT_MS,
): Promise<Buffer> {
  const res = await graphFetch(itemUrl(driveId, itemId, "/content"), token, timeoutMs);
  return readBodyCapped(res, maxBytes);
}

/** Largest side of a custom thumbnail that is asked for. */
export const MAX_THUMBNAIL_PX = 16_384;

/**
 * Downloads a custom thumbnail of a drive item, scaled by SharePoint to fit
 * `sizePx` x `sizePx` (aspect ratio kept; SharePoint does not enlarge).
 * SharePoint renders it from the original, so the size of the original does
 * not matter. Like `/content`, Graph answers with a redirect that fetch
 * follows. An answer that is not an image (content-type) is refused with
 * status 415 before its body is read. Stops reading after `maxBytes`.
 */
export async function downloadDriveItemThumbnail(
  token: string,
  driveId: string,
  itemId: string,
  sizePx: number,
  maxBytes: number,
  timeoutMs = GRAPH_DOWNLOAD_TIMEOUT_MS,
): Promise<{ data: Buffer; contentType: string }> {
  if (!Number.isInteger(sizePx) || sizePx < 1 || sizePx > MAX_THUMBNAIL_PX) {
    throw new GraphFileError("Invalid thumbnail size.", 400);
  }
  const res = await graphFetch(
    itemUrl(driveId, itemId, `/thumbnails/0/c${sizePx}x${sizePx}/content`),
    token,
    timeoutMs,
  );
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) {
    await res.body?.cancel().catch(() => {});
    throw new GraphFileError("Graph returned no thumbnail image.", 415);
  }
  const data = await readBodyCapped(res, maxBytes);
  return { data, contentType };
}

/** Graph's parentReference of a drive item (only the fields used here). */
export interface DriveItemParent {
  driveId: string;
  /** Id of the parent folder; absent for the root of a drive. */
  id?: string;
}

/** A file or folder as the SharePoint files feature needs it. */
export interface DriveItemInfo {
  id: string;
  name: string;
  webUrl: string;
  size: number;
  lastModifiedDateTime: string;
  isFile: boolean;
  isFolder: boolean;
  parent: DriveItemParent | undefined;
}

const DRIVE_ITEM_SELECT =
  "$select=id,name,webUrl,size,lastModifiedDateTime,file,folder,parentReference";

function toDriveItemInfo(body: unknown): DriveItemInfo | undefined {
  const b = body as {
    id?: unknown;
    name?: unknown;
    webUrl?: unknown;
    size?: unknown;
    lastModifiedDateTime?: unknown;
    file?: unknown;
    folder?: unknown;
    parentReference?: { driveId?: unknown; id?: unknown };
  };
  if (!b || !isGraphItemId(b.id) || typeof b.name !== "string" || !b.name) return undefined;
  const p = b.parentReference;
  return {
    id: b.id,
    name: b.name,
    webUrl: isHttpsUrl(b.webUrl) ? b.webUrl : "",
    size: typeof b.size === "number" && b.size >= 0 ? b.size : 0,
    lastModifiedDateTime: typeof b.lastModifiedDateTime === "string" ? b.lastModifiedDateTime : "",
    isFile: Boolean(b.file),
    isFolder: Boolean(b.folder),
    parent:
      p && isGraphDriveId(p.driveId)
        ? { driveId: p.driveId, id: isGraphItemId(p.id) ? p.id : undefined }
        : undefined,
  };
}

/** Reads one drive item (file or folder) with its parent reference. */
export async function getDriveItemInfo(
  token: string,
  driveId: string,
  itemId: string,
  timeoutMs = GRAPH_METADATA_TIMEOUT_MS,
): Promise<DriveItemInfo> {
  const res = await graphFetch(`${itemUrl(driveId, itemId)}?${DRIVE_ITEM_SELECT}`, token, timeoutMs);
  const info = toDriveItemInfo(await res.json());
  if (!info) throw new GraphFileError("Graph returned no drive item.", 502);
  return info;
}

/** Most children read from one folder (all pages together). */
export const MAX_CHILDREN_PER_FOLDER = 5_000;

/** A listing does not need the web URL of each child: not asked for. */
const CHILDREN_SELECT = "$select=id,name,size,lastModifiedDateTime,file,folder,parentReference";

/**
 * Items several listings may still read together (all sources of one
 * request). Each item read takes one; at 0 the listing stops.
 */
export interface ListingBudget {
  remaining: number;
}

/**
 * The children of a folder, all pages. A next page is only followed when its
 * URL is on the Graph base URL (no other host is ever called with the token).
 * Stops (truncated) after `maxItems`, when the shared `budget` is used up, or
 * at the `deadline` (epoch ms): each call to Graph gets at most the time that
 * is left, and a call that runs into the deadline ends the listing with the
 * items read so far instead of an error.
 */
export async function listDriveItemChildren(
  token: string,
  driveId: string,
  folderId: string,
  options: {
    timeoutMs?: number;
    maxItems?: number;
    budget?: ListingBudget;
    deadline?: number;
  } = {},
): Promise<{ items: DriveItemInfo[]; truncated: boolean }> {
  const maxItems = options.maxItems ?? MAX_CHILDREN_PER_FOLDER;
  const timeoutMs = options.timeoutMs ?? GRAPH_METADATA_TIMEOUT_MS;
  const { budget, deadline } = options;
  const items: DriveItemInfo[] = [];
  let url: string | undefined =
    `${itemUrl(driveId, folderId, "/children")}?${CHILDREN_SELECT}&$top=200`;
  while (url) {
    if (budget && budget.remaining <= 0) return { items, truncated: true };
    const left = deadline === undefined ? timeoutMs : deadline - Date.now();
    if (left <= 0) return { items, truncated: true };
    const callTimeout = Math.min(timeoutMs, left);
    let body: { value?: unknown; "@odata.nextLink"?: unknown };
    try {
      const res = await graphFetch(url, token, callTimeout);
      body = (await res.json()) as typeof body;
    } catch (error) {
      // The deadline, not Graph, ended this call: the listing is incomplete.
      const name = (error as { name?: string })?.name;
      const timedOut =
        (error instanceof GraphFileError && error.timedOut) ||
        name === "TimeoutError" ||
        name === "AbortError";
      if (callTimeout < timeoutMs && timedOut) {
        return { items, truncated: true };
      }
      throw error;
    }
    for (const entry of Array.isArray(body.value) ? body.value : []) {
      const info = toDriveItemInfo(entry);
      if (!info) continue;
      if (items.length >= maxItems) return { items, truncated: true };
      if (budget) {
        if (budget.remaining <= 0) return { items, truncated: true };
        budget.remaining--;
      }
      items.push(info);
    }
    const next = body["@odata.nextLink"];
    url =
      typeof next === "string" && next.startsWith(`${GRAPH_BASE_URL}/`) ? next : undefined;
  }
  return { items, truncated: false };
}
