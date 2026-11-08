import { expect, type Locator, type Page } from "@playwright/test";

export const E2E_BASE_URL = process.env.E2E_BASE_URL;

/**
 * Throwaway user for one test. Every name starts with `e2e-` so an admin can find the leftovers on a shared server by
 * that prefix and remove them with `DELETE /api/users/:name?force=true`.
 */
export function uniqueUser(prefix = "run"): string {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  return `e2e-${prefix}-${stamp}`.slice(0, 32);
}

/** Open the app logged out and create/pick `name` through the real username page. */
export async function loginViaUi(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  const input = page.getByTestId("login-name");
  await input.fill(name);
  await page.getByTestId("login-continue").click();
  await expect(page.getByTestId("mode-code")).toBeVisible();
}

/** Skip the login page by creating the user over REST and seeding localStorage (for specs that are not about login). */
export async function loginViaStorage(page: Page, name: string): Promise<void> {
  const res = await page.request.post("/api/users", { data: { name } });
  expect([200, 201, 409]).toContain(res.status());
  await page.addInitScript((n) => {
    try {
      localStorage.setItem("workstation.user", n);
    } catch {}
  }, name);
}

/** Type into the composer and send with the button (works for both the new-session pane and an open session). */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("composer-input");
  await input.fill(text);
  const send = page.getByTestId("composer-send");
  await expect(send).toBeEnabled();
  await send.click();
}

/** Open a right-panel tab; the toggle buttons close the panel when their tab is already showing, so check first. */
export async function openPanel(page: Page, tab: "overview" | "files" | "terminal" | "changes" | "history" | "browser"): Promise<void> {
  const btn = page.getByTestId(`panel-${tab}`);
  await expect(btn).toBeVisible();
  if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
}

/** Create `name` over REST (409 = already there is fine). */
export async function ensureUser(page: Page, name: string): Promise<void> {
  const res = await page.request.post("/api/users", { data: { name } });
  expect([200, 201, 409]).toContain(res.status());
}

/**
 * Wait until `done` is visible while approving every permission card that shows up on the way
 * (a real Claude turn may ask before it reads or writes).
 */
export async function approveUntil(page: Page, done: Locator, timeout = 90_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await done.first().isVisible().catch(() => false)) return;
    const allow = page.getByTestId("perm-allow").first();
    if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => {});
    await page.waitForTimeout(400);
  }
  await expect(done.first()).toBeVisible({ timeout: 1_000 });
}

/**
 * Wait until the current turn is over: Claude's reply is in (or the turn failed) and neither the composer's stop button
 * nor the live turn indicator is showing any more. A successful turn leaves no row behind, so "done" is the absence of
 * those two. It does not return before the turn was seen running (or a reply is already there), so calling it right
 * after sending cannot pass on the idle moment before the hub reports `running`.
 * `approve: true` also answers permission cards on the way (a real Claude turn may ask before it reads or writes).
 */
/** Tool groups start collapsed ("Ran a command ▸"): open every one on screen (their rows stay collapsed). */
export async function openToolGroups(page: Page): Promise<void> {
  const collapsed = page.locator("[data-testid=tool-group] > button[aria-expanded=false]");
  for (let n = await collapsed.count(); n > 0; n--) await collapsed.first().click();
}

export async function waitForTurnEnd(page: Page, timeoutMs = 90_000, opts: { approve?: boolean } = {}): Promise<void> {
  const stop = page.getByTestId("composer-stop");
  const indicator = page.getByTestId("turn-indicator");
  const replied = page.getByTestId("assistant-message").or(page.locator("[data-testid=result-divider][data-error=true]"));
  let seenRunning = false;
  await expect
    .poll(
      async () => {
        if (opts.approve) {
          const allow = page.getByTestId("perm-allow").first();
          if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => {});
        }
        const busy = (await stop.isVisible().catch(() => false)) || (await indicator.count().catch(() => 0)) > 0;
        if (busy) seenRunning = true;
        return !busy && (seenRunning || (await replied.count().catch(() => 0)) > 0);
      },
      { timeout: timeoutMs, intervals: [250, 400, 500], message: "the turn did not end (composer-stop / turn-indicator still showing, or nothing ever started)" },
    )
    .toBe(true);
}

/** xterm's rendered rows as plain text (non-breaking spaces normalised). */
export async function terminalText(page: Page): Promise<string> {
  return (await page.locator(".xterm-rows").first().innerText()).replace(/\u00a0/g, " ");
}

/** True when the hub answers `path` with something other than 404/501 (route exists). */
export async function hubHasRoute(page: Page, user: string, path: string): Promise<boolean> {
  const res = await page.request.get(path, { headers: { "X-Workstation-User": user } });
  return res.status() !== 404 && res.status() !== 501;
}

/** True against the mock hub only: its `/__mock/*` test hooks exist. Specs that need them skip themselves on a real hub. */
export async function hasMockHooks(page: Page): Promise<boolean> {
  const res = await page.request.post("/__mock/api", { data: { spentUsd: 12 } });
  return res.ok();
}

/** Mock hub: create a session with a ready-made history (answers the Session). */
export async function seedSession(
  page: Page,
  body: { user: string; title: string; kind?: "chat" | "code"; model?: string; incognito?: boolean; ageMinutes?: number; messages?: Array<{ role: "user" | "assistant"; text: string }> },
): Promise<{ id: string; title: string }> {
  const res = await page.request.post("/__mock/seed-session", { data: body });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { id: string; title: string };
}

/** The Session as the hub serves it (404 -> null). */
export async function getSession(page: Page, user: string, id: string): Promise<Record<string, unknown> | null> {
  const res = await page.request.get(`/api/sessions/${id}`, { headers: { "X-Workstation-User": user } });
  return res.ok() ? ((await res.json()) as Record<string, unknown>) : null;
}
