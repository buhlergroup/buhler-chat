/**
 * A tool failure whose message is safe to show to the user: it names the
 * tool and the reason, never a URL, header, secret or stack. The chat stream
 * shows its message on the failed tool call. Every other error shows as
 * "An error occurred." (the AI SDK default), because its text can carry
 * internal details. The model gets the message in both cases.
 */
export class ToolUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolUserError";
  }
}

const GENERIC_ERROR_TEXT = "An error occurred.";

/** Error text for the UI stream: the message of a ToolUserError, else the generic text. */
export function uiErrorText(error: unknown): string {
  if (error instanceof ToolUserError) return error.message;
  if ((error as { name?: unknown })?.name === "ToolUserError" && error instanceof Error) {
    return error.message;
  }
  return GENERIC_ERROR_TEXT;
}
