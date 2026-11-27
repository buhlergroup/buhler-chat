import { exceedsInlineLimit } from "../chat-services/copilot-runtime/inline-limit";

/** "pasted-text-20261127-082705.txt" (UTC). */
export function pastedTextFileName(now: Date): string {
  const stamp = now.toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
  return `pasted-text-${stamp}.txt`;
}

/**
 * A pasted text over the limit as a text file, for the upload flow a picked
 * .txt file takes (chip, /workspace/uploads on the Copilot path). Undefined
 * when there is no limit (AI SDK path) or the text fits: it then stays
 * message text. The limit is in UTF-8 bytes; exactly the limit stays text.
 */
export function pastedTextFile(text: string, limitBytes: number | undefined, now: Date = new Date()): File | undefined {
  if (!limitBytes || limitBytes <= 0 || !text) return undefined;
  if (!exceedsInlineLimit(text, limitBytes)) return undefined;
  return new File([text], pastedTextFileName(now), { type: "text/plain;charset=utf-8" });
}
