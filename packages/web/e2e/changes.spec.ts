import { expect, test, type Page } from "@playwright/test";
import { E2E_BASE_URL, ensureUser, loginViaStorage, openPanel, uniqueUser, waitForTurnEnd } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

interface SessionRow {
  id: string;
  projectId?: string | null;
}

async function createCodeSession(page: Page, user: string, cwd: string, title: string): Promise<SessionRow> {
  const res = await page.request.post("/api/sessions", { headers: { "X-Workstation-User": user }, data: { kind: "code", cwd, title } });
  expect(res.status()).toBe(201);
  return (await res.json()) as SessionRow;
}

async function projectsOf(page: Page, user: string): Promise<Array<{ id: string; name: string; pendingFiles: number }>> {
  const res = await page.request.get("/api/projects", { headers: { "X-Workstation-User": user } });
  return res.ok() ? ((await res.json()) as Array<{ id: string; name: string; pendingFiles: number }>) : [];
}

test.describe("Changes tab without a project", () => {
  test("a Code session outside every project names the missing linked project", async ({ page }) => {
    const user = uniqueUser("noproj");
    await loginViaStorage(page, user);
    const s = await createCodeSession(page, user, "", "Plain session");
    await page.goto(`/s/${s.id}`);
    await openPanel(page, "changes");
    const panel = page.getByTestId("changes-panel");
    await expect(panel).toContainText("No linked project");
    await expect(panel).not.toContainText("macOS app");
    // nothing changed yet: the download is offered but disabled
    await expect(panel.getByTestId("download-session-files")).toBeDisabled();
    await expect(panel.getByRole("link", { name: "Open Projects" })).toHaveAttribute("href", "/projects");
    // History shows the same title
    await openPanel(page, "history");
    await expect(page.getByTestId("history-panel")).toContainText("No linked project");
  });
});

