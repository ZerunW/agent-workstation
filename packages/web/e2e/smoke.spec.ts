import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, loginViaUi, openPanel, sendMessage, uniqueUser, waitForTurnEnd } from "./helpers";

// Runs against a live hub (or `node mock/mock-hub.mjs`) that serves the built UI:
//   E2E_BASE_URL=http://localhost:9000 npm run e2e -w packages/web
test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

test("pick user → chat → code → files → terminal", async ({ page }) => {
  const user = uniqueUser();

  // 1. username page → create user → land in the workbench
  await loginViaUi(page, user);

  // 2. Chat mode: first message creates the session lazily, the turn indicator goes away when the turn ends
  await page.getByTestId("mode-chat").click();
  await sendMessage(page, "say OK");
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}/);
  await waitForTurnEnd(page, 45_000);
  await expect(page.getByTestId("session-title")).toBeVisible();
  await expect(page.getByRole("main")).toContainText("OK");
  const chatUrl = page.url();

  // 3. Code mode: its own (empty) session list, then a code session
  await page.getByTestId("mode-code").click();
  await expect(page).not.toHaveURL(chatUrl);
  await sendMessage(page, "hello from the code workbench");
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}/);
  await waitForTurnEnd(page, 45_000);

  // 4. Files tab shows the workspace tree (inbox/ is created with every user)
  await openPanel(page, "files");
  await expect(page.getByRole("complementary", { name: /right panel/i })).toContainText("inbox", { timeout: 20_000 });

  // 5. Terminal tab attaches to a shell and shows a prompt
  await openPanel(page, "terminal");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => (await page.locator(".xterm-rows").first().innerText()).replace(/\u00a0/g, " "), { timeout: 20_000, message: "shell prompt in xterm" })
    .toMatch(/[$#%]\s*$/m);
});

test("the Chat and Code session lists are separate and survive a reload", async ({ page }) => {
  const user = uniqueUser();
  await loginViaUi(page, user);
  await page.getByTestId("mode-chat").click();
  await sendMessage(page, "say OK");
  await waitForTurnEnd(page, 45_000);
  const url = page.url();

  await page.reload();
  await expect(page).toHaveURL(url);
  // history is replayed from the hub after a reload
  await expect(page.getByRole("main")).toContainText("say OK", { timeout: 20_000 });
  await expect(page.getByTestId("assistant-message").first()).toBeVisible();
  await expect(page.getByTestId("turn-indicator")).toHaveCount(0);

  // the chat session is not listed under Code
  await page.getByTestId("mode-code").click();
  await expect(page.getByRole("navigation", { name: /session list/i }).locator(`a[href="${new URL(url).pathname}"]`)).toHaveCount(0);
});
