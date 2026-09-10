import { describe, it, expect } from "vitest";

import {
  BUILT_IN_TOOL_PRECEDENCE,
  compareByCodepoint,
  stabilizeToolset,
} from "./stabilize-toolset";

/** Stand-in for a tool definition: the fields that go on the wire. */
function fakeTool(name: string) {
  return {
    description: `does ${name}`,
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  };
}

function toolsetFrom(names: string[]) {
  const set: Record<string, ReturnType<typeof fakeTool>> = {};
  for (const n of names) set[n] = fakeTool(n);
  return set;
}

describe("compareByCodepoint", () => {
  it("orders uppercase before lowercase, unlike localeCompare", () => {
    expect(compareByCodepoint("B_tool", "a_tool")).toBeLessThan(0);
    // Proof the two comparators genuinely disagree, i.e. this matters.
    expect("B_tool".localeCompare("a_tool")).toBeGreaterThan(0);
  });

  it("places '_' (U+005F) after uppercase and before lowercase, per codepoint", () => {
    expect(compareByCodepoint("B_tool", "_x")).toBeLessThan(0);
    expect(compareByCodepoint("_x", "a_tool")).toBeLessThan(0);
  });
});

describe("stabilizeToolset", () => {
  it("is insensitive to insertion order", () => {
    const a = stabilizeToolset(toolsetFrom(["b_tool", "a_tool", "c_tool"]));
    const b = stabilizeToolset(toolsetFrom(["c_tool", "b_tool", "a_tool"]));
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("orders by codepoint, not locale", () => {
    const names = ["a_tool", "B_tool", "_x"];
    const ordered = Object.keys(stabilizeToolset(toolsetFrom(names)));
    expect(ordered).toEqual(["B_tool", "_x", "a_tool"]);
    // localeCompare would have produced a different order.
    expect(ordered).not.toEqual([...names].sort((x, y) => x.localeCompare(y)));
  });

  it("puts the built-in provider tools first, in the fixed precedence order", () => {
    const ordered = Object.keys(
      stabilizeToolset(
        toolsetFrom([
          "a_custom",
          "web_search_preview",
          "search_documents",
          "code_interpreter",
          "image_generation",
        ]),
      ),
    );
    expect(ordered.slice(0, 3)).toEqual([...BUILT_IN_TOOL_PRECEDENCE]);
    expect(ordered.slice(3)).toEqual(["a_custom", "search_documents"]);
  });

  it("puts a built-in that has no pinned position after the precedence list", () => {
    const ordered = Object.keys(
      stabilizeToolset(
        toolsetFrom(["a_custom", "web_search", "web_fetch", "code_interpreter"]),
      ),
    );
    expect(ordered).toEqual([
      "code_interpreter",
      "web_fetch",
      "web_search",
      "a_custom",
    ]);
  });

  it("treats caller-declared names as built-in", () => {
    const ordered = Object.keys(
      stabilizeToolset(toolsetFrom(["a_custom", "zz_new_builtin"]), [
        "zz_new_builtin",
      ]),
    );
    // Without the declaration "a_custom" would sort first by codepoint.
    expect(ordered).toEqual(["zz_new_builtin", "a_custom"]);
  });

  it("keeps every tool and its definition intact", () => {
    const input = toolsetFrom(["b_tool", "code_interpreter", "a_tool"]);
    const out = stabilizeToolset(input);
    expect(Object.keys(out).sort()).toEqual(Object.keys(input).sort());
    for (const name of Object.keys(input)) {
      expect(out[name]).toBe(input[name]);
    }
  });

  it("handles an empty toolset (negative)", () => {
    expect(stabilizeToolset({})).toEqual({});
  });
});

describe("tool definitions are byte-stable across turns of a thread", () => {
  it("serialises identically when the same toolset is assembled twice", () => {
    const turnOne = stabilizeToolset({
      ...toolsetFrom(["search_documents", "get_current_time"]),
      ...toolsetFrom(["code_interpreter"]),
    });
    // Turn 2 assembles the same tools, discovered in a different order.
    const turnTwo = stabilizeToolset({
      ...toolsetFrom(["get_current_time"]),
      ...toolsetFrom(["code_interpreter", "search_documents"]),
    });
    expect(JSON.stringify(turnTwo)).toBe(JSON.stringify(turnOne));
  });

  it("keeps the code_interpreter definition identical between turn 1 and turn 2 of a thread", async () => {
    // With the container pre-created (see code-interpreter-container.ts) both
    // turns declare the SAME container id, so the real provider tool
    // definition is byte-identical. Before that change turn 1 sent
    // container: {} and turn 2 sent container: "<harvested id>".
    const { azure } = await import("@ai-sdk/azure");
    const turnOne = azure.tools.codeInterpreter({ container: "cntr_stable" });
    const turnTwo = azure.tools.codeInterpreter({ container: "cntr_stable" });
    expect(JSON.stringify(turnTwo)).toBe(JSON.stringify(turnOne));

    // And the old shapes really did differ, which is what cost the prefix.
    const bootstrapped = azure.tools.codeInterpreter({});
    expect(JSON.stringify(bootstrapped)).not.toBe(JSON.stringify(turnOne));
  });
});
