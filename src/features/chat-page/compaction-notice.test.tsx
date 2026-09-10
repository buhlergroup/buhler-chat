import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompactionMarker, CompactionNotice } from "./compaction-notice";

// The divider is the only thing that tells a user the model can no longer
// quote turns they can still scroll to, so these pin the words on screen.

describe("chat-page.unit.compaction-notice.001 — a row that recorded no reason", () => {
  it("states the compaction and claims nothing about a summary", () => {
    // A summary row written before `summaryOutcome` existed. This used to map
    // to "off" and print "no summary, feature off" on threads whose
    // summariser was on and working — the same misdiagnosis the reason code
    // was added to remove. The honest line names the compaction and stops.
    render(
      <CompactionNotice
        data={{
          status: "done",
          trimmedTurns: 12,
          summaryOutcome: "unknown",
          durationMs: 0,
        }}
      />,
    );
    expect(screen.getByText("Compacted 12 older turns")).toBeInTheDocument();
    expect(screen.queryByText(/feature off/)).not.toBeInTheDocument();
    expect(screen.queryByText(/failed|timed out|deployment/)).not.toBeInTheDocument();
    // Nothing to expand: an unknown outcome never carries summary text.
    expect(screen.queryByText("Show summary")).not.toBeInTheDocument();
  });
});

describe("chat-page.unit.compaction-notice.002 — when it is done", () => {
  const done = {
    status: "done" as const,
    trimmedTurns: 12,
    tokensBefore: 34_012,
    tokensAfter: 17_565,
    summaryOutcome: "ok" as const,
    summaryModel: "gpt-5.6-terra",
    durationMs: 4210,
    summaryText: "FACTS: the user prefers metric units.",
  };

  it("names the turns and the real tokens, and stops spinning", () => {
    render(<CompactionNotice data={done} />);
    expect(
      screen.getByText(
        "Compacted 12 older turns into a summary (34,012 → 17,565 tokens)",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTitle("Loader")).not.toBeInTheDocument();
  });

  it("shows the line without numbers until the provider reports them", () => {
    // The first write happens at stream start, when tokensAfter — this
    // request's own inputTokens — does not exist yet. No estimate is shown in
    // its place, and no "~".
    const { tokensBefore: _b, tokensAfter: _a, ...pending } = done;
    render(<CompactionNotice data={pending} />);
    expect(
      screen.getByText("Compacted 12 older turns into a summary"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/~/)).not.toBeInTheDocument();
  });

  it("expands the summary on demand, and hides it again", async () => {
    const user = userEvent.setup();
    render(<CompactionNotice data={done} />);

    const toggle = screen.getByText("Show summary");
    expect(
      screen.queryByText("FACTS: the user prefers metric units."),
    ).not.toBeInTheDocument();

    await user.click(toggle);
    expect(
      screen.getByText("FACTS: the user prefers metric units."),
    ).toBeInTheDocument();
    // The model that wrote it is labelled, so a bad summary can be traced.
    expect(screen.getByText("Summary by gpt-5.6-terra")).toBeInTheDocument();

    await user.click(screen.getByText("Hide summary"));
    expect(
      screen.queryByText("FACTS: the user prefers metric units."),
    ).not.toBeInTheDocument();
  });
});

describe("chat-page.unit.compaction-notice.003 — trimmed without a summary", () => {
  // One line per reason code. "feature off" for a broken summariser is what
  // hid a 404 on every trim behind a plausible-looking notice.
  it.each([
    ["off", "Trimmed 3 older turns (no summary, feature off)"],
    ["failed", "Trimmed 3 older turns (summary failed, see server log)"],
    ["timeout", "Trimmed 3 older turns (summary timed out)"],
    ["no-deployment", "Trimmed 3 older turns (no summarizer deployment)"],
  ] as const)("says why there is no summary (%s)", (summaryOutcome, expected) => {
    render(
      <CompactionNotice
        data={{
          status: "done",
          trimmedTurns: 3,
          tokensBefore: 90_000,
          tokensAfter: 50_000,
          summaryOutcome,
          durationMs: 12,
        }}
      />,
    );
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.queryByText("Show summary")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Loader")).not.toBeInTheDocument();
  });
});

describe("chat-page.unit.compaction-notice.004 — the persisted marker", () => {
  it("marks where the model's view of the conversation starts", () => {
    render(
      <CompactionMarker
        realTokensAfter={17_565}
        realTokensBefore={34_012}
        summaryModel="terra-dep"
        summaryText="FACTS: metric units."
        trimmedTurns={12}
      />,
    );
    expect(
      screen.getByText(
        "Conversation compacted here · 12 older turns · 34,012 → 17,565 tokens",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Show summary")).toBeInTheDocument();
    expect(screen.getByTestId("compaction-notice")).toBeInTheDocument();
  });

  it("renders without a summary to expand", () => {
    render(<CompactionMarker trimmedTurns={1} />);
    expect(
      screen.getByText("Conversation compacted here · 1 older turn"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Show summary")).not.toBeInTheDocument();
  });
});
