import "./testMatchers";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageLimits } from "@agent-workstation/protocol";

const mocks = vi.hoisted(() => ({
  usageLimits: vi.fn(),
  usageMe: vi.fn(),
}));

vi.mock("../../lib/api", () => ({ api: mocks, getApiUser: () => null, setApiUser: () => {} }));

import { useApp } from "../../store/app";
import { UsageView } from "./UsageView";

const future = (ms: number) => new Date(Date.now() + ms).toISOString();

const apiBlock = (over: Partial<NonNullable<UsageLimits["api"]>> = {}): NonNullable<UsageLimits["api"]> => ({
  spentUsd: 12,
  limitUsd: 100,
  percent: 12,
  periodStart: "2026-01-01T00:00:00.000Z",
  resetsAt: future(12 * 86400_000 + 3 * 3600_000),
  severity: "normal",
  ...over,
});
const limits = (api: UsageLimits["api"] = apiBlock()): UsageLimits => ({ api });

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ limits: null });
  mocks.usageMe.mockResolvedValue({ range: "7d", buckets: [], weeklyTokens: 0, weeklyLimit: null });
});

describe("UsageView", () => {
  it("shows the API credits as one full-width card: This period, $12.00 / $100.00, a percent bar and one meta line", async () => {
    mocks.usageLimits.mockResolvedValue(limits());
    render(<UsageView />);
    const group = await screen.findByTestId("api-usage");
    expect(within(group).getByRole("heading", { name: "API credits" })).toBeInTheDocument();
    const bars = within(group).getAllByTestId("limit-bar");
    expect(bars).toHaveLength(1);
    const card = bars[0]!;
    expect(card).toHaveTextContent("This period");
    expect(within(card).getByTestId("limit-percent")).toHaveTextContent("$12.00 / $100.00");
    const bar = within(card).getByRole("progressbar", { name: "This period" });
    expect(bar).toHaveAttribute("aria-valuenow", "12");
    expect(bar).toHaveAttribute("aria-valuetext", "12% used");
    // countdown · month day, time, no seconds
    const meta = within(card).getByTestId("limit-countdown").parentElement!;
    expect(meta).toHaveTextContent(/^Resets in 12d 3h · [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/);
  });

  it("has no plan-limit, Gemini or history sections and no subscription wording", async () => {
    mocks.usageLimits.mockResolvedValue(limits());
    render(<UsageView />);
    await screen.findByTestId("api-usage");
    expect(screen.getAllByTestId("limit-bar")).toHaveLength(1);
    expect(screen.queryByTestId("gemini-usage")).not.toBeInTheDocument();
    expect(screen.queryByText(/Plan limits|5-hour|Gemini|subscription/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["API credits"]);
  });

  it("the card follows the hub's severity", async () => {
    mocks.usageLimits.mockResolvedValue(limits(apiBlock({ spentUsd: 194, percent: 97, severity: "critical" })));
    render(<UsageView />);
    const card = within(await screen.findByTestId("api-usage")).getByTestId("limit-bar");
    expect(card).toHaveAttribute("data-severity", "critical");
    expect(card).toHaveTextContent("Critical");
  });

  it("a budget at 80% or more reads as a warning even when the hub says normal", async () => {
    mocks.usageLimits.mockResolvedValue(limits(apiBlock({ spentUsd: 85, percent: 85, severity: "normal" })));
    render(<UsageView />);
    expect(await within(await screen.findByTestId("api-usage")).findByTestId("limit-bar")).toHaveAttribute("data-severity", "warning");
  });

  it("says so in one line when no API credits are configured (api null)", async () => {
    mocks.usageLimits.mockResolvedValue(limits(null));
    render(<UsageView />);
    expect(await screen.findByTestId("api-none")).toHaveTextContent("No API credits are configured.");
    expect(screen.queryByTestId("limit-bar")).not.toBeInTheDocument();
  });

  it("a limit of 0 (no percentage) shows n/a with an empty bar", async () => {
    mocks.usageLimits.mockResolvedValue(limits(apiBlock({ limitUsd: 0, spentUsd: 3, percent: null, severity: "unknown" })));
    render(<UsageView />);
    const card = within(await screen.findByTestId("api-usage")).getByTestId("limit-bar");
    expect(within(card).getByTestId("limit-percent")).toHaveTextContent("$3.00 / $0.00");
    expect(within(card).getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });

  it("follows a live websocket snapshot", async () => {
    mocks.usageLimits.mockResolvedValue(limits());
    render(<UsageView />);
    await screen.findByRole("progressbar", { name: "This period" });
    useApp.getState().setLimits(limits(apiBlock({ spentUsd: 100, percent: 50 })));
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "This period" })).toHaveAttribute("aria-valuenow", "50"));
  });

  it("shows an error with retry when the hub fails", async () => {
    mocks.usageLimits.mockRejectedValueOnce(new Error("boom"));
    render(<UsageView />);
    expect(await screen.findByText(/Couldn't load usage: boom/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
  });

  it("shows token totals and the weekly limit progress in My tokens", async () => {
    mocks.usageLimits.mockResolvedValue(limits());
    mocks.usageMe.mockResolvedValue({
      range: "7d",
      weeklyTokens: 900_000,
      weeklyLimit: 1_000_000,
      buckets: [{ bucket: "2026-10-30", model: "opus", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0.5, turns: 2 }],
    });
    render(<UsageView />);
    const weeklyTokens = await screen.findByRole("progressbar", { name: "Weekly tokens" });
    expect(weeklyTokens).toHaveAttribute("aria-valuenow", "90");
    expect(screen.getByText(/You're at 90% of your weekly token limit/)).toBeInTheDocument();
    expect((await screen.findAllByText("Cost (estimated)")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Opus").length).toBeGreaterThan(0); // the alias gets a readable name
  });
});
