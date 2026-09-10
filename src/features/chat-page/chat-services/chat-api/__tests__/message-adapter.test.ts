import { describe, it, expect } from "vitest";
import {
  uiMessagesFromChatMessages,
  chatMessagesFromUIMessages,
} from "../message-adapter";
import { ChatMessageModel, MESSAGE_ATTRIBUTE } from "../../models";
import { convertToModelMessages } from "ai";
import type { ModelMessage, UIMessage } from "ai";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let seq = 0;
function makeId() {
  return `id-${++seq}`;
}

function baseRow(overrides: Partial<ChatMessageModel>): ChatMessageModel {
  return {
    id: makeId(),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    isDeleted: false,
    threadId: "thread-1",
    userId: "user-1",
    name: "",
    content: "",
    role: "user",
    type: MESSAGE_ATTRIBUTE,
    ...overrides,
  };
}

const CTX = { threadId: "thread-1", userId: "user-1" };

// ---------------------------------------------------------------------------
// Structural equivalence helper
// ---------------------------------------------------------------------------

/**
 * Compare rows structurally, ignoring id and createdAt because those are
 * regenerated on the return trip (UIMessage carries no Cosmos-level ids).
 */
function stripVolatile(row: ChatMessageModel) {
  // Deliberately drop `id` and `createdAt`. Written as a delete on a shallow
  // copy rather than as a rest-destructure, because the destructure needs an
  // eslint-disable for a rule this repo's flat config does not register — and
  // an unknown rule name in a disable comment is itself an eslint error.
  const rest: Record<string, unknown> = { ...row };
  delete rest.id;
  delete rest.createdAt;
  return rest;
}

// ---------------------------------------------------------------------------
// 1. Plain user + assistant (no tools, no reasoning)
// ---------------------------------------------------------------------------

describe("plain conversation (user + assistant)", () => {
  const rows: ChatMessageModel[] = [
    baseRow({ id: "u1", role: "user", content: "Hello" }),
    baseRow({ id: "a1", role: "assistant", content: "Hi there!" }),
  ];

  it("produces two UIMessages with correct roles", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
  });

  it("text parts carry the right content", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    const userText = msgs[0].parts.find((p) => p.type === "text") as any;
    const assistantText = msgs[1].parts.find((p) => p.type === "text") as any;
    expect(userText.text).toBe("Hello");
    expect(assistantText.text).toBe("Hi there!");
  });

  it("round-trips structurally", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    const back = chatMessagesFromUIMessages(msgs, CTX);
    expect(back.map(stripVolatile)).toEqual(rows.map(stripVolatile));
  });

  it("drops a data-compaction part instead of persisting it", () => {
    // The compaction notice is something the app told the user, not something
    // anyone said. It must not become a row, because a row would come back as
    // history on the next turn and end up in the model's prompt. The adapter
    // selects parts by type, so this holds by construction — pinned here
    // because the cost of it silently changing is a polluted prompt.
    const msgs = uiMessagesFromChatMessages(rows);
    const withNotice = msgs.map((m, i) =>
      i === 1
        ? {
            ...m,
            parts: [
              {
                type: "data-compaction",
                id: "compaction",
                data: { status: "done", trimmedTurns: 3 },
              } as never,
              ...m.parts,
            ],
          }
        : m,
    );

    const back = chatMessagesFromUIMessages(withNotice, CTX);

    expect(back.map(stripVolatile)).toEqual(rows.map(stripVolatile));
    expect(JSON.stringify(back)).not.toContain("compaction");
  });
});

// ---------------------------------------------------------------------------
// 2. Assistant + 1 tool call
// ---------------------------------------------------------------------------

