/**
 * Safety net for a very large user message on the Copilot path (a typed or
 * pasted text, an API call, an old client that does not turn a big paste into
 * a file).
 *
 * A message over the inline limit (inline-limit.ts, the same setting as large
 * tool results) is saved in full as /workspace/uploads/pasted-text-<id>.txt.
 * The model gets a short note in the USER message instead: the path, the size
 * and a preview, in the style of spillLargeResult (tool-adapter.ts). Nothing
 * goes into the system message, so it stays the same on every turn.
 *
 * The chat history (Cosmos, UI) keeps the message as the user sent it; only
 * the text sent to the model changes.
 */
import { inlineResultLimit, exceedsInlineLimit, utf8ByteLength } from "./inline-limit";
import { RESULT_PREVIEW_BYTES, utf8Prefix } from "./tool-adapter";

const NL = String.fromCharCode(10);

export interface PromptSpill {
  /** The text for the model: the message itself, or the note when it was saved. */
  prompt: string;
  /** Workspace path of the saved text, when the message was too large. */
  savedTo?: string;
  /** Size of the saved text in UTF-8 bytes. */
  bytes?: number;
}

/** File name of a saved message: pasted-text-<id>.txt, with a safe id. */
export function pastedTextFileName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "message";
  return `pasted-text-${safe}.txt`;
}

/** The note the model gets in place of a saved message. */
export function pastedTextNote(path: string, text: string): string {
  const bytes = utf8ByteLength(text);
  const preview = utf8Prefix(text, RESULT_PREVIEW_BYTES);
  return (
    `The user's message was too long to send inline. The full text (${bytes} bytes) is saved at ${path}. ` +
    `The first ${utf8ByteLength(preview)} bytes:${NL}${preview}${NL}[...]${NL}` +
    `Read the rest of ${path} with view (use a line range) or rg before you answer: the request may be at the end.`
  );
}

/**
 * Saves the message as a workspace file when it is over the limit.
 * `store` writes the file (storeUpload: /workspace/uploads, unique name,
 * workspace quota) and returns its path.
 */
export async function spillLargePrompt(
  text: string,
  args: {
    id: string;
    store: (fileName: string, data: Buffer) => Promise<{ path: string }>;
    limit?: number;
  },
): Promise<PromptSpill> {
  const limit = args.limit ?? inlineResultLimit();
  if (!exceedsInlineLimit(text, limit)) return { prompt: text };
  const data = Buffer.from(text, "utf8");
  const { path } = await args.store(pastedTextFileName(args.id), data);
  return { prompt: pastedTextNote(path, text), savedTo: path, bytes: data.length };
}
