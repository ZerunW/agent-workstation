import { expect, test, type Page } from "@playwright/test";
import { E2E_BASE_URL, ensureUser, hasMockHooks, loginViaStorage, seedSession, uniqueUser } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

const ASSISTANT = [
  "Euler: $e^{i\\pi}+1=0$ and \\(a_1 + b_1\\).",
  "",
  "$$",
  "\\int_0^1 x\\,dx = \\tfrac12",
  "$$",
  "",
  "\\[ \\sum_{k=1}^n k \\]",
  "",
  "It costs $5 and $10, so $ 15 $ in all.",
  "",
  "Code stays code: `$x^2$`",
  "",
  "```js",
  "const price = '$y$'; // \\(z\\)",
  "```",
].join("\n");

async function openSeeded(page: Page, prefix = "math") {
  const user = uniqueUser(prefix);
  await ensureUser(page, user);
  await loginViaStorage(page, user);
  test.skip(!(await hasMockHooks(page)), "needs the mock hub's seed hook");
  const s = await seedSession(page, { user, title: "Math chat", kind: "chat", messages: [{ role: "user", text: "What is $a+b$? And \\(c\\), plus $$d$$ and the price $5 or $6." }, { role: "assistant", text: ASSISTANT }] });
  await page.goto(`/s/${s.id}`);
  await expect(page.getByTestId("assistant-message")).toBeVisible({ timeout: 20_000 });
  return { user, id: s.id };
}

const tex = (page: Page, scope = "[data-testid=transcript]") => page.locator(`${scope} annotation[encoding="application/x-tex"]`).allTextContents();

test("renders inline and display math in assistant markdown and in user bubbles; currency and code stay text", async ({ page }) => {
  await openSeeded(page);
  expect(await tex(page, "[data-testid=assistant-message]")).toEqual(["e^{i\\pi}+1=0", "a_1 + b_1", "\\int_0^1 x\\,dx = \\tfrac12", "\\sum_{k=1}^n k"]);
  await expect(page.locator("[data-testid=assistant-message] .katex-display")).toHaveCount(2);
  expect(await tex(page, "[data-testid=user-message]")).toEqual(["a+b", "c", "d"]);
  await expect(page.locator("[data-testid=user-message] .katex-display")).toHaveCount(1);
  // currency is text
  await expect(page.getByTestId("assistant-message")).toContainText("It costs $5 and $10, so $ 15 $ in all.");
  await expect(page.getByTestId("user-message")).toContainText("the price $5 or $6.");
  // code is never math
  await expect(page.getByTestId("assistant-message")).toContainText("`$x^2$`".replace(/`/g, ""));
  await expect(page.getByTestId("assistant-message").locator("pre")).toContainText("const price = '$y$'; // \\(z\\)");
  await page.screenshot({ path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/math-light.png` : undefined });
});

test("KaTeX's fonts and stylesheet come from the bundle: every request is same-origin and the fonts load", async ({ page }) => {
  const origins = new Set<string>();
  const fonts: Array<{ url: string; status: number }> = [];
  page.on("response", (r) => {
    origins.add(new URL(r.url()).origin);
    if (/KaTeX_.*\.(woff2?|ttf)/.test(r.url())) fonts.push({ url: r.url(), status: r.status() });
  });
  await openSeeded(page, "mathfonts");
  await expect(page.locator(".katex").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => Array.from(document.fonts).some((f) => f.family.startsWith("KaTeX") && f.status === "loaded"))).toBe(true);
  expect(origins.size).toBe(1);
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every((f) => f.status === 200)).toBe(true);
});

test("copying a selection that holds rendered math puts the LaTeX source on the clipboard", async ({ page }) => {
  await openSeeded(page, "mathcopy");
  const copied = await page.evaluate(() => {
    const root = document.querySelector("[data-testid=assistant-message]")!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.selectAllChildren(root);
    const data = new DataTransfer();
    const ev = new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true });
    root.dispatchEvent(ev);
    return { text: data.getData("text/plain"), prevented: ev.defaultPrevented };
  });
  expect(copied.prevented).toBe(true);
  expect(copied.text).toContain("Euler: $e^{i\\pi}+1=0$ and $a_1 + b_1$.");
  expect(copied.text).toContain("$$\n\\int_0^1 x\\,dx = \\tfrac12\n$$");
  expect(copied.text).toContain("$$\n\\sum_{k=1}^n k\n$$");
  expect(copied.text).toContain("It costs $5 and $10");
  expect(copied.text).not.toMatch(/∫|𝑒|\u2062/); // no glyphs or invisible MathML operators

  // a selection without math is left to the browser
  const plain = await page.evaluate(() => {
    const code = document.querySelector("[data-testid=assistant-message] pre")!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.selectAllChildren(code);
    const ev = new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
    code.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(plain).toBe(false);
});

test("the Copy buttons copy the raw message, LaTeX included", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await openSeeded(page, "mathbtn");
  const assistant = page.getByTestId("assistant-message");
  await assistant.hover();
  await assistant.getByRole("button", { name: "Copy", exact: true }).click(); // not the code block's "Copy code"
  const text = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  test.skip(text === null, "clipboard read is not available in this browser context");
  expect(text).toBe(ASSISTANT);
  const user = page.getByTestId("user-message");
  await user.hover();
  await user.getByRole("button", { name: "Copy", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("What is $a+b$? And \\(c\\), plus $$d$$ and the price $5 or $6.");
});

test("works in dark mode: the formulas take the text colour", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openSeeded(page, "mathdark");
  const colors = await page.evaluate(() => {
    const k = document.querySelector("[data-testid=assistant-message] .katex")!;
    const p = k.closest("p")!;
    return { katex: getComputedStyle(k).color, text: getComputedStyle(p).color, bg: getComputedStyle(document.body).backgroundColor };
  });
  expect(colors.katex).toBe(colors.text);
  expect(colors.text).not.toBe(colors.bg);
  await page.screenshot({ path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/math-dark.png` : undefined });
});

test("works in the embed transcript too", async ({ page }) => {
  const { user, id } = await openSeeded(page, "mathembed");
  await page.goto(`/embed.html?hubUrl=${encodeURIComponent(new URL(page.url()).origin)}&user=${user}&mode=transcript&sessionId=${id}`);
  await expect(page.locator(".katex").first()).toBeVisible({ timeout: 20_000 });
  expect(await tex(page)).toContain("a_1 + b_1");
});
