import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, hasMockHooks, loginViaStorage, sendMessage, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

// The mock hub's "browse <url>" scenario asks the browser-site question first (a real hub asks when the agent's browser
// call reaches an origin the user has not granted).
test("a browser-site question: Allow this session, Deny, then Always allow lands in Browser sites and stops the questions", async ({ page }) => {
  const user = uniqueUser("site");
  await loginViaStorage(page, user);
  test.skip(!(await hasMockHooks(page)), "needs the mock hub's 'browse <url>' scenario");
  await page.goto("/");
  await page.getByTestId("mode-code").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();

  // Allow this session: the card goes, the answer folds into the group, nothing is saved
  await sendMessage(page, "browse github.com");
  const card = page.getByTestId("site-card");
  await expect(page.getByTestId("site-title")).toHaveText("Use the browser on github.com?");
  await expect(card.getByRole("button")).toHaveText(["Allow this session", "Always allow", "Deny"]);
  await card.getByTestId("site-session").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("The page is open.")).toBeVisible();
  await expect(page.getByTestId("permission-resolved")).toHaveCount(0); // folded away
  await page.getByTestId("tool-group").first().getByRole("button").first().click();
  await expect(page.getByTestId("permission-resolved")).toHaveText("Allowed github.com");

  // Deny
  await sendMessage(page, "browse https://example.org");
  await expect(page.getByTestId("site-title")).toHaveText("Use the browser on example.org?");
  await page.getByTestId("site-deny").click();
  await expect(page.getByText("Understood, I did not open the page.")).toBeVisible();

  // nothing was remembered yet
  await page.goto("/browser-sites");
  await expect(page.getByRole("heading", { name: "Browser sites" })).toBeVisible();
  await expect(page.getByTestId("browser-site")).toHaveCount(0);

  // Always allow
  await page.goto("/");
  await page.getByTestId("mode-code").click();
  await sendMessage(page, "browse github.com");
  await page.getByTestId("site-always").click();
  await expect(page.getByText("The page is open.")).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("menu-browser-sites").click();
  await expect(page).toHaveURL(/\/browser-sites$/);
  const row = page.getByTestId("browser-site");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("browser-site-host")).toHaveText("github.com");
  await expect(row.getByTestId("browser-site-used")).toHaveText(/now|\d+\s?m/);

  // an allowed site is not asked again
  await page.goto("/");
  await page.getByTestId("mode-code").click();
  await sendMessage(page, "browse github.com");
  await expect(page.getByText("The page is open.")).toBeVisible();
  await expect(page.getByTestId("site-card")).toHaveCount(0);

  // removing it brings the question back
  await page.goto("/browser-sites");
  await page.getByRole("button", { name: "Remove github.com" }).click();
  await expect(page.getByTestId("browser-site")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("browser-site")).toHaveCount(0);
  await page.goto("/");
  await page.getByTestId("mode-code").click();
  await sendMessage(page, "browse github.com");
  await expect(page.getByTestId("site-title")).toHaveText("Use the browser on github.com?");
  await page.getByTestId("site-deny").click();
});
