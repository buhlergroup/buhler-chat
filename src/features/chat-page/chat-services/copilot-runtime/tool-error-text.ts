/**
 * The error text the model gets when a workspace tool (view, rg / grep,
 * glob) fails. The runtime also streams this text to the chat and stores it
 * with the message, so it must not carry storage details: an Azure error
 * message names the storage URL, and our own ENOENT of a data blob names the
 * thread's namespace (user key and thread id).
 *
 * Our own errors with a text written for the model (path jail, file too
 * large, quotas) keep their text; everything else gets a short fixed text.
 */
const OWN_ERRORS: ReadonlySet<string> = new Set([
  "SessionPathError",
  "FileTooLargeError",
  "WorkspaceQuotaError",
  "SessionStateFullError",
]);

export function workspaceToolErrorText(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; message?: unknown } | undefined;
  if (err instanceof Error && typeof e?.name === "string" && OWN_ERRORS.has(e.name)) return `Error: ${err.message}`;
  if (e?.code === "ENOENT") return "Error: the file does not exist (any more).";
  return "Error: the workspace storage could not be read. Try again.";
}
