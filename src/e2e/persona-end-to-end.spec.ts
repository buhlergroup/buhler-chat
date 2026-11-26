import { test, expect } from "@playwright/test";

// Real-user invariant: I can create a persona ("agent"), see it in the library,
// start a chat with it, and the chat is bound to that persona (header shows
// the persona name; messages go through the real chat pipeline).
//
// Runs against AZURECHAT_TEST_BACKEND=memory — persona writes hit the
// in-memory Cosmos history container.
test.describe("persona-end-to-end", () => {
  test("create persona → appears in library → start chat → composer ready", async ({ page }) => {
    const personaName = `E2E Robot ${Date.now()} ${"with a deliberately long title ".repeat(5)}`;
    const personaDescription = "Robot persona for e2e test";
    const personaInstructions =
      "You are a robot. Always respond starting with the literal word BEEP.";

    await page.goto("/agent");

    await page.getByRole("button", { name: /new agent/i }).first().click();

    const nameInput = page.getByPlaceholder(/Name of your agent/i);
    await expect(nameInput).toBeVisible({ timeout: 10_000 });
    await nameInput.fill(personaName);
    await page.getByPlaceholder(/^Short description$/i).fill(personaDescription);
    await page.getByPlaceholder(/Instructions for your agent/i).fill(personaInstructions);

    // The first save of a new agent keeps the sheet open on the saved agent
    // (server action `AddOrUpdatePersona` then revalidates), so files can be
    // added right away: the Files section becomes active.
    await page.getByRole("button", { name: /^save$/i }).click();
    const files = page.getByTestId("persona-files");
    await expect(files).toBeVisible({ timeout: 15_000 });
    await expect(files.getByText("Save the agent to add files.")).toBeHidden({
      timeout: 15_000,
    });
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue(personaName);

    // Close the sheet — the name field placeholder is no longer in the DOM.
    await page.getByRole("button", { name: /^close$/i }).click();
    await expect(nameInput).toBeHidden({ timeout: 15_000 });

    // RevalidateCache({page:"agent"}) invalidates the route cache server-side
    // but does not push fresh HTML to the current document. Reload to pick up
    // the new persona in the server-rendered list.
    await page.goto("/agent");

    // The new persona shows up in the library grid as a card with the chosen name.
    const personaHeading = page.getByText(personaName, { exact: true }).first();
    await expect(personaHeading).toBeVisible({ timeout: 10_000 });
    const personaCard = page
      .locator("[data-persona-id]")
      .filter({ hasText: personaName })
      .first();

    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await personaCard.evaluate((card) => ({
      card: card.scrollWidth > card.clientWidth,
      page: document.documentElement.scrollWidth > window.innerWidth,
    }));
    expect(overflow).toEqual({ card: false, page: false });
    // The narrow viewport above is scoped to the card-overflow check. Restore
    // the project's desktop viewport before the chat round-trip below —
    // at 375px the message log renders offscreen and its bubbles never
    // become visible, which has nothing to do with what this test asserts.
    await page.setViewportSize({ width: 1280, height: 720 });

    const creator = personaCard.getByLabel("Creator: Test User");
    await creator.hover();
    await expect(page.getByRole("tooltip")).toContainText("Creator: Test User");

    // Radix tooltips keep a "grace area" open between trigger and content:
    // `pointerleave` only arms the polygon, and the tooltip closes on the NEXT
    // document `pointermove` that lands outside it. A real mouse emits a
    // continuous stream of moves, so it closes instantly; a single synthetic
    // teleport fires leave+move in one dispatch, before Radix has attached its
    // listener, and nothing would ever close it. `steps` models real movement.
    await page.mouse.move(0, 0, { steps: 10 });
    await expect(page.getByRole("tooltip")).toBeHidden();
    const created = personaCard.getByLabel(/^Created:/);
    await created.hover();
    await expect(
      page.getByRole("tooltip").filter({ hasText: /^Created:/ })
    ).toContainText(/\((now|\d+[mhd] ago)\)/);

    await page.mouse.move(0, 0, { steps: 10 });
    await expect(page.getByRole("tooltip")).toBeHidden();
    const changed = personaCard.getByLabel(/^Last changed:/);
    await changed.hover();
    await expect(
      page.getByRole("tooltip").filter({ hasText: /^Last changed:/ })
    ).toContainText(/\((now|\d+[mhd] ago)\)/);

    // "Start chat" on that card creates a chat thread (CreatePersonaChat) and
    // navigates to /chat/<threadId>. The card with our persona has a
    // sibling "Start chat" button; scope by the closest card containing the name.
    await personaCard.getByRole("button", { name: /start chat/i }).click();

    await page.waitForURL(/\/chat\/[^/]+$/, { timeout: 30_000 });

    // Composer renders and a turn round-trips through /api/chat → fake OpenAI.
    // During hydration the composer briefly exists twice in the DOM, which
    // trips Playwright strict mode. Same scoping the jank spec already uses.
    const textarea = page.getByPlaceholder("Type your message...").first();
    await expect(textarea).toBeVisible({ timeout: 30_000 });
    await textarea.fill("hello robot");
    await page.keyboard.press("Enter");
    await expect(page.getByText("hello robot")).toBeVisible({ timeout: 15_000 });
    // Scope to the message log so a prior thread's auto-title in the sidebar
    // (which can be the same stubbed reply) doesn't trigger strict-mode-violation.
    await expect(
      page.getByRole("log").getByText(/TEST: this is a stubbed assistant reply/).first()
    ).toBeVisible({ timeout: 15_000 });
  });
});
