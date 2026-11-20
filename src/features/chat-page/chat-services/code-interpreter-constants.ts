// Supported file extensions for Code Interpreter
export const DEFAULT_CODE_INTERPRETER_FILE_LIMIT = 20;

export function getCodeInterpreterFileLimit(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CODE_INTERPRETER_FILE_LIMIT;
}

/** Largest code interpreter file of an agent, in bytes (512 MB). */
export const DEFAULT_CODE_INTERPRETER_MAX_FILE_BYTES = 536870912;

/**
 * Size limit per code interpreter file of an agent, in bytes. The one reader
 * for the agent editor (Code files) and the chat start (preload): the first
 * valid value of MAX_PERSONA_CI_DOCUMENT_SIZE, then
 * NEXT_PUBLIC_MAX_PERSONA_CI_DOCUMENT_SIZE, else 512 MB.
 */
export function readCodeInterpreterMaxFileBytes(
  env: Record<string, string | undefined> = process.env
): number {
  for (const value of [
    env.MAX_PERSONA_CI_DOCUMENT_SIZE,
    env.NEXT_PUBLIC_MAX_PERSONA_CI_DOCUMENT_SIZE,
  ]) {
    const parsed = Number(value);
    if (value?.trim() && Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_CODE_INTERPRETER_MAX_FILE_BYTES;
}

export const CODE_INTERPRETER_SUPPORTED_EXTENSIONS = [
  // Data files
  "CSV", "JSON", "XML", "XLSX", "XLS",
  // Documents
  "PDF", "TXT", "MD", "HTML", "HTM",
  // Code files
  "PY", "JS", "TS", "C", "CPP", "H", "HPP", "JAVA", "CS", "PHP", "RB", "TEX",
  // Config files
  "CSS", "SH", "BAT",
  // Images (for analysis)
  "JPEG", "JPG", "PNG", "GIF", "WEBP",
  // Archives
  "ZIP", "TAR",
  // Other
  "PKL", "PPTX", "DOCX"
];

/**
 * Check if a file extension is supported by Code Interpreter
 */
export function isCodeInterpreterSupportedFile(fileName: string): boolean {
  const extension = fileName.split(".").pop()?.toUpperCase();
  return !!extension && CODE_INTERPRETER_SUPPORTED_EXTENSIONS.includes(extension);
}
