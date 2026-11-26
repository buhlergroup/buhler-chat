import "server-only";

import { DocumentIntelligenceInstance } from "@/features/common/services/document-intelligence";
import { logDebug } from "@/features/common/services/logger";

/**
 * Text of a document (PDF, Office, image) with Document Intelligence
 * "prebuilt-read": one string per paragraph. Shared by the chat document
 * upload (chunks for AI Search) and the agent workspace upload (Markdown
 * next to the original).
 */
export async function extractDocumentParagraphs(data: ArrayBuffer): Promise<string[]> {
  const client = DocumentIntelligenceInstance();
  logDebug("Starting Document Intelligence analysis", {
    model: "prebuilt-read",
    blobSize: data.byteLength,
  });
  const poller = await client.beginAnalyzeDocument("prebuilt-read", data);
  logDebug("Polling Document Intelligence for completion");
  const { paragraphs } = await poller.pollUntilDone();
  logDebug("Document Intelligence analysis completed", {
    paragraphCount: paragraphs?.length || 0,
  });
  return (paragraphs ?? []).map((p) => p.content);
}
