import { test, expect } from "@playwright/test";
import { scriptToolCall, newThreadUrl } from "./_helpers/script-fake";

const SUB_AGENT_ID = "agent-123";
const TASK = "Summarise the sales figures for Q3";
const FINAL_ANSWER =
  "I delegated the analysis as requested; see the agent box above for details.";
// ToolHeader renders the tool name through `formatToolName`
// (components/ai-elements/tool.tsx): the `tool-` discriminant is dropped,
// snake/kebab separators become spaces and the first letter is capitalised.
// Assert the label the user actually sees.
const TOOL_LABEL = "Call sub agent";

test.describe("sub-agent-tool-call", () => {
  // Why this spec asserts the widget and not a scripted success payload:
  //
  // `call_sub_agent` is registered on EVERY thread (see the `includeSubAgentTools`
  // block in chat-services/tools/registry.ts — hiding it behind `subAgentIds` was
  // the #37 regression). Because a real `execute` exists, the AI SDK runs it and
  // its result wins over the inline `providerExecuted` tool-result the fake
  // provider emits — the "inline-emitted tool result fighting a local execute"
  // race that registry.ts documents. Scripting a fake success body for this tool
  // therefore cannot work; the real tool runs, calls FindPersonaByID(agent-123),
  // finds nothing and throws.
  //
  // That is genuine product behaviour worth pinning: delegating to an agent the
  // user cannot see must surface as a finished Error widget, never as an
  // eternally-running one (the state mapping in tool-part-view.tsx).
  //
  // Tools that are only registered conditionally (e.g. `search_documents`) have
  // no local execute on a bare thread, so their inline result survives — that is
  // where scripted tool OUTPUT rendering is covered, in
  // tool-execution-error.spec.ts. The two specs together cover both paths.
  test("call_sub_agent renders the tool widget and the parent's final answer", async ({
    page,
  }) => {
    const threadUrl = await newThreadUrl(page);
    await scriptToolCall(page, {
      toolName: "call_sub_agent",
      args: { agent_id: SUB_AGENT_ID, task: TASK },
      // Ignored: the real call_sub_agent execute wins the race (see above).
      result: { note: "superseded by the real tool execution" },
      finalText: FINAL_ANSWER,
    });

    await page.goto(threadUrl);
    // During hydration the composer briefly exists twice in the DOM, which
    // trips Playwright strict mode. Same scoping the jank spec already uses.
    const textarea = page.getByPlaceholder("Type your message...").first();
    await expect(textarea).toBeVisible({ timeout: 30_000 });

    await textarea.fill("Please delegate the Q3 sales analysis");
    await page.keyboard.press("Enter");

    await expect(page.getByText(FINAL_ANSWER)).toBeVisible({ timeout: 15_000 });

    // Tool widget header renders exactly once, under the user-facing label.
    await expect(page.getByText(TOOL_LABEL, { exact: true })).toHaveCount(1);

    // The failed delegation settles into the Error state rather than hanging
    // in "Running" forever.
    await expect(
      page.getByRole("button", { name: `${TOOL_LABEL} Error` }),
    ).toBeVisible({ timeout: 5_000 });

    // Exactly one assistant bubble — no orphan from tool-role messages.
    await expect(page.locator(".is-assistant")).toHaveCount(1, {
      timeout: 5_000,
    });
  });
});
