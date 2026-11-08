import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, loginViaUi, openPanel, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

// The right-hand panel works without an open session, so this spec covers the Files and Terminal tabs on their own.
test.describe("right panel", () => {
  test("Files tab lists the workspace tree", async ({ page }) => {
    await loginViaUi(page, uniqueUser("files"));
    await page.getByTestId("mode-code").click();
    await openPanel(page, "files");
    const panel = page.getByRole("complementary", { name: /right panel/i });
    await expect(panel).toContainText("inbox", { timeout: 20_000 });
    await expect(panel).toContainText("projects");
  });

  test("Terminal tab attaches to a shell, runs a command and survives a reload", async ({ page }) => {
    await loginViaUi(page, uniqueUser("term"));
    await page.getByTestId("mode-code").click();
    await openPanel(page, "terminal");
    const rows = page.locator(".xterm-rows").first();
    await expect(rows).toBeVisible({ timeout: 20_000 });
    const text = async () => (await rows.innerText()).replace(/\u00a0/g, " ");
    await expect.poll(text, { timeout: 20_000, message: "shell prompt" }).toMatch(/[$#%]\s*$/m);

    await page.locator(".xterm-helper-textarea").first().focus();
    await page.keyboard.type("echo workstation-e2e-marker");
    await page.keyboard.press("Enter");
    await expect.poll(text, { timeout: 15_000 }).toMatch(/^workstation-e2e-marker$/m);

    // the hub keeps the shell (tmux): reloading re-attaches to the same terminal and replays its output
    await page.reload();
    await page.getByTestId("mode-code").click();
    await openPanel(page, "terminal");
    await expect.poll(async () => (await page.locator(".xterm-rows").first().innerText()).replace(/\u00a0/g, " "), { timeout: 20_000 }).toContain("workstation-e2e-marker");
  });
});
