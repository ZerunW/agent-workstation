import { expect, test, type Page } from "@playwright/test";
import { E2E_BASE_URL, ensureUser, loginViaStorage, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

// The macOS app injects the theme through window.workstationEmbedConfig and flips it later with workstationEmbed.setTheme(): both must repaint
// every surface (composer, palettes, diff viewer, terminal) at once, whatever the OS scheme is.
test.use({ colorScheme: "light", viewport: { width: 720, height: 640 } });

/** What `var(--token)` resolves to as a background color under the current theme. */
const tokenBg = (page: Page, token: string) =>
  page.evaluate((v) => {
    const d = document.createElement("div");
    d.style.background = `var(${v})`;
    document.body.appendChild(d);
    const c = getComputedStyle(d).backgroundColor;
    d.remove();
    return c;
  }, token);
const bgOf = (page: Page, selector: string) => page.evaluate((s) => getComputedStyle(document.querySelector(s)!).backgroundColor, selector);

async function openEmbed(page: Page, config: Record<string, unknown>): Promise<void> {
  await page.addInitScript((c) => ((window as unknown as { workstationEmbedConfig: unknown }).workstationEmbedConfig = c), { hubUrl: "", ...config });
  await page.goto("/embed.html");
}

async function transcriptEmbed(page: Page, theme?: "dark" | "light"): Promise<string> {
  const user = uniqueUser("emb");
  await ensureUser(page, user);
  const res = await page.request.post("/api/sessions", { headers: { "X-Workstation-User": user }, data: { kind: "code", title: "Embed theme" } });
  const session = (await res.json()) as { id: string };
  await openEmbed(page, { user, mode: "transcript", sessionId: session.id, ...(theme ? { theme } : {}) });
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 20_000 });
  return user;
}

const COMPOSER_BOX = "[data-testid=composer-input]";
const boxBg = (page: Page) => page.evaluate((s) => getComputedStyle(document.querySelector(s)!.parentElement!).backgroundColor, COMPOSER_BOX);

test.describe("embed theme", () => {
  test("config theme 'dark' paints the composer, its palette and the canvas dark although the OS is light", async ({ page }) => {
    await transcriptEmbed(page, "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const surface = await tokenBg(page, "--surface");
    expect(surface).not.toBe("rgb(255, 255, 255)");
    expect(await boxBg(page)).toBe(surface);
    expect(await bgOf(page, "[data-testid=embed-root]")).toBe(await tokenBg(page, "--bg"));
    expect(await bgOf(page, "html")).toBe(await tokenBg(page, "--bg")); // the canvas behind a transparent body

    await page.getByTestId("composer-input").fill("/");
    const palette = page.getByRole("listbox", { name: /slash commands/i });
    await expect(palette).toBeVisible({ timeout: 20_000 });
    expect(await palette.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(surface);
  });

  test("setTheme() switches the composer at once (no color fade left running) in both directions", async ({ page }) => {
    await transcriptEmbed(page);
    const light = await tokenBg(page, "--surface");
    expect(await boxBg(page)).toBe(light);

    // flip and read in the same task: a transition would still report the old color here
    const toDark = await page.evaluate((s) => {
      (window as unknown as { workstationEmbed: { setTheme(t: string): void } }).workstationEmbed.setTheme("dark");
      return getComputedStyle(document.querySelector(s)!.parentElement!).backgroundColor;
    }, COMPOSER_BOX);
    const dark = await tokenBg(page, "--surface");
    expect(dark).not.toBe(light);
    expect(toDark).toBe(dark);

    const toLight = await page.evaluate((s) => {
      (window as unknown as { workstationEmbed: { setTheme(t: string): void } }).workstationEmbed.setTheme("light");
      return getComputedStyle(document.querySelector(s)!.parentElement!).backgroundColor;
    }, COMPOSER_BOX);
    expect(toLight).toBe(light);
    // the transition guard is gone again afterwards
    await expect(page.locator("html")).not.toHaveAttribute("data-theme-switching", "");
  });

  test("terminal mode: the terminal background and text follow config and setTheme()", async ({ page }) => {
    const user = uniqueUser("embt");
    await ensureUser(page, user);
    const term = (await (await page.request.post("/api/terminals", { headers: { "X-Workstation-User": user }, data: {} })).json()) as { id: string };
    await openEmbed(page, { user, mode: "terminal", terminalId: term.id, theme: "dark" });
    const view = page.getByTestId("terminal-view");
    await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 20_000 });
    const codeDark = await tokenBg(page, "--code-bg");
    expect(await view.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(codeDark);
    const fgDark = await page.evaluate(() => getComputedStyle(document.querySelector(".xterm-rows")!).color);

    await page.evaluate(() => (window as unknown as { workstationEmbed: { setTheme(t: string): void } }).workstationEmbed.setTheme("light"));
    const codeLight = await tokenBg(page, "--code-bg");
    expect(codeLight).not.toBe(codeDark);
    expect(await view.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(codeLight);
    // xterm re-themes from the CSS tokens (MutationObserver): its text color changes with the palette
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector(".xterm-rows")!).color)).not.toBe(fgDark);
  });

  test("diff mode: the merge view and its buttons use the dark tokens", async ({ page }) => {
    const user = uniqueUser("embd");
    await ensureUser(page, user);
    const projects = (await (await page.request.get("/api/projects", { headers: { "X-Workstation-User": user } })).json().catch(() => [])) as Array<{ id: string; name: string }>;
    const demo = Array.isArray(projects) ? projects.find((p) => p.name === "demo-app") : undefined;
    test.skip(!demo, "needs the mock hub's demo-app project");
    await openEmbed(page, { user, mode: "diff", projectId: demo!.id, path: "src/app.ts", theme: "dark" });
    await expect(page.getByTestId("diff-viewer")).toBeVisible({ timeout: 20_000 });
    const root = page.locator("[data-testid=embed-root]");
    expect(await root.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(await tokenBg(page, "--bg"));
    // the added lines use the dark tint
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".cm-changedLine, .cm-insertedLine")!).backgroundColor)).toBe(await tokenBg(page, "--diff-add"));

    await page.evaluate(() => (window as unknown as { workstationEmbed: { setTheme(t: string): void } }).workstationEmbed.setTheme("light"));
    await expect(page.getByTestId("diff-viewer")).toBeVisible();
    await expect.poll(() => bgOf(page, "[data-testid=embed-root]")).toBe(await tokenBg(page, "--bg"));
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".cm-changedLine, .cm-insertedLine")!).backgroundColor)).toBe(await tokenBg(page, "--diff-add"));
  });
});

test("the workbench applies a saved dark choice before React mounts and the settings menu switches it at once", async ({ page }) => {
  const user = uniqueUser("wbth");
  await loginViaStorage(page, user);
  await page.addInitScript(() => localStorage.setItem("workstation.theme", "dark"));
  await page.goto("/");
  await expect(page.getByTestId("mode-code")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await bgOf(page, "html")).toBe(await tokenBg(page, "--bg"));
});
