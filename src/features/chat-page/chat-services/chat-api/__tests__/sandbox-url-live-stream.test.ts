/**
 * The live (streamed) answer of a code-interpreter turn must carry the
 * same-origin /api/images download link, not the raw `sandbox:` URL.
 *
 * These tests run a Responses-API event stream through the real provider
 * (@ai-sdk/azure), the real `streamText`, the transform chain the chat route
 * uses (createChatStreamTransforms) and `toUIMessageStream` — the text the
 * browser receives. Only the network (fetch) and the container-file ingest
 * are replaced.
 *
 * The event shapes and the text-delta split follow a stream recorded from
 * the Responses API: the model writes `[Download sales3.csv](sandbox:/mnt/
 * data/sales3.csv)` in deltas `](`, `sandbox`, `:/`, `mnt`, `/data`, `/s`,
 * `ales`, `3`, `.csv`, `)`, and the container_file_citation annotation
 * arrives only after the last text delta.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { streamText, type ToolSet } from "ai";
import { createAzure } from "@ai-sdk/azure";

const ingestMock = vi.hoisted(() => ({
  fail: false,
  calls: [] as string[],
}));

vi.mock("@/features/chat-page/chat-services/chat-file-store-ingest", () => ({
  ingestContainerFileSourceToChatStore: vi.fn(
    async (threadId: string, source: { filename?: string }) => {
      ingestMock.calls.push(source.filename ?? "");
      if (ingestMock.fail || !source.filename) return null;
      return {
        filename: source.filename,
        url: `/api/images?t=${encodeURIComponent(threadId)}&img=${encodeURIComponent(source.filename)}`,
      };
    },
  ),
}));
vi.mock("@/features/chat-page/chat-services/chat-image-persistence-service", () => ({
  persistBase64Image: vi.fn(),
}));

import { createChatStreamTransforms } from "../chat-stream-transforms";

const THREAD_ID = "thread-1";
const DOWNLOAD_URL = `/api/images?t=${THREAD_ID}&img=sales3.csv`;
const CONTAINER_ID = "cntr_test";

/** The recorded split of the final answer. */
const RECORDED_DELTAS = [
  "[",
  "Download",
  " sales",
  "3",
  ".csv",
  "](",
  "sandbox",
  ":/",
  "mnt",
  "/data",
  "/s",
  "ales",
  "3",
  ".csv",
  ")",
  " —",
  " a CSV",
  " with ",
  "5 sample",
  " sales records.",
];

type TextItem = {
  id: string;
  phase?: "commentary" | "final_answer";
  deltas: string[];
  /** Filename of a container_file_citation emitted after the last delta. */
  citation?: string;
};

