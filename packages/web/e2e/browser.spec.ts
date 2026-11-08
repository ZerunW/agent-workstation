import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, hubHasRoute, loginViaStorage, openPanel, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

test.describe("browser panel", () => {
  test("starts the server browser, shows frames, navigates and stops sending frames when hidden", async ({ page }) => {
    const user = uniqueUser("brw");
    await loginViaStorage(page, user);
    const state = () => page.request.get("/api/browser", { headers: { "x-workstation-user": user } });
    test.skip(!(await hubHasRoute(page, user, "/api/browser")), "this hub has no /api/browser yet");

    await page.goto("/");
    await page.getByTestId("mode-code").click();
    await openPanel(page, "browser");
    await expect(page.getByText("Not running")).toBeVisible();
    await page.getByRole("button", { name: "Start" }).click();

    const canvas = page.getByTestId("browser-canvas");
    await expect(canvas).toBeVisible();
    await expect.poll(async () => Number((await canvas.getAttribute("data-frames")) ?? 0), { message: "a frame was drawn" }).toBeGreaterThan(0);
    // the frame is a real picture, not an empty canvas
    const painted = await canvas.evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      const first = [d[0], d[1], d[2]].join();
      for (let i = 0; i < d.length; i += 4) if ([d[i], d[i + 1], d[i + 2]].join() !== first) return true;
      return false;
    });
    expect(painted).toBe(true);

    const address = page.getByLabel("Address");
    await expect(address).toHaveValue("https://example.com/");
    await expect(page.getByTestId("browser-control")).toHaveText("Agent");

    await address.fill("openai.com/docs");
    await address.press("Enter");
    await expect(address).toHaveValue("https://openai.com/docs");
    await expect(page.getByTestId("browser-control")).toHaveText("You");
    await page.getByLabel("Back").click();
    await expect(address).toHaveValue("https://example.com/");
    await page.getByLabel("Forward").click();
    await expect(address).toHaveValue("https://openai.com/docs");

    // the view counts as a viewer while it shows, and not once another tab is on top
    await expect.poll(async () => (await (await state()).json()).viewers).toBe(1);
    await openPanel(page, "files");
    await expect.poll(async () => (await (await state()).json()).viewers).toBe(0);
    await openPanel(page, "browser");
    await expect.poll(async () => (await (await state()).json()).viewers).toBe(1);

    // clicking the view focuses it for keys
    await canvas.click({ position: { x: 40, y: 40 } });
    await expect(page.getByTestId("browser-view")).toHaveAttribute("data-capturing", "true");

    await page.getByLabel("Stop").click();
    await expect(page.getByText("Not running")).toBeVisible();
  });
});
