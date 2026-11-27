// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { pastedTextFileName, pastedTextNote, spillLargePrompt } from "./prompt-spill";
import { RESULT_PREVIEW_BYTES } from "./tool-adapter";

describe("spillLargePrompt", () => {
  it("keeps a message up to the limit as it is, without a write", async () => {
    const store = vi.fn();
    expect(await spillLargePrompt("abc", { id: "t1", store, limit: 3 })).toEqual({ prompt: "abc" });
    expect(store).not.toHaveBeenCalled();
  });

  it("counts UTF-8 bytes: 2 umlauts are 4 bytes", async () => {
    const store = vi.fn(async (name: string, _data: Buffer) => ({ path: `/workspace/uploads/${name}` }));
    expect((await spillLargePrompt("ää", { id: "t1", store, limit: 4 })).savedTo).toBeUndefined();
    const spilled = await spillLargePrompt("äää", { id: "t1", store, limit: 4 });
    expect(spilled.savedTo).toBe("/workspace/uploads/pasted-text-t1.txt");
    expect(spilled.bytes).toBe(6);
    expect(store.mock.calls[0][1].toString("utf8")).toBe("äää");
  });

  it("uses the path the store gives (a taken name gets a suffix there)", async () => {
    const store = async () => ({ path: "/workspace/uploads/pasted-text-t1 (2).txt" });
    const spilled = await spillLargePrompt("x".repeat(10), { id: "t1", store, limit: 5 });
    expect(spilled.prompt).toContain("/workspace/uploads/pasted-text-t1 (2).txt");
  });

  it("the default limit is COPILOT_TOOL_RESULT_INLINE_BYTES (16 KiB)", async () => {
    const store = vi.fn(async (name: string) => ({ path: `/workspace/uploads/${name}` }));
    expect((await spillLargePrompt("x".repeat(16 * 1024), { id: "a", store })).savedTo).toBeUndefined();
    expect((await spillLargePrompt("x".repeat(16 * 1024 + 1), { id: "a", store })).savedTo).toBeDefined();
  });
});

describe("pastedTextNote", () => {
  it("has the path, the size and a preview of RESULT_PREVIEW_BYTES", () => {
    const text = "a".repeat(RESULT_PREVIEW_BYTES * 3);
    const note = pastedTextNote("/workspace/uploads/pasted-text-x.txt", text);
    expect(note).toContain(`(${RESULT_PREVIEW_BYTES * 3} bytes)`);
    expect(note).toContain(`The first ${RESULT_PREVIEW_BYTES} bytes:`);
    expect(note).toContain("a".repeat(RESULT_PREVIEW_BYTES));
    expect(note).not.toContain("a".repeat(RESULT_PREVIEW_BYTES + 1));
    expect(note).toContain("/workspace/uploads/pasted-text-x.txt");
  });
});

describe("pastedTextFileName", () => {
  it("keeps only safe characters of the id", () => {
    expect(pastedTextFileName("turn_abc-123")).toBe("pasted-text-turn_abc-123.txt");
    expect(pastedTextFileName("../x y")).toBe("pasted-text-___x_y.txt");
    expect(pastedTextFileName("")).toBe("pasted-text-message.txt");
  });
});
