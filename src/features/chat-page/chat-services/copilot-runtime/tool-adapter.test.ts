import { describe, it, expect, vi } from "vitest";
import { jsonSchema, tool } from "ai";
import { z } from "zod";

import { ToolUserError } from "../tools/tool-user-error";
import { runAppTool, toCopilotTools, toModelText, type ToolCallRecord, type TurnToolBinding } from "./tool-adapter";

/** A toolset shaped like buildToolset's: zod tools, a JSON-schema (extension/MCP) tool, a function description. */
function appToolset(exec = vi.fn(async () => ({ datetime: "2026-01-01T00:00:00Z" }))) {
  return {
    get_current_time: tool({
      description: "Get the current date and time (the user's local time).",
      inputSchema: z.object({}),
      execute: exec,
    }),
    search_documents: tool({
      description: "Search documents",
      inputSchema: z.object({ query: z.string().describe("what to find"), top: z.number().default(5) }),
      execute: async ({ query, top }: { query: string; top: number }) => ({ query, top, hits: [] }),
    }),
    abcd1234_lookup: tool({
      description: "HTTP extension tool",
      inputSchema: jsonSchema({
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      }),
      execute: async (args: unknown) => `found ${(args as { id: string }).id}`,
    }),
    dynamic_description: tool({
      description: () => "described by a function",
      inputSchema: z.object({}),
      execute: async () => "ok",
    }),
  };
}

describe("toCopilotTools", () => {
  it("keeps names, descriptions and JSON schemas of the AI SDK tools", async () => {
    const toolset = appToolset();
    const tools = await toCopilotTools(toolset, () => undefined);
    expect(tools.map((t) => t.name)).toEqual(Object.keys(toolset));
    const search = tools.find((t) => t.name === "search_documents")!;
    expect(search.description).toBe("Search documents");
    expect(search.parameters).toMatchObject({
      type: "object",
      properties: { query: { type: "string", description: "what to find" }, top: { type: "number", default: 5 } },
      required: ["query"],
    });
    expect(tools.find((t) => t.name === "abcd1234_lookup")!.parameters).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    expect(tools.find((t) => t.name === "dynamic_description")!.description).toBe("described by a function");
    // All tools stay loaded, like on the AI SDK path; no tool overrides a built-in.
    for (const t of tools) {
      expect(t.defer).toBe("never");
      expect(t.overridesBuiltInTool).toBeUndefined();
    }
  });

  it("skips provider-executed tools that have no execute", async () => {
    const tools = await toCopilotTools(
      { web_search: { type: "provider", id: "x.web", args: {} } as never, ...appToolset() },
      () => undefined,
    );
    expect(tools.map((t) => t.name)).not.toContain("web_search");
  });

  it("the handler calls the CURRENT turn's execute, with the call id and an abort signal", async () => {
    const first = vi.fn(async () => ({ datetime: "first" }));
    const second = vi.fn(async () => ({ datetime: "second" }));
    let binding: TurnToolBinding | undefined;
    const tools = await toCopilotTools(appToolset(first), () => binding);
    const handler = tools.find((t) => t.name === "get_current_time")!.handler!;

    const turnAbort = new AbortController();
    const records: ToolCallRecord[] = [];
    binding = { toolset: appToolset(second), abortSignal: turnAbort.signal, onResult: (r) => records.push(r) };
    const result = await handler({}, { sessionId: "s", toolCallId: "call-1", toolName: "get_current_time", arguments: {} });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    const [, options] = second.mock.calls[0] as unknown as [unknown, { toolCallId: string; abortSignal?: AbortSignal }];
    expect(options.toolCallId).toBe("call-1");
    turnAbort.abort();
    expect(options.abortSignal?.aborted).toBe(true);
    expect(result).toEqual({ textResultForLlm: JSON.stringify({ datetime: "second" }), resultType: "success" });
    expect(records).toEqual([
      { toolCallId: "call-1", toolName: "get_current_time", input: {}, output: { datetime: "second" } },
    ]);
  });
});

