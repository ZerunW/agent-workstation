import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, ensureUser, hubHasRoute, loginViaStorage, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

test("Memory page: add, edit and delete a memory, and the on/off switch survives a reload", async ({ page }) => {
  const user = uniqueUser("mem");
  await ensureUser(page, user);
  test.skip(!(await hubHasRoute(page, user, "/api/me/memories")), "this hub has no Memory routes yet");
  await loginViaStorage(page, user);
  await page.goto("/memory");

  await expect(page.getByTestId("memory-empty")).toBeVisible();
  await page.getByTestId("memory-add-input").fill("Prefers short answers");
  await page.getByTestId("memory-add").click();
  const item = page.getByTestId("memory-item").first();
  await expect(item).toContainText("Prefers short answers");
  await expect(item.getByTestId("memory-source")).toHaveText("You");

  await item.getByTestId("memory-edit").click();
  await item.getByTestId("memory-edit-input").fill("Prefers detailed answers");
  await item.getByTestId("memory-save").click();
  await expect(item).toContainText("Prefers detailed answers");

  // survives a reload: it is stored on the hub, not in the browser
  await page.reload();
  await expect(page.getByTestId("memory-item")).toHaveCount(1);
  await expect(page.getByTestId("memory-item").first()).toContainText("Prefers detailed answers");

  // delete asks first
  await page.getByTestId("memory-delete").click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("memory-item")).toHaveCount(1);
  await page.getByTestId("memory-delete").click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("memory-empty")).toBeVisible();

  // the switch is a user preference on the hub
  const toggle = page.getByTestId("memory-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await expect(page.getByTestId("memory-toggle")).toHaveAttribute("aria-checked", "false");
});

test("Memory… is in the settings menu and on Customize, not in the user menu", async ({ page }) => {
  await loginViaStorage(page, uniqueUser("memmenu"));
  await page.goto("/");
  await page.getByRole("button", { name: "Signed in as" }).click();
  await expect(page.getByRole("menuitem", { name: "Switch user" })).toBeVisible();
  await expect(page.getByTestId("menu-memory")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("menu-memory").click();
  await expect(page).toHaveURL(/\/memory$/);
});
