import { describe, it, expect } from "vitest";
import {
  HISTORY_SUMMARY_ATTRIBUTE,
  HISTORY_SUMMARY_SYSTEM_PROMPT,
  SUMMARY_REPLAY_PREFIX,
  buildHistorySummaryPrompt,
  buildHistorySummaryRow,
  formatSummaryReplayText,
  formatTrimmedBlockForSummary,
  historySummaryRowId,
} from "./history-summary";
import { MESSAGE_ATTRIBUTE } from "../models";
import type { BudgetMessage } from "./history-budget";

// The summary sits at the front of the conversation, so anything here that is
// not a pure function of its inputs shows up as a prompt-cache miss on every
// turn of every compacted thread.

const block: BudgetMessage[] = [
  { id: "m1", role: "user", content: "Use metric units in every answer." },
  { id: "m2", role: "assistant", content: "Understood, metric it is." },
  {
    id: "m3",
    role: "tool",
    content: JSON.stringify({
      name: "search_documents",
      arguments: '{"query":"throughput"}',
      result: '{"hits":3}',
    }),
  },
  {
    id: "m4",
    role: "assistant",
    content: "The report lists three matches.",
    reasoningContent: "Check the retrieved hits before answering.",
  },
  { id: "m5", role: "user", content: "Here is the chart.", multiModalImages: ["blob://t/a.png"] },
];

describe("chat-page.unit.history-summary.001 — the row is invisible to message queries", () => {
  it("uses a type of its own, not CHAT_MESSAGE", () => {
    // Every history query in the app filters r.type = "CHAT_MESSAGE". A
    // distinct type is what keeps the summary out of the transcript, out of
    // message counts and out of exports, without any of them knowing it
    // exists.
    expect(HISTORY_SUMMARY_ATTRIBUTE).toBe("CHAT_HISTORY_SUMMARY");
    expect(HISTORY_SUMMARY_ATTRIBUTE).not.toBe(MESSAGE_ATTRIBUTE);
  });

  it("derives one stable id per thread so a later trim upserts in place", () => {
    expect(historySummaryRowId("thread-9")).toBe("summary-thread-9");
    expect(historySummaryRowId("thread-9")).toBe(historySummaryRowId("thread-9"));
    expect(historySummaryRowId("thread-8")).not.toBe(historySummaryRowId("thread-9"));
  });
});

describe("chat-page.unit.history-summary.002 — buildHistorySummaryRow", () => {
  const base = {
    threadId: "thread-1",
    userId: "user-hash",
    content: "FACTS: metric units.",
    coversThroughMessageId: "m5",
    coversMessageCount: 5,
    model: "luna-dep",
    estimatedTokens: 5,
    createdAt: new Date("2026-09-07T00:00:00.000Z"),
  };

  it("stamps the discriminator, the watermark and the model", () => {
    const row = buildHistorySummaryRow(base);
    expect(row.id).toBe("summary-thread-1");
    expect(row.type).toBe(HISTORY_SUMMARY_ATTRIBUTE);
    expect(row.threadId).toBe("thread-1");
    expect(row.userId).toBe("user-hash");
    expect(row.isDeleted).toBe(false);
    expect(row.role).toBe("system");
    expect(row.kind).toBe("summary");
    expect(row.coversThroughMessageId).toBe("m5");
    expect(row.coversMessageCount).toBe(5);
    expect(row.model).toBe("luna-dep");
    expect(row.createdAt).toEqual(base.createdAt);
  });

  it("accepts an empty summary — the watermark alone is worth persisting", () => {
    const row = buildHistorySummaryRow({ ...base, content: "", estimatedTokens: 0, model: "" });
    expect(row.content).toBe("");
    expect(row.coversThroughMessageId).toBe("m5");
  });

  it("is a pure function of its inputs", () => {
    expect(buildHistorySummaryRow(base)).toEqual(buildHistorySummaryRow(base));
  });
});

