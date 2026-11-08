import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, ensureUser, loginViaStorage, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

// A long session: the hub replays only its newest messages (`truncated: true`) and the UI offers "Load earlier messages".
// Needs the mock hub's /__mock/seed hook (the real hub caps replay at 500 messages, which takes a long conversation to reach).
test("a truncated replay offers 'Load earlier messages', which backfills over REST and keeps the reading position", async ({ page }) => {
  const user = uniqueUser("long");
  await ensureUser(page, user);
  const created = await page.request.post("/api/sessions", { headers: { "X-Workstation-User": user }, data: { kind: "code", title: "Long history" } });
  const session = (await created.json()) as { id: string };
  const seeded = await page.request.post("/__mock/seed", { data: { user, sessionId: session.id, count: 1100 } });
  test.skip(!seeded.ok(), "needs the mock hub's /__mock/seed hook");
  expect(((await seeded.json()) as { lastSeq: number }).lastSeq).toBe(1100);

  await loginViaStorage(page, user);
  await page.goto(`/s/${session.id}`);
  // the newest messages are there, the oldest are not
  await expect(page.getByTestId("transcript")).toContainText("Filler answer 1100", { timeout: 20_000 });
  await expect(page.getByTestId("transcript")).not.toContainText(/Filler question 3(?!\d)/);
  const button = page.getByTestId("load-earlier");
  await expect(button).toBeVisible();

  // scroll to the top and load: the messages that were visible stay where they were
  const scroller = page.getByTestId("transcript");
  await scroller.evaluate((el) => (el.scrollTop = 0));
  const anchor = page.locator('[data-seq="101"]').first();
  await expect(anchor).toBeAttached();
  const before = await anchor.evaluate((el) => el.getBoundingClientRect().top - (el.closest("[data-testid=transcript]") as HTMLElement).getBoundingClientRect().top);
  await button.click();
  await expect(page.locator('[data-seq="1"]').first()).toBeAttached({ timeout: 20_000 }).catch(() => {});
  await expect(page.locator('[data-seq="50"]').first()).toBeAttached({ timeout: 20_000 });
  const after = await anchor.evaluate((el) => el.getBoundingClientRect().top - (el.closest("[data-testid=transcript]") as HTMLElement).getBoundingClientRect().top);
  expect(Math.abs(after - before)).toBeLessThan(40);

  // keep loading until the start of the conversation: the control goes away
  for (let i = 0; i < 6 && (await button.count()); i++) {
    await button.click();
    await page.waitForTimeout(300);
  }
  await expect(button).toHaveCount(0);
  await expect(page.locator('[data-seq="1"]').first()).toBeAttached();
});
