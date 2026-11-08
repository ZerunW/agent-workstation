import { expect, test } from "@playwright/test";
import { E2E_BASE_URL, loginViaStorage, sendMessage, uniqueUser, waitForTurnEnd } from "./helpers";

test.skip(!E2E_BASE_URL, "set E2E_BASE_URL to run the e2e specs against a live hub");

test("two browser contexts on one session see the same stream", async ({ browser }) => {
  const user = uniqueUser("two");
  const a = await browser.newContext({ baseURL: E2E_BASE_URL, viewport: { width: 1360, height: 860 } });
  const b = await browser.newContext({ baseURL: E2E_BASE_URL, viewport: { width: 1360, height: 860 } });
  try {
    const pa = await a.newPage();
    const pb = await b.newPage();
    await loginViaStorage(pa, user);
    await loginViaStorage(pb, user);

    await pa.goto("/");
    await pa.getByTestId("mode-chat").click();
    await sendMessage(pa, "Reply with exactly PONG");
    await expect(pa).toHaveURL(/\/s\/[0-9a-f-]{36}/);
    await waitForTurnEnd(pa, 60_000);

    // the second context opens the same session: history is replayed
    await pb.goto(new URL(pa.url()).pathname);
    await expect(pb.getByTestId("user-message").first()).toContainText("Reply with exactly PONG", { timeout: 20_000 });
    await expect(pb.getByTestId("assistant-message").first()).toContainText("PONG");

    // …and live events reach it without a reload: a second turn typed in context A streams into B
    await sendMessage(pa, "Reply with exactly PING");
    await expect(pb.getByTestId("user-message").nth(1)).toContainText("PING", { timeout: 20_000 });
    await expect(pb.getByTestId("assistant-message").nth(1)).toContainText("PING", { timeout: 60_000 });
    await waitForTurnEnd(pb, 60_000);
    await waitForTurnEnd(pa, 60_000);
    // one assistant message per turn, the same in both contexts
    await expect(pb.getByTestId("assistant-message")).toHaveCount(2);
    await expect(pa.getByTestId("assistant-message")).toHaveCount(2);
  } finally {
    await a.close();
    await b.close();
  }
});
