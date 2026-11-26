// Content types and Content-Disposition values for files this app serves back
// to the browser (chat images, code interpreter files).

/** The only types a file may be served with inline. */
export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/**
 * Types a stored file may keep. Anything else (for example image/svg+xml,
 * text/html, application/xhtml+xml, text/xml) is stored and served as
 * application/octet-stream, so a browser never renders it.
 */
const STORABLE_TYPES: ReadonlySet<string> = new Set([
  ...INLINE_IMAGE_TYPES,
  "text/csv",
  "text/plain",
  "application/json",
  "application/pdf",
  "application/zip",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export const OCTET_STREAM = "application/octet-stream";

/** The media type without parameters, lowercase ("Image/PNG; x=y" -> "image/png"). */
export const mediaTypeEssence = (value: string | null | undefined): string =>
  String(value ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

/** The stored content type for a file: a known type, else octet-stream. */
export const storableContentType = (value: string | null | undefined): string => {
  const essence = mediaTypeEssence(value);
  if (essence === "image/jpg") return "image/jpeg";
  return STORABLE_TYPES.has(essence) ? essence : OCTET_STREAM;
};

/**
 * The raster image type the first bytes show, or null. Checks PNG, JPEG,
 * GIF and WebP signatures only.
 */
export const sniffRasterImageType = (bytes: Uint8Array): string | null => {
  const at = (i: number) => (i < bytes.length ? bytes[i] : -1);
  const ascii = (start: number, text: string) =>
    [...text].every((ch, i) => at(start + i) === ch.charCodeAt(0));

  if (
    at(0) === 0x89 &&
    ascii(1, "PNG") &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return "image/png";
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
};

/** Bytes needed by sniffRasterImageType. */
export const SNIFF_BYTES = 12;

// RFC 5987 attr-char: ALPHA / DIGIT / "!#$&+-.^_`|~". encodeURIComponent
// leaves "'()*" as is, so those are encoded here too.
const encodeRfc5987 = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );

/**
 * A Content-Disposition header value with an ASCII `filename` fallback
 * (quotes, backslashes and non-printable or non-ASCII characters removed or
 * replaced) and an RFC 6266 `filename*=UTF-8''…` for the real name. Never
 * throws, also for names that are not Latin-1.
 */
export const contentDisposition = (
  kind: "inline" | "attachment",
  fileName: string | null | undefined
): string => {
  const name = String(fileName ?? "").trim() || "download";
  const fallback =
    name
      .replace(/["\\]/g, "")
      .replace(/[^\x20-\x7e]/g, "_")
      .trim() || "download";
  let encoded: string;
  try {
    encoded = encodeRfc5987(name);
  } catch {
    // A lone surrogate cannot be UTF-8 encoded.
    encoded = encodeRfc5987(fallback);
  }
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};