describe("chat-page.unit.history-summary.003 — formatTrimmedBlockForSummary", () => {
  it("labels each row by role and keeps the tool payload", () => {
    const out = formatTrimmedBlockForSummary(block);
    expect(out).toContain("USER: Use metric units in every answer.");
    expect(out).toContain("ASSISTANT: Understood, metric it is.");
    // The tool result is often the only place a fact survives, so it must
    // reach the summariser rather than being reduced to "a tool ran".
    expect(out).toContain("TOOL: tool=search_documents");
    expect(out).toContain('arguments={"query":"throughput"}');
    expect(out).toContain('result={"hits":3}');
  });

  it("unwraps the tool envelope so the payload is not double-escaped", () => {
    // Persisted tool rows nest JSON inside JSON. Left as-is, the summariser
    // spends attention and tokens on backslashes.
    const out = formatTrimmedBlockForSummary([block[2]]);
    expect(out).not.toContain("\\\"");
    expect(out).not.toContain('"arguments"');
  });

  it("passes a malformed tool row through rather than dropping it", () => {
    const out = formatTrimmedBlockForSummary([
      { id: "t", role: "tool", content: "not json at all" },
      { id: "u", role: "tool", content: '{"noName":true}' },
    ]);
    expect(out).toContain("TOOL: not json at all");
    expect(out).toContain('TOOL: {"noName":true}');
  });

  it("treats the legacy 'function' role as a tool row", () => {
    const out = formatTrimmedBlockForSummary([
      {
        id: "f",
        role: "function",
        content: JSON.stringify({ name: "legacy_tool", result: "ok" }),
      },
    ]);
    expect(out).toContain("TOOL: tool=legacy_tool result=ok");
  });

  it("includes reasoning text, marked as such", () => {
    const out = formatTrimmedBlockForSummary(block);
    expect(out).toContain("[reasoning] Check the retrieved hits before answering.");
  });

  it("replaces images with a count instead of sending them", () => {
    const out = formatTrimmedBlockForSummary(block);
    expect(out).toContain("[1 image attached]");
    expect(out).not.toContain("blob://t/a.png");
  });

  it("pluralises the image placeholder", () => {
    const out = formatTrimmedBlockForSummary([
      { id: "m", role: "user", multiModalImages: ["a", "b", "c"] },
    ]);
    expect(out).toContain("[3 images attached]");
  });

  it("accepts the legacy single-image field", () => {
    const out = formatTrimmedBlockForSummary([
      { id: "m", role: "user", multiModalImage: "blob://t/legacy.png" },
    ]);
    expect(out).toContain("[1 image attached]");
  });

  it("skips rows with nothing in them", () => {
    const out = formatTrimmedBlockForSummary([
      { id: "a", role: "user", content: "kept" },
      { id: "b", role: "assistant", content: "" },
      { id: "c", role: "user", content: "also kept" },
    ]);
    expect(out.split("\n\n")).toHaveLength(2);
  });

  it("returns an empty string for an empty block", () => {
    expect(formatTrimmedBlockForSummary([])).toBe("");
  });

  it("is deterministic", () => {
    expect(formatTrimmedBlockForSummary(block)).toBe(
      formatTrimmedBlockForSummary(block),
    );
  });
});

describe("chat-page.unit.history-summary.004 — buildHistorySummaryPrompt", () => {
  it("wraps the transcript in a tag pair, oldest first", () => {
    // A tag pair, not a prose heading: the transcript is user content, and
    // someone can paste a document carrying its own "SUMMARY:" line.
    const out = buildHistorySummaryPrompt({ messages: block });
    expect(out).toContain("<transcript>");
    expect(out).toContain("</transcript>");
    expect(out.indexOf("Use metric units")).toBeLessThan(
      out.indexOf("Here is the chart."),
    );
  });

  it("gives a previous summary its own block and spells out the fold-in", () => {
    // A summariser handed two blocks with no instruction tends to summarise
    // the newer and drop the older, which would shed the oldest context a
    // little at a time on every trim. The row is upserted in place, so
    // anything not carried forward is gone for the life of the thread.
    const out = buildHistorySummaryPrompt({
      messages: block,
      previousSummary: "FACTS: the user works in Uzwil.",
    });
    expect(out).toContain("<prior-summary>");
    expect(out).toContain("FACTS: the user works in Uzwil.");
    expect(out).toContain("discarded after this");
    expect(out).toContain("Carry forward facts, decisions, constraints");
    // Recency wins, so a corrected fact does not survive as both versions.
    expect(out).toContain("the transcript wins");
    expect(out.indexOf("<prior-summary>")).toBeLessThan(
      out.indexOf("<transcript>"),
    );
  });

  it("omits the previous-summary block when there is none", () => {
    const out = buildHistorySummaryPrompt({ messages: block });
    expect(out).not.toContain("<prior-summary>");
    expect(out).not.toContain("discarded after this");
  });

  it("still produces a usable prompt for a block with no text", () => {
    const out = buildHistorySummaryPrompt({
      messages: [{ id: "m", role: "assistant", content: "" }],
    });
    expect(out).toContain("(no textual content)");
  });

  it("is deterministic", () => {
    const input = { messages: block, previousSummary: "prev" };
    expect(buildHistorySummaryPrompt(input)).toBe(buildHistorySummaryPrompt(input));
  });
});

