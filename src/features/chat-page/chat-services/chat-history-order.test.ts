import { describe, it, expect } from "vitest";
import {
  sortHistoryRowsDeterministically,
  type OrderableHistoryRow,
} from "./chat-history-order";

// `ORDER BY r.createdAt ASC` is not a total order: createdAt is millisecond
// resolution and parallel tool calls persist in the same millisecond, so
// Cosmos leaves their relative order undefined. Two reads of one thread can
// then differ, which moves the prompt prefix and voids the prompt cache for
// the whole turn.

const ms = (iso: string) => new Date(iso);

describe("chat-page.unit.history-order.001 — createdAt is the primary key", () => {
  it("orders oldest-first", () => {
    const rows: OrderableHistoryRow[] = [
      { id: "c", createdAt: ms("2026-09-07T10:00:03Z") },
      { id: "a", createdAt: ms("2026-09-07T10:00:01Z") },
      { id: "b", createdAt: ms("2026-09-07T10:00:02Z") },
    ];
    expect(sortHistoryRowsDeterministically(rows).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("accepts createdAt as a Date, an ISO string or epoch millis", () => {
    const rows: OrderableHistoryRow[] = [
      { id: "third", createdAt: ms("2026-09-07T10:00:03Z").getTime() },
      { id: "first", createdAt: ms("2026-09-07T10:00:01Z") },
      { id: "second", createdAt: "2026-09-07T10:00:02.000Z" },
    ];
    expect(sortHistoryRowsDeterministically(rows).map((r) => r.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("does not mutate the caller's array", () => {
    const rows: OrderableHistoryRow[] = [
      { id: "b", createdAt: ms("2026-09-07T10:00:02Z") },
      { id: "a", createdAt: ms("2026-09-07T10:00:01Z") },
    ];
    const snapshot = rows.map((r) => r.id);
    sortHistoryRowsDeterministically(rows);
    expect(rows.map((r) => r.id)).toEqual(snapshot);
  });

  it("sorts an unparseable createdAt to the front rather than going unstable", () => {
    // NaN compares false against everything, which makes the comparator
    // inconsistent and the resulting order implementation-defined. A corrupt
    // row landing at the front is at least visible and debuggable.
    const rows: OrderableHistoryRow[] = [
      { id: "good", createdAt: ms("2026-09-07T10:00:01Z") },
      { id: "bad", createdAt: "not a date" },
    ];
    const once = sortHistoryRowsDeterministically(rows).map((r) => r.id);
    const twice = sortHistoryRowsDeterministically([...rows].reverse()).map(
      (r) => r.id,
    );
    expect(once).toEqual(["bad", "good"]);
    expect(twice).toEqual(once);
  });
});

describe("chat-page.unit.history-order.002 — same-millisecond rows break on sequence", () => {
  const SAME = ms("2026-09-07T10:00:00.000Z");

  it("orders identical timestamps by sequence", () => {
    const rows: OrderableHistoryRow[] = [
      { id: "z", createdAt: SAME, sequence: 3 },
      { id: "y", createdAt: SAME, sequence: 1 },
      { id: "x", createdAt: SAME, sequence: 2 },
    ];
    expect(sortHistoryRowsDeterministically(rows).map((r) => r.id)).toEqual([
      "y",
      "x",
      "z",
    ]);
  });

  it("gives the same answer whatever order Cosmos hands the rows back in", () => {
    const rows: OrderableHistoryRow[] = [
      { id: "call-a", createdAt: SAME, sequence: 1 },
      { id: "call-b", createdAt: SAME, sequence: 2 },
      { id: "call-c", createdAt: SAME, sequence: 3 },
      { id: "call-d", createdAt: SAME, sequence: 4 },
    ];
    const expected = ["call-a", "call-b", "call-c", "call-d"];
    // Every permutation Cosmos could plausibly produce must collapse to one
    // order; otherwise the prompt prefix is a coin flip per read.
    const permutations = [
      [rows[3], rows[1], rows[0], rows[2]],
      [rows[2], rows[3], rows[1], rows[0]],
      [...rows].reverse(),
      rows,
    ];
    for (const permutation of permutations) {
      expect(sortHistoryRowsDeterministically(permutation).map((r) => r.id)).toEqual(
        expected,
      );
    }
  });

  it("keeps sequence subordinate to createdAt", () => {
    const rows: OrderableHistoryRow[] = [
      { id: "later-turn", createdAt: ms("2026-09-07T10:00:05Z"), sequence: 1 },
      { id: "earlier-turn", createdAt: ms("2026-09-07T10:00:01Z"), sequence: 99 },
    ];
    expect(sortHistoryRowsDeterministically(rows).map((r) => r.id)).toEqual([
      "earlier-turn",
      "later-turn",
    ]);
  });
});

describe("chat-page.unit.history-order.003 — without sequence, id is the tie-breaker", () => {
  const SAME = ms("2026-09-07T10:00:00.000Z");

  it("orders identical timestamps by id when no row carries a sequence", () => {
    // Rows written before `sequence` existed must still land in ONE order,
    // every read, forever. Arbitrary is fine; unstable is not.
    const rows: OrderableHistoryRow[] = [
      { id: "m-c", createdAt: SAME },
      { id: "m-a", createdAt: SAME },
      { id: "m-b", createdAt: SAME },
    ];
    expect(sortHistoryRowsDeterministically(rows).map((r) => r.id)).toEqual([
      "m-a",
      "m-b",
      "m-c",
    ]);
    expect(
      sortHistoryRowsDeterministically([...rows].reverse()).map((r) => r.id),
    ).toEqual(["m-a", "m-b", "m-c"]);
  });

  it("treats a missing sequence as 0 so mixed rows still have a total order", () => {
    const rows: OrderableHistoryRow[] = [
      { id: "with-seq", createdAt: SAME, sequence: 5 },
      { id: "no-seq", createdAt: SAME },
    ];
    expect(sortHistoryRowsDeterministically(rows).map((r) => r.id)).toEqual([
      "no-seq",
      "with-seq",
    ]);
  });

  it("compares ids by code point, not by locale", () => {
    // localeCompare would let the pod's locale change the order.
    const rows: OrderableHistoryRow[] = [
      { id: "b", createdAt: SAME },
      { id: "A", createdAt: SAME },
      { id: "a", createdAt: SAME },
    ];
    expect(sortHistoryRowsDeterministically(rows).map((r) => r.id)).toEqual([
      "A",
      "a",
      "b",
    ]);
  });

  it("is idempotent — sorting an already-sorted list changes nothing", () => {
    const rows: OrderableHistoryRow[] = [
      { id: "m1", createdAt: SAME, sequence: 1 },
      { id: "m2", createdAt: SAME, sequence: 2 },
      { id: "m3", createdAt: ms("2026-09-07T10:00:01Z") },
    ];
    const once = sortHistoryRowsDeterministically(rows);
    const twice = sortHistoryRowsDeterministically(once);
    expect(twice.map((r) => r.id)).toEqual(once.map((r) => r.id));
  });

  it("handles the trivial cases", () => {
    expect(sortHistoryRowsDeterministically([])).toEqual([]);
    const one = [{ id: "solo", createdAt: ms("2026-09-07T10:00:00Z") }];
    expect(sortHistoryRowsDeterministically(one).map((r) => r.id)).toEqual(["solo"]);
  });
});
