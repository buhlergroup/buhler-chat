import { describe, it, expect } from "vitest";
import {
  isToolPart,
  normalizeToolPart,
  renderToolOutput,
} from "../tool-part-view";

describe("isToolPart", () => {
  it.each([
    [{ type: "dynamic-tool" }, true],
    [{ type: "tool-call" }, true],
    [{ type: "tool-result" }, true],
    [{ type: "tool-search_documents" }, true],
    [{ type: "tool-call_sub_agent" }, true],
    [{ type: "text", text: "hi" }, false],
    [{ type: "reasoning", text: "..." }, false],
    [{ type: "file", url: "x" }, false],
  ])("classifies %j → %s", (part, expected) => {
    expect(isToolPart(part as never)).toBe(expected);
  });
});

describe("normalizeToolPart", () => {
  it("recovers toolName from `tool-<name>` type discriminator", () => {
    const out = normalizeToolPart(
      { type: "tool-search_documents", input: { q: "x" } } as never,
      0,
    );
    expect(out.toolName).toBe("search_documents");
  });

  it("prefers explicit toolName over the type discriminant", () => {
    const out = normalizeToolPart(
      { type: "dynamic-tool", toolName: "call_sub_agent", input: {} } as never,
      0,
    );
    expect(out.toolName).toBe("call_sub_agent");
  });

  it("uses toolCallId as the part id when present", () => {
    const out = normalizeToolPart(
      { type: "tool-call", toolCallId: "tc-42", input: {} } as never,
      7,
    );
    expect(out.id).toBe("tc-42");
  });

  it("falls back to idx-<index> when toolCallId is absent", () => {
    const out = normalizeToolPart(
      { type: "tool-call", input: {} } as never,
      7,
    );
    expect(out.id).toBe("idx-7");
  });

  it("marks state=output-available when output is present and non-null", () => {
    const out = normalizeToolPart(
      { type: "tool-call", output: { hits: [] } } as never,
      0,
    );
    expect(out.state).toBe("output-available");
  });

  it("marks state=input-available when output is absent and SDK state is default", () => {
    const out = normalizeToolPart({ type: "tool-call", input: {} } as never, 0);
    expect(out.state).toBe("input-available");
  });

  it("respects SDK-declared output-available even when output is null", () => {
    const out = normalizeToolPart(
      { type: "tool-call", state: "output-available", output: null } as never,
      0,
    );
    expect(out.state).toBe("output-available");
  });

  it("maps SDK output-error state to output-error, not Running", () => {
    const out = normalizeToolPart(
      {
        type: "tool-comos_search",
        state: "output-error",
        input: { query: "x" },
        errorText: 'Extension "comos_search" failed with status 403',
      } as never,
      0,
    );
    expect(out.state).toBe("output-error");
    expect(out.errorText).toBe(
      'Extension "comos_search" failed with status 403',
    );
  });

  it("treats a part with errorText but no state as output-error", () => {
    const out = normalizeToolPart(
      { type: "tool-call", input: {}, errorText: "boom" } as never,
      0,
    );
    expect(out.state).toBe("output-error");
    expect(out.errorText).toBe("boom");
  });

  it("falls back to a generic error message when output-error has no errorText", () => {
    const out = normalizeToolPart(
      { type: "tool-call", state: "output-error", input: {} } as never,
      0,
    );
    expect(out.state).toBe("output-error");
    expect(out.errorText).toBe("Tool call failed");
  });

  it("leaves errorText undefined for successful parts", () => {
    const out = normalizeToolPart(
      { type: "tool-call", output: { hits: [] } } as never,
      0,
    );
    expect(out.errorText).toBeUndefined();
  });

  // Regression: extension tool keys are namespaced on the wire as
  // `${8-char-id-prefix}_${functionName}` (see buildExtensionToolKey in
  // chat-services/tools/registry.ts) so extensions sharing a functionName
  // don't overwrite each other's toolset entry. Users must still see the
  // authored function name, not the internal dispatch key.
  it("strips the extension-id-prefix namespace from a `tool-<key>` type discriminator", () => {
    const out = normalizeToolPart(
      { type: "tool-Kj3nQ8xz_aisearch", input: { q: "x" } } as never,
      0,
    );
    expect(out.toolName).toBe("aisearch");
  });

  it("strips the extension-id-prefix namespace from an explicit toolName field", () => {
    const out = normalizeToolPart(
      { type: "dynamic-tool", toolName: "abcdefgh_my_api_call", input: {} } as never,
      0,
    );
    expect(out.toolName).toBe("my_api_call");
  });

  it("does not strip anything from built-in tool names (no 8-char-prefix shape)", () => {
    const out = normalizeToolPart(
      { type: "tool-call_sub_agent", input: {} } as never,
      0,
    );
    expect(out.toolName).toBe("call_sub_agent");
  });
});

