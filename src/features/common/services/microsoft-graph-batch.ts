import "server-only";

/**
 * Microsoft Graph JSON batching ("/$batch") in chunks.
 *
 * Graph accepts at most 20 requests in one batch and refuses a larger batch
 * as a whole. The requests are therefore sent in chunks of at most 20, a few
 * chunks at a time, and the answers are merged.
 *
 * A chunk that fails as a whole (the batch call throws or returns no
 * answers) is reported in `failedIds`; the other chunks still count. Callers
 * decide per request: a failed request never counts as allowed.
 */

/** Graph limit: requests in one JSON batch. */
export const GRAPH_BATCH_MAX_REQUESTS = 20;

/** Chunks sent at the same time. */
export const GRAPH_BATCH_PARALLEL_CHUNKS = 2;

export interface GraphBatchRequest {
  id: string;
  method: "GET";
  url: string;
}

export interface GraphBatchResponse {
  id: string;
  status: number;
  /** The body of a Graph answer; its shape depends on the request. */
  body?: any;
}

export interface GraphBatchResult {
  /** The answers of all chunks that succeeded. */
  responses: GraphBatchResponse[];
  /** Ids of the requests whose chunk failed as a whole. */
  failedIds: string[];
  /** The error of each failed chunk. */
  errors: unknown[];
}

/** The part of the Graph client this module uses. */
export interface GraphBatchClient {
  api(path: string): { post(body: unknown): Promise<unknown> };
}

/** Splits `items` into chunks of at most `size` items, order kept. */
export function chunkItems<T>(
  items: ReadonlyArray<T>,
  size: number = GRAPH_BATCH_MAX_REQUESTS,
): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError("Chunk size must be a positive integer.");
  }
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

async function postChunk(
  client: GraphBatchClient,
  requests: GraphBatchRequest[],
): Promise<{ ok: true; responses: GraphBatchResponse[] } | { ok: false; error: unknown }> {
  try {
    const answer = (await client.api("/$batch").post({ requests })) as
      | { responses?: unknown }
      | undefined;
    if (!answer || !Array.isArray(answer.responses)) {
      return { ok: false, error: new Error("Graph returned no batch answers.") };
    }
    return { ok: true, responses: answer.responses as GraphBatchResponse[] };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Sends `requests` to Graph's `/$batch` in chunks of at most 20 requests.
 * Never throws.
 */
export async function postGraphBatches(
  client: GraphBatchClient,
  requests: ReadonlyArray<GraphBatchRequest>,
): Promise<GraphBatchResult> {
  const result: GraphBatchResult = { responses: [], failedIds: [], errors: [] };
  const chunks = chunkItems(requests, GRAPH_BATCH_MAX_REQUESTS);

  for (let i = 0; i < chunks.length; i += GRAPH_BATCH_PARALLEL_CHUNKS) {
    const group = chunks.slice(i, i + GRAPH_BATCH_PARALLEL_CHUNKS);
    const answers = await Promise.all(group.map((chunk) => postChunk(client, chunk)));
    answers.forEach((answer, index) => {
      if (answer.ok) {
        result.responses.push(...answer.responses);
      } else {
        result.failedIds.push(...group[index].map((r) => r.id));
        result.errors.push(answer.error);
      }
    });
  }

  return result;
}
