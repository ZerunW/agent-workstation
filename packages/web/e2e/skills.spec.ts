import { expect, test, type Page } from "@playwright/test";
import { E2E_BASE_URL, ensureUser, hubHasRoute, loginViaStorage, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

async function setup(page: Page, name = uniqueUser("sk")): Promise<string> {
  await ensureUser(page, name);
  await loginViaStorage(page, name);
  return name;
}

test("Skills page degrades to 'Not available yet' on a hub without skill routes", async ({ page }) => {
  const user = await setup(page);
  test.skip(await hubHasRoute(page, user, "/api/skills"), "this hub serves skills");
  await page.goto("/skills");
  await expect(page.getByText("Not available yet")).toBeVisible();
  await expect(page.getByTestId("skills-new-user")).toHaveCount(0);
});

test.describe("with a hub that serves skills", () => {
  let user: string;
  test.beforeEach(async ({ page }) => {
    user = await setup(page);
    test.skip(!(await hubHasRoute(page, user, "/api/skills")), "this hub has no /api/skills yet");
  });

  test("create, edit with the markdown editor, see it in the / palette, delete", async ({ page }) => {
    const name = `e2e-${Date.now().toString(36)}`;
    await page.goto("/skills");
    await expect(page.getByTestId("skills-palette-note")).toHaveCount(0);

    // name validation first
    await page.getByTestId("skills-new-user").click();
    await page.getByLabel("Name").fill("Not Valid!");
    await expect(page.getByTestId("skills-create")).toBeDisabled();
    await page.getByLabel("Name").fill(name);
    await page.getByTestId("skills-create").click();

    // the editor opens with the frontmatter template
    const editor = page.getByTestId("skill-editor-content");
    await expect(editor).toContainText(`name: ${name}`);
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("\nSay hello in French.");
    await expect(page.getByTestId("skill-dirty")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.getByTestId("skill-dirty")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("skill-editor-content")).toContainText("Say hello in French.");

    // it is listed and shows up in the slash palette of a session
    await page.goto("/skills");
    await expect(page.getByTestId("skills-user").getByTestId("skill-row").filter({ hasText: `/${name}` })).toBeVisible();
    await page.goto("/");
    await page.getByTestId("mode-code").click();
    await page.getByTestId("composer-input").fill(`/${name.slice(0, 8)}`);
    await expect(page.getByRole("listbox", { name: /slash commands/i }).getByRole("option", { name: new RegExp(name) })).toBeVisible({ timeout: 20_000 });

    // delete with a confirmation
    await page.goto("/skills");
    await page.getByRole("button", { name: `Delete ${name}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByTestId("skills-user").getByTestId("skill-row").filter({ hasText: `/${name}` })).toHaveCount(0);
  });

  test("a .md upload becomes a skill named after its frontmatter", async ({ page }) => {
    const name = `up-${Date.now().toString(36)}`;
    await page.goto("/skills");
    await page.getByTestId("skills-upload-input").setInputFiles({ name: "anything.md", mimeType: "text/markdown", buffer: Buffer.from(`---\nname: ${name}\ndescription: uploaded by e2e\n---\n\nbody\n`) });
    await expect(page.getByTestId("skills-user").getByTestId("skill-row").filter({ hasText: `/${name}` })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("uploaded by e2e")).toBeVisible();
  });

  test("global skills are read-only for regular users, editable for admins", async ({ page }) => {
    await page.goto("/skills");
    const global = page.getByTestId("skills-global");
    if (await global.count()) {
      await expect(global.getByTestId("skills-new-global")).toHaveCount(0);
      await expect(global.getByRole("button", { name: /^Delete/ })).toHaveCount(0);
    }
    const admin = await setup(page, "admin");
    expect(admin).toBe("admin");
    await page.goto("/skills");
    await expect(page.getByTestId("skills-new-global")).toBeVisible();
  });
});
