import { describe, it, expect } from "vitest";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { withAnthropicPromptCache } from "./prompt-builder";

// Wire-level proof that the breakpoints from withAnthropicPromptCache survive
// the full AI SDK → @ai-sdk/anthropic pipeline and land as `cache_control` in
// the actual Anthropic Messages-API request body (the exact field Claude /
// Azure-/anthropic key the prompt cache on). Unlike prompt-builder.test.ts —
// which asserts the helper's ModelMessage shape — this drives the real provider
// through a fake fetch, so an SDK upgrade that changed how providerOptions map
// to the wire would fail here.

function captureRequestBody(): { getBody: () => any; fetch: typeof fetch } {
  let body: any;
  const fakeFetch: typeof fetch = async (_input, init) => {
    body = JSON.parse(init!.body as string);
    // Minimal non-streaming Anthropic Messages-API response.
    const responseBody = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { getBody: () => body, fetch: fakeFetch };
}

describe("Anthropic prompt cache — wire level", () => {
  it("sends cache_control on the system block AND the latest turn, nothing else", async () => {
    const cap = captureRequestBody();
    const provider = createAnthropic({
      baseURL: "https://example.invalid/anthropic/v1",
      apiKey: "test-key",
      fetch: cap.fetch,
    });

    const { instructions: system, messages } = withAnthropicPromptCache(
      "A SUFFICIENTLY LARGE, STABLE SYSTEM PROMPT FOR CACHING",
      [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "latest question" },
      ],
    );

    await generateText({
      model: provider("claude-opus-4-8"),
      instructions: system,
      messages,
    });

    const body = cap.getBody();

    // Breakpoint #1 — the system block (caches tools + system together).
    expect(Array.isArray(body.system)).toBe(true);
    const cachedSystemBlocks = body.system.filter(
      (b: any) => b.cache_control?.type === "ephemeral",
    );
    expect(cachedSystemBlocks.length).toBe(1);

    // Breakpoint #2 — the last content block of the latest turn (caches history).
    const lastMsg = body.messages[body.messages.length - 1];
    const lastBlock = lastMsg.content[lastMsg.content.length - 1];
    expect(lastBlock.cache_control?.type).toBe("ephemeral");

    // Earlier turns must carry NO breakpoint — total stays at 2, well under
    // Anthropic's hard limit of 4 cache_control breakpoints per request.
    const earlierTurns = body.messages.slice(0, -1);
    const markedEarlier = earlierTurns.flatMap((m: any) =>
      (Array.isArray(m.content) ? m.content : []).filter((b: any) => b.cache_control),
    );
    expect(markedEarlier).toEqual([]);

    const totalBreakpoints =
      cachedSystemBlocks.length +
      body.messages.flatMap((m: any) =>
        (Array.isArray(m.content) ? m.content : []).filter(
          (b: any) => b.cache_control,
        ),
      ).length;
    expect(totalBreakpoints).toBe(2);
  });
});
