import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, hasMockHooks, loginViaStorage, openPanel, sendMessage, uniqueUser, waitForTurnEnd } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

test("Overview: environment and context cards, collapse is remembered", async ({ page }) => {
  await loginViaStorage(page, uniqueUser("ovw"));
  await page.goto("/");
  await page.getByTestId("mode-code").click();
  await sendMessage(page, "say OK");
  await waitForTurnEnd(page, 60_000);

  await openPanel(page, "overview");
  const overview = page.getByTestId("overview-tab");
  await expect(overview.getByTestId("overview-machine")).not.toBeEmpty();
  await expect(overview.getByTestId("overview-folder")).toContainText("Workspace");
  await expect(overview.getByTestId("overview-model")).not.toBeEmpty();

  // the hub refreshes the usage when the turn ends (context_usage event)
  const context = page.getByTestId("overview-context");
  await expect(context).toContainText(/\d+% used|<1% used/, { timeout: 20_000 });
  await expect(context).toContainText("Free space");

  await page.getByTestId("overview-context-toggle").click();
  await expect(page.getByTestId("context-bar")).toHaveCount(0);
  await page.reload();
  await page.getByTestId("mode-code").click();
  await openPanel(page, "overview");
  await expect(page.getByTestId("overview-context-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("overview-environment-toggle")).toHaveAttribute("aria-expanded", "true");
});

test("Overview: a background task is listed and stopped; a created file is an output that opens in Files", async ({ page }) => {
  await loginViaStorage(page, uniqueUser("ovt"));
  test.skip(!(await hasMockHooks(page)), "the background-task scenario needs the mock hub");
  await page.goto("/");
  await page.getByTestId("mode-code").click();
  await sendMessage(page, "start a background job");
  await waitForTurnEnd(page, 60_000);

  await openPanel(page, "overview");
  const tasks = page.getByTestId("overview-tasks");
  await expect(tasks.getByTestId("overview-task")).toHaveCount(2, { timeout: 20_000 });
  await expect(tasks.getByTestId("overview-task").first()).toContainText("npm run dev");
  await expect(tasks.getByTestId("overview-task-elapsed").first()).toHaveText(/\d+s/);

  await tasks.getByTestId("overview-task-stop").first().click();
  await expect(tasks.getByTestId("overview-task")).toHaveCount(1);
  await tasks.getByTestId("overview-task-stop").first().click();
  await expect(tasks).toHaveCount(0);

  await sendMessage(page, "create a file notes.txt containing hi");
  await page.getByTestId("permission-card").first().getByTestId("perm-allow").click({ timeout: 60_000 });
  await waitForTurnEnd(page, 60_000);
  const output = page.getByTestId("overview-outputs").getByTestId("overview-output").first();
  await expect(output).toContainText("notes.txt", { timeout: 20_000 });
  await output.click();
  await expect(page.getByTestId("panel-files")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("file-detail")).toContainText("notes.txt");
});

test("End of turn: pinned task list, next-step box that answers with a button, finished tasks in Overview", async ({ page }) => {
  await loginViaStorage(page, uniqueUser("nxt"));
  test.skip(!(await hasMockHooks(page)), "the wrap-up scenario needs the mock hub");
  await page.goto("/");
  await page.getByTestId("mode-code").click();
  await sendMessage(page, "wrap up");
  await waitForTurnEnd(page, 60_000);

  // the TodoWrite call is the pinned card, not a tool group
  const rows = page.getByTestId("todo-card").getByTestId("todo-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText("Writing up the audit");
  await expect(page.getByTestId("tool-group")).toHaveCount(0);

  const box = page.getByTestId("next-step");
  await expect(box).toContainText("Tests pass and the sync audit is written up.");
  await expect(box.getByTestId("next-step-ask")).toHaveText("Open the changes for review?");
  await expect(box.getByTestId("next-step-action")).toHaveText(["Review changes", "Keep going"]);

  await openPanel(page, "overview");
  const tasks = page.getByTestId("overview-tasks");
  await expect(tasks.getByTestId("overview-task")).toHaveCount(0);
  await tasks.getByTestId("overview-tasks-finished").click();
  await expect(tasks.getByTestId("overview-task-finished")).toHaveCount(3);
  await expect(tasks.getByTestId("overview-task-mark")).toHaveText(["✓", "✗", "■"]);

  // a button sends its label as the next message; the box goes away
  await box.getByTestId("next-step-action").first().click();
  await expect(page.getByTestId("user-message").last()).toContainText("Review changes");
  await expect(page.getByTestId("next-step")).toHaveCount(0);
});

test("Chat has the Overview too, without the Code-only tabs", async ({ page }) => {
  await loginViaStorage(page, uniqueUser("ovc"));
  await page.goto("/");
  await page.getByTestId("mode-chat").click();
  await sendMessage(page, "say OK");
  await waitForTurnEnd(page, 60_000);

  await expect(page.getByTestId("panel-files")).toHaveCount(0);
  await openPanel(page, "overview");
  await expect(page.getByTestId("overview-machine")).not.toBeEmpty();
  await expect(page.getByTestId("overview-folder")).toHaveCount(0);
});
