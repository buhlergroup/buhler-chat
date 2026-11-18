import { describe, it, expect } from "vitest";
import {
  checkedToolNames,
  completeDraftKey,
  reconcileSelection,
  selectionSummary,
  toggleTool,
} from "./mcp-tool-selection";

const NAMES = ["a", "b", "c"];
const all = { toolAllowList: [], noneSelected: false };

describe("MCP tool selection (empty allow list = all tools)", () => {
  it("checks every tool when the allow list is empty", () => {
    expect([...checkedToolNames(NAMES, all)]).toEqual(NAMES);
    expect(selectionSummary(NAMES, all)).toBe("All tools are available.");
  });

  it("unchecking one stores all other tools", () => {
    const next = toggleTool(NAMES, all, "b", false);
    expect(next).toEqual({ toolAllowList: ["a", "c"], noneSelected: false });
    expect(selectionSummary(NAMES, next)).toBe("2 of 3 tools are available.");
  });

  it("checking the last unchecked tool normalises back to an empty list", () => {
    expect(toggleTool(NAMES, { toolAllowList: ["a", "c"], noneSelected: false }, "b", true)).toEqual(all);
  });

  it("unchecking every tool is 'none', never 'all'", () => {
    const next = toggleTool(NAMES, { toolAllowList: ["a"], noneSelected: false }, "a", false);
    expect(next).toEqual({ toolAllowList: [], noneSelected: true });
    expect(checkedToolNames(NAMES, next).size).toBe(0);
    expect(selectionSummary(NAMES, next)).toBe("Select at least one tool.");
  });

  it("drops names the server no longer has; an emptied selection becomes 'none'", () => {
    expect(reconcileSelection(NAMES, { toolAllowList: ["a", "gone"], noneSelected: false })).toEqual({
      toolAllowList: ["a"],
      noneSelected: false,
    });
    expect(reconcileSelection(NAMES, { toolAllowList: ["gone"], noneSelected: false })).toEqual({
      toolAllowList: [],
      noneSelected: true,
    });
    expect(reconcileSelection(["a"], { toolAllowList: ["a", "gone"], noneSelected: false })).toEqual(all);
    expect(reconcileSelection(NAMES, all)).toEqual(all);
  });
});

describe("completeDraftKey", () => {
  const draft = (url: string, value: string, auth: "none" | "oauth" = "none") => ({
    url,
    transport: "auto" as const,
    auth,
    toolAllowList: [],
    secrets: [{ id: "r", name: "X-Key", target: "X-Key", placement: "header" as const, value }],
  });

  it("is empty until the URL is https and every header row has a value", () => {
    expect(completeDraftKey(draft("", "v"))).toBe("");
    expect(completeDraftKey(draft("http://mcp.example.test", "v"))).toBe("");
    expect(completeDraftKey(draft("https://mcp.example.test", ""))).toBe("");
    expect(completeDraftKey(draft("https://mcp.example.test", "v", "oauth"))).toBe("");
    expect(completeDraftKey(draft("https://mcp.example.test", "v"))).not.toBe("");
  });
});