/** Builds the SSE event list for: [text item] → code_interpreter → [text item]. */
function responsesEvents(opts: { before?: TextItem; after?: TextItem }) {
  let seq = 0;
  const events: Record<string, unknown>[] = [];
  const push = (e: Record<string, unknown>) =>
    events.push({ sequence_number: seq++, ...e });
  let outputIndex = 0;

  const textItem = (item: TextItem) => {
    const index = outputIndex++;
    const text = item.deltas.join("");
    const annotations = item.citation
      ? [
          {
            type: "container_file_citation",
            container_id: CONTAINER_ID,
            file_id: "cfile_test",
            filename: item.citation,
            start_index: 0,
            end_index: text.length,
          },
        ]
      : [];
    push({
      type: "response.output_item.added",
      output_index: index,
      item: { type: "message", id: item.id, phase: item.phase, role: "assistant", status: "in_progress", content: [] },
    });
    for (const delta of item.deltas) {
      push({
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: index,
        content_index: 0,
        delta,
        logprobs: [],
      });
    }
    for (const [annotationIndex, annotation] of annotations.entries()) {
      push({
        type: "response.output_text.annotation.added",
        item_id: item.id,
        output_index: index,
        content_index: 0,
        annotation_index: annotationIndex,
        annotation,
      });
    }
    push({
      type: "response.output_item.done",
      output_index: index,
      item: {
        type: "message",
        id: item.id,
        phase: item.phase,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations, logprobs: [] }],
      },
    });
  };

  push({ type: "response.created", response: { id: "resp_test", created_at: 1, model: "test", status: "in_progress" } });
  if (opts.before) textItem(opts.before);

  const ciIndex = outputIndex++;
  const code = "Path('/mnt/data/sales3.csv').write_text('region,month,revenue\\n')";
  push({
    type: "response.output_item.added",
    output_index: ciIndex,
    item: { type: "code_interpreter_call", id: "ci_test", container_id: CONTAINER_ID, code: "", outputs: [], status: "in_progress" },
  });
  push({ type: "response.code_interpreter_call_code.delta", item_id: "ci_test", output_index: ciIndex, delta: code });
  push({ type: "response.code_interpreter_call_code.done", item_id: "ci_test", output_index: ciIndex, code });
  push({
    type: "response.output_item.done",
    output_index: ciIndex,
    item: {
      type: "code_interpreter_call",
      id: "ci_test",
      container_id: CONTAINER_ID,
      code,
      outputs: [{ type: "logs", logs: "41" }],
      status: "completed",
    },
  });

  if (opts.after) textItem(opts.after);
  push({
    type: "response.completed",
    response: {
      id: "resp_test",
      created_at: 1,
      model: "test",
      status: "completed",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  return events;
}

/** Streams the events through the route's chain; returns the client text per text part. */
async function streamToClient(events: Record<string, unknown>[]) {
  const sse =
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
    "data: [DONE]\n\n";
  const azure = createAzure({
    resourceName: "test",
    apiKey: "test",
    fetch: (async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch,
  });
  const result = streamText({
    model: azure("test"),
    prompt: "Save it again as sales3.csv and give me a download link.",
    tools: {
      code_interpreter: azure.tools.codeInterpreter({ container: CONTAINER_ID }),
    } as ToolSet,
    experimental_transform: createChatStreamTransforms(THREAD_ID),
  });
  const textByPart = new Map<string, string>();
  for await (const chunk of result.toUIMessageStream()) {
    if (chunk.type === "text-delta") {
      textByPart.set(chunk.id, (textByPart.get(chunk.id) ?? "") + chunk.delta);
    }
  }
  return textByPart;
}

describe("live code-interpreter download link (route transform chain)", () => {
  beforeEach(() => {
    ingestMock.fail = false;
    ingestMock.calls = [];
  });

  it("rewrites the link of the recorded stream (split after '/s', citation after the text)", async () => {
    const text = await streamToClient(
      responsesEvents({
        after: { id: "msg_final", phase: "final_answer", deltas: RECORDED_DELTAS, citation: "sales3.csv" },
      }),
    );
    const answer = text.get("msg_final");
    expect(answer).toBe(
      `[Download sales3.csv](${DOWNLOAD_URL}) — a CSV with 5 sample sales records.`,
    );
    expect(ingestMock.calls).toContain("sales3.csv");
  });

  it("falls back to the /api/images path when the container file cannot be ingested", async () => {
    ingestMock.fail = true;
    const text = await streamToClient(
      responsesEvents({
        after: { id: "msg_final", phase: "final_answer", deltas: RECORDED_DELTAS, citation: "sales3.csv" },
      }),
    );
    expect(text.get("msg_final")).toContain(`(${DOWNLOAD_URL})`);
    expect(text.get("msg_final")).not.toContain("sandbox:");
  });

  it("rewrites a link written in a commentary part before the code_interpreter call", async () => {
    const text = await streamToClient(
      responsesEvents({
        before: {
          id: "msg_commentary",
          phase: "commentary",
          deltas: ["I'll save it. ", ...RECORDED_DELTAS.slice(0, 15)],
        },
        after: { id: "msg_final", phase: "final_answer", deltas: ["Done."] },
      }),
    );
    expect(text.get("msg_commentary")).toBe(
      `I'll save it. [Download sales3.csv](${DOWNLOAD_URL})`,
    );
    expect(text.get("msg_final")).toBe("Done.");
  });

  it("rewrites the link for every two-way split of the answer into deltas", async () => {
    const full = RECORDED_DELTAS.join("");
    for (let cut = 1; cut < full.length; cut++) {
      const text = await streamToClient(
        responsesEvents({
          after: {
            id: "msg_final",
            phase: "final_answer",
            deltas: [full.slice(0, cut), full.slice(cut)],
            citation: "sales3.csv",
          },
        }),
      );
      expect(text.get("msg_final"), `split at ${cut}`).toBe(
        `[Download sales3.csv](${DOWNLOAD_URL}) — a CSV with 5 sample sales records.`,
      );
    }
  });
});
