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
  // `call_sub_agent` is registered only on a thread with configured
  // sub-agents (see `includeSubAgentTools` in chat-services/tools/registry.ts).
  // This bare thread has none, so no local `execute` exists and the inline
  // `providerExecuted` tool-result the fake provider emits is what renders, the
  // same path as tool-call.spec.ts. The model cannot reach a real sub-agent
  // from a thread without configured sub-agents.
  test("call_sub_agent renders the tool widget and the parent's final answer", async ({
    page,
  }) => {
    const threadUrl = await newThreadUrl(page);
    await scriptToolCall(page, {
      toolName: "call_sub_agent",
      args: { agent_id: SUB_AGENT_ID, task: TASK },
      result: { response: "Q3 sales grew.", summary: "Done" },
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

    // No local execute ran: the widget does not settle into the Error state.
    await expect(
      page.getByRole("button", { name: `${TOOL_LABEL} Error` }),
    ).toHaveCount(0);

    // Exactly one assistant bubble — no orphan from tool-role messages.
    await expect(page.locator(".is-assistant")).toHaveCount(1, {
      timeout: 5_000,
    });
  });
});