describe("renderToolOutput", () => {
  it("returns undefined for null/undefined so ToolOutput hides", () => {
    expect(renderToolOutput(null)).toBeUndefined();
    expect(renderToolOutput(undefined)).toBeUndefined();
  });

  it("stringifies primitive output", () => {
    expect(renderToolOutput("hello")).toBe("hello");
    expect(renderToolOutput(42)).toBe("42");
    expect(renderToolOutput(true)).toBe("true");
  });

  it("renders object-of-primitives as a key/value table element", () => {
    const result = renderToolOutput({
      temperature: "15",
      condition: "sunny",
      humidity: 60,
    });
    // Result is a React element with table props
    expect(result).toBeTruthy();
    expect((result as { type: { name: string } }).type.name).toBe(
      "KeyValueTable",
    );
  });

  it("renders array of primitives as a list element", () => {
    const result = renderToolOutput(["one", "two", 3]);
    expect((result as { type: { name: string } }).type.name).toBe(
      "PrimitiveList",
    );
  });

  it("falls back to a <pre> JSON dump for nested structures", () => {
    const nested = { hits: [{ id: "d1", snippet: "x" }] };
    const result = renderToolOutput(nested);
    expect((result as { type: string }).type).toBe("pre");
    expect((result as { props: { children: string } }).props.children).toContain(
      "hits",
    );
  });
});

describe("renderToolOutput — MCP sign-in needed", () => {
  it("shows a Connect <extension> action instead of the raw result", async () => {
    const { render, screen } = await import("@testing-library/react");
    const node = renderToolOutput({
      text: "The user is not connected.",
      mcpConnect: { extensionId: "ext1", extensionName: "Market data", personaId: "agent-1" },
    });
    render(<>{node}</>);
    expect(screen.getByRole("button", { name: /Connect Market data/ })).toBeInTheDocument();
  });
});

describe("renderToolOutput: Copilot path image tools", () => {
  it("renders generate_image like image_generation (blob ref -> /api/images)", async () => {
    const { render, screen } = await import("@testing-library/react");
    const node = renderToolOutput({ result: "blob://t1/abc.png", path: "/workspace/images/cat.png" }, "generate_image");
    render(<>{node}</>);
    expect(screen.getByRole("img")).toHaveAttribute("src", "/api/images?t=t1&img=abc.png");
  });

  it("renders run_code image outputs and the rest as JSON", async () => {
    const { render, screen } = await import("@testing-library/react");
    const node = renderToolOutput(
      { stdout: "ok", files: ["/workspace/outputs/chart.png"], images: ["blob://t1/c1.png", "not-a-ref"] },
      "run_code",
    );
    const { container } = render(<>{node}</>);
    expect(screen.getAllByRole("img").map((i) => i.getAttribute("src"))).toEqual(["/api/images?t=t1&img=c1.png"]);
    expect(container.textContent).toContain("/workspace/outputs/chart.png");
    expect(container.textContent).not.toContain("blob://");
  });
});
