import { describe, it, expect } from "vitest";
import { tool } from "ai";
import { z } from "zod";

import {
  inlineResultLimit,
  resultFileContent,
  resultFileExtension,
  runAppTool,
  spillLargeResult,
  utf8Prefix,
  type ToolCallRecord,
} from "./tool-adapter";
import { MAX_MCP_TOOL_OUTPUT_CHARS, mapMcpCallResult } from "../tools/mcp-tool";

const bigSvg = `<svg xmlns="http://www.w3.org/2000/svg">${"<rect/>".repeat(30_000)}<text>needle</text></svg>`;

describe("large tool results go to a workspace file (Copilot path)", () => {
  it("threshold: 16 KB by default, configurable", () => {
    expect(inlineResultLimit({})).toBe(16384);
    expect(inlineResultLimit({ COPILOT_TOOL_RESULT_INLINE_BYTES: "1000" })).toBe(1000);
    expect(inlineResultLimit({ COPILOT_TOOL_RESULT_INLINE_BYTES: "nonsense" })).toBe(16384);
  });

  it("extension from the content", () => {
    expect(resultFileExtension(bigSvg)).toBe("svg");
    expect(resultFileExtension('<?xml version="1.0"?>\n<svg></svg>')).toBe("svg");
    expect(resultFileExtension('{"a": [1, 2]}')).toBe("json");
    expect(resultFileExtension("{not json")).toBe("txt");
    expect(resultFileExtension("# Title\n\ntext")).toBe("md");
    expect(resultFileExtension("| a | b |\n|---|---|")).toBe("md");
    expect(resultFileExtension("plain words")).toBe("txt");
  });

  it("an MCP result is written as its text, other objects as JSON", () => {
    expect(resultFileContent({ text: bigSvg })).toBe(bigSvg);
    expect(resultFileContent({ text: "t", structuredContent: { a: 1 } })).toBe('t\n\n{\n  "a": 1\n}');
    expect(resultFileContent({ hits: [1] })).toBe('{\n  "hits": [\n    1\n  ]\n}');
    expect(resultFileContent("s")).toBe("s");
  });

  it("writes the FULL result, returns a 4 KB preview, the size, the path and skipLargeOutputProcessing", async () => {
    const files = new Map<string, string>();
    const spilled = await spillLargeResult("abcd1234_board_svg", "call|1", { text: bigSvg }, async (p, c) => {
      files.set(p, c);
    });
    expect(spilled).toBeDefined();
    const path = "/workspace/tool-results/abcd1234_board_svg-call_1.svg";
    expect(files.get(path)).toBe(bigSvg);
    const text = spilled!.result.textResultForLlm;
    expect(text).toContain(`The full result (${Buffer.byteLength(bigSvg)} bytes) is saved at ${path}`);
    expect(text).toContain(bigSvg.slice(0, 4096));
    expect(text).not.toContain("needle");
    expect(text).toMatch(/Use view with a line range or rg on/);
    expect(spilled!.result.skipLargeOutputProcessing).toBe(true);
    expect(spilled!.display).toEqual({ text: bigSvg.slice(0, 4096), savedTo: path, bytes: Buffer.byteLength(bigSvg) });
  });

  it("small results stay inline and untouched", async () => {
    expect(await spillLargeResult("t", "1", { text: "short" }, async () => undefined)).toBeUndefined();
    const writes: string[] = [];
    const toolset = { small: tool({ description: "", inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
    const res = await runAppTool("small", {}, { toolCallId: "1" }, { toolset, spill: async (p) => void writes.push(p) });
    expect(res).toEqual({ textResultForLlm: '{"ok":true}', resultType: "success" });
    expect(writes).toEqual([]);
  });

  it("through the adapter: the model gets the preview, the chat UI the preview and the path", async () => {
    const files = new Map<string, string>();
    const records: ToolCallRecord[] = [];
    const toolset = { board: tool({ description: "", inputSchema: z.object({}), execute: async () => ({ text: bigSvg }) }) };
    const res = await runAppTool("board", {}, { toolCallId: "c9" }, {
      toolset,
      spill: async (p, c) => void files.set(p, c),
      onResult: (r) => records.push(r),
    });
    expect(res.skipLargeOutputProcessing).toBe(true);
    expect([...files.keys()]).toEqual(["/workspace/tool-results/board-c9.svg"]);
    expect(records[0].output).toMatchObject({ savedTo: "/workspace/tool-results/board-c9.svg" });
  });

  it("without a spill writer (no workspace) nothing changes", async () => {
    const toolset = { board: tool({ description: "", inputSchema: z.object({}), execute: async () => bigSvg }) };
    const res = await runAppTool("board", {}, { toolCallId: "1" }, { toolset });
    expect(res.textResultForLlm).toBe(bigSvg);
    expect(res.skipLargeOutputProcessing).toBeUndefined();
  });

  it("utf8Prefix never cuts a character", () => {
    expect(utf8Prefix("äöü", 3)).toBe("ä");
    expect(utf8Prefix("abc", 10)).toBe("abc");
  });
});

describe("MCP output cap", () => {
  const big = { content: [{ type: "text", text: "x".repeat(174_000) }] };
  it("the AI SDK path keeps the 100,000-character cap", () => {
    const mapped = mapMcpCallResult(big);
    expect(mapped.text.length).toBe(MAX_MCP_TOOL_OUTPUT_CHARS + "\n[output truncated]".length);
  });
  it("the Copilot path passes no cap: the full text reaches the adapter", () => {
    expect(mapMcpCallResult(big, Number.POSITIVE_INFINITY).text.length).toBe(174_000);
  });
});
