// Reads the first bytes of a stream to sniff its type, without buffering
// the rest: the returned stream yields the whole content again.

const toBytes = (chunk: unknown): Uint8Array => {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return new Uint8Array(0);
};

/**
 * Reads the first `count` bytes of a stream (a web ReadableStream or a Node
 * readable, both async-iterable) and returns them plus a stream with the
 * whole content again.
 */
export async function peekStream(
  source: unknown,
  count: number
): Promise<{ head: Uint8Array; body: ReadableStream<Uint8Array> }> {
  const iterator = (source as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let done = false;
  while (length < count) {
    const next = await iterator.next();
    if (next.done) {
      done = true;
      break;
    }
    const bytes = toBytes(next.value);
    chunks.push(bytes);
    length += bytes.length;
  }
  const head = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    head.set(chunk, offset);
    offset += chunk.length;
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length > 0) controller.enqueue(head);
      if (done) controller.close();
    },
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(toBytes(next.value));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  return { head, body };
}