describe("runAppTool", () => {
  const binding = (records: ToolCallRecord[] = []): TurnToolBinding => ({
    toolset: appToolset(),
    onResult: (r) => records.push(r),
  });

  it("validates and defaults arguments with the tool's schema, like the AI SDK", async () => {
    const records: ToolCallRecord[] = [];
    const ok = await runAppTool("search_documents", { query: "pumps" }, { toolCallId: "c" }, binding(records));
    expect(ok.resultType).toBe("success");
    expect(JSON.parse(ok.textResultForLlm)).toEqual({ query: "pumps", top: 5, hits: [] });

    const bad = await runAppTool("search_documents", { top: "x" }, { toolCallId: "d" }, binding(records));
    expect(bad.resultType).toBe("failure");
    expect(bad.textResultForLlm).toMatch(/Invalid arguments for search_documents/);
    expect(records.at(-1)?.error).toMatch(/Invalid arguments/);
  });

  it("returns a thrown error as a failure the model can read", async () => {
    const toolset = {
      broken: tool({
        description: "fails",
        inputSchema: z.object({}),
        execute: async () => {
          throw new Error("Agent \"x\" was not found or you do not have access to it.");
        },
      }),
    };
    const records: ToolCallRecord[] = [];
    const res = await runAppTool("broken", {}, { toolCallId: "c" }, { toolset, onResult: (r) => records.push(r) });
    expect(res).toEqual({
      textResultForLlm: "Agent \"x\" was not found or you do not have access to it.",
      resultType: "failure",
      error: "Agent \"x\" was not found or you do not have access to it.",
    });
    expect(records[0]).toMatchObject({ toolName: "broken", error: expect.stringContaining("not found") });
  });

  it("UI error text: a ToolUserError's message, every other error the generic text; the model gets both", async () => {
    const toolset = {
      safe: tool({ description: "", inputSchema: z.object({}), execute: async () => { throw new ToolUserError("Docs / search: the server is busy"); } }),
      internal: tool({ description: "", inputSchema: z.object({}), execute: async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:443"); } }),
    };
    const records: ToolCallRecord[] = [];
    const a = await runAppTool("safe", {}, { toolCallId: "a" }, { toolset, onResult: (r) => records.push(r) });
    const b = await runAppTool("internal", {}, { toolCallId: "b" }, { toolset, onResult: (r) => records.push(r) });
    expect(a.textResultForLlm).toBe("Docs / search: the server is busy");
    expect(b.textResultForLlm).toBe("connect ECONNREFUSED 10.0.0.1:443");
    expect(records.map((r) => r.uiError)).toEqual(["Docs / search: the server is busy", "An error occurred."]);
  });

  it("passes string output through and takes the last value of a streaming tool", async () => {
    expect((await runAppTool("abcd1234_lookup", { id: "7" }, { toolCallId: "c" }, binding())).textResultForLlm).toBe("found 7");
    const streaming = {
      progress: tool({
        description: "streams",
        inputSchema: z.object({}),
        async *execute() {
          yield { step: 1 };
          yield { step: 2, done: true };
        },
      }),
    };
    const res = await runAppTool("progress", {}, { toolCallId: "c" }, { toolset: streaming });
    expect(JSON.parse(res.textResultForLlm)).toEqual({ step: 2, done: true });
  });

  it("refuses a tool the current turn does not have", async () => {
    const res = await runAppTool("removed_tool", {}, { toolCallId: "c" }, binding());
    expect(res.resultType).toBe("failure");
    expect(await runAppTool("get_current_time", {}, { toolCallId: "c" }, undefined)).toMatchObject({ resultType: "failure" });
  });

  it("aborts with the runtime's own signal too", async () => {
    let seen: AbortSignal | undefined;
    const toolset = {
      slow: tool({
        description: "slow",
        inputSchema: z.object({}),
        execute: async (_: unknown, { abortSignal }: { abortSignal?: AbortSignal }) => {
          seen = abortSignal;
          return "done";
        },
      }),
    };
    const runtimeAbort = new AbortController();
    await runAppTool("slow", {}, { toolCallId: "c", signal: runtimeAbort.signal }, { toolset, abortSignal: new AbortController().signal });
    runtimeAbort.abort();
    expect(seen?.aborted).toBe(true);
  });
});

describe("toModelText", () => {
  it("matches the AI SDK default: strings as-is, everything else as JSON", () => {
    expect(toModelText("plain")).toBe("plain");
    expect(toModelText({ a: 1 })).toBe("{\"a\":1}");
    expect(toModelText(undefined)).toBe("null");
  });
});
