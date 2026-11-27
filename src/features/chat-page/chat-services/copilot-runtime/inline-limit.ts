/**
 * The inline size limit of the Copilot path, in UTF-8 bytes: text up to this
 * size goes to the model as it is, larger text is saved as a workspace file
 * and the model gets a preview and the path.
 *
 * One setting (COPILOT_TOOL_RESULT_INLINE_BYTES, default 16 KiB) for both:
 *   - large tool results (tool-adapter.ts spillLargeResult), and
 *   - large user text: a big paste in the chat input becomes a text file
 *     upload (chat-page.tsx), and the server saves a big user message as a
 *     file (prompt-spill.ts).
 *
 * No "server-only" and no Node APIs: the chat input imports this module too.
 * The browser cannot read the env var; the server passes the value to the
 * chat page (WorkspaceSummary.pastedTextLimitBytes).
 */

export const DEFAULT_INLINE_BYTES = 16 * 1024;

/** Text up to this many UTF-8 bytes stays inline (COPILOT_TOOL_RESULT_INLINE_BYTES). */
export const inlineResultLimit = (env: Record<string, string | undefined> = process.env): number => {
  const configured = Number(env.COPILOT_TOOL_RESULT_INLINE_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INLINE_BYTES;
};

/** Size of a string in UTF-8 bytes, without allocating a buffer. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A surrogate pair: one code point, 4 bytes.
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/** True when the text is larger than the limit (exactly the limit stays inline). */
export function exceedsInlineLimit(text: string, limit: number): boolean {
  // Every UTF-16 unit is at most 3 bytes: a short text is decided without a count.
  if (text.length * 3 <= limit) return false;
  if (text.length > limit) return true;
  return utf8ByteLength(text) > limit;
}
