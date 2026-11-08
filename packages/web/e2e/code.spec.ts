import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, approveUntil, loginViaStorage, openPanel, openToolGroups, sendMessage, uniqueUser, waitForTurnEnd } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

test.describe("Code session", () => {
  test("the composer row shows the working directory; /?new=code&cwd= opens a draft in that folder and cleans the URL", async ({ page }) => {
    await loginViaStorage(page, uniqueUser("cwd"));
    await page.goto("/");
    await page.getByTestId("mode-code").click();
    await expect(page.getByTestId("composer-cwd")).toHaveText("Workspace");
    await expect(page.getByRole("button", { name: "Choose folder" })).toHaveCount(0); // only inside AgentWorkstation.app

    await page.goto("/?new=code&cwd=inbox%2Fdemo");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("composer-cwd")).toHaveText("demo");

    await page.goto("/?new=code&cwd=..%2Fescape");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("composer-cwd")).toHaveText("Workspace");
  });

  test("default permission mode: a permission card appears, Allow lets Claude create the file, it shows up in Files", async ({ page }) => {
    await loginViaStorage(page, uniqueUser("perm"));
    await page.goto("/");
    await page.getByTestId("mode-code").click();
    // new Code sessions start in the "ask before edits" mode
    await expect(page.getByTestId("mode-picker")).toHaveAttribute("aria-label", /Ask before edits/);
    await sendMessage(page, "create a file hello.txt containing hi");
    await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}/);

    const card = page.getByTestId("permission-card").first();
    await expect(card).toBeVisible({ timeout: 90_000 });
    await expect(card).toContainText(/hello\.txt/);
    await card.getByTestId("perm-allow").click();
    await expect(page.getByTestId("tool-group").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("permission-card")).toHaveCount(0);
    await openToolGroups(page);
    await expect(page.getByTestId("permission-resolved").first()).toBeVisible();
    await waitForTurnEnd(page, 90_000);

    await openPanel(page, "files");
    await expect(page.getByRole("complementary", { name: /right panel/i }).getByRole("treeitem", { name: /hello\.txt/ })).toBeVisible({ timeout: 20_000 });
  });

  test("an uploaded file is an attachment tile (no @inbox text), shows as a chip on the sent message, and Claude can read it", async ({ page }) => {
    await loginViaStorage(page, uniqueUser("upl"));
    await page.goto("/");
    await page.getByTestId("mode-code").click();
    const secret = `ZEBRA${Date.now().toString(36).toUpperCase()}`;

    // the drop handler and the paperclip share one code path; the hidden input is what a drag-drop ends up feeding
    await page.getByTestId("composer-file-input").setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from(`The secret word is ${secret}.\n`) });
    const tile = page.getByTestId("composer").getByTestId("file-card");
    await expect(tile).toContainText("note.txt", { timeout: 30_000 });
    await expect(tile).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    const input = page.getByTestId("composer-input");
    await expect(input).toHaveValue("");

    await input.fill("What is the secret word in the attached file? Answer with the word only.");
    await page.getByTestId("composer-send").click();
    // the sent bubble shows the typed text and a file chip, not the path note Claude receives
    const sent = page.getByTestId("user-message").first();
    await expect(sent.getByTestId("file-card")).toContainText("note.txt", { timeout: 30_000 });
    await expect(sent).not.toContainText("Attached files");
    await approveUntil(page, page.getByTestId("assistant-message").filter({ hasText: secret }), 120_000);
    await waitForTurnEnd(page, 90_000);

    // the file really is in inbox/
    await openPanel(page, "files");
    await expect(page.getByRole("complementary", { name: /right panel/i })).toContainText("inbox");
  });

  test("typing / opens the slash palette with /compact", async ({ page }) => {
    await loginViaStorage(page, uniqueUser("slash"));
    await page.goto("/");
    await page.getByTestId("mode-code").click();
    const input = page.getByTestId("composer-input");
    await input.click();
    await input.fill("/comp");
    const palette = page.getByRole("listbox", { name: /slash commands/i });
    await expect(palette).toBeVisible({ timeout: 20_000 });
    await expect(palette.getByRole("option", { name: /compact/ }).first()).toBeVisible();
  });
});
