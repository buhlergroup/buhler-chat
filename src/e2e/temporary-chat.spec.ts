import { test, expect } from "@playwright/test";
import { scriptText } from "./_helpers/script-fake";

test.describe("temporary-chat", () => {
  test("/chat/temporary renders the chat input and is not listed as a normal thread in the sidebar", async ({ page }) => {
    await page.goto("/chat/temporary");

    const textarea = page.getByPlaceholder("Type your message...").first();
    await expect(textarea).toBeVisible({ timeout: 30_000 });

    // The current URL points at /chat/temporary. A normal thread link in the
    // sidebar would be /chat/<thread-id>; the temporary route is excluded from
    // the FindAllChatThreadForCurrentUser query (filters out isTemporary=true).
    const sidebarLink = page.locator('a[href="/chat/temporary"]');
    await expect(sidebarLink).toHaveCount(0);
  });

  test("the reply stays visible after the title refresh and is gone after a reload", async ({ page }) => {
    await scriptText(page, "Temporary reply that must stay.");

    await page.goto("/chat/temporary");
    const textarea = page.getByPlaceholder("Type your message...").first();
    await expect(textarea).toBeVisible({ timeout: 30_000 });

    await textarea.fill("First temporary question");
    await page.keyboard.press("Enter");
    const reply = page.getByText("Temporary reply that must stay.");
    await expect(reply).toBeVisible({ timeout: 15_000 });

    // chat-page.tsx refreshes the route 1.5 s and 5 s after the first turn
    // to pick up the generated title. Wait for both refreshes to land.
    await page.waitForTimeout(6_500);
    await expect(reply).toBeVisible();
    await expect(page.getByText("First temporary question").first()).toBeVisible();

    // A new visit still starts an empty temporary chat.
    await page.reload();
    await expect(page.getByPlaceholder("Type your message...").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Temporary reply that must stay.")).toHaveCount(0);
  });
});
