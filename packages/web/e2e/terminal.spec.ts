import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, loginViaStorage, openPanel, terminalText, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

test.describe("terminal", () => {
  test("shows a shell prompt and echoes `echo hi`", async ({ page }) => {
    await loginViaStorage(page, uniqueUser("term"));
    await page.goto("/");
    await page.getByTestId("mode-code").click();
    await openPanel(page, "terminal");
    await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => terminalText(page), { timeout: 20_000, message: "shell prompt" }).toMatch(/[$#%]\s*$/m);

    await page.locator(".xterm-helper-textarea").first().focus();
    await page.keyboard.type("echo hi");
    await page.keyboard.press("Enter");
    // the command line contains "echo hi", its output is a line that is exactly "hi"
    await expect.poll(() => terminalText(page), { timeout: 15_000 }).toMatch(/^hi$/m);
  });

  test("re-attaching to a terminal replaces the buffer instead of drawing the screen twice", async ({ page }) => {
    // remember every terminal WebSocket so the test can cut the connection without reloading the page
    await page.addInitScript(() => {
      const w = window as unknown as { __termSockets: WebSocket[] };
      w.__termSockets = [];
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (String(url).includes("/ws/terminal/")) w.__termSockets.push(this);
        }
      } as typeof WebSocket;
    });
    await loginViaStorage(page, uniqueUser("reat"));
    await page.goto("/");
    await page.getByTestId("mode-code").click();
    await openPanel(page, "terminal");
    await expect.poll(() => terminalText(page), { timeout: 20_000 }).toMatch(/[$#%]\s*$/m);
    await page.locator(".xterm-helper-textarea").first().focus();
    await page.keyboard.type("echo reattach-marker");
    await page.keyboard.press("Enter");
    await expect.poll(() => terminalText(page), { timeout: 15_000 }).toMatch(/^reattach-marker$/m);

    // drop the socket: the client re-attaches and the hub replays the tmux screen
    await page.evaluate(() => (window as unknown as { __termSockets: WebSocket[] }).__termSockets.forEach((s) => s.close()));
    await expect.poll(() => page.evaluate(() => (window as unknown as { __termSockets: WebSocket[] }).__termSockets.length), { timeout: 15_000 }).toBeGreaterThan(1);
    await expect.poll(async () => (await page.getByTestId("terminal-view").first().getAttribute("data-conn")) ?? "", { timeout: 15_000 }).toBe("open");
    await page.waitForTimeout(1_500); // let the replay arrive
    const text = await terminalText(page);
    const outputLines = text.split("\n").filter((l) => l.trim() === "reattach-marker");
    expect(outputLines, `terminal text after re-attach:\n${text}`).toHaveLength(1);
  });
});
