import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, hasMockHooks, loginViaStorage, sendMessage, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

// The mock hub's "subagent" scenario proposes a batch (mcp__workstation_subagent__run_subagents): one approval card, then one
// child session per agent and one result section per agent.
test("a subagent batch: one approval card, Start runs the children, Don't start leaves 'Subagents not started'", async ({ page }) => {
  const user = uniqueUser("subs");
  await loginViaStorage(page, user);
  test.skip(!(await hasMockHooks(page)), "needs the mock hub's 'subagent' scenario");
  await page.goto("/");
  await page.getByTestId("mode-code").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();

  // Start
  await sendMessage(page, "claude subagent");
  await expect(page.getByTestId("subagents-title")).toHaveText("Start 2 subagents?");
  await expect(page.getByTestId("approval-agent")).toHaveCount(2);
  await expect(page.getByTestId("subagents-card").getByRole("button").filter({ hasText: /always/i })).toHaveCount(0);
  await page.getByTestId("subagents-start").click();
  await expect(page.getByText("The subagents are done; their answers are above.")).toBeVisible({ timeout: 20_000 });
  const group = page.getByTestId("tool-group").first();
  await expect(group.getByTestId("tool-group-text")).toHaveText("2 subagents");
  await group.getByRole("button").first().click();
  await expect(page.getByTestId("subagent-row")).toHaveCount(2);
  await page.getByTestId("subagent-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("subagent-transcript")).toHaveCount(1);
  await expect(page.getByTestId("subagent-answer")).toContainText("newer mtime");

  // Don't start
  await sendMessage(page, "claude subagent");
  await page.getByTestId("subagents-skip").click();
  await expect(page.getByText("Understood, I did not start the subagents.")).toBeVisible();
  await expect(page.getByTestId("tool-group-text").last()).toHaveText("Subagents not started");
});
