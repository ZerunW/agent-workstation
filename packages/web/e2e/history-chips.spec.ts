import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, ensureUser, hasMockHooks, loginViaStorage, openToolGroups, seedSession, sendMessage, uniqueUser, waitForTurnEnd } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

test("search_conversations and read_conversation render as compact chips; a read chip opens that chat", async ({ page }) => {
  const user = uniqueUser("hist");
  await ensureUser(page, user);
  await loginViaStorage(page, user);
  test.skip(!(await hasMockHooks(page)), "the history tools are scripted by the mock hub");
  const quarterly = await seedSession(page, { user, title: "Quarterly plan", ageMinutes: 90, messages: [{ role: "user", text: "Draft the quarterly roadmap" }, { role: "assistant", text: "Roadmap: ship search, billing and incognito." }] });

  await page.goto("/");
  await page.getByTestId("mode-chat").click();
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 20_000 });
  await sendMessage(page, "search chats quarterly");
  await waitForTurnEnd(page, 30_000);
  await expect(page.getByTestId("pastchat-card")).toHaveCount(0); // folded into a collapsed group
  await openToolGroups(page);
  const search = page.getByTestId("pastchat-card").first();
  await expect(search).toHaveAttribute("data-kind", "search");
  await expect(search).toContainText("Searched past chats · quarterly");
  await expect(page.getByTestId("tool-card")).toHaveCount(0);
  await expect(search.getByTestId("pastchat-result")).toHaveCount(0);
  await search.getByTestId("pastchat-toggle").click();
  await expect(search.getByTestId("pastchat-result")).toContainText("Quarterly plan");
  await page.screenshot({ path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/history-chips.png` : undefined });

  await sendMessage(page, `read chat ${quarterly.id}`);
  await waitForTurnEnd(page, 30_000);
  await openToolGroups(page);
  const read = page.getByTestId("pastchat-card").nth(1);
  await expect(read).toHaveAttribute("data-kind", "read");
  await expect(read).toContainText("Read · Quarterly plan");
  await read.getByTestId("pastchat-open").click();
  await expect(page).toHaveURL(new RegExp(`/s/${quarterly.id}$`));
  await expect(page.getByTestId("assistant-message").first()).toContainText("ship search, billing and incognito");
});
