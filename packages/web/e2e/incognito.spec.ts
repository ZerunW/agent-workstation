import { expect, test, type Page } from "@playwright/test";
import { E2E_BASE_URL, ensureUser, getSession, hasMockHooks, loginViaStorage, openToolGroups, seedSession, sendMessage, uniqueUser, waitForTurnEnd } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

async function start(page: Page, prefix = "inc"): Promise<string> {
  const user = uniqueUser(prefix);
  await ensureUser(page, user);
  await loginViaStorage(page, user);
  await page.goto("/");
  await page.getByTestId("mode-chat").click();
  await expect(page.getByTestId("incognito-toggle")).toBeVisible({ timeout: 20_000 });
  return user;
}

/** The id of the session the page is on (/s/<id>). */
const currentId = (page: Page) => page.url().split("/s/")[1]!.split(/[?#]/)[0]!;

async function poll(check: () => Promise<boolean>, message: string, timeout = 8_000) {
  await expect.poll(check, { timeout, message }).toBe(true);
}

test("the ghost toggle starts an incognito chat: chip, tint, not listed, not searchable", async ({ page }) => {
  const user = await start(page);
  const toggle = page.getByTestId("incognito-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  // the header paints with the page background token, which an incognito chat swaps for its tint
  const bg = () => page.locator("header").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const normalBg = await bg();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("incognito-title")).toBeVisible();
  const tintedBg = await bg();
  expect(tintedBg).not.toBe(normalBg); // a distinct, subtle tint

  await sendMessage(page, "this is private zebra");
  await waitForTurnEnd(page, 30_000);
  const id = currentId(page);

  // the hub knows it as incognito, and never lists it
  const session = await getSession(page, user, id);
  expect(session?.incognito).toBe(true);
  const list = (await (await page.request.get("/api/sessions", { headers: { "X-Workstation-User": user } })).json()) as Array<{ id: string }>;
  expect(list.map((s) => s.id)).not.toContain(id);

  // the chat view carries one quiet line: the chip (and the same tint)
  const chip = page.getByTestId("incognito-chip");
  await expect(chip).toHaveText("Incognito");
  const inChat = await bg();
  expect(inChat).toBe(tintedBg);
  await page.screenshot({ path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/incognito-chat.png` : undefined });

  // not in the sidebar, even after a refresh of the list, and not in search
  await expect(page.getByRole("navigation", { name: "Session list" }).getByText("this is private zebra")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Session list" }).getByRole("link")).toHaveCount(0);
  const hits = (await (await page.request.get("/api/search?q=zebra", { headers: { "X-Workstation-User": user } })).json()) as { hits: unknown[] };
  expect(hits.hits).toHaveLength(0);
  await page.keyboard.press("Control+k");
  await page.getByTestId("search-input").fill("zebra");
  await expect(page.getByTestId("search-empty-keyword")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("starting a new chat deletes the incognito one on the hub, and the next chat is a normal one", async ({ page }) => {
  const user = await start(page);
  await page.getByTestId("incognito-toggle").click();
  await sendMessage(page, "hello in private");
  await waitForTurnEnd(page, 30_000);
  const id = currentId(page);
  expect(await getSession(page, user, id)).not.toBeNull();

  await page.getByTestId("nav-new").click();
  await expect(page).toHaveURL(/\/$/);
  await poll(async () => (await getSession(page, user, id)) === null, "the incognito session is deleted on the hub");
  // the ghost is off again, no chip, no tint
  await expect(page.getByTestId("incognito-toggle")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("incognito-chip")).toHaveCount(0);
  await sendMessage(page, "a normal chat");
  await waitForTurnEnd(page, 30_000);
  expect((await getSession(page, user, currentId(page)))?.incognito).toBeFalsy();
  await expect(page.getByTestId("incognito-chip")).toHaveCount(0);
});

test("switching to another session deletes it too", async ({ page }) => {
  const user = await start(page);
  test.skip(!(await hasMockHooks(page)), "needs the mock hub's seed hook");
  const other = await seedSession(page, { user, title: "Another chat", messages: [{ role: "user", text: "hi" }] });
  await page.reload();
  await page.getByTestId("mode-chat").click();
  await page.getByTestId("incognito-toggle").click();
  await sendMessage(page, "secret");
  await waitForTurnEnd(page, 30_000);
  const id = currentId(page);
  await page.getByRole("navigation", { name: "Session list" }).getByRole("link", { name: /Another chat/ }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${other.id}$`));
  await poll(async () => (await getSession(page, user, id)) === null, "deleted after switching away");
  expect(await getSession(page, user, other.id)).not.toBeNull();
});

test("closing the tab deletes it (a keepalive DELETE leaves with the page)", async ({ page, context }) => {
  const user = await start(page);
  await page.getByTestId("incognito-toggle").click();
  await sendMessage(page, "close me");
  await waitForTurnEnd(page, 30_000);
  const id = currentId(page);
  expect(await getSession(page, user, id)).not.toBeNull();
  await page.close({ runBeforeUnload: true });
  const probe = await context.newPage();
  await expect
    .poll(async () => (await probe.request.get(`/api/sessions/${id}`, { headers: { "X-Workstation-User": user } })).status(), { timeout: 8_000, message: "the hub dropped the session after the tab closed" })
    .toBe(404);
});

test("navigating away from the app also deletes it (pagehide)", async ({ page }) => {
  const user = await start(page);
  await page.getByTestId("incognito-toggle").click();
  await sendMessage(page, "leave the site");
  await waitForTurnEnd(page, 30_000);
  const id = currentId(page);
  await page.goto("about:blank");
  const probe = await page.context().newPage();
  await expect.poll(async () => (await probe.request.get(`/api/sessions/${id}`, { headers: { "X-Workstation-User": user } })).status(), { timeout: 8_000 }).toBe(404);
});

test("no memory chips in an incognito chat (the hub offers no memory tools), but a normal chat has them", async ({ page }) => {
  const user = await start(page, "incmem");
  const probe = await page.request.post("/__mock/api", { data: { spentUsd: 12 } });
  test.skip(!probe.ok(), "the memory script is the mock hub's");
  await page.getByTestId("incognito-toggle").click();
  await sendMessage(page, "remember that I like tea");
  await waitForTurnEnd(page, 30_000);
  await openToolGroups(page);
  await expect(page.getByTestId("memory-chip")).toHaveCount(0);
  const memories = (await (await page.request.get("/api/me/memories", { headers: { "X-Workstation-User": user } })).json()) as { memories: unknown[] };
  expect(memories.memories).toHaveLength(0);

  await page.getByTestId("nav-new").click();
  await sendMessage(page, "remember that I like coffee");
  await waitForTurnEnd(page, 30_000);
  await openToolGroups(page);
  await expect(page.getByTestId("memory-chip").first()).toBeVisible();
});

test("an incognito session never reaches Code mode's lists, and Code has no ghost", async ({ page }) => {
  await start(page, "inccode");
  await page.getByTestId("mode-code").click();
  await expect(page.getByTestId("incognito-toggle")).toHaveCount(0);
});
