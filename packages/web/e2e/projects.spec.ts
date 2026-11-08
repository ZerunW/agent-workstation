import { expect, test, type Page } from "@playwright/test";
import { E2E_BASE_URL, ensureUser, loginViaStorage, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

async function setup(page: Page): Promise<string> {
  const user = uniqueUser("pj");
  await ensureUser(page, user);
  await loginViaStorage(page, user);
  return user;
}

test("Projects page: empty or 'not available yet' states are one short title", async ({ page }) => {
  const user = await setup(page);
  const res = await page.request.get("/api/projects", { headers: { "X-Workstation-User": user } });
  const projects = res.ok() ? ((await res.json()) as unknown[]) : null;
  await page.goto("/projects");
  await expect(page.getByTestId("mac-hint")).toHaveCount(0);
  if (projects === null) await expect(page.getByText("Not available yet")).toBeVisible();
  else if (projects.length === 0) await expect(page.getByText("No projects yet")).toBeVisible();
  else await expect(page.getByTestId("projects-table")).toBeVisible();
  // the sidebar entries exist on every hub
  await page.goto("/");
  await expect(page.getByTestId("nav-projects")).toBeVisible();
  await expect(page.getByTestId("nav-customize")).toHaveCount(0); // Skills live in the gear menu
  await expect(page.getByTestId("nav-skills")).toHaveCount(0);
});

test.describe("with the mock hub's demo projects", () => {
  let user: string;
  test.beforeEach(async ({ page }) => {
    user = await setup(page);
    const res = await page.request.get("/api/projects", { headers: { "X-Workstation-User": user } });
    const list = res.ok() ? ((await res.json()) as Array<{ name: string }>) : [];
    test.skip(!list.some((p) => p.name === "demo-app"), "needs the mock hub's demo-app project");
  });

  test("table shows size, pending, undownloaded and the short commit; review and zip download work", async ({ page }) => {
    await page.goto("/projects");
    const demo = page.getByTestId("project-row").filter({ hasText: "demo-app" });
    await expect(demo.getByTestId("cell-pending")).toHaveText("3");
    await expect(demo.getByTestId("cell-undownloaded")).toHaveText("3");
    await expect(demo.locator("code")).toHaveText(/^[0-9a-f]{7}$/);

    const [download] = await Promise.all([page.waitForEvent("download"), demo.getByRole("button", { name: "Download zip" }).click()]);
    expect(download.suggestedFilename()).toBe("demo-app.zip");

    await demo.getByRole("link", { name: "Review" }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("review-row")).toHaveCount(3);
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByTestId("project-history")).toBeVisible();
  });

  test("delete is two steps: counts first, then the name and an explicit discard when something would be lost", async ({ page }) => {
    await page.goto("/projects");
    const demo = page.getByTestId("project-row").filter({ hasText: "demo-app" });
    await demo.getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("count-pending")).toHaveText("3");
    await expect(dialog.getByTestId("count-undownloaded")).toHaveText("3");
    // step 1 offers no plain "continue" while something exists only on the server
    await expect(dialog.getByTestId("delete-continue")).toHaveCount(0);
    await dialog.getByTestId("delete-discard-anyway").click();

    const confirm = dialog.getByTestId("delete-confirm");
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Project name").fill("demo-app");
    await expect(confirm).toBeDisabled(); // still needs the discard checkbox
    await dialog.getByRole("checkbox").check();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByTestId("project-row").filter({ hasText: "demo-app" })).toHaveCount(0);
    await expect(page.getByTestId("project-row").filter({ hasText: "notes" })).toHaveCount(1);
  });

  test("a clean project deletes with just its name", async ({ page }) => {
    await page.goto("/projects");
    const notes = page.getByTestId("project-row").filter({ hasText: "notes" });
    await notes.getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("count-pending")).toHaveText("0");
    await dialog.getByTestId("delete-continue").click();
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await dialog.getByLabel("Project name").fill("notes");
    await dialog.getByTestId("delete-confirm").click();
    await expect(notes).toHaveCount(0);
  });
});
