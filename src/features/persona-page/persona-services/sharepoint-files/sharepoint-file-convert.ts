import "server-only";

/**
 * Prepares a fetched SharePoint file for the code interpreter:
 *   - a SharePoint preview image (thumbnail) gets the original's base name
 *     with the extension of its own format ("photo.tif" -> "photo.jpg");
 *   - TIFF and BMP become JPEG (the code interpreter does not take them);
 *   - an image whose longer side is above `imageMaxPx` is scaled down
 *     (aspect ratio kept, EXIF orientation applied first, so the result
 *     shows the right way up);
 *   - everything else is passed through unchanged.
 * The caller has already refused unsupported types (fileTypeRule).
 */

import sharp, { type Metadata, type Sharp } from "sharp";
import { SHAREPOINT_FILE_RULES } from "./sharepoint-file-limits";
import { fileExtension, fileTypeRule } from "./sharepoint-file-models";

export class FileConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileConversionError";
  }
}

export interface PreparedFile {
  name: string;
  data: Buffer;
  /** What was changed, for the model ("converted from TIFF", "resized ..."). */
  note?: string;
  width?: number;
  height?: number;
}

/**
 * Decoded pixels may not exceed this: a small, highly compressed PNG or GIF
 * can hold a pixel bomb. 40 MP (about 160 MB of RGBA) covers normal photos;
 * larger images come as SharePoint's preview image (imageMaxPx) anyway.
 */
export const MAX_INPUT_PIXELS = 40_000_000;

/**
 * sharp input with the pixel limit, first page / frame only: an animated GIF
 * or WebP, or a multi-page TIFF, is never decoded with all its frames.
 */
const firstFrame = (data: Buffer): Sharp =>
  sharp(data, { page: 0, pages: 1, limitInputPixels: MAX_INPUT_PIXELS });

const PIXEL_LIMIT_MESSAGE =
  `The image has more than ${MAX_INPUT_PIXELS / 1_000_000} megapixels and cannot be read. ` +
  "Ask the user for a smaller copy.";

const isPixelLimitError = (error: unknown): boolean =>
  error instanceof Error && /pixel limit/i.test(error.message);

const replaceExtension = (name: string, ext: string): string => {
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
};

/**
 * Minimal BMP decoder (sharp's prebuilt libvips cannot read BMP): only
 * uncompressed 24- and 32-bit images (BI_RGB, or BI_BITFIELDS with the usual
 * BGRA masks). Anything else is refused.
 */
export function decodeBmp(buf: Buffer): {
  data: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
} {
  const fail = () => {
    throw new FileConversionError(
      "This BMP format is not supported (only uncompressed 24- or 32-bit). Use a PNG or JPEG.",
    );
  };
  if (buf.length < 54 || buf.toString("latin1", 0, 2) !== "BM") fail();
  const pixelOffset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  if (headerSize < 40) fail();
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  if (width <= 0 || height <= 0 || width * height > MAX_INPUT_PIXELS) fail();
  if (bpp !== 24 && bpp !== 32) fail();
  if (compression === 3) {
    if (bpp !== 32 || headerSize < 52) fail();
    const r = buf.readUInt32LE(54);
    const g = buf.readUInt32LE(58);
    const b = buf.readUInt32LE(62);
    if (r !== 0x00ff0000 || g !== 0x0000ff00 || b !== 0x000000ff) fail();
  } else if (compression !== 0) {
    fail();
  }
  const srcBytes = bpp / 8;
  const rowSize = Math.ceil((width * bpp) / 32) * 4;
  if (pixelOffset + rowSize * height > buf.length) fail();
  // 32-bit BI_RGB has an unused fourth byte; BI_BITFIELDS may carry alpha
  // but most writers leave it zero, so alpha is dropped for both.
  const channels = 3;
  const out = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    const srcRow = pixelOffset + (topDown ? y : height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * srcBytes;
      const d = (y * width + x) * channels;
      out[d] = buf[s + 2];
      out[d + 1] = buf[s + 1];
      out[d + 2] = buf[s];
    }
  }
  return { data: out, width, height, channels };
}

