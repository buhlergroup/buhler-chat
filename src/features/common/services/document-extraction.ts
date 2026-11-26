import "server-only";

import { DocumentIntelligenceInstance } from "./document-intelligence";

/**
 * Text of a document (PDF, Office, HTML) with Document Intelligence
 * ("prebuilt-read"): the paragraphs, one per line. The content store caches
 * the result per content hash, so callers run this at most once per file
 * content and owner.
 */
export async function extractTextWithDocumentIntelligence(
  bytes: Uint8Array
): Promise<string> {
  // The SDK takes an ArrayBuffer; copy so a Buffer view of a larger pool
  // does not send bytes outside the view.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const poller = await DocumentIntelligenceInstance().beginAnalyzeDocument(
    "prebuilt-read",
    copy.buffer
  );
  const { paragraphs } = await poller.pollUntilDone();
  return (paragraphs ?? []).map((p) => p.content).join("\n");
}
