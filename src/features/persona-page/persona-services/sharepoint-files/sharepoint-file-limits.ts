import "server-only";

/**
 * Limits of the SharePoint files feature. Each one can be set with an
 * environment variable (see .env.example); a missing or invalid value
 * (not a whole number, zero, negative, above the hard maximum) uses the
 * default.
 */
export interface SharePointFileLimits {
  /** Linked folders + files per agent. */
  maxSources: number;
  /** fetch_sharepoint_file downloads per chat request. */
  maxFetchesPerRequest: number;
  /**
   * Largest file the model may fetch; reading stops beyond it. Not for an
   * image that comes as SharePoint's preview image (see imageMaxPx).
   */
  maxFileBytes: number;
  /**
   * Longest image side after a fetch: the size of the SharePoint preview
   * image that is asked for, and the limit an original image is scaled to.
   */
  imageMaxPx: number;
}

/** Fixed rules (not configurable). */
export const SHAREPOINT_FILE_RULES = {
  /** find_sharepoint_files returns at most this many files. */
  maxFindResults: 50,
  /** Folder levels below a linked folder: 1 = only its own files. */
  maxDepth: 3,
  /** Folders read per linked folder for one listing. */
  maxFoldersPerSource: 100,
  /** Files kept from all linked sources for one listing. */
  maxListedFiles: 5_000,
  /** JPEG quality of converted and resized images. */
  jpegQuality: 85,
  /** Largest SharePoint preview image (thumbnail) read; reading stops beyond it. */
  maxPreviewBytes: 20_000_000,
  /**
   * JPEG, PNG, GIF and WebP originals up to this size are downloaded as they
   * are instead of as a preview: no JPEG re-encoding, PNG transparency, GIF
   * animation and EXIF data are kept, and the download is small anyway.
   */
  maxOriginalImageBytes: 2_000_000,
} as const;

export const SHAREPOINT_FILE_LIMIT_DEFAULTS = {
  maxSources: 10,
  maxFetchesPerRequest: 10,
  maxFileMb: 50,
  imageMaxPx: 2560,
} as const;

const readInt = (value: string | undefined, fallback: number, max: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value.trim());
  return Number.isInteger(n) && n > 0 && n <= max ? n : fallback;
};

export function readSharePointFileLimits(
  env: Record<string, string | undefined> = process.env,
): SharePointFileLimits {
  const d = SHAREPOINT_FILE_LIMIT_DEFAULTS;
  return {
    maxSources: readInt(env.SHAREPOINT_FILES_MAX_SOURCES, d.maxSources, 100),
    maxFetchesPerRequest: readInt(
      env.SHAREPOINT_FILES_MAX_FETCHES_PER_REQUEST,
      d.maxFetchesPerRequest,
      100,
    ),
    // 512 MB is the code interpreter's own limit per file.
    maxFileBytes: readInt(env.SHAREPOINT_FILES_MAX_FILE_MB, d.maxFileMb, 512) * 1_000_000,
    imageMaxPx: readInt(env.SHAREPOINT_FILES_IMAGE_MAX_PX, d.imageMaxPx, 16_384),
  };
}
