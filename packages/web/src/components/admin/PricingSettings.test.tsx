import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ adminPricing: vi.fn(), refreshAdminPricing: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: mocks, getApiUser: () => null, setApiUser: () => {} }));

import { useToasts } from "../../store/toasts";
import { PricingSettings } from "./PricingSettings";

const period = (model: string, input: number, output: number, cacheRead: number, from: string | null = null, source = "builtin") => ({ model, from, inputPerMtok: input, outputPerMtok: output, cacheReadFactor: cacheRead / input, cacheReadPerMtok: cacheRead, source });
const check = (over = {}) => ({ id: 1, at: "2026-10-30T12:00:00Z", trigger: "schedule", outcome: "unchanged", model: "claude-opus-5-5", inputPerMtok: 5, outputPerMtok: 25, cacheReadPerMtok: 0.5, effectiveFrom: null, previousInputPerMtok: 5, previousOutputPerMtok: 25, message: null, ...over });

const MULTI = {
  models: [
    { model: "claude-opus-5-5", current: period("claude-opus-5-5", 5, 25, 0.5, "2026-09-01T00:00:00Z", "config"), periods: [] },
    { model: "claude-haiku-5-5", current: period("claude-haiku-5-5", 1, 5, 0.1), periods: [] },
    { model: "claude-sonnet-5-5", current: period("claude-sonnet-5-5", 3, 15, 0.3, null, "override"), periods: [] },
    { model: "claude-next", current: null, periods: [] },
  ],
  lastCheck: check(),
  checks: [check({ id: 2, outcome: "updated", message: "new price" }), check()],
  nextCheckAt: null,
};

const row = (model: string) => screen.getAllByTestId("pricing-row").find((r) => r.getAttribute("data-model") === model)!;
const cells = (model: string) => Array.from(row(model).querySelectorAll("td")).map((c) => c.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  useToasts.setState({ toasts: [] });
});

describe("PricingSettings", () => {
  it("lists every model with input / output / cache read per MTok, source and effective date", async () => {
    mocks.adminPricing.mockResolvedValue(MULTI);
    render(<PricingSettings />);
    await screen.findByTestId("pricing-table");
    expect(screen.getAllByTestId("pricing-row")).toHaveLength(4);
    expect(Array.from(screen.getByTestId("pricing-table").querySelectorAll("th")).map((h) => h.textContent)).toEqual(["Model", "Input", "Output", "Cache read", "Source", "Effective from"]);
    expect(cells("claude-opus-5-5")).toEqual(["claude-opus-5-5", "$5", "$25", "$0.5", "config", "2026-09-01"]);
    expect(cells("claude-haiku-5-5")).toEqual(["claude-haiku-5-5", "$1", "$5", "$0.1", "builtin", "—"]);
    expect(cells("claude-sonnet-5-5")).toEqual(["claude-sonnet-5-5", "$3", "$15", "$0.3", "override", "—"]);
  });

  it("a model without a current price shows dashes", async () => {
    mocks.adminPricing.mockResolvedValue(MULTI);
    render(<PricingSettings />);
    await screen.findByTestId("pricing-table");
    expect(cells("claude-next")).toEqual(["claude-next", "—", "—", "—", "—", "—"]);
  });

  it("derives the cache read price from the factor when the period has no explicit one", async () => {
    mocks.adminPricing.mockResolvedValue({ ...MULTI, models: [{ model: "g", current: { model: "g", from: null, inputPerMtok: 2, outputPerMtok: 8, cacheReadFactor: 0.25, source: "builtin" }, periods: [] }] });
    render(<PricingSettings />);
    await screen.findByTestId("pricing-table");
    expect(cells("g")[3]).toBe("$0.5");
  });

  it("shows the check history", async () => {
    mocks.adminPricing.mockResolvedValue(MULTI);
    render(<PricingSettings />);
    const list = await screen.findByTestId("pricing-checks");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("updated");
    expect(items[0]).toHaveTextContent("new price");
    expect(items[1]).toHaveTextContent("unchanged");
  });

  it("Check now refreshes and shows the new table; a failed check toasts", async () => {
    mocks.adminPricing.mockResolvedValue({ ...MULTI, models: MULTI.models.slice(0, 1) });
    mocks.refreshAdminPricing.mockResolvedValue({ check: check(), pricing: MULTI });
    render(<PricingSettings />);
    await screen.findByTestId("pricing-table");
    await userEvent.click(screen.getByTestId("pricing-check"));
    await waitFor(() => expect(screen.getAllByTestId("pricing-row")).toHaveLength(4));
    expect(mocks.refreshAdminPricing).toHaveBeenCalledTimes(1);
    expect(useToasts.getState().toasts).toHaveLength(0);

    mocks.refreshAdminPricing.mockResolvedValue({ check: check({ outcome: "failed", message: "offline" }), pricing: MULTI });
    await userEvent.click(screen.getByTestId("pricing-check"));
    await waitFor(() => expect(useToasts.getState().toasts.map((x) => x.title)).toContain("Price check failed"));
  });

  it("shows the error when the pricing cannot be loaded", async () => {
    mocks.adminPricing.mockRejectedValue(new Error("nope"));
    render(<PricingSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("nope");
  });
});
