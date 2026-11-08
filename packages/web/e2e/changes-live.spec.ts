import { expect, test, type Page } from "@playwright/test";
import { E2E_BASE_URL, ensureUser, loginViaStorage, openPanel, sendMessage, uniqueUser, waitForTurnEnd } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

// Real review pipeline: a project created over REST (the macOS app does the same), a Code session inside it, and a real
// Claude turn that creates a file. Needs a hub with the project routes; the mock hub has no POST /api/projects and skips.
async function createProject(page: Page, user: string, name: string): Promise<{ id: string } | null> {
  const res = await page.request.post("/api/projects", { headers: { "X-Workstation-User": user }, data: { name } });
  return res.status() === 201 ? ((await res.json()) as { id: string }) : null;
}

test("a Claude edit in a project shows up in Changes, is accepted per file and lands in History", async ({ page }) => {
  const user = uniqueUser("live");
  await ensureUser(page, user);
  const project = await createProject(page, user, "live-proj");
  test.skip(!project, "this hub cannot create projects over REST");
  try {
    await loginViaStorage(page, user);
    const res = await page.request.post("/api/sessions", { headers: { "X-Workstation-User": user }, data: { kind: "code", cwd: "projects/live-proj", title: "Live review" } });
    const session = (await res.json()) as { id: string; projectId?: string | null };
    // the hub tells which project a session belongs to (older hubs: the UI derives it from the cwd)
    if ("projectId" in session) expect(session.projectId).toBe(project!.id);

    await page.goto(`/s/${session.id}`);
    // the sidebar groups the session under its project
    await expect(page.getByTestId("session-group").filter({ has: page.getByRole("heading", { name: "live-proj" }) })).toContainText("Live review");

    await sendMessage(page, "create a file notes.txt containing hello");
    await waitForTurnEnd(page, 120_000, { approve: true });

    await openPanel(page, "changes");
    const row = page.getByTestId("review-row").filter({ hasText: "notes.txt" });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByTestId("status-badge")).toHaveText("A");
    await expect(row.getByTestId("touched-by")).toHaveText("this session");

    // diff → file-level accept → the file leaves the review
    await page.getByRole("button", { name: "Review notes.txt" }).click();
    await expect(page.getByTestId("diff-viewer")).toContainText("hello");
    await page.getByRole("button", { name: /accept file/i }).click();
    await expect(page.getByTestId("project-review")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("review-row").filter({ hasText: "notes.txt" })).toHaveCount(0);

    // the history has the turn snapshot and the accept
    await openPanel(page, "history");
    const history = page.getByTestId("project-history");
    await expect(history.getByTestId("history-group-accept")).toBeVisible({ timeout: 20_000 });
    await expect(history.getByTestId("history-group-snapshot")).toBeVisible();

    // the Projects page lists it with nothing pending and offers the zip
    await page.goto("/projects");
    const rowP = page.getByTestId("project-row").filter({ hasText: "live-proj" });
    await expect(rowP.getByTestId("cell-pending")).toHaveText("0");
    const [download] = await Promise.all([page.waitForEvent("download"), rowP.getByRole("button", { name: "Download zip" }).click()]);
    expect(download.suggestedFilename()).toMatch(/live-proj.*\.zip$/);

    // clean project: delete needs only its name
    await rowP.getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("count-pending")).toHaveText("0");
    await dialog.getByTestId("delete-continue").click();
    await dialog.getByLabel("Project name").fill("live-proj");
    await dialog.getByTestId("delete-confirm").click();
    await expect(rowP).toHaveCount(0);
  } finally {
    // best effort: leave nothing behind for this throwaway user
    await page.request.delete(`/api/projects/${project!.id}`, { headers: { "X-Workstation-User": user }, data: { discardRemaining: true } }).catch(() => {});
  }
});
