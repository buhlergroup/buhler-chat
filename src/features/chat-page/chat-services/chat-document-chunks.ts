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

// Most chunks one document may have in the index (MAX_DOCUMENT_CHUNKS).
// 4000 chunks are about 6.9 million characters of text (one chunk adds
// CHUNK_SIZE - CHUNK_OVERLAP = 1725 new characters), some 2.3 million
// embedding tokens and 40 embedding calls. A longer document takes many
// minutes to index and hits the embedding rate limit, so it is refused
// before the first embedding call.
export const DEFAULT_MAX_DOCUMENT_CHUNKS = 4000;

export function maxDocumentChunks(): number {
  const configured = Number(process.env.MAX_DOCUMENT_CHUNKS);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_DOCUMENT_CHUNKS;
}

/** The user-facing message for a document with more chunks than the limit. */
export function documentTooLongMessage(chunkCount: number, maxChunks: number): string {
  const maxMillionChars = ((maxChunks * (CHUNK_SIZE - CHUNK_OVERLAP)) / 1_000_000).toFixed(1);
  return (
    `The document is too long to index: it has ${chunkCount} text parts and the limit is ` +
    `${maxChunks} (about ${maxMillionChars} million characters). ` +
    `Split the document into smaller documents and upload them one by one.`
  );
}
