import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, loginViaStorage, sendMessage, uniqueUser, waitForTurnEnd } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

test("Chat turn end to end: 'Reply with exactly PONG' → assistant text → the turn indicator goes away", async ({ page }) => {
  await loginViaStorage(page, uniqueUser("chat"));
  await page.goto("/");
  await page.getByTestId("mode-chat").click();
  await sendMessage(page, "Reply with exactly PONG");
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}/);

  // the user bubble is echoed by the hub, then the assistant streams and persists its text
  await expect(page.getByTestId("user-message").first()).toContainText("Reply with exactly PONG");
  await expect(page.getByTestId("assistant-message").first()).toContainText("PONG", { timeout: 60_000 });
  // the turn ends: no live indicator any more, and no error box (a successful result leaves no row)
  await waitForTurnEnd(page, 60_000);
  await expect(page.locator("[data-testid=result-divider][data-error=true]")).toHaveCount(0);
  // the composer is usable again
  await expect(page.getByTestId("composer-send")).toBeVisible();
});
