// Checks for blob names built from values that are not constants in the code
// (thread ids, file names from uploads or from the code interpreter).
//
// The storage SDK resolves "." and ".." segments in a blob URL, so a name
// such as "thread/../other/file" leaves the prefix it was built under.

import { isValidId } from "./odata-filter";

const MAX_FILE_NAME_LENGTH = 200;
const MAX_BLOB_PATH_LENGTH = 1024;

// C0 controls, DEL and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A single blob file name: no path separators, no "..", no control
 * characters, not empty, at most 200 characters.
 */
export const isSafeBlobFileName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_FILE_NAME_LENGTH &&
  value.trim() === value &&
  !value.includes("/") &&
  !value.includes("\\") &&
  !value.includes("..") &&
  value !== "." &&
  !CONTROL_CHARS.test(value);

/**
 * A blob path of one or more segments ("a/b/c.zip"): no backslash, no
 * control characters, no empty, "." or ".." segment, no leading slash.
 */
export const isSafeBlobPath = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_BLOB_PATH_LENGTH) return false;
  if (value.includes("\\") || CONTROL_CHARS.test(value)) return false;
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
};

/**
 * `${prefix}/${fileName}` for a thread-scoped blob. Throws when the thread id
 * is not an id of this app, the file name is not a safe single name, or the
 * normalised result does not stay under `${prefix}/`.
 */
export const threadBlobPath = (threadId: unknown, fileName: unknown): string => {
  if (!isValidId(threadId)) {
    throw new Error("Invalid thread id for blob path");
  }
  if (!isSafeBlobFileName(fileName)) {
    throw new Error("Invalid file name for blob path");
  }
  const path = `${threadId}/${fileName}`;
  if (!isSafeBlobPath(path) || !normalisePosix(path).startsWith(`${threadId}/`)) {
    throw new Error("Blob path leaves its prefix");
  }
  return path;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A lowercase hex SHA-256 digest (64 characters). */
export const isSha256Hex = (value: unknown): value is string =>
  typeof value === "string" && SHA256_HEX.test(value);

/** Suffixes of the blobs the content store keeps next to the content. */
export type ContentBlobSuffix = "" | ".md";

export const CONTENT_BLOB_PREFIX = "content";

/**
 * `content/${scope}/sha256/${hash}${suffix}` for the content store. Throws
 * when the scope is not an id of this app (a user hash), the hash is not a
 * lowercase SHA-256 hex digest, the suffix is unknown, or the normalised
 * result does not stay under `content/${scope}/sha256/`.
 */
export const contentBlobPath = (
  scope: unknown,
  sha256: unknown,
  suffix: ContentBlobSuffix = ""
): string => {
  if (!isValidId(scope)) {
    throw new Error("Invalid scope for content blob path");
  }
  if (!isSha256Hex(sha256)) {
    throw new Error("Invalid hash for content blob path");
  }
  if (suffix !== "" && suffix !== ".md") {
    throw new Error("Invalid suffix for content blob path");
  }
  const prefix = `${CONTENT_BLOB_PREFIX}/${scope}/sha256/`;
  const path = `${prefix}${sha256}${suffix}`;
  if (!isSafeBlobPath(path) || !normalisePosix(path).startsWith(prefix)) {
    throw new Error("Blob path leaves its prefix");
  }
  return path;
};

/**
 * The parts of a content store blob name, or undefined when the name is not
 * one contentBlobPath builds (the cleanup skips such blobs).
 */
export const parseContentBlobPath = (
  path: string
): { scope: string; sha256: string; suffix: ContentBlobSuffix } | undefined => {
  const match = /^content\/([^/]+)\/sha256\/([0-9a-f]{64})(\.md)?$/.exec(path);
  if (!match || !isValidId(match[1])) return undefined;
  return { scope: match[1], sha256: match[2], suffix: (match[3] ?? "") as ContentBlobSuffix };
};

/**
 * Turns any file name (for example one the code interpreter chose) into a
 * safe single blob file name: the last path segment, control characters and
 * separators replaced, ".." broken up, length capped with the extension kept.
 */
export const toSafeBlobFileName = (value: string): string => {
  const base = String(value ?? "").split(/[\\/]/).pop() ?? "";
  let name = base
    .replace(new RegExp(CONTROL_CHARS.source, "g"), "_")
    .replace(/\.{2,}/g, "_")
    .trim();
  if (name.length > MAX_FILE_NAME_LENGTH) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = (name.slice(0, MAX_FILE_NAME_LENGTH - ext.length).trim() + ext).trim();
  }
  if (name === "" || name === ".") name = "file";
  return name;
};

// Resolves "." and ".." the way a URL path is resolved.
const normalisePosix = (path: string): string => {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/") + (path.endsWith("/") ? "/" : "");
};