/** Width/height as shown, i.e. after the EXIF orientation is applied. */
const orientedSize = (meta: Metadata): { width: number; height: number } => {
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  return (meta.orientation ?? 1) >= 5 ? { width: h, height: w } : { width: w, height: h };
};

export async function prepareFileForCodeInterpreter(
  name: string,
  data: Buffer,
  options: { imageMaxPx: number },
): Promise<PreparedFile> {
  const rule = fileTypeRule(name);
  if (rule.kind === "refused") throw new FileConversionError(rule.message);
  if (rule.kind === "as-is") return { name, data };
  if (rule.previewOnlyMessage) throw new FileConversionError(rule.previewOnlyMessage);

  const ext = fileExtension(name);
  const maxPx = options.imageMaxPx;
  const quality = SHAREPOINT_FILE_RULES.jpegQuality;
  const fit = { width: maxPx, height: maxPx, fit: "inside" as const, withoutEnlargement: true };

  try {
    if (rule.convertToJpeg) {
      let input: Sharp;
      if (ext === "bmp") {
        const bmp = decodeBmp(data);
        input = sharp(bmp.data, {
          raw: { width: bmp.width, height: bmp.height, channels: bmp.channels },
          limitInputPixels: MAX_INPUT_PIXELS,
        });
      } else {
        // First page of a multi-page TIFF.
        input = firstFrame(data);
      }
      const { data: out, info } = await input
        .rotate()
        .resize(fit)
        .flatten({ background: "#ffffff" })
        .toColourspace("srgb")
        .jpeg({ quality })
        .toBuffer({ resolveWithObject: true });
      return {
        name: replaceExtension(name, "jpg"),
        data: out,
        note: `Converted from ${ext.toUpperCase()} to JPEG (${info.width}x${info.height} px).`,
        width: info.width,
        height: info.height,
      };
    }

    // Header only (no pixels decoded); width/height of the first frame.
    const meta = await firstFrame(data).metadata();
    const { width, height } = orientedSize(meta);
    if (Math.max(width, height) <= maxPx) {
      // Passed through as it is: an animation is kept.
      return { name, data, width, height };
    }
    let pipeline = firstFrame(data).rotate().resize(fit);
    if (ext === "jpg" || ext === "jpeg") pipeline = pipeline.jpeg({ quality });
    else if (ext === "png") pipeline = pipeline.png();
    else if (ext === "webp") pipeline = pipeline.webp({ quality });
    else pipeline = pipeline.gif();
    const { data: out, info } = await pipeline.toBuffer({ resolveWithObject: true });
    const frames = (meta.pages ?? 1) > 1 ? " Only the first frame of the animation is kept." : "";
    return {
      name,
      data: out,
      note: `Resized from ${width}x${height} to ${info.width}x${info.height} px.${frames}`,
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    if (error instanceof FileConversionError) throw error;
    if (isPixelLimitError(error)) throw new FileConversionError(PIXEL_LIMIT_MESSAGE);
    throw new FileConversionError(
      `The image could not be read (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

/** Formats a SharePoint preview image may have, and their file extension. */
const PREVIEW_EXTENSIONS = new Map<string, string>([
  ["jpeg", "jpg"],
  ["png", "png"],
  ["webp", "webp"],
  ["gif", "gif"],
]);

/**
 * Prepares a SharePoint preview image (thumbnail) of `originalName`: the
 * name keeps the original's base name with the extension of the preview's
 * real format (read from its bytes, not from the content-type), and the
 * pixel size is read with sharp. A preview above `imageMaxPx` (SharePoint
 * should not send one) is scaled down like any image.
 */
export async function preparePreviewForCodeInterpreter(
  originalName: string,
  data: Buffer,
  options: { imageMaxPx: number },
): Promise<PreparedFile> {
  let format: string | undefined;
  try {
    format = (await firstFrame(data).metadata()).format;
  } catch (error) {
    throw new FileConversionError(
      `The preview image could not be read (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  const ext = format ? PREVIEW_EXTENSIONS.get(format) : undefined;
  if (!ext) throw new FileConversionError(`The preview image has an unsupported format (${format}).`);
  return prepareFileForCodeInterpreter(replaceExtension(originalName, ext), data, options);
}
