import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, ensureUser, loginViaStorage, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

test("usage page shows the API credits card and no plan limits", async ({ page }) => {
  const user = uniqueUser("usage");
  await loginViaStorage(page, user);
  const api = await page.request.get("/api/usage/limits", { headers: { "X-Workstation-User": user } });
  expect(api.ok()).toBeTruthy();
  expect(Object.keys((await api.json()) as object)).toEqual(["api"]);

  await page.goto("/usage");
  await expect(page.getByRole("heading", { name: "API credits" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/5-hour|Plan limits/i)).toHaveCount(0);
});

test("usage page: By model names models (not ids) and shows an estimated cost for every row", async ({ page }) => {
  await loginViaStorage(page, uniqueUser("bymodel"));
  await page.goto("/usage");
  const rows = page.getByTestId("model-row");
  const first = await rows.first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
  test.skip(!first, "this account has no token usage to break down");
  const names = await rows.locator("td:first-child").allTextContents();
  for (const n of names) expect(n, n).not.toMatch(/^claude-|\d{8}$/);
  expect(new Set(names).size).toBe(names.length); // one row per model
  await expect(page.getByText("Included", { exact: true })).toHaveCount(0);
  for (const c of await rows.getByTestId("model-cost").allTextContents()) expect(c).toMatch(/^\$\d/);
  await expect(page.getByText("Cost (estimated)").first()).toBeVisible();
  // the chart legend uses the same names
  const legend = await page.locator("figure ul li").allTextContents();
  for (const n of legend) expect(n).not.toMatch(/^claude-/);
  await page.screenshot({ path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/usage-by-model.png` : undefined, fullPage: true });
});

test.describe("admin page", () => {
  test("is denied for a non-admin: /admin sends them back to the workbench and the sidebar has no Admin link", async ({ page }) => {
    const user = uniqueUser("plain");
    await loginViaStorage(page, user);
    await page.goto("/admin");
    await expect(page.getByTestId("mode-code")).toBeVisible({ timeout: 20_000 });
    await expect(page).not.toHaveURL(/\/admin/);
    await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
    // and the API refuses too
    const res = await page.request.get("/api/admin/overview", { headers: { "X-Workstation-User": user } });
    expect(res.status()).toBe(403);
  });

  test("is visible for the user `admin`", async ({ page }) => {
    await ensureUser(page, "admin");
    await loginViaStorage(page, "admin");
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin/);
    await expect(page.getByRole("heading", { name: "Admin", level: 1 })).toBeVisible({ timeout: 20_000 });
    // the workbench sidebar offers the page to admins only
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Admin" })).toBeVisible({ timeout: 20_000 });
  });
});
