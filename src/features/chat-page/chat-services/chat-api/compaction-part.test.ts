import { describe, it, expect } from "vitest";
import {
  COMPACTION_DATA_PART_TYPE,
  COMPACTION_PART_ID,
  compactionDonePart,
  compactionMarkerPlacement,
  compactionMarkerText,
  compactionNoticeText,
  compactionRunningPart,
  formatTokenCount,
  isCompactionDataPart,
  threadCompactionMarker,
} from "./compaction-part";

// The wire contract between /api/chat, the transcript and the thread loader.
// Everything here is pure: no stream, no Cosmos, no React.

describe("chat-page.unit.compaction-part.001 — the part shape", () => {
  it("gives both phases the same id, so the second write replaces the first", () => {
    const running = compactionRunningPart({ turnsToTrim: 4 });
    const done = compactionDonePart({
      trimmedTurns: 4,
      summaryOutcome: "ok",
      durationMs: 900,
    });
    expect(running.type).toBe(COMPACTION_DATA_PART_TYPE);
    expect(running.type).toBe("data-compaction");
    expect(running.id).toBe(COMPACTION_PART_ID);
    expect(done.id).toBe(running.id);
  });

  it("omits every field it has no value for, rather than sending undefined", () => {
    const done = compactionDonePart({
      trimmedTurns: 2,
      summaryOutcome: "off",
      durationMs: 11,
      coversThroughMessageId: "m9",
    });
    expect(done.data).toEqual({
      status: "done",
      trimmedTurns: 2,
      summaryOutcome: "off",
      durationMs: 11,
    });
    expect("summaryText" in done.data).toBe(false);
    expect("summaryModel" in done.data).toBe(false);
    // The watermark is for the persisted divider, not for the wire.
    expect("coversThroughMessageId" in done.data).toBe(false);
    // And NO token counts on the first write: they are the provider's real
    // numbers, and the request they describe has not finished yet. The
    // ESTIMATES the plan carries are deliberately not shown to anyone.
    expect("tokensBefore" in done.data).toBe(false);
    expect("tokensAfter" in done.data).toBe(false);
  });

  it("takes the real numbers on the second write, under the same id", () => {
    const outcome = {
      trimmedTurns: 2,
      summaryOutcome: "ok" as const,
      durationMs: 11,
    };
    const first = compactionDonePart(outcome);
    const second = compactionDonePart(outcome, {
      tokensBefore: 34_012,
      tokensAfter: 17_565,
    });

    expect(second.id).toBe(first.id);
    expect(second.data).toMatchObject({
      tokensBefore: 34_012,
      tokensAfter: 17_565,
    });
  });

  it("carries only the after count on a thread's first turn", () => {
    const done = compactionDonePart(
      {
        trimmedTurns: 1,
        summaryOutcome: "ok",
        durationMs: 11,
      },
      { tokensAfter: 17_565 },
    );
    expect(done.data).toMatchObject({ tokensAfter: 17_565 });
    expect("tokensBefore" in done.data).toBe(false);
  });

  it("carries the summary inline when there is one", () => {
    const done = compactionDonePart({
      trimmedTurns: 12,
      summaryOutcome: "ok",
      summaryModel: "gpt-5.6-terra",
      durationMs: 4210,
      summaryText: "FACTS: metric units.",
    });
    expect(done.data).toMatchObject({
      summaryText: "FACTS: metric units.",
      summaryModel: "gpt-5.6-terra",
    });
  });

  it("narrows only its own part type (negative)", () => {
    expect(isCompactionDataPart({ type: "data-compaction" })).toBe(true);
    for (const type of ["text", "reasoning", "data-usage-warning", ""]) {
      expect(isCompactionDataPart({ type })).toBe(false);
    }
    expect(isCompactionDataPart({})).toBe(false);
  });
});

