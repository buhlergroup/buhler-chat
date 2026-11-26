import { describe, it, expect } from "vitest";
import type { UIMessage, UIMessageChunk } from "ai";
import { render, screen } from "@testing-library/react";

import { RichResponse } from "@/components/ai-elements/rich-response";
import { CopilotEventMapper, type CopilotEventLike } from "./event-mapper";
import { buildAssistantUIMessage, deriveStepToolLayout } from "../chat-api/persist-assistant";
import { chatMessagesFromUIMessages, uiMessagesFromChatMessages } from "../chat-api/message-adapter";
import { MESSAGE_ATTRIBUTE, type ChatMessageModel } from "../models";

// Regression: on the Copilot path the generate_image picture was only in the
// collapsed tool part. The AI SDK path also puts `![Generated image](blob://…)`
// into the answer text (image-generation-stream-rewriter.ts); the chat shows
// that inline, live and after a reload.

const REF = "blob://thread1/img01.png";
const SRC = "/api/images?t=thread1&img=img01.png";
const ANSWER = "Here is your red bicycle.";

const events: CopilotEventLike[] = [
  {
    type: "assistant.message",
    data: { messageId: "m1", content: "", toolRequests: [{ toolCallId: "call_1", name: "generate_image", arguments: {} }] },
  },
  { type: "tool.execution_start", data: { toolCallId: "call_1", toolName: "generate_image", arguments: { prompt: "a red bicycle", name: "red-bicycle" } } },
  // The runtime's own result text is what the MODEL saw: the path, no ref.
  { type: "tool.execution_complete", data: { toolCallId: "call_1", success: true, result: { content: "{\"path\":\"/workspace/images/red-bicycle.png\"}" } } },
  { type: "assistant.message", data: { messageId: "m2", content: ANSWER } },
  { type: "session.idle", data: {} },
];

function runTurn() {
  const chunks: UIMessageChunk[] = [];
  const mapper = new CopilotEventMapper((c) => chunks.push(c), {
    appToolNames: new Set(["generate_image"]),
    rawToolOutput: (id) => (id === "call_1" ? { output: { result: REF, path: "/workspace/images/red-bicycle.png" } } : undefined),
  });
  mapper.start();
  for (const e of events) mapper.handle(e);
  return { chunks, mapper };
}

const textOf = (m: UIMessage) =>
  m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");

describe("generate_image on the Copilot path: the image shows in the answer", () => {
  it("live: the stream carries the image markdown right after the tool output", () => {
    const { chunks } = runTurn();
    const outputAt = chunks.findIndex((c) => c.type === "tool-output-available");
    const imageAt = chunks.findIndex((c) => c.type === "text-delta" && c.delta.includes(`![Generated image](${REF})`));
    expect(outputAt).toBeGreaterThan(-1);
    expect(imageAt).toBeGreaterThan(outputAt);

    // What chat-page renders: the text parts of the message, through RichResponse.
    const text = chunks.flatMap((c) => (c.type === "text-delta" ? [c.delta] : [])).join("");
    render(<RichResponse content={text} />);
    expect(screen.getByRole("img")).toHaveAttribute("src", SRC);
    expect(screen.getByText(ANSWER)).toBeInTheDocument();
  });

  it("after a reload: the stored rows render the image again", () => {
    const { mapper } = runTurn();
    const result = mapper.result();
    expect(result.text).toBe(`\n\n![Generated image](${REF})\n\n${ANSWER}`);

    // The persist path (persist-assistant) and the reload path (message-adapter).
    const assistant = buildAssistantUIMessage(
      {
        text: result.text,
        toolResults: result.steps.flatMap((s) => s.toolResults) as never,
        stepLayout: deriveStepToolLayout(result.steps),
      },
      "a1",
    );
    const rows = chatMessagesFromUIMessages([assistant], { threadId: "thread1", userId: "u1" });
    const toolRow = rows.find((r) => r.role === "tool")!;
    expect(JSON.parse(toolRow.content).name).toBe("generate_image");
    const [reloaded] = uiMessagesFromChatMessages(rows);
    render(<RichResponse content={textOf(reloaded)} />);
    expect(screen.getByRole("img")).toHaveAttribute("src", SRC);
  });

  it("a stored Copilot row (shape as in the store) renders an <img> to /api/images", () => {
    const content = `\n\n![Generated image](${REF})\n\n${ANSWER}`;
    const base = { createdAt: new Date(), isDeleted: false, threadId: "thread1", userId: "u1", name: "", type: MESSAGE_ATTRIBUTE } as const;
    const rows: ChatMessageModel[] = [
      { ...base, id: "u", role: "user", content: "Generate an image of a red bicycle." },
      {
        ...base,
        id: "a",
        role: "assistant",
        content,
        stepLayout: ["step-start", "tool:call_1", "step-start", `text:${content.length}`],
      },
      {
        ...base,
        id: "t",
        role: "tool",
        content: JSON.stringify({
          name: "generate_image",
          arguments: JSON.stringify({ prompt: "a red bicycle", name: "red-bicycle" }),
          result: JSON.stringify({ result: REF, path: "/workspace/images/red-bicycle.png" }),
          call_id: "call_1",
        }),
      },
    ];
    const reloaded = uiMessagesFromChatMessages(rows).find((m) => m.role === "assistant")!;
    render(<RichResponse content={textOf(reloaded)} />);
    expect(screen.getByRole("img")).toHaveAttribute("src", SRC);
  });

  it("adds no image text for other tools or an output without a blob ref", () => {
    const chunks: UIMessageChunk[] = [];
    const mapper = new CopilotEventMapper((c) => chunks.push(c), {
      appToolNames: new Set(["generate_image"]),
      rawToolOutput: () => ({ output: { result: "javascript:alert(1)", path: "/workspace/images/x.png" } }),
    });
    mapper.start();
    for (const e of events) mapper.handle(e);
    expect(chunks.some((c) => c.type === "text-delta" && c.delta.includes("!["))).toBe(false);
    expect(mapper.result().text).toBe(ANSWER);
  });
});
