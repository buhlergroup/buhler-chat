// Splits document text into the chunks the search index stores: 2300
// characters with 25% overlap. Pure module, shared by the chat and agent
// document paths.

export const CHUNK_SIZE = 2300;
// 25% overlap
export const CHUNK_OVERLAP = CHUNK_SIZE * 0.25;

export function chunkTextWithOverlap(document: string): string[] {
  const chunks: string[] = [];

  if (document.length <= CHUNK_SIZE) {
    // If the document is smaller than the desired chunk size, return it as a single chunk.
    chunks.push(document);
    return chunks;
  }

  let startIndex = 0;

  // Split the document into chunks of the desired size, with overlap.
  while (startIndex < document.length) {
    const endIndex = startIndex + CHUNK_SIZE;
    chunks.push(document.substring(startIndex, endIndex));
    startIndex = endIndex - CHUNK_OVERLAP;
  }

  return chunks;
}
