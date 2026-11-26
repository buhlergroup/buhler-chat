import { describe, it, expect } from "vitest";
import type { UIMessageChunk } from "ai";

import { CopilotEventMapper, type CopilotEventLike } from "./event-mapper";
import { citesAnySource, markdownLink, sourcesMarkdown, webSearchSources } from "./web-sources";

const searchOutput = {
  answer: "Pressure is 3 bar ([example.org](https://example.org/a?utm_source=openai)).",
  citations: [
    { url: "https://example.org/a?utm_source=openai", title: "Spec [v2]" },
    { url: "https://example.org/b" },
  ],
};

function turn(answer: string, raw = true) {
  const chunks: UIMessageChunk[] = [];
  const mapper = new CopilotEventMapper((c) => chunks.push(c), {
    appToolNames: new Set(["web_search"]),
    ...(raw ? { rawToolOutput: () => ({ output: searchOutput }) as never } : {}),
  });
  mapper.start();
  const events: CopilotEventLike[] = [
    { type: "assistant.message", data: { messageId: "m1", content: "", toolRequests: [{ toolCallId: "w1", name: "web_search", arguments: { query: "q" } }] } },
    { type: "tool.execution_start", data: { toolCallId: "w1", toolName: "web_search", arguments: { query: "q" } } },
    { type: "tool.execution_complete", data: { toolCallId: "w1", success: true, result: { content: JSON.stringify(searchOutput) } } },
    { type: "assistant.message", data: { messageId: "m2", content: answer } },
    { type: "session.idle", data: {} },
  ];
  for (const e of events) mapper.handle(e);
  const text = chunks.flatMap((c) => (c.type === "text-delta" ? [c.delta] : [])).join("");
  return { chunks, text, result: mapper.result() };
}

describe("web_search sources on the Copilot path", () => {
  it("an answer without source links gets them as markdown links in the stream and the stored text", () => {
    const { text, result, chunks } = turn("Pressure is 3 bar.");
    const line = "\n\n**Sources:** [Spec v2](https://example.org/a?utm_source=openai) · [example.org](https://example.org/b)\n";
    // The same form the AI SDK path shows: markdown links in the answer text.
    expect(text).toBe(`Pressure is 3 bar.${line}`);
    expect(result.text).toBe(`Pressure is 3 bar.${line}`);
    // Before the step ends and the message finishes.
    const types = chunks.map((c) => c.type);
    expect(types.slice(-5)).toEqual(["text-start", "text-delta", "text-end", "finish-step", "finish"]);
  });

  it("works from the runtime's result text when the raw output is not there", () => {
    expect(turn("Pressure is 3 bar.", false).result.text).toContain("[example.org](https://example.org/b)");
  });

  it("an answer that links a source stays as it is", () => {
    const answer = "Pressure is 3 bar ([spec](https://example.org/a)).";
    const { text, result } = turn(answer);
    expect(text).toBe(answer);
    expect(result.text).toBe(answer);
  });

  it("keeps http(s) sources only, once each, and escapes what would break a link", () => {
    expect(
      webSearchSources({
        citations: [{ url: "javascript:alert(1)" }, { url: "https://x.test/a b(1)" }, { url: "https://x.test/c" }, { url: "https://x.test/c" }],
      }),
    ).toEqual([{ url: "https://x.test/c" }]);
    expect(markdownLink({ url: "https://x.test/p(1)", title: "A]\nB" })).toBe("[A B](https://x.test/p%281%29)");
    expect(sourcesMarkdown([])).toBe("");
    expect(citesAnySource("see https://x.test/a", [{ url: "https://x.test/a?utm_source=openai" }])).toBe(true);
  });
});