describe("assistant with one tool call", () => {
  const toolContent = JSON.stringify({
    name: "web_search",
    arguments: JSON.stringify({ query: "azurechat" }),
    result: JSON.stringify({ hits: 3 }),
    call_id: "call-abc",
  });

  const rows: ChatMessageModel[] = [
    baseRow({ id: "u1", role: "user", content: "search for azurechat" }),
    baseRow({ id: "a1", role: "assistant", content: "Sure, searching…" }),
    baseRow({ id: "t1", role: "tool", name: "web_search", content: toolContent }),
  ];

  it("folds the tool row into the assistant UIMessage", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    expect(msgs).toHaveLength(2); // user + assistant (tool folded in)
    const assistantParts = msgs[1].parts;
    const toolPart = assistantParts.find((p) => p.type === "dynamic-tool") as any;
    expect(toolPart).toBeDefined();
    expect(toolPart.toolName).toBe("web_search");
    expect(toolPart.state).toBe("output-available");
  });

  it("round-trips structurally (3 rows in → 3 rows out)", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    const back = chatMessagesFromUIMessages(msgs, CTX);
    expect(back).toHaveLength(3);
    expect(back.map(stripVolatile)).toEqual(rows.map(stripVolatile));
  });
});

// ---------------------------------------------------------------------------
// 3. Assistant + 2 tool calls
// ---------------------------------------------------------------------------

describe("assistant with two tool calls", () => {
  const tool1 = JSON.stringify({
    name: "get_weather",
    arguments: JSON.stringify({ city: "Zurich" }),
    result: JSON.stringify({ temp: 18 }),
    call_id: "call-1",
  });
  const tool2 = JSON.stringify({
    name: "get_weather",
    arguments: JSON.stringify({ city: "Berne" }),
    result: JSON.stringify({ temp: 16 }),
    call_id: "call-2",
  });

  const rows: ChatMessageModel[] = [
    baseRow({ role: "user", content: "Weather in Zurich and Berne?" }),
    baseRow({ role: "assistant", content: "Let me check…" }),
    baseRow({ role: "tool", name: "get_weather", content: tool1 }),
    baseRow({ role: "tool", name: "get_weather", content: tool2 }),
  ];

  it("folds both tool rows into the one assistant UIMessage", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    expect(msgs).toHaveLength(2);
    const toolParts = msgs[1].parts.filter((p) => p.type === "dynamic-tool");
    expect(toolParts).toHaveLength(2);
  });

  it("tool parts carry distinct call ids", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    const toolParts = msgs[1].parts.filter((p) => p.type === "dynamic-tool") as any[];
    const ids = toolParts.map((p) => p.toolCallId);
    expect(new Set(ids).size).toBe(2);
  });

  it("round-trips structurally (4 rows in → 4 rows out)", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    const back = chatMessagesFromUIMessages(msgs, CTX);
    expect(back).toHaveLength(4);
    expect(back.map(stripVolatile)).toEqual(rows.map(stripVolatile));
  });
});

// ---------------------------------------------------------------------------
// 4. Assistant + reasoning + tool call
// ---------------------------------------------------------------------------

describe("assistant with reasoning and one tool", () => {
  const toolContent = JSON.stringify({
    name: "calculator",
    arguments: JSON.stringify({ expr: "2+2" }),
    result: "4",
    call_id: "call-r1",
  });

  const rows: ChatMessageModel[] = [
    baseRow({ role: "user", content: "What is 2+2?" }),
    baseRow({
      role: "assistant",
      content: "The answer is 4.",
      reasoningContent: "I need to compute 2+2.",
      reasoningState: { encrypted: "blob" },
    }),
    baseRow({ role: "tool", name: "calculator", content: toolContent }),
  ];

  it("creates a reasoning part before the text part", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    const assistant = msgs[1];
    const reasoningIdx = assistant.parts.findIndex((p) => p.type === "reasoning");
    const textIdx = assistant.parts.findIndex((p) => p.type === "text");
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(reasoningIdx).toBeLessThan(textIdx);
  });

  it("reasoning text is preserved", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    const reasoningPart = msgs[1].parts.find((p) => p.type === "reasoning") as any;
    expect(reasoningPart.text).toBe("I need to compute 2+2.");
  });

  it("reasoningState survives the round-trip via metadata", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    const meta = (msgs[1].metadata ?? {}) as any;
    expect(meta.reasoningState).toEqual({ encrypted: "blob" });

    const back = chatMessagesFromUIMessages(msgs, CTX);
    const assistantRow = back.find((r) => r.role === "assistant")!;
    expect(assistantRow.reasoningState).toEqual({ encrypted: "blob" });
  });

  it("round-trips structurally (3 rows in → 3 rows out)", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    const back = chatMessagesFromUIMessages(msgs, CTX);
    expect(back).toHaveLength(3);
    expect(back.map(stripVolatile)).toEqual(rows.map(stripVolatile));
  });
});

