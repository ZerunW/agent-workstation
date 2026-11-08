import { expect, test, type Page } from "@playwright/test";
import { E2E_BASE_URL, loginViaStorage, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

interface Model {
  value: string;
  displayName: string;
  legacy?: boolean;
}

async function hubInfo(page: Page, user: string) {
  const headers = { "X-Workstation-User": user };
  const models = (await (await page.request.get("/api/models", { headers })).json()) as Model[];
  return { models };
}

const options = (page: Page) => page.getByTestId("model-option");
const values = async (page: Page) => (await options(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-model")))) as string[];

test("model menu: newest per family on top, older versions under More models, Effort as a submenu", async ({ page }) => {
  const user = uniqueUser("models");
  await loginViaStorage(page, user);
  const { models } = await hubInfo(page, user);
  const legacy = models.filter((m) => m.legacy === true);
  await page.goto("/");
  await page.getByTestId("mode-code").click();
  await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("model-picker").click();
  const menu = page.getByTestId("model-menu");
  await expect(menu).toBeVisible();

  const top = await values(page);
  expect(top.length).toBeGreaterThan(0);
  await expect(menu.getByText("Default", { exact: true })).toHaveCount(1); // the effective default carries the badge
  await expect(page.getByTestId("model-menu-effort")).toContainText(/Effort/);

  if (legacy.length === 0) {
    await expect(page.getByTestId("model-menu-more")).toHaveCount(0);
    return;
  }
  // older versions are not at the top level (unless pinned as the default), they live in the submenu
  const pinnedLegacy = legacy.filter((m) => top.includes(m.value)).length;
  expect(pinnedLegacy).toBeLessThanOrEqual(1);
  await page.getByTestId("model-menu-more").click();
  const more = page.getByTestId("model-menu-more-list");
  await expect(more).toBeVisible();
  const inMore = await more.getByTestId("model-option").evaluateAll((els) => els.map((e) => e.getAttribute("data-model")));
  expect(inMore.length).toBe(legacy.length - pinnedLegacy);

  // picking an older version changes the pill, and the menu now pins it at the top level
  const pick = legacy.find((m) => inMore.includes(m.value))!;
  await more.locator(`[data-model="${pick.value}"]`).click();
  await expect(page.getByTestId("model-picker")).toContainText(pick.displayName);
  await page.getByTestId("model-picker").click();
  expect(await values(page)).toContain(pick.value);
});

test("model menu cleanups: no 'Default (recommended)' pseudo-entry, subtitles stay on one line", async ({ page }) => {
  const user = uniqueUser("menuclean");
  await loginViaStorage(page, user);
  const { models } = await hubInfo(page, user);
  const withDescription = (models as Array<Model & { description?: string }>).filter((m) => m.value !== "default" && (m.description?.length ?? 0) > 0);
  await page.goto("/");
  await page.getByTestId("mode-code").click();
  await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("model-picker").click();
  const menu = page.getByTestId("model-menu");
  await expect(menu).toBeVisible();

  // the SDK's "default" model is never listed; the Default badge marks the effective default instead
  expect(await values(page)).not.toContain("default");
  await expect(menu.getByText("Default (recommended)")).toHaveCount(0);
  await expect(menu.getByText("Default", { exact: true })).toHaveCount(1);

  // every subtitle is one truncated line (no wrapping), whatever its length
  const subtitles = menu.getByTestId("menu-description");
  const count = await subtitles.count();
  expect(count).toBeGreaterThan(0);
  const heights = await subtitles.evaluateAll((els) => els.map((el) => ({ h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight), ws: getComputedStyle(el).whiteSpace, text: el.textContent ?? "" })));
  for (const s of heights) {
    expect(s.ws).toBe("nowrap");
    expect(s.h).toBeLessThanOrEqual(s.lh + 1);
  }
  if (withDescription.length > 0) expect(count).toBeGreaterThanOrEqual(1);
  await page.screenshot({ path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/model-menu.png` : undefined });
});
