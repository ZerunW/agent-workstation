import "./testMatchers";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ usageMe: vi.fn(), models: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: mocks, getApiUser: () => null, setApiUser: () => {} }));

import { useApp } from "../../store/app";
import { MyTokens } from "./MyTokens";

const row = (model: string, bucket: string, inputTokens: number, outputTokens: number, costUsd: number) => ({ bucket, model, inputTokens, outputTokens, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd, turns: 1 });
const CATALOG = [
  { value: "claude-opus-5-5", displayName: "Opus 5.5", family: "opus", legacy: false },
  { value: "claude-haiku-5-5", displayName: "Haiku 5.5", family: "haiku", legacy: false },
  { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5", family: "sonnet", legacy: false },
];
const BUCKETS = [
  row("claude-opus-5-5", "2026-10-30", 4000, 1000, 1.5),
  row("claude-haiku-5-5-20251001", "2026-10-30", 400, 100, 0.05),
  row("claude-sonnet-5-5-20251001", "2026-10-30", 3000, 500, 0.02),
  row("claude-sonnet-5-5[1m]", "2026-10-31", 2000, 300, 0.01),
  row("claude-sonnet-5-5", "2026-10-31", 100, 20, 0.001),
];

const open = async () => {
  render(<MyTokens />);
  return screen.findAllByTestId("model-row");
};
const cells = (r: HTMLElement) => Array.from(r.querySelectorAll("td")).map((td) => td.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.usageMe.mockResolvedValue({ range: "7d", buckets: BUCKETS, weeklyTokens: 0, weeklyLimit: null });
  mocks.models.mockResolvedValue(CATALOG);
  useApp.setState({ models: CATALOG as never, modelsLoaded: true });
});

describe("MyTokens — By model", () => {
  it("shows display names, not ids, and folds dated and [1m] variants into one Sonnet 5.5 row", async () => {
    const rows = await open();
    // sorted by tokens: Sonnet 5.1k + 0.8k, Opus 5k, Haiku 0.5k
    expect(rows.map((r) => cells(r)[0])).toEqual(["Sonnet 5.5", "Opus 5.5", "Haiku 5.5"]);
    expect(cells(rows[0]!).slice(0, 3)).toEqual(["Sonnet 5.5", "5.1k", "820"]); // 3000 + 2000 + 100 in, 500 + 300 + 20 out
    expect(document.body.textContent).not.toMatch(/claude-opus|claude-sonnet|20251001/);
  });

  it("the cost column shows the (estimated) dollar figure for every row: no 'Included'", async () => {
    const rows = await open();
    const cost = (i: number) => within(rows[i]!).getByTestId("model-cost").textContent;
    expect(cost(0)).toBe("$0.031"); // Sonnet: 0.02 + 0.01 + 0.001, summed across the folded rows
    expect(cost(1)).toBe("$1.50");
    expect(cost(2)).toBe("$0.050");
    expect(screen.queryByText("Included")).not.toBeInTheDocument();
    expect(screen.getAllByText("Cost (estimated)").length).toBeGreaterThan(0);
  });

  it("the chart legend uses the same names", async () => {
    await open();
    const legend = screen.getAllByRole("listitem").filter((li) => li.closest("ul"))
      .map((li) => li.textContent);
    expect(legend).toEqual(expect.arrayContaining(["Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]));
    expect(legend.filter((l) => l === "Sonnet 5.5")).toHaveLength(1);
    expect(legend.some((l) => /claude-sonnet/.test(l ?? ""))).toBe(false);
  });

  it("the stacked chart's tooltips carry the names too", async () => {
    await open();
    const titles = screen.getAllByRole("listitem").map((el) => el.getAttribute("title") ?? "").join("\n");
    expect(titles).toContain("Sonnet 5.5:");
    expect(titles).toContain("Opus 5.5:");
  });

  it("derives a name from the id when the catalog does not know the model (old data, retired versions)", async () => {
    mocks.usageMe.mockResolvedValue({ range: "7d", buckets: [row("claude-opus-4-8-20251101", "2026-10-30", 10, 5, 0.1), row("claude-sonnet-4-1", "2026-10-30", 10, 5, 0)], weeklyTokens: 0, weeklyLimit: null });
    const rows = await open();
    expect(rows.map((r) => cells(r)[0]).sort()).toEqual(["Opus 4.8", "Sonnet 4.1"]);
  });

  it("without the shell's catalog (a bare usage window) it fetches the catalog once and uses its names", async () => {
    useApp.setState({ models: [], modelsLoaded: false });
    mocks.models.mockResolvedValue(CATALOG.map((m) => (m.value === "claude-opus-5-5" ? { ...m, displayName: "Opus 5.5 (catalog)" } : m)));
    await open();
    await waitFor(() => expect(mocks.models).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByTestId("model-row").map((r) => cells(r)[0])).toContain("Opus 5.5 (catalog)"));
  });

  it("does not fetch the catalog when the shell already has it", async () => {
    await open();
    expect(mocks.models).not.toHaveBeenCalled();
  });

  it("a failing catalog fetch leaves readable derived names", async () => {
    useApp.setState({ models: [], modelsLoaded: false });
    mocks.models.mockRejectedValue(new Error("nope"));
    const rows = await open();
    expect(rows.map((r) => cells(r)[0])).toContain("Sonnet 5.5");
    expect(rows.map((r) => cells(r)[0])).toContain("Opus 5.5");
  });
});
