import { expect, test, type Page } from "@playwright/test";
import { E2E_BASE_URL, ensureUser, hasMockHooks, loginViaStorage, sendMessage, uniqueUser, waitForTurnEnd } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

const H = (user: string) => ({ "X-Workstation-User": user });

async function setup(page: Page, prefix = "api", spent = 12): Promise<string> {
  const user = uniqueUser(prefix);
  await ensureUser(page, user);
  await loginViaStorage(page, user);
  test.skip(!(await hasMockHooks(page)), "needs the mock hub's API-credit hooks");
  await page.request.post("/__mock/api", { data: { spentUsd: spent } });
  const me = (await (await page.request.get("/api/me", { headers: H(user) })).json()) as { apiAvailable?: boolean };
  test.skip(me.apiAvailable !== true, "this hub has no API credits configured (MOCK_API=off)");
  await page.goto("/");
  await page.getByTestId("mode-chat").click();
  await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 20_000 });
  return user;
}

test.afterEach(async ({ page }) => {
  await page.request.post("/__mock/api", { data: { spentUsd: 12 } });
});

test("a turn is billed to the API credits: the spend moves, and the model menu has no billing choice", async ({ page }) => {
  const user = await setup(page);
  await expect(page.getByTestId("api-banner")).toHaveCount(0);
  await page.getByTestId("model-picker").click();
  await expect(page.getByTestId("model-menu-billing")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await sendMessage(page, "say OK");
  await waitForTurnEnd(page, 30_000);
  const limits = (await (await page.request.get("/api/usage/limits", { headers: H(user) })).json()) as { api: { spentUsd: number } };
  expect(limits.api.spentUsd).toBeGreaterThan(12);
});

test("Session defaults has no billing choice", async ({ page }) => {
  await setup(page, "apidef");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("menu-session-defaults").click();
  await expect(page.getByTestId("defaults-model")).toBeVisible();
  await expect(page.getByTestId("defaults-billing")).toHaveCount(0);
});

test("API credits used up: the composer is blocked with one line and keeps the draft", async ({ page }) => {
  const user = await setup(page, "apifull");
  const created = (await (await page.request.post("/api/sessions", { headers: H(user), data: { kind: "chat" } })).json()) as { id: string };
  await page.request.post("/__mock/api", { data: { spentUsd: 100 } }); // the month's budget is gone
  await page.goto(`/s/${created.id}`);
  await sendMessage(page, "one more please");
  const block = page.getByTestId("composer-blocked");
  await expect(block).toHaveAttribute("data-code", "api_limit_reached");
  await expect(block).toContainText("API credits used up this month.");
  await expect(page.getByTestId("composer-input")).toHaveValue("one more please");
  await page.screenshot({ path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/api-blocked.png` : undefined });
  await page.request.post("/__mock/api", { data: { spentUsd: 12 } });
  await block.getByRole("button", { name: "Retry" }).click();
  await expect(block).toHaveCount(0);
  await page.getByTestId("composer-send").click();
  await waitForTurnEnd(page, 30_000);
  await expect(page.getByTestId("assistant-message").last()).toContainText("one more please");
});

test("usage page: one API credits group with one 'This period' card, no plan limits", async ({ page }) => {
  await setup(page, "apiuse");
  await page.goto("/usage");
  const group = page.getByTestId("api-usage");
  await expect(group).toBeVisible({ timeout: 20_000 });
  await expect(group.getByRole("heading", { name: "API credits" })).toBeVisible();
  const card = group.getByTestId("limit-bar");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("This period");
  await expect(card.getByTestId("limit-percent")).toHaveText("$12.00 / $100.00");
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "12");
  const meta = (await card.getByTestId("limit-countdown").locator("xpath=..").textContent()) ?? "";
  expect(meta).toMatch(/^Resets in \d+d( \d+h)? · [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/);
  const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
  expect(headings).not.toContain("Plan limits");
  expect(headings.indexOf("API credits")).toBe(0);
  await page.screenshot({ path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/usage-api.png` : undefined, fullPage: true });
});

test("admin page: API credits section with a monthly limit and a reset day (1–28)", async ({ page }) => {
  await ensureUser(page, "admin");
  await loginViaStorage(page, "admin");
  test.skip(!(await hasMockHooks(page)), "needs the mock hub's settings (apiMonthlyLimitUsd)");
  const before = (await (await page.request.get("/api/admin/settings", { headers: H("admin") })).json()) as { apiMonthlyLimitUsd?: number; apiResetDay?: number };
  await page.goto("/admin");
  const section = page.getByTestId("admin-api-credits");
  await expect(section).toBeVisible({ timeout: 20_000 });
  await expect(section.getByTestId("api-default-billing")).toHaveCount(0);
  const limit = section.getByTestId("api-limit");
  const day = section.getByTestId("api-day");
  await expect(limit).toHaveValue(String(before.apiMonthlyLimitUsd ?? 100));
  await expect(day).toHaveValue(String(before.apiResetDay ?? 1));

  // validation: day 29 and a negative limit cannot be saved
  await day.fill("29");
  await expect(day).toHaveAttribute("aria-invalid", "true");
  await expect(section.getByRole("alert")).toContainText("reset day 1–28");
  await expect(section.getByTestId("api-save")).toBeDisabled();
  await day.fill("0");
  await expect(section.getByTestId("api-save")).toBeDisabled();
  await day.fill("5");
  await limit.fill("-1");
  await expect(limit).toHaveAttribute("aria-invalid", "true");
  await expect(section.getByTestId("api-save")).toBeDisabled();

  try {
    await limit.fill("300.5");
    await expect(section.getByTestId("api-save")).toBeEnabled();
    await section.getByTestId("api-save").click();
    await expect(page.getByText("API credits saved")).toBeVisible();
    const after = (await (await page.request.get("/api/admin/settings", { headers: H("admin") })).json()) as { apiMonthlyLimitUsd: number; apiResetDay: number };
    expect(after).toMatchObject({ apiMonthlyLimitUsd: 300.5, apiResetDay: 5 });
    await page.screenshot({ path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/admin-api.png` : undefined, fullPage: true });
  } finally {
    await page.request.patch("/api/admin/settings", { headers: H("admin"), data: { apiMonthlyLimitUsd: before.apiMonthlyLimitUsd ?? 100, apiResetDay: before.apiResetDay ?? 1 } });
  }
});
