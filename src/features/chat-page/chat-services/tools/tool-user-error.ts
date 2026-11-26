/**
 * A tool failure whose message may be shown to the user: it names the tool
 * and the reason. The chat stream shows its UI text on the failed tool call.
 * Every other error shows as "An error occurred." (the AI SDK default),
 * because its text can carry internal details. The model gets the full
 * message in both cases.
 *
 * The message can contain text of an outside server (for example the error
 * text of an MCP tool, which may echo a URL, a header or a token). So the UI
 * text is always cleaned (sanitizeUiErrorText): URLs, credentials and long
 * key-like runs are replaced, and the length is limited. A tool can set its
 * own `uiMessage`; it is cleaned too.
 */
export class ToolUserError extends Error {
  readonly uiMessage?: string;

  constructor(message: string, options?: { uiMessage?: string }) {
    super(message);
    this.name = "ToolUserError";
    this.uiMessage = options?.uiMessage;
  }
}

const GENERIC_ERROR_TEXT = "An error occurred.";

/** Longest error text shown in the UI. */
export const MAX_UI_ERROR_CHARS = 300;

const URL_PATTERN = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s"'<>()]+/gi;
const AUTH_SCHEME_PATTERN = /\b(Bearer|bearer|BEARER|Basic|basic|BASIC)\s+[A-Za-z0-9._~+/=-]{8,}/g;
// key=value, key: value, "key": "value" for names that usually carry a secret.
const SECRET_PAIR_PATTERN =
  /\b([A-Za-z0-9_-]*(?:key|token|secret|password|passwd|pwd|sig|signature|credential)[A-Za-z0-9_-]*)("?\s*[:=]\s*"?)([^\s"',;&]+)/gi;
// Long base64, base64url or hex-like runs (> 32 characters).
const LONG_RUN_PATTERN = /[A-Za-z0-9+/=_-]{33,}/g;

/**
 * The text of an error as it may be shown in the UI: URLs become "[url]",
 * Bearer/Basic credentials and secret-like key/value pairs "[redacted]",
 * long base64/hex-like runs "[redacted]", one line, at most 300 characters.
 */
export function sanitizeUiErrorText(text: string): string {
  const cleaned = text
    .replace(URL_PATTERN, "[url]")
    .replace(AUTH_SCHEME_PATTERN, (_m, scheme: string) => `${scheme} [redacted]`)
    .replace(SECRET_PAIR_PATTERN, (_m, name: string, sep: string) => `${name}${sep}[redacted]`)
    .replace(LONG_RUN_PATTERN, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > MAX_UI_ERROR_CHARS
    ? `${chars.slice(0, MAX_UI_ERROR_CHARS - 1).join("")}…`
    : cleaned;
}

const isToolUserError = (error: unknown): error is ToolUserError =>
  error instanceof ToolUserError ||
  ((error as { name?: unknown })?.name === "ToolUserError" && error instanceof Error);

/** Error text for the UI stream: the cleaned text of a ToolUserError, else the generic text. */
export function uiErrorText(error: unknown): string {
  if (!isToolUserError(error)) return GENERIC_ERROR_TEXT;
  const own = (error as { uiMessage?: unknown }).uiMessage;
  const text = sanitizeUiErrorText(typeof own === "string" && own ? own : error.message);
  return text || GENERIC_ERROR_TEXT;
}