// The fixtures below (demo-app with pending changes, history) come from the mock hub: every new user gets them.
test.describe("Changes and History for a synced project", () => {
  let user: string;
  let projectId: string;
  let sessionId: string;

  test.beforeEach(async ({ page }) => {
    user = uniqueUser("proj");
    await ensureUser(page, user);
    const demo = (await projectsOf(page, user)).find((p) => p.name === "demo-app" && p.pendingFiles > 0);
    test.skip(!demo, "this hub has no demo-app project with pending changes (run against `npm run mock`)");
    projectId = demo!.id;
    await loginViaStorage(page, user);
    sessionId = (await createCodeSession(page, user, "projects/demo-app", "Demo session")).id;
    await page.goto(`/s/${sessionId}`);
  });

  test("lists the review files with status, counts and size, and refreshes on review_changed", async ({ page }) => {
    await openPanel(page, "changes");
    const rows = page.getByTestId("review-row");
    await expect(rows).toHaveCount(3);
    const app = rows.filter({ hasText: "src/app.ts" });
    await expect(app.getByTestId("status-badge")).toHaveText("M");
    await expect(rows.filter({ hasText: "new-file.ts" }).getByTestId("status-badge")).toHaveText("A");
    await expect(app).toContainText("+7");
    await expect(rows.filter({ hasText: "logo.bin" })).toContainText("binary");

    // an accept elsewhere (another tab, the Mac app) pushes review_changed: the list follows without a click
    const diff = await (await page.request.get(`/api/projects/${projectId}/review/diff`, { headers: { "X-Workstation-User": user }, params: { path: "src/new-file.ts" } })).json();
    expect(diff.diffId).toBeTruthy();
    const res = await page.request.post(`/api/projects/${projectId}/review/accept`, { headers: { "X-Workstation-User": user }, data: { path: "src/new-file.ts" } });
    expect(res.ok()).toBeTruthy();
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId("pending-count")).toContainText("2 to review");
  });

  test("an edit made by this session is labelled and the 'This session' filter keeps only it", async ({ page }) => {
    await page.getByTestId("composer-input").fill("please edit util");
    await page.getByTestId("composer-send").click();
    await page.getByTestId("perm-allow").click({ timeout: 30_000 });
    await waitForTurnEnd(page, 30_000);
    await openPanel(page, "changes");
    const rows = page.getByTestId("review-row");
    await expect(rows).toHaveCount(4); // the three fixture files plus the one this session just edited
    await expect(rows.filter({ hasText: "src/util.ts" }).getByTestId("touched-by")).toHaveText("this session");
    await expect(rows.filter({ hasText: "src/app.ts" }).getByTestId("touched-by")).toHaveText("other");
    await page.getByTestId("filter-session").click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("src/util.ts");
  });

  test("per-hunk accept sends the diffId; a stale diff reloads with a notice", async ({ page }) => {
    await openPanel(page, "changes");
    await page.getByRole("button", { name: "Review src/app.ts" }).click();
    const viewer = page.getByTestId("diff-viewer");
    await expect(viewer).toBeVisible();
    await expect(page.getByTestId("diff-header")).toContainText("3 changes");
    await expect(viewer.locator("button[name=accept]")).toHaveCount(3);

    // accept the first hunk through the UI
    const posts: Array<Record<string, unknown>> = [];
    page.on("request", (r) => r.method() === "POST" && r.url().includes("/review/accept") && posts.push(r.postDataJSON()));
    await viewer.locator("button[name=accept]").first().click();
    await expect(page.getByTestId("diff-header")).toContainText("2 changes");
    expect(posts[0]).toMatchObject({ path: "src/app.ts", hunks: [0] });
    expect(typeof posts[0]!.diffId).toBe("string");

    // somebody else accepts another hunk of the same file behind our back: our diff is now stale
    const fresh = await (await page.request.get(`/api/projects/${projectId}/review/diff`, { headers: { "X-Workstation-User": user }, params: { path: "src/app.ts" } })).json();
    const other = await page.request.post(`/api/projects/${projectId}/review/accept`, { headers: { "X-Workstation-User": user }, data: { path: "src/app.ts", hunks: [0], diffId: fresh.diffId } });
    expect(other.ok()).toBeTruthy();
    await viewer.locator("button[name=accept]").first().click(); // refers to the old numbering
    await expect(page.getByText(/changed on the server since you opened the diff/)).toBeVisible();
    await expect(page.getByTestId("diff-header")).toContainText("1 change");
  });

  test("a sync_conflict event shows an inline alert on the file", async ({ page }) => {
    await openPanel(page, "changes");
    await expect(page.getByTestId("review-row")).toHaveCount(3);
    const res = await page.request.post("/__mock/emit", { data: { user, event: { type: "sync_conflict", projectId, path: "src/app.ts", reason: "edited on both sides" } } });
    expect(res.status()).toBe(204);
    const alert = page.getByTestId("review-row").filter({ hasText: "src/app.ts" }).getByTestId("row-conflict");
    await expect(alert).toContainText("edited on both sides");
    await page.getByRole("button", { name: "Review src/app.ts" }).click();
    await expect(page.getByTestId("review-detail").getByRole("alert")).toContainText("edited on both sides");
  });

  test("Accept all clears the list", async ({ page }) => {
    await openPanel(page, "changes");
    await expect(page.getByTestId("review-row")).toHaveCount(3);
    await page.getByTestId("accept-all").click();
    await expect(page.getByText("Nothing to review")).toBeVisible();
    await expect(page.getByTestId("review-row")).toHaveCount(0);
  });

  test("History groups entries by kind and Restore all writes a trash entry after a confirmation", async ({ page }) => {
    await openPanel(page, "history");
    const history = page.getByTestId("project-history");
    for (const kind of ["sync", "snapshot", "accept", "trash"]) await expect(history.getByTestId(`history-group-${kind}`)).toBeVisible();
    const trash = history.getByTestId("history-group-trash").getByTestId("history-row");
    const before = await trash.count();

    await history.getByTestId("history-group-snapshot").getByTestId("history-row").first().getByRole("button", { name: "Restore all" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("saved to a trash snapshot in History first");
    await dialog.getByTestId("restore-confirm").click();
    await expect(trash).toHaveCount(before + 1);

    await history.getByTestId("history-group-sync").getByTestId("history-row").first().getByRole("button", { name: "Restore file…" }).click();
    await page.getByLabel(/Path of the file inside/).fill("src/app.ts");
    await expect(page.getByRole("dialog")).toContainText("overwrites src/app.ts on the server");
    await page.getByTestId("restore-confirm").click();
    await expect(trash).toHaveCount(before + 2);
  });

  test("the sidebar groups Code sessions by project and puts the rest under Workspace", async ({ page }) => {
    await createCodeSession(page, user, "", "Loose session");
    await page.reload();
    const groups = page.getByTestId("session-group");
    await expect(groups.filter({ has: page.getByRole("heading", { name: "demo-app" }) })).toContainText("Demo session");
    const workspace = groups.filter({ has: page.getByRole("heading", { name: "Workspace" }) });
    await expect(workspace).toContainText("Loose session");
    await expect(workspace).not.toContainText("Demo session");
    // pending count badge next to the project name opens the project's review page
    await page.getByTestId("group-pending").click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}`));
    await expect(page.getByTestId("project-review")).toBeVisible();
  });
});
