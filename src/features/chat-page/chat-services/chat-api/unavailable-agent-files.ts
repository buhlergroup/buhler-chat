/**
 * Code interpreter files of an agent that could not be loaded when the chat
 * started (no access for the user, file moved or deleted, too large, or a
 * download error). The thread keeps their names; the system prompt gets a
 * short note, so the model does not claim the files are there.
 *
 * Names only: no file ids, no URLs. A name comes from SharePoint, so it is
 * cleaned (one line, limited length) before it goes into the prompt.
 */

/** Names kept on a thread at most. */
export const MAX_UNAVAILABLE_AGENT_FILES = 20;

const MAX_NAME_LENGTH = 120;

/** One line, no control characters, at most 120 characters. */
export function cleanFileNameForPrompt(name: string): string {
  const isControl = (code: number) =>
    code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
  const oneLine = Array.from(name, (ch) => (isControl(ch.codePointAt(0) ?? 0) ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(oneLine);
  return chars.length > MAX_NAME_LENGTH
    ? `${chars.slice(0, MAX_NAME_LENGTH - 1).join("")}…`
    : oneLine;
}

/** The names to store on the thread: cleaned, unique, at most 20. */
export function unavailableAgentFileNames(names: ReadonlyArray<string>): string[] {
  const cleaned = names.map(cleanFileNameForPrompt).filter((n) => n.length > 0);
  return [...new Set(cleaned)].slice(0, MAX_UNAVAILABLE_AGENT_FILES);
}

/** Largest count told to the model (a stored value is not trusted blindly). */
const MAX_NOT_FOUND_COUNT = 1000;

const notFoundCount = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_NOT_FOUND_COUNT)
    : 0;

/**
 * The note for the system prompt; "" when every file was loaded. `names` are
 * the files that could not be loaded; `notFound` counts the files whose
 * stored entry was not found (no name, no id). Sorted, so the text is the
 * same on every turn (prompt cache).
 */
export function buildUnavailableAgentFilesPrompt(
  names: ReadonlyArray<string> | undefined,
  notFound?: number,
): string {
  const list = unavailableAgentFileNames(names ?? []).sort();
  const missing = notFoundCount(notFound);
  if (list.length === 0 && missing === 0) return "";
  const lines: string[] = [];
  if (list.length > 0) {
    lines.push(
      "These code interpreter files of the agent could not be loaded for this chat, " +
        "maybe because the user has no access to them, or they were moved or deleted: " +
        list.map((n) => JSON.stringify(n)).join(", ") +
        ".",
    );
  }
  if (missing > 0) {
    lines.push(
      list.length > 0
        ? `${missing} further agent file(s) could not be found.`
        : `${missing} agent file(s) could not be found for this chat.`,
    );
  }
  return (
    "\n\n## Agent files not loaded\n" +
    lines.join(" ") +
    " They are not in the code interpreter. If a task needs one of them, " +
    "tell the user in one short sentence and continue without it."
  );
}