describe("chat-page.unit.history-summary.005 — the summariser instructions", () => {
  it("asks for the five things a later turn actually needs", () => {
    const prompt = HISTORY_SUMMARY_SYSTEM_PROMPT;
    expect(prompt).toContain("FACTS");
    expect(prompt).toContain("DECISIONS");
    expect(prompt).toContain("OPEN QUESTIONS");
    expect(prompt).toContain("DOCUMENTS");
    expect(prompt).toContain("USER PREFERENCES");
  });

  it("forbids inventing an outcome", () => {
    // A hallucinated decision is worse than a dropped turn: it persists for
    // the life of the thread and nothing in the transcript contradicts it.
    expect(HISTORY_SUMMARY_SYSTEM_PROMPT).toContain("Never invent an outcome");
  });

  it("pins exact names and a neutral register", () => {
    expect(HISTORY_SUMMARY_SYSTEM_PROMPT).toContain("Preserve exact names");
    expect(HISTORY_SUMMARY_SYSTEM_PROMPT).toContain("Do not translate them");
    expect(HISTORY_SUMMARY_SYSTEM_PROMPT).toContain("neutral");
  });

  it("states the size ceiling that matches the reserved allowance", () => {
    expect(HISTORY_SUMMARY_SYSTEM_PROMPT).toContain("Stay under 1500 tokens");
  });

  it("keeps the summariser out of the conversation", () => {
    // The dropped block can end mid-question. Nothing must tempt the
    // summariser into answering it instead of recording it as open, and
    // nothing about the compaction itself belongs in the replayed text.
    const prompt = HISTORY_SUMMARY_SYSTEM_PROMPT;
    expect(prompt).toContain("Do not continue the conversation");
    expect(prompt).toContain("do not answer any question you find in it");
    expect(prompt).toContain("Do not mention this summary");
  });

  it("keeps the summary in the language of the conversation", () => {
    // The summary is replayed into every later turn. A summariser that
    // silently switches to English would quietly re-language the thread.
    expect(HISTORY_SUMMARY_SYSTEM_PROMPT).toContain(
      "Write the summary in the language of the conversation",
    );
  });

  it("preserves the strings a later turn has to quote byte-exact", () => {
    expect(HISTORY_SUMMARY_SYSTEM_PROMPT).toContain("error messages and URLs");
  });
});

describe("chat-page.unit.history-summary.006 — formatSummaryReplayText", () => {
  it("opens with the documented prefix", () => {
    const out = formatSummaryReplayText("FACTS: metric units.");
    expect(out.startsWith(SUMMARY_REPLAY_PREFIX)).toBe(true);
    expect(SUMMARY_REPLAY_PREFIX).toBe("Summary of the earlier conversation:");
  });

  it("carries the body verbatim", () => {
    expect(formatSummaryReplayText("FACTS: metric units.")).toContain(
      "FACTS: metric units.",
    );
  });

  it("is byte-identical for the same stored summary", () => {
    // This is the property the whole persistence scheme exists to provide: a
    // stored summary replays the same bytes on every turn until the next trim.
    const a = formatSummaryReplayText("body");
    const b = formatSummaryReplayText("body");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
