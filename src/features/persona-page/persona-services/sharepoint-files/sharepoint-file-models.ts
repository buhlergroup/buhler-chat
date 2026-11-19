import { z } from "zod";
import {
  GRAPH_DRIVE_ID_PATTERN,
  GRAPH_ITEM_ID_PATTERN,
  isHttpsUrl,
} from "@/features/common/services/sharepoint/graph-ids";
import { CODE_INTERPRETER_SUPPORTED_EXTENSIONS } from "@/features/chat-page/chat-services/code-interpreter-constants";

/**
 * SharePoint files for the model: an agent links SharePoint folders or files
 * (its "sources"); during a chat the model lists files inside them
 * (find_sharepoint_files) and fetches single files into the code interpreter
 * (fetch_sharepoint_file), always with the chatting user's token.
 *
 * No server-only import: the agent editor uses the types and the file-type
 * rules too.
 */

export const PERSONA_FILE_SOURCE_ATTRIBUTE = "PERSONA_SHAREPOINT_FILE_SOURCE";

export const FILE_SOURCE_KINDS = ["folder", "file"] as const;
export type FileSourceKind = (typeof FILE_SOURCE_KINDS)[number];

/**
 * One linked folder or file of an agent. One Cosmos row each, partition =
 * the agent owner's hashed id (like the persona row). Name and link come
 * from Graph when the source is added; the client only sends the ids.
 */
export const PersonaFileSourceModelSchema = z.object({
  id: z.string().min(1),
  type: z.literal(PERSONA_FILE_SOURCE_ATTRIBUTE),
  userId: z.string().min(1),
  personaId: z.string().min(1),
  driveId: z.string().regex(GRAPH_DRIVE_ID_PATTERN),
  itemId: z.string().regex(GRAPH_ITEM_ID_PATTERN),
  name: z.string().min(1).max(255),
  webUrl: z.string().refine((v) => v === "" || isHttpsUrl(v), "Must be an https URL"),
  kind: z.enum(FILE_SOURCE_KINDS),
  createdAt: z.coerce.date(),
});
export type PersonaFileSourceModel = z.infer<typeof PersonaFileSourceModelSchema>;

/** What the editor shows of a source. */
export interface PersonaFileSourceSummary {
  id: string;
  name: string;
  webUrl: string;
  kind: FileSourceKind;
  createdAt: string;
}

export const toFileSourceSummary = (s: PersonaFileSourceModel): PersonaFileSourceSummary => ({
  id: s.id,
  name: s.name,
  webUrl: isHttpsUrl(s.webUrl) ? s.webUrl : "",
  kind: s.kind,
  createdAt: new Date(s.createdAt).toISOString(),
});

// ---------------------------------------------------------------------------
// File types
// ---------------------------------------------------------------------------

/** Image types the code interpreter does not take; converted to JPEG. */
export const CONVERTED_TO_JPEG_EXTENSIONS = ["TIF", "TIFF", "BMP"] as const;

/** Lower-case extension without the dot ("" when there is none). */
export const fileExtension = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
};

export type FileTypeRule =
  | { kind: "as-is" }
  | { kind: "image"; convertToJpeg: boolean }
  | { kind: "refused"; message: string };

const RESIZABLE_IMAGES = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

/**
 * What happens to a file of this name: the code interpreter's own types
 * (ZIP included) go as they are, images may be resized, TIFF/BMP become
 * JPEG, everything else is refused with a message for the model.
 */
export function fileTypeRule(name: string): FileTypeRule {
  const ext = fileExtension(name);
  if (!ext) {
    return { kind: "refused", message: "Files without an extension are not supported." };
  }
  if ((CONVERTED_TO_JPEG_EXTENSIONS as readonly string[]).includes(ext.toUpperCase())) {
    return { kind: "image", convertToJpeg: true };
  }
  if (RESIZABLE_IMAGES.has(ext)) return { kind: "image", convertToJpeg: false };
  if (CODE_INTERPRETER_SUPPORTED_EXTENSIONS.includes(ext.toUpperCase())) return { kind: "as-is" };
  if (ext === "psd") {
    return {
      kind: "refused",
      message:
        "Photoshop files (.psd) are not supported. Use a JPEG, PNG or TIFF export of the same image.",
    };
  }
  return {
    kind: "refused",
    message: `Files of type .${ext} are not supported. Supported: ${supportedExtensionsText()}.`,
  };
}

export const supportedExtensionsText = (): string =>
  [
    ...CODE_INTERPRETER_SUPPORTED_EXTENSIONS,
    ...CONVERTED_TO_JPEG_EXTENSIONS,
  ]
    .map((e) => `.${e.toLowerCase()}`)
    .join(", ");

/** File extensions for the SharePoint picker ("Add file"). */
export const pickerFileFilters = (): string[] =>
  [...CODE_INTERPRETER_SUPPORTED_EXTENSIONS, ...CONVERTED_TO_JPEG_EXTENSIONS].map(
    (e) => `.${e.toLowerCase()}`,
  );
