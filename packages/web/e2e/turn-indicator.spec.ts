import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, loginViaStorage, sendMessage, uniqueUser, waitForTurnEnd } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

test("a running turn shows the live indicator; it is gone with the turn and leaves no result row", async ({ page }) => {
  await loginViaStorage(page, uniqueUser("turn"));
  await page.goto("/");
  await page.getByTestId("mode-chat").click();
  await sendMessage(page, "Reply with exactly PONG");

  const indicator = page.getByTestId("turn-indicator");
  await expect(indicator).toBeVisible({ timeout: 30_000 });
  await expect(indicator).toHaveText(/\d+s/);
  await waitForTurnEnd(page, 60_000);
  await expect(indicator).toHaveCount(0);
  await expect(page.getByTestId("assistant-message").first()).toContainText("PONG");
  // a successful result has no row; only failures keep a box
  await expect(page.getByTestId("result-divider")).toHaveCount(0);
});
