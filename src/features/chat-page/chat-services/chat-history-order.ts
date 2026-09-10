/**
 * chat-history-order.ts
 *
 * Puts a thread's persisted rows into a total order.
 *
 * ## Why `ORDER BY r.createdAt ASC` is not enough
 *
 * `createdAt` has millisecond resolution and rows are written concurrently.
 * A turn that fires several tool calls in parallel persists their rows in the
 * same millisecond, and Cosmos gives NO defined order among equal sort keys —
 * so the same thread can come back with those rows in a different order on a
 * later read.
 *
 * For the transcript that is a cosmetic glitch. For the prompt it is the same
 * failure the row cap caused: a reshuffle anywhere in the history moves every
 * byte after it, the prompt-cache prefix no longer matches, and the whole
 * prompt is re-billed at the 1.25x cache-write rate. A stable history is a
 * precondition for everything `history-budget.ts` does — there is no point
 * holding the cut still if the rows behind it can swap places.
 *
 * ## Why the sort is in memory
 *
 * A three-column `ORDER BY` in Cosmos needs a composite index, which means an
 * infrastructure change and a backfill before the query works at all. The
 * ordering is cheap to do here instead: the query already returns the whole
 * thread ordered by `createdAt`, so this pass only has to break ties.
 *
 * ## The key
 *
 *   1. `createdAt` — the real ordering.
 *   2. `sequence` — a monotonic counter stamped on write, when present. This is
 *      the only tie-break that reflects the order things actually happened.
 *      Treated as optional: rows written before the field existed do not have
 *      it, and they must not sort differently from run to run either.
 *   3. `id` — the final tie-break. Arbitrary but TOTAL, which is the whole
 *      point: two rows with the same timestamp and no sequence still land in
 *      the same order on every read, forever.
 */

/**
 * The fields the ordering needs. Structural, so it applies to a full
 * `ChatMessageModel` and to a test fixture alike, and so `sequence` can be
 * added to the persisted model independently of this file.
 */
export interface OrderableHistoryRow {
  id: string;
  /** Cosmos hands this back as an ISO string; the model types it as a Date. */
  createdAt: Date | string | number;
  /** Monotonic write counter, when the writer stamped one. */
  sequence?: number;
}

/**
 * Milliseconds for a `createdAt` in any of the shapes it arrives in.
 *
 * An unparseable value sorts as 0 rather than NaN. NaN compares false against
 * everything, which would make the comparator inconsistent and the sort order
 * implementation-defined — the exact thing this module exists to prevent. A
 * corrupt row sorting to the front is a visible, debuggable outcome; a
 * silently unstable sort is not.
 */
function toMillis(value: Date | string | number): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const millis = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(millis) ? millis : 0;
}

/**
 * Order rows oldest-first under a total order: `createdAt`, then `sequence`
 * (absent counts as 0), then `id`.
 *
 * Returns a new array; does not mutate the input. `localeCompare` is avoided
 * for the id so the result cannot vary with the pod's locale.
 */
export function sortHistoryRowsDeterministically<T extends OrderableHistoryRow>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    const byTime = toMillis(a.createdAt) - toMillis(b.createdAt);
    if (byTime !== 0) return byTime;

    const bySequence = (a.sequence ?? 0) - (b.sequence ?? 0);
    if (bySequence !== 0) return bySequence;

    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}
