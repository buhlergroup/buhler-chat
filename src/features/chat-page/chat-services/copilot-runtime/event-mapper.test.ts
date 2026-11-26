import { describe, it, expect } from "vitest";
import type { UIMessageChunk } from "ai";

import { CopilotEventMapper, type CopilotEventLike, type EventMapperOptions } from "./event-mapper";

function run(events: CopilotEventLike[], options: Partial<EventMapperOptions> = {}) {
  const chunks: UIMessageChunk[] = [];
  const mapper = new CopilotEventMapper((c) => chunks.push(c), {
    appToolNames: new Set(["get_current_time", "search_documents"]),
    ...options,
  });
  mapper.start();
  let done = false;
  for (const e of events) done = mapper.handle(e) || done;
  return { chunks, mapper, done, types: chunks.map((c) => c.type) };
}

const usage = (data: Record<string, unknown>): CopilotEventLike => ({ type: "assistant.usage", data });

describe("CopilotEventMapper", () => {
  it("maps a streamed text turn to start / step / text / finish with usage metadata", () => {
    const { chunks, done, mapper } = run(
      [
        { type: "assistant.turn_start", data: { turnId: "1" } },
        { type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "Hel" } },
        { type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "lo" } },
        { type: "assistant.message", data: { messageId: "m1", content: "Hello" } },
        usage({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: 10, finishReason: "stop" }),
        { type: "assistant.turn_end", data: { turnId: "1" } },
        { type: "session.idle", data: {} },
      ],
      { finishMetadata: (u) => ({ usage: { input: u.inputTokens, cached: u.cacheReadTokens } }) },
    );
    expect(done).toBe(true);
    expect(chunks).toEqual([
      { type: "start" },
      { type: "start-step" },
      { type: "text-start", id: "m1" },
      { type: "text-delta", id: "m1", delta: "Hel" },
      { type: "text-delta", id: "m1", delta: "lo" },
      { type: "text-end", id: "m1" },
      { type: "finish-step" },
      { type: "finish", finishReason: "stop", messageMetadata: { usage: { input: 100, cached: 80 } } },
    ]);
    const result = mapper.result();
    expect(result.text).toBe("Hello");
    expect(result.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 5,
      totalTokens: 105,
      inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 10 },
    });
  });

  it("maps reasoning, a tool round trip and a second model call to two steps", () => {
    const { chunks, mapper } = run(
      [
        { type: "assistant.reasoning_delta", data: { reasoningId: "r1", deltaContent: "think" } },
        {
          type: "assistant.message",
          data: { messageId: "m1", content: "", toolRequests: [{ toolCallId: "c1", name: "get_current_time", arguments: {} }] },
        },
        usage({ inputTokens: 50, outputTokens: 10, finishReason: "tool_calls" }),
        { type: "tool.execution_start", data: { toolCallId: "c1", toolName: "get_current_time", arguments: {} } },
        { type: "tool.execution_complete", data: { toolCallId: "c1", success: true, result: { content: "{\"datetime\":\"x\"}" } } },
        { type: "assistant.message_delta", data: { messageId: "m2", deltaContent: "It is x." } },
        { type: "assistant.message", data: { messageId: "m2", content: "It is x." } },
        usage({ inputTokens: 70, outputTokens: 4, cacheReadTokens: 50, finishReason: "stop" }),
        { type: "session.idle", data: {} },
      ],
      { rawToolOutput: (id) => (id === "c1" ? { output: { datetime: "x" } } : undefined) },
    );
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "start-step",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "tool-input-available",
      "tool-output-available",
      "finish-step",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
    // App tool: static part (no `dynamic`), RAW output object, not the model text.
    expect(chunks.find((c) => c.type === "tool-input-available")).toEqual({
      type: "tool-input-available",
      toolCallId: "c1",
      toolName: "get_current_time",
      input: {},
    });
    expect(chunks.find((c) => c.type === "tool-output-available")).toEqual({
      type: "tool-output-available",
      toolCallId: "c1",
      output: { datetime: "x" },
    });
    const result = mapper.result();
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].toolResults).toEqual([
      { type: "tool-result", toolCallId: "c1", toolName: "get_current_time", input: {}, output: { datetime: "x" }, dynamic: true },
    ]);
    expect(result.steps[0].reasoningText).toBe("think");
    expect(result.text).toBe("It is x.");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.inputTokens).toBe(120);
    expect(mapper.turnUsage).toMatchObject({ calls: 2, lastInputTokens: 70, cacheReadTokens: 50 });
    // Per-step usage for the last-prompt-size number.
    expect(result.steps[1].usage?.inputTokens).toBe(70);
  });

  it("marks runtime built-in tools as dynamic and maps tool errors", () => {
    const { chunks } = run([
      { type: "assistant.message", data: { messageId: "m1", content: "", toolRequests: [] } },
      { type: "tool.execution_start", data: { toolCallId: "v1", toolName: "view", arguments: { path: "/etc/passwd" } } },
      { type: "tool.execution_complete", data: { toolCallId: "v1", success: false, error: { message: "Failed to stat path" } } },
      { type: "tool.execution_start", data: { toolCallId: "v2", toolName: "view", arguments: { path: "/workspace/a.txt" } } },
      { type: "tool.execution_complete", data: { toolCallId: "v2", success: true, result: { content: "alpha", detailedContent: "diff..." } } },
      { type: "session.idle", data: {} },
    ]);
    expect(chunks).toContainEqual({
      type: "tool-input-available",
      toolCallId: "v1",
      toolName: "view",
      input: { path: "/etc/passwd" },
      dynamic: true,
    });
    expect(chunks).toContainEqual({ type: "tool-output-error", toolCallId: "v1", errorText: "Failed to stat path", dynamic: true });
    expect(chunks).toContainEqual({ type: "tool-output-available", toolCallId: "v2", output: "alpha", dynamic: true });
  });

  it("shows the UI-safe error text for app tools", () => {
    const { chunks } = run(
      [
        { type: "tool.execution_start", data: { toolCallId: "c1", toolName: "search_documents", arguments: {} } },
        { type: "tool.execution_complete", data: { toolCallId: "c1", success: false, error: { message: "internal host 10.0.0.1" } } },
        { type: "session.idle", data: {} },
      ],
      { toolErrorText: (id) => (id === "c1" ? "An error occurred." : undefined) },
    );
    expect(chunks).toContainEqual({ type: "tool-output-error", toolCallId: "c1", errorText: "An error occurred." });
  });

  it("emits non-streamed message content and reasoning in full", () => {
    const { chunks, mapper } = run([
      { type: "assistant.message", data: { messageId: "m1", content: "Full answer", reasoningText: "why" } },
      { type: "session.idle", data: {} },
    ]);
    expect(chunks.slice(1, 9).map((c) => c.type)).toEqual([
      "start-step",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
    ]);
    expect(mapper.result()).toMatchObject({ text: "Full answer", reasoningText: "why" });
  });

  it("ignores events of runtime sub-agents (agentId)", () => {
    const { chunks } = run([
      { type: "assistant.message_delta", agentId: "sub-1", data: { messageId: "s", deltaContent: "hidden" } },
      { type: "session.idle", data: {} },
    ]);
    expect(chunks.map((c) => c.type)).toEqual(["start", "finish"]);
  });

  it("maps session.error to an error chunk and an error finish", () => {
    const { chunks, mapper } = run([
      { type: "session.error", data: { errorType: "authentication", message: "401 from provider" } },
      { type: "session.idle", data: {} },
    ]);
    expect(chunks).toContainEqual({ type: "error", errorText: "401 from provider" });
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "error" });
    expect(mapper.result().error).toEqual({ message: "401 from provider", name: "authentication" });
  });

  it("ends an aborted turn with an abort chunk and keeps the partial text", () => {
    const { chunks, mapper } = run([
      { type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "Once upon" } },
      { type: "abort", data: { reason: "user_initiated" } },
      { type: "session.idle", data: { aborted: true } },
    ]);
    expect(chunks.slice(-4).map((c) => c.type)).toEqual(["text-delta", "text-end", "finish-step", "abort"]);
    expect(mapper.result()).toMatchObject({ aborted: true, finishReason: "other", text: "Once upon" });
  });

  it("maps finish reasons and content filtering", () => {
    const { chunks } = run([
      { type: "assistant.message", data: { messageId: "m1", content: "cut" } },
      usage({ inputTokens: 1, outputTokens: 1, finishReason: "length" }),
      { type: "session.idle", data: {} },
    ]);
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "length" });
    const filtered = run([
      { type: "assistant.message", data: { messageId: "m1", content: "" } },
      usage({ inputTokens: 1, outputTokens: 0, finishReason: "stop", contentFilterTriggered: true }),
      { type: "session.idle", data: {} },
    ]);
    expect(filtered.chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "content-filter" });
  });

  it("fail() and abort() close a turn that never got session.idle", () => {
    const failed = new CopilotEventMapper(() => undefined, { appToolNames: new Set() });
    failed.fail("send failed", "SendError");
    expect(failed.isFinished).toBe(true);
    expect(failed.result()).toMatchObject({ finishReason: "error", error: { message: "send failed" } });
    // Events after the end are ignored.
    expect(failed.handle({ type: "assistant.message_delta", data: { messageId: "x", deltaContent: "late" } })).toBe(true);

    const aborted = new CopilotEventMapper(() => undefined, { appToolNames: new Set() });
    aborted.abort();
    expect(aborted.result()).toMatchObject({ aborted: true, finishReason: "other" });
  });
});
