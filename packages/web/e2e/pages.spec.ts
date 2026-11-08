import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, loginViaStorage, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

test.describe("login page", () => {
  test("rejects invalid usernames, never lists users, and the same typed name is the same user", async ({ page, request }) => {
    const other = uniqueUser("listed");
    expect([200, 201, 409]).toContain((await request.post("/api/users", { data: { name: other } })).status());
    // the list itself is admin-only
    expect((await request.get("/api/users")).status()).toBe(401);

    await page.goto("/login");
    await expect(page.getByRole("heading", { name: /who's working/i })).toBeVisible();
    // no list of existing users anywhere on the page
    await expect(page.getByText(other)).toHaveCount(0);

    const input = page.getByTestId("login-name");
    await input.fill("Bad Name!");
    await page.getByTestId("login-continue").click();
    await expect(page.getByText(/use only a–z, 0–9/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    // typing an existing name enters that workspace (200, not a "taken" error)
    await input.fill(other);
    await page.getByTestId("login-continue").click();
    await expect(page.getByTestId("mode-code")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("workstation.user"))).toBe(other);

    // "switch user" offers the name already used on this device
    await page.goto("/login");
    await expect(page.getByTestId("login-continue-current")).toContainText(other);
  });

  test("redirects to /login when no user is selected", async ({ page }) => {
    await page.goto("/usage");
    await expect(page).toHaveURL(/\/login/);
  });
});

test("session defaults: opus/high out of the box, the user's own choice is stored on the hub", async ({ page }) => {
  const user = uniqueUser("defaults");
  await loginViaStorage(page, user);
  await page.goto("/");
  // the composer pickers show the effective default before anything is created
  await expect(page.getByTestId("model-picker")).toContainText(/opus/i, { timeout: 20_000 });
  await expect(page.getByTestId("effort-picker")).toContainText(/high/i);

  // settings menu → Session defaults… (also on Customize) → pick Sonnet / Medium → Save
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("menu-session-defaults").click();
  const model = page.getByTestId("defaults-model");
  await expect(model).toBeVisible();
  // the newest Sonnet the hub lists (its id is whatever the hub calls it: "sonnet" on the server)
  const models = (await (await page.request.get("/api/models", { headers: { "X-Workstation-User": user } })).json()) as Array<{ value: string; displayName: string; legacy?: boolean }>;
  const sonnet = (models.find((m) => /sonnet/i.test(m.displayName) && !m.legacy) ?? models.find((m) => /sonnet/i.test(m.displayName)))!.value;
  await model.selectOption(sonnet);
  await page.getByTestId("defaults-effort").selectOption("medium");
  await page.getByTestId("defaults-save").click();
  await expect(page.getByRole("status")).toContainText(/saved/i);

  // stored on the hub, so it follows the name to every device
  const me = await (await page.request.get("/api/me", { headers: { "X-Workstation-User": user } })).json();
  expect(me.user.defaultModel).toBe(sonnet);
  expect(me.user.defaultEffort).toBe("medium");
  const created = await (await page.request.post("/api/sessions", { headers: { "X-Workstation-User": user }, data: { kind: "chat" } })).json();
  expect(created.model).toBe(sonnet);
  expect(created.effort).toBe("medium");
  await page.request.delete(`/api/sessions/${created.id}`, { headers: { "X-Workstation-User": user } });
});

test("usage page shows the limit progress bars", async ({ page }) => {
  await loginViaStorage(page, uniqueUser("usage"));
  await page.goto("/usage");
  // 5-hour, weekly and per-model rows each render a progress bar
  await expect(page.getByRole("progressbar").first()).toBeVisible({ timeout: 20_000 });
  expect(await page.getByRole("progressbar").count()).toBeGreaterThanOrEqual(3);
});
