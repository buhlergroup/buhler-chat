import "server-only";

import { DocumentIntelligenceInstance } from "./document-intelligence";

/**
 * Text of a document (PDF, Office, HTML) with Document Intelligence
 * ("prebuilt-read"): the paragraphs, one per line, and the number of pages
 * the service analysed. `pages` limits the analysis to a page range in the
 * service's syntax ("1-20", "1,3,5-7"); the caller validates it.
 */
export async function analyzeTextWithDocumentIntelligence(
  bytes: Uint8Array,
  options: { pages?: string } = {}
): Promise<{ text: string; pageCount?: number }> {
  // The SDK takes an ArrayBuffer; copy so a Buffer view of a larger pool
  // does not send bytes outside the view.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const client = DocumentIntelligenceInstance();
  const poller = options.pages
    ? await client.beginAnalyzeDocument("prebuilt-read", copy.buffer, { pages: options.pages })
    : await client.beginAnalyzeDocument("prebuilt-read", copy.buffer);
  const { paragraphs, pages } = await poller.pollUntilDone();
  return {
    text: (paragraphs ?? []).map((p) => p.content).join("\n"),
    ...(pages ? { pageCount: pages.length } : {}),
  };
}

/**
 * Text of a whole document with Document Intelligence ("prebuilt-read"): the
 * paragraphs, one per line. The content store caches the result per content
 * hash, so callers run this at most once per file content and owner.
 */
export async function extractTextWithDocumentIntelligence(
  bytes: Uint8Array
): Promise<string> {
  return (await analyzeTextWithDocumentIntelligence(bytes)).text;
}