// ---------------------------------------------------------------------------
// 5. Multi-turn conversation with tools across turns
// ---------------------------------------------------------------------------

describe("multi-turn conversation with tools across turns", () => {
  const tool1 = JSON.stringify({
    name: "fetch_url",
    arguments: JSON.stringify({ url: "https://example.com" }),
    result: "<html>…</html>",
    call_id: "call-mt1",
  });
  const tool2 = JSON.stringify({
    name: "summarise",
    arguments: JSON.stringify({ text: "<html>…</html>" }),
    result: "A page about example.com",
    call_id: "call-mt2",
  });

  const rows: ChatMessageModel[] = [
    baseRow({ role: "user", content: "Summarise example.com" }),
    baseRow({ role: "assistant", content: "" }),
    baseRow({ role: "tool", name: "fetch_url", content: tool1 }),
    baseRow({ role: "assistant", content: "Here is the summary." }),
    baseRow({ role: "tool", name: "summarise", content: tool2 }),
    baseRow({ role: "user", content: "Thanks!" }),
    baseRow({ role: "assistant", content: "You're welcome!" }),
  ];

  it("produces 4 UIMessages (user + 2 assistants with tools folded + user + assistant)", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    // user, assistant(+tool1), assistant(+tool2), user, assistant
    expect(msgs).toHaveLength(5);
  });

  it("each tool row is folded into its preceding assistant", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    // second UIMessage is first assistant, has fetch_url tool
    const firstAssistant = msgs[1];
    const tool1Part = firstAssistant.parts.find((p) => p.type === "dynamic-tool") as any;
    expect(tool1Part?.toolName).toBe("fetch_url");

    // third UIMessage is second assistant, has summarise tool
    const secondAssistant = msgs[2];
    const tool2Part = secondAssistant.parts.find((p) => p.type === "dynamic-tool") as any;
    expect(tool2Part?.toolName).toBe("summarise");
  });

  it("round-trips structurally (7 rows in → 7 rows out)", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    const back = chatMessagesFromUIMessages(msgs, CTX);
    expect(back).toHaveLength(7);
    expect(back.map(stripVolatile)).toEqual(rows.map(stripVolatile));
  });
});

// ---------------------------------------------------------------------------
// 6. User message with multiModalImages
// ---------------------------------------------------------------------------