describe("chat-page.unit.compaction-part.002 — the copy", () => {
  it("prints token counts in full, with separators", () => {
    // Not "18k": these are the provider's own numbers, and a reader comparing
    // the notice against the usage panel needs the digits to match.
    expect(formatTokenCount(17_565)).toBe("17,565");
    expect(formatTokenCount(184_000)).toBe("184,000");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(0)).toBe("0");
    // A junk value must not put "NaN" on screen.
    expect(formatTokenCount(Number.NaN)).toBe("0");
    expect(formatTokenCount(-5)).toBe("0");
  });

  it("says what happened, in each state", () => {
    // Each reason code gets its own line. A boolean could not tell "the
    // operator turned it off" from "the summariser 404'd", and the live defect
    // that prompted these codes was invisible for exactly that reason.
    expect(
      compactionNoticeText({ status: "running", turnsToTrim: 3 }),
    ).toBe("Compacting older messages…");

    const done = {
      status: "done" as const,
      trimmedTurns: 12,
      tokensBefore: 34_012,
      tokensAfter: 17_565,
      durationMs: 1,
    };
    expect(compactionNoticeText({ ...done, summaryOutcome: "ok" })).toBe(
      "Compacted 12 older turns into a summary (34,012 → 17,565 tokens)",
    );
    // Before the numbers arrive, the same line without the clause.
    expect(
      compactionNoticeText({
        status: "done",
        trimmedTurns: 12,
        summaryOutcome: "ok",
        durationMs: 1,
      }),
    ).toBe("Compacted 12 older turns into a summary");
    // First turn of a thread: no previous request to compare against.
    expect(
      compactionNoticeText({
        status: "done",
        trimmedTurns: 12,
        tokensAfter: 17_565,
        summaryOutcome: "ok",
        durationMs: 1,
      }),
    ).toBe("Compacted 12 older turns into a summary (17,565 tokens)");
    expect(compactionNoticeText({ ...done, summaryOutcome: "off" })).toBe(
      "Trimmed 12 older turns (no summary, feature off)",
    );
    expect(compactionNoticeText({ ...done, summaryOutcome: "failed" })).toBe(
      "Trimmed 12 older turns (summary failed, see server log)",
    );
    expect(compactionNoticeText({ ...done, summaryOutcome: "timeout" })).toBe(
      "Trimmed 12 older turns (summary timed out)",
    );
    expect(
      compactionNoticeText({ ...done, summaryOutcome: "no-deployment" }),
    ).toBe("Trimmed 12 older turns (no summarizer deployment)");
  });

  it("keeps the singular singular", () => {
    expect(
      compactionNoticeText({
        status: "done",
        trimmedTurns: 1,
        tokensBefore: 2_000,
        tokensAfter: 1_000,
        summaryOutcome: "ok",
        durationMs: 1,
      }),
    ).toContain("1 older turn into");
    expect(compactionMarkerText(1)).toBe("Conversation compacted here · 1 older turn");
    expect(compactionMarkerText(9)).toBe("Conversation compacted here · 9 older turns");
    // The persisted divider carries the same real numbers when the row has
    // them, and stays plain when it does not.
    expect(
      compactionMarkerText(2, { tokensBefore: 34_012, tokensAfter: 17_565 }),
    ).toBe("Conversation compacted here · 2 older turns · 34,012 → 17,565 tokens");
    expect(compactionMarkerText(2, { tokensAfter: 17_565 })).toBe(
      "Conversation compacted here · 2 older turns · 17,565 tokens",
    );
  });
});

describe("chat-page.unit.compaction-part.003 — the persisted marker", () => {
  it("keeps only what the divider renders", () => {
    expect(
      threadCompactionMarker({
        coversThroughMessageId: "m42",
        content: "  FACTS: metric units.  ",
        model: "terra-dep",
        realTokensBefore: 34_012,
        realTokensAfter: 17_565,
      }),
    ).toEqual({
      coversThroughMessageId: "m42",
      summaryText: "FACTS: metric units.",
      summaryModel: "terra-dep",
      realTokensBefore: 34_012,
      realTokensAfter: 17_565,
    });
  });

  it("drops token counts a row never recorded (negative)", () => {
    // Rows written before the real numbers existed, and the first turn of a
    // thread, both simply have no clause on the divider.
    expect(
      threadCompactionMarker({
        coversThroughMessageId: "m42",
        content: "text",
        model: "m",
        realTokensBefore: 0,
      }),
    ).toEqual({
      coversThroughMessageId: "m42",
      summaryText: "text",
      summaryModel: "m",
    });
  });

  it("is still a marker with no summary text, but carries no model label", () => {
    // Trimmed with the feature off: the turns are gone from the prompt, there
    // is just nothing to expand.
    expect(
      threadCompactionMarker({ coversThroughMessageId: "m42", content: "", model: "x" }),
    ).toEqual({ coversThroughMessageId: "m42" });
  });

  it("is null without a watermark (negative)", () => {
    expect(threadCompactionMarker(null)).toBeNull();
    expect(threadCompactionMarker(undefined)).toBeNull();
    expect(threadCompactionMarker({ content: "text" })).toBeNull();
    expect(threadCompactionMarker({ coversThroughMessageId: "" })).toBeNull();
  });
});

describe("chat-page.unit.compaction-part.004 — divider placement", () => {
  const messages = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "u2", role: "user" },
    { id: "a2", role: "assistant" },
    { id: "u3", role: "user" },
    { id: "a3", role: "assistant" },
  ];

  it("puts the divider on the watermark row and counts the turns before it", () => {
    const placement = compactionMarkerPlacement({
      marker: { coversThroughMessageId: "a2" },
      messages,
    });
    // The position IS the summary row's coversThroughMessageId.
    expect(placement).toEqual({ afterMessageId: "a2", trimmedTurns: 2 });
  });

  it("counts the watermark's own turn when the watermark is the user row", () => {
    expect(
      compactionMarkerPlacement({
        marker: { coversThroughMessageId: "u3" },
        messages,
      }),
    ).toEqual({ afterMessageId: "u3", trimmedTurns: 3 });
  });

  it("draws nothing when the watermark row is gone (negative, fail open)", () => {
    // The user rewound or deleted messages. A divider in the wrong place would
    // claim the model has forgotten turns it can still read.
    expect(
      compactionMarkerPlacement({
        marker: { coversThroughMessageId: "deleted-row" },
        messages,
      }),
    ).toBeNull();
    expect(compactionMarkerPlacement({ marker: null, messages })).toBeNull();
    expect(
      compactionMarkerPlacement({
        marker: { coversThroughMessageId: "a2" },
        messages: [],
      }),
    ).toBeNull();
  });
});
