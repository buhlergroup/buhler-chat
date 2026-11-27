import { describe, it, expect } from "vitest";
import { DEFAULT_INLINE_BYTES, exceedsInlineLimit, inlineResultLimit, utf8ByteLength } from "./inline-limit";
import { inlineResultLimit as toolResultLimit } from "./tool-adapter";

describe("inline-limit", () => {
  it("tool results and user text use the same setting", () => {
    expect(toolResultLimit).toBe(inlineResultLimit);
    expect(inlineResultLimit({})).toBe(DEFAULT_INLINE_BYTES);
    expect(inlineResultLimit({ COPILOT_TOOL_RESULT_INLINE_BYTES: "1000" })).toBe(1000);
  });

  it("utf8ByteLength matches the UTF-8 encoder", () => {
    const samples = ["", "abc", "äöü", "€", "日本語", "a😀b", "\ud800", "x\udc00y", "mixed ä € 😀 text"];
    for (const s of samples) {
      expect(utf8ByteLength(s), JSON.stringify(s)).toBe(new TextEncoder().encode(s).length);
    }
  });

  it("text exactly at the limit stays inline, one byte more does not", () => {
    expect(exceedsInlineLimit("a".repeat(100), 100)).toBe(false);
    expect(exceedsInlineLimit("a".repeat(101), 100)).toBe(true);
    // 50 two-byte characters are 100 bytes; 51 are 102.
    expect(exceedsInlineLimit("ä".repeat(50), 100)).toBe(false);
    expect(exceedsInlineLimit("ä".repeat(51), 100)).toBe(true);
    // 25 emoji are 100 bytes (50 UTF-16 units).
    expect(exceedsInlineLimit("😀".repeat(25), 100)).toBe(false);
    expect(exceedsInlineLimit("😀".repeat(25) + "a", 100)).toBe(true);
  });
});