describe("user message with multiModalImages", () => {
  const rows: ChatMessageModel[] = [
    baseRow({
      role: "user",
      content: "Describe this image",
      multiModalImages: ["https://blob.example.com/img1.png", "https://blob.example.com/img2.png"],
    }),
    baseRow({ role: "assistant", content: "These are two images." }),
  ];

  it("images become FileUIPart entries on the user UIMessage", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    const fileParts = msgs[0].parts.filter((p) => p.type === "file") as any[];
    expect(fileParts).toHaveLength(2);
    expect(fileParts[0].url).toBe("https://blob.example.com/img1.png");
    expect(fileParts[1].url).toBe("https://blob.example.com/img2.png");
  });

  it("round-trips image URLs structurally", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    const back = chatMessagesFromUIMessages(msgs, CTX);
    const userRow = back.find((r) => r.role === "user")!;
    expect(userRow.multiModalImages).toEqual([
      "https://blob.example.com/img1.png",
      "https://blob.example.com/img2.png",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 7. Stray tool row (no preceding assistant) — edge case
// ---------------------------------------------------------------------------

describe("stray tool row without preceding assistant", () => {
  const toolContent = JSON.stringify({
    name: "orphan_tool",
    arguments: "{}",
    result: "done",
    call_id: "call-orphan",
  });

  const rows: ChatMessageModel[] = [
    baseRow({ role: "tool", name: "orphan_tool", content: toolContent }),
  ];

  it("creates a synthetic assistant UIMessage and folds the tool part in", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    const toolPart = msgs[0].parts.find((p) => p.type === "dynamic-tool") as any;
    expect(toolPart?.toolName).toBe("orphan_tool");
  });
});

// ---------------------------------------------------------------------------
// 8. Deleted rows are skipped
// ---------------------------------------------------------------------------

describe("deleted rows", () => {
  const rows: ChatMessageModel[] = [
    baseRow({ role: "user", content: "Keep me" }),
    baseRow({ role: "user", content: "Delete me", isDeleted: true }),
    baseRow({ role: "assistant", content: "Response" }),
  ];

  it("skips rows with isDeleted=true", () => {
    const msgs = uiMessagesFromChatMessages(rows);
    const texts = msgs
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "text")
      .map((p) => (p as any).text);
    expect(texts).not.toContain("Delete me");
    expect(texts).toContain("Keep me");
  });
});

// ---------------------------------------------------------------------------
// 9. Empty rows array
// ---------------------------------------------------------------------------

describe("image_generation tool result with blob:// reference", () => {
  it("passes the persisted blob:// reference through unchanged — server NEVER resolves it", () => {
    // The contract: `blob://` is the canonical storage token and stays on
    // the server side of every boundary, including the model's view of
    // history. The UI tool widget (tool-part-view.tsx) resolves to a
    // `/api/images?...` URL at render time. Resolving here would leak the
    // URL into convertToModelMessages, the model would echo it as
    // markdown on follow-up turns, and Streamdown would render every
    // image twice.
    const toolRow = baseRow({
      role: "tool",
      name: "image_generation",
      content: JSON.stringify({
        name: "image_generation",
        arguments: "{}",
        result: JSON.stringify({
          result: "blob://thread-1/imagegen-call-1.png",
        }),
        call_id: "call-1",
      }),
    });
    const assistantRow = baseRow({ role: "assistant", content: "" });
    const msgs = uiMessagesFromChatMessages([assistantRow, toolRow]);

    const toolPart = msgs[0].parts.find(
      (p) => (p as { type: string }).type === "dynamic-tool",
    ) as { output: { result: string } } | undefined;
    expect(toolPart).toBeDefined();
    expect(toolPart!.output.result).toBe("blob://thread-1/imagegen-call-1.png");
    expect(toolPart!.output.result).not.toMatch(/^\/api\/images/);
  });
});

describe("empty input", () => {
  it("returns empty array for no rows", () => {
    expect(uiMessagesFromChatMessages([])).toEqual([]);
  });

  it("returns empty array for no messages", () => {
    expect(chatMessagesFromUIMessages([], CTX)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 11. Step boundaries — live turn vs rehydrated turn produce the same
//     model messages (prompt-cache prefix stability)
// ---------------------------------------------------------------------------

/**
 * Model messages carry reasoning items on the live path only (encrypted
 * reasoning is deliberately not persisted), so drop them before comparing.
 */
function withoutReasoning(messages: ModelMessage[]) {
  return messages
    .map((m) => {
      if (m.role !== "assistant" || typeof m.content === "string") return m;
      return {
        ...m,
        content: (m.content as Array<{ type: string }>).filter(
          (c) => c.type !== "reasoning",
        ),
      } as ModelMessage;
    })
    .filter(
      (m) =>
        typeof m.content === "string" ||
        (m.content as Array<unknown>).length > 0,
    );
}

/** The live UIMessages the AI SDK produces for a 2-step tool turn. */
function liveTwoStepTurn(): UIMessage[] {
  return [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "What time is it?" }],
    },
    {
      id: "a1",
      role: "assistant",
      parts: [
        // Step 1: the model calls a tool and nothing else.
        { type: "step-start" },
        {
          type: "dynamic-tool",
          toolName: "get_current_time",
          toolCallId: "call-1",
          state: "output-available",
          input: { timezone: "Europe/Zurich" },
          output: { now: "2026-09-07T12:00:00+02:00" },
        },
        // Step 2: with the result in hand it writes the answer.
        { type: "step-start" },
        { type: "text", text: "It is just after noon in Zurich.", state: "done" },
      ],
    },
  ] as UIMessage[];
}

describe("step boundaries survive a Cosmos round-trip", () => {
  it("replays a 2-step tool turn as the same model-message sequence the live turn sent", async () => {
    const live = liveTwoStepTurn();
    const liveModelMessages = await convertToModelMessages(live);

    // Sanity-check the fixture really is the interleaved live shape.
    expect(liveModelMessages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);

    const rows = chatMessagesFromUIMessages(live, CTX).map((r) => ({
      ...r,
      id: makeId(),
      isDeleted: false,
    }));
    const rehydrated = uiMessagesFromChatMessages(rows);
    const replayModelMessages = await convertToModelMessages(rehydrated);

    expect(withoutReasoning(replayModelMessages)).toEqual(
      withoutReasoning(liveModelMessages),
    );
  });

  it("persists the step layout on the assistant row", () => {
    const rows = chatMessagesFromUIMessages(liveTwoStepTurn(), CTX);
    const assistantRow = rows.find((r) => r.role === "assistant")!;
    expect(assistantRow.stepLayout).toEqual([
      "step-start",
      "tool:call-1",
      "step-start",
      "text:32",
    ]);
    // The row content is unchanged — the layout only describes the ordering.
    expect(assistantRow.content).toBe("It is just after noon in Zurich.");
  });

  it("re-persisting a rehydrated turn keeps the same layout (idempotent)", () => {
    const rows = chatMessagesFromUIMessages(liveTwoStepTurn(), CTX).map((r) => ({
      ...r,
      id: makeId(),
      isDeleted: false,
    }));
    const rehydrated = uiMessagesFromChatMessages(rows);
    const reRows = chatMessagesFromUIMessages(rehydrated, CTX);
    const before = rows.find((r) => r.role === "assistant")!.stepLayout;
    const after = reRows.find((r) => r.role === "assistant")!.stepLayout;
    expect(after).toEqual(before);
  });

  it("keeps the old flat replay for rows written before stepLayout existed (back-compat)", async () => {
    // Exactly the shape the old persist path wrote: no stepLayout anywhere.
    const rows: ChatMessageModel[] = [
      baseRow({ role: "user", content: "What time is it?" }),
      baseRow({ role: "assistant", content: "It is just after noon in Zurich." }),
      baseRow({
        role: "tool",
        name: "get_current_time",
        content: JSON.stringify({
          name: "get_current_time",
          arguments: JSON.stringify({ timezone: "Europe/Zurich" }),
          result: JSON.stringify({ now: "2026-09-07T12:00:00+02:00" }),
          call_id: "call-1",
        }),
      }),
    ];
    const modelMessages = await convertToModelMessages(
      uiMessagesFromChatMessages(rows),
    );
    // One assistant block holding text + tool-call, then the tool message —
    // the pre-existing behaviour, unchanged for legacy rows.
    expect(modelMessages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    const assistantContent = modelMessages[1].content as Array<{ type: string }>;
    expect(assistantContent.map((c) => c.type)).toEqual(["text", "tool-call"]);
  });

  it("falls back to the flat ordering when the layout does not match the row (negative)", async () => {
    // A layout whose text lengths don't add up to the stored content, e.g. a
    // row whose content was edited by a later migration.
    const rows: ChatMessageModel[] = [
      baseRow({
        role: "assistant",
        content: "short",
        stepLayout: ["step-start", "tool:call-1", "step-start", "text:999"],
      }),
      baseRow({
        role: "tool",
        name: "get_current_time",
        content: JSON.stringify({
          name: "get_current_time",
          arguments: "{}",
          result: "{}",
          call_id: "call-1",
        }),
      }),
    ];
    const rehydrated = uiMessagesFromChatMessages(rows);
    expect(rehydrated[0].parts.map((p) => p.type)).toEqual([
      "text",
      "dynamic-tool",
    ]);
    const modelMessages = await convertToModelMessages(rehydrated);
    expect(modelMessages.map((m) => m.role)).toEqual(["assistant", "tool"]);
  });

  it("drops a layout entry that names a tool call the thread no longer has (negative)", async () => {
    const rows: ChatMessageModel[] = [
      baseRow({
        role: "assistant",
        content: "done",
        stepLayout: ["step-start", "tool:missing", "step-start", "text:4"],
      }),
    ];
    const rehydrated = uiMessagesFromChatMessages(rows);
    // No tool part to place → layout rejected, flat ordering kept.
    expect(rehydrated[0].parts.map((p) => p.type)).toEqual(["text"]);
    expect(await convertToModelMessages(rehydrated)).toHaveLength(1);
  });
});
