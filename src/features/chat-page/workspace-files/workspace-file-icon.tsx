import {
  File as FileIcon,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Presentation,
} from "lucide-react";
import type { FC } from "react";

type IconKind = { kind: string; Icon: typeof FileIcon; className: string };
const BY_EXTENSION: Record<string, IconKind> = {};
const add = (extensions: string[], kind: string, Icon: typeof FileIcon, className: string) => {
  for (const ext of extensions) BY_EXTENSION[ext] = { kind, Icon, className };
};
add(["xlsx", "xls", "csv", "tsv"], "spreadsheet", FileSpreadsheet, "text-green-600");
add(["pdf", "doc", "docx", "txt", "md", "rtf", "log"], "text", FileText, "text-blue-600");
add(["ppt", "pptx"], "slides", Presentation, "text-orange-600");
add(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "svg", "heic", "heif"], "image", FileImage, "text-purple-600");
add(
  ["js", "ts", "tsx", "jsx", "py", "json", "xml", "yml", "yaml", "html", "htm", "css", "sql", "sh", "ps1", "cs", "java", "c", "cpp", "go", "rs", "toml", "ini"],
  "code",
  FileCode,
  "text-sky-600",
);
add(["zip", "tar", "gz", "tgz", "7z"], "archive", FileArchive, "text-amber-600");

/** The file icon for a file name, by its extension. */
export const WorkspaceFileIcon: FC<{ name: string; className?: string }> = ({ name, className }) => {
  const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  const { kind, Icon, className: color } = BY_EXTENSION[ext] ?? { kind: "file", Icon: FileIcon, className: "text-muted-foreground" };
  return <Icon aria-hidden="true" data-file-kind={kind} className={`h-4 w-4 shrink-0 ${color} ${className ?? ""}`} />;
};

/** Download URL of a workspace file (path relative to /workspace). */
export const workspaceFileUrl = (threadId: string, path: string): string =>
  `/api/workspace/file?t=${encodeURIComponent(threadId)}&p=${encodeURIComponent(path)}`;

/** "1.2 MB", "340 KB", "12 B". */
export const formatFileSize = (bytes: number | undefined): string => {
  if (bytes === undefined || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
