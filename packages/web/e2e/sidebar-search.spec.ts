import { expect, test, type Page } from "@playwright/test";
import { E2E_BASE_URL, ensureUser, hasMockHooks, hubHasRoute, loginViaStorage, seedSession, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

test("the sidebar starts with New, Search and Projects; Usage and the gear stay in the footer", async ({ page }) => {
  await loginViaStorage(page, uniqueUser("side"));
  await page.goto("/");
  const top = page.getByTestId("sidebar-top");
  await expect(top).toBeVisible({ timeout: 20_000 });
  await expect(top.getByTestId("nav-new")).toContainText("⌘N");
  await expect(top.getByTestId("nav-search")).toContainText("⌘K");
  await expect(top.getByTestId("nav-projects")).toBeVisible();
  await expect(top.getByTestId("nav-customize")).toHaveCount(0);
  await expect(page.getByText("Artifacts", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Scheduled", { exact: true })).toHaveCount(0);
  const footer = page.getByTestId("sidebar-footer");
  await expect(footer.getByRole("link", { name: "Usage" })).toBeVisible();
  await expect(footer.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(footer.getByTestId("nav-projects")).toHaveCount(0);
  // the Chat/Code toggle and the session list are still there
  await expect(page.getByTestId("mode-chat")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Session list" })).toBeVisible();
});

test("the gear menu holds Session defaults, Instructions, Memory, Skills and Browser sites", async ({ page }) => {
  await loginViaStorage(page, uniqueUser("gear"));
  await page.goto("/");
  const gear = page.getByTestId("sidebar-footer").getByRole("button", { name: "Settings" });
  await gear.click();
  await page.getByTestId("menu-session-defaults").click();
  await expect(page.getByRole("dialog", { name: "Session defaults" })).toBeVisible();
  await page.keyboard.press("Escape");
  for (const [id, path] of [["menu-instructions", "instructions"], ["menu-memory", "memory"], ["menu-skills", "skills"], ["menu-browser-sites", "browser-sites"]] as const) {
    await page.goto("/");
    await gear.click();
    await page.getByTestId(id).click();
    await expect(page).toHaveURL(new RegExp(`/${path}$`));
  }
  await page.goto("/customize");
  await expect(page).toHaveURL(/\/$/);
});

test.describe("Search dialog", () => {
  let user: string;

  test.beforeEach(async ({ page }) => {
    user = uniqueUser("search");
    await ensureUser(page, user);
    await loginViaStorage(page, user);
    test.skip(!(await hubHasRoute(page, user, "/api/search?q=x")), "this hub has no /api/search yet");
    test.skip(!(await hasMockHooks(page)), "needs the mock hub's seed hooks");
    await seedSession(page, { user, title: "Search box design", ageMinutes: 5, messages: [{ role: "user", text: "How long should the debounce be?" }, { role: "assistant", text: "A debounce of 200 ms is fine for the search box." }] });
    await seedSession(page, { user, title: "Typing delay notes", ageMinutes: 60, messages: [{ role: "user", text: "typing delay for the input" }, { role: "assistant", text: "Wait for a short pause in typing before asking." }] });
    await seedSession(page, { user, title: "Lunch plans", ageMinutes: 600, messages: [{ role: "user", text: "pizza or ramen" }] });
  });

  const openSearch = async (page: Page) => {
    await page.goto("/");
    await expect(page.getByTestId("mode-chat")).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("search-dialog")).toBeVisible();
  };

  test("⌘K / Ctrl+K and the sidebar item open it; Esc closes it; ⌘⇧P is the command palette", async ({ page }) => {
    await openSearch(page);
    await expect(page.getByTestId("search-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("search-dialog")).toHaveCount(0);
    await page.getByTestId("nav-search").click();
    await expect(page.getByTestId("search-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Shift+p");
    await expect(page.getByPlaceholder("Search sessions and actions…")).toBeVisible();
  });

  test("two columns side by side: Keyword live (~150 ms), Relevant after typing stops (600 ms) with a skeleton, reasons and dates", async ({ page }) => {
    const calls: Array<{ url: string; at: number }> = [];
    page.on("request", (r) => {
      if (/\/api\/search(\/relevant)?\?/.test(r.url())) calls.push({ url: r.url(), at: Date.now() });
    });
    await openSearch(page);
    const keyword = page.getByTestId("search-col-keyword");
    const relevant = page.getByTestId("search-col-relevant");
    const kb = (await keyword.boundingBox())!;
    const rb = (await relevant.boundingBox())!;
    expect(rb.x).toBeGreaterThan(kb.x + kb.width - 2); // right of it
    expect(Math.abs(rb.y - kb.y)).toBeLessThan(2); // same row

    const typedAt = Date.now();
    await page.getByTestId("search-input").pressSequentially("debounce", { delay: 20 });
    const lastKey = Date.now();
    await expect(keyword.getByTestId("search-hit").first()).toBeVisible();
    await expect(relevant.getByTestId("relevant-skeleton")).toBeVisible();
    expect(calls.filter((c) => c.url.includes("/relevant")).length).toBe(0);
    await expect(relevant.getByTestId("search-hit").first()).toBeVisible({ timeout: 5_000 });
    const kc = calls.filter((c) => !c.url.includes("/relevant"));
    const rc = calls.filter((c) => c.url.includes("/relevant"));
    expect(kc).toHaveLength(1); // typed in one go: one live request
    expect(rc).toHaveLength(1);
    expect(kc[0]!.at - lastKey).toBeGreaterThanOrEqual(100); // debounced, not per key
    expect(rc[0]!.at - lastKey).toBeGreaterThanOrEqual(550);
    expect(rc[0]!.at - typedAt).toBeGreaterThan(kc[0]!.at - typedAt);

    // newest first, snippet with the match marked
    const titles = await keyword.getByTestId("search-hit-title").allTextContents();
    expect(titles[0]).toBe("Search box design");
    await expect(keyword.getByTestId("search-snippet").first().locator("mark").first()).toHaveText(/debounce/i);
    await expect(keyword.getByTestId("search-hit-date").first()).not.toBeEmpty();
    // relevant: title, date and one reason line
    const first = relevant.getByTestId("search-hit").first();
    await expect(first.getByTestId("search-hit-title")).not.toBeEmpty();
    await expect(first.getByTestId("search-hit-date")).not.toBeEmpty();
    await expect(first.getByTestId("search-reason")).toContainText(/\w/);
    await page.screenshot({ path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/search-desktop.png` : undefined });
  });

  test("a repeated query is served from the client cache", async ({ page }) => {
    const relevantCalls: string[] = [];
    page.on("request", (r) => /\/api\/search\/relevant\?/.test(r.url()) && relevantCalls.push(r.url()));
    await openSearch(page);
    const input = page.getByTestId("search-input");
    await input.fill("debounce");
    await expect(page.getByTestId("search-col-relevant").getByTestId("search-hit").first()).toBeVisible({ timeout: 5_000 });
    await input.fill("");
    await input.fill("debounce");
    await expect(page.getByTestId("search-col-relevant").getByTestId("search-hit").first()).toBeVisible({ timeout: 300 }); // no 600 ms wait, no skeleton
    await page.waitForTimeout(900);
    expect(relevantCalls).toHaveLength(1);
  });

  test("arrow keys go through the left list and then the right one; Enter opens the session", async ({ page }) => {
    await openSearch(page);
    await page.getByTestId("search-input").fill("typing");
    const hits = page.getByTestId("search-hit");
    await expect(page.getByTestId("search-col-relevant").getByTestId("search-hit").first()).toBeVisible({ timeout: 5_000 });
    const kinds = await hits.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
    expect(kinds[0]).toBe("keyword");
    expect(kinds).toContain("relevant");
    const firstRelevant = kinds.indexOf("relevant");
    await expect(hits.nth(0)).toHaveAttribute("aria-selected", "true");
    for (let i = 0; i < firstRelevant; i++) await page.keyboard.press("ArrowDown");
    await expect(hits.nth(firstRelevant)).toHaveAttribute("aria-selected", "true");
    const wanted = await hits.nth(firstRelevant).getAttribute("data-session");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/s/${wanted}$`));
    await expect(page.getByTestId("search-dialog")).toHaveCount(0);
  });

  test("on a narrow screen the columns stack, Keyword above Relevant", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("search-dialog")).toBeVisible();
    await page.getByTestId("search-input").fill("debounce");
    await expect(page.getByTestId("search-col-relevant").getByTestId("search-hit").first()).toBeVisible({ timeout: 5_000 });
    const kb = (await page.getByTestId("search-col-keyword").boundingBox())!;
    const rb = (await page.getByTestId("search-col-relevant").boundingBox())!;
    expect(rb.y).toBeGreaterThanOrEqual(kb.y + kb.height - 2);
    expect(Math.abs(rb.x - kb.x)).toBeLessThan(2);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(scroll).toBe(true); // no sideways page scroll
    await page.screenshot({ path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/search-narrow.png` : undefined });
  });

  test("empty states are one short line each", async ({ page }) => {
    await openSearch(page);
    await expect(page.getByTestId("search-prompt")).toHaveCount(0);
    await page.getByTestId("search-input").fill("zzzqqq");
    await expect(page.getByTestId("search-empty-keyword")).toHaveText("No matches.");
    await expect(page.getByTestId("search-empty-relevant")).toHaveText("Nothing relevant.", { timeout: 5_000 });
  });
});
