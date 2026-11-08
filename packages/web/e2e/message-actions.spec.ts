import { expect, test, type Page } from "@playwright/test";
import { E2E_BASE_URL, ensureUser, hasMockHooks, loginViaStorage, seedSession, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

async function openSeeded(page: Page, kind: "code" | "chat", prefix: string) {
  const user = uniqueUser(prefix);
  await ensureUser(page, user);
  await loginViaStorage(page, user);
  test.skip(!(await hasMockHooks(page)), "needs the mock hub's seed hook");
  const s = await seedSession(page, {
    user,
    title: "Actions",
    kind,
    messages: [
      { role: "user", text: "first question about needles" },
      { role: "assistant", text: "First answer mentions a needle." },
      { role: "user", text: "second question" },
      { role: "assistant", text: "Second answer, no match here." },
    ],
  });
  await page.goto(`/s/${s.id}`);
  await expect(page.getByTestId("assistant-message")).toHaveCount(2);
  return s;
}

test("Code: one Copy button per message, in the action row under it", async ({ page }) => {
  await openSeeded(page, "code", "actcopy");
  const msg = page.getByTestId("assistant-message").first();
  await msg.hover();
  await expect(msg.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  await expect(msg.getByRole("button", { name: "Fork", exact: true })).toBeVisible();
  await expect(msg.getByRole("button", { name: "Pin", exact: true })).toBeVisible();
  const user = page.getByTestId("user-message").first();
  await user.hover();
  for (const name of ["Copy", "Rewind", "Fork"]) await expect(user.getByRole("button", { name, exact: true })).toBeVisible();
});

test("Code: Rewind asks first, drops the message and puts its text into the composer", async ({ page }) => {
  await openSeeded(page, "code", "actrewind");
  const second = page.getByTestId("user-message").nth(1);
  await second.hover();
  await second.getByRole("button", { name: "Rewind", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Rewind to before this message?" })).toBeVisible();
  await dialog.getByRole("button", { name: "Rewind", exact: true }).click();
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  await expect(page.getByTestId("composer-input")).toHaveValue("second question");
});

test("Code: Pin shows a mark and a Pinned card in Overview; Unpin removes both", async ({ page }) => {
  await openSeeded(page, "code", "actpin");
  const msg = page.getByTestId("assistant-message").first();
  await msg.hover();
  await msg.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(msg.getByTestId("pin-mark")).toBeVisible();
  const btn = page.getByTestId("panel-overview");
  if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
  const card = page.getByTestId("overview-pinned");
  await expect(card).toContainText("First answer mentions a needle.");
  await msg.hover();
  await msg.getByRole("button", { name: "Unpin", exact: true }).click();
  await expect(page.getByTestId("overview-pinned")).toHaveCount(0);
});

test("Code: Fork opens the new session with the message text as its draft", async ({ page }) => {
  const s = await openSeeded(page, "code", "actfork");
  const second = page.getByTestId("user-message").nth(1);
  await second.hover();
  await second.getByRole("button", { name: "Fork", exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(`/s/${s.id}$`));
  await expect(page.getByTestId("composer-input")).toHaveValue("second question");
  await expect(page.getByTestId("user-message")).toHaveCount(1);
});

test("Chat: Edit turns the bubble into an editor and resends the new text", async ({ page }) => {
  await openSeeded(page, "chat", "actedit");
  const first = page.getByTestId("user-message").first();
  await first.hover();
  await first.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByTestId("user-editor");
  await editor.getByRole("textbox").fill("an edited question");
  await editor.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("user-message").first()).toContainText("an edited question");
  await expect(page.getByTestId("user-message")).toHaveCount(1);
});

test("⌘F / Ctrl+F: find bar in a session (count, next, Esc), the search dialog outside one", async ({ page }) => {
  await openSeeded(page, "code", "actfind");
  await page.keyboard.press("Control+f");
  const input = page.getByTestId("find-input");
  await expect(input).toBeFocused();
  await input.fill("answer");
  await expect(page.getByTestId("find-count")).toHaveText("1/2");
  await input.press("Enter");
  await expect(page.getByTestId("find-count")).toHaveText("2/2");
  await input.press("Shift+Enter");
  await expect(page.getByTestId("find-count")).toHaveText("1/2");
  await input.press("Escape");
  await expect(page.getByTestId("find-bar")).toHaveCount(0);
  await expect(page.getByTestId("search-dialog")).toHaveCount(0);

  await page.goto("/usage");
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("search-dialog")).toBeVisible();
});
