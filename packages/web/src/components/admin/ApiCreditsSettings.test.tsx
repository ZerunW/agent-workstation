import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ adminSettings: vi.fn(), patchAdminSettings: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: mocks, getApiUser: () => null, setApiUser: () => {} }));

import { useApp } from "../../store/app";
import { useToasts } from "../../store/toasts";
import { ApiCreditsSettings, parseApiCredits, parseReserve } from "./ApiCreditsSettings";

const SETTINGS = { remoteClaudeEnabled: true, diskWarnPercent: 80, diskBlockPercent: 95, defaultWeeklyTokenLimit: 0, defaultModel: "opus", defaultEffort: "high", apiMonthlyLimitUsd: 200, apiResetDay: 13 };

beforeEach(() => {
  vi.clearAllMocks();
  useToasts.setState({ toasts: [] });
  useApp.setState({ me: { user: { name: "root" }, settings: SETTINGS } as never });
  mocks.adminSettings.mockResolvedValue(SETTINGS);
});

describe("parseApiCredits", () => {
  it("accepts a limit of 0 or more (at most two decimals) and a reset day from 1 to 28", () => {
    expect(parseApiCredits("200", "1")).toMatchObject({ ok: true, limit: 200, day: 1 });
    expect(parseApiCredits("0", "28")).toMatchObject({ ok: true, limit: 0, day: 28 });
    expect(parseApiCredits(" 12.5 ", " 13 ")).toMatchObject({ ok: true, limit: 12.5, day: 13 });
    expect(parseApiCredits("0.99", "5")).toMatchObject({ ok: true, limit: 0.99 });
  });

  it("rejects negative, non-numeric, empty and over-precise limits", () => {
    for (const bad of ["-1", "abc", "", "1e3", "1.234", "1,5", "$20", "20 USD"]) expect(parseApiCredits(bad, "1"), bad).toMatchObject({ ok: false, limitOk: false, dayOk: true });
  });

  it("rejects reset days outside 1–28 or not whole", () => {
    for (const bad of ["0", "29", "31", "-3", "1.5", "", "x", "100"]) expect(parseApiCredits("200", bad), bad).toMatchObject({ ok: false, limitOk: true, dayOk: false });
    expect(parseApiCredits("x", "99")).toMatchObject({ ok: false, limitOk: false, dayOk: false });
  });
});

describe("parseReserve", () => {
  it("accepts 0 up to 1,000,000 with at most two decimals", () => {
    expect(parseReserve("30")).toBe(30);
    expect(parseReserve(" 0 ")).toBe(0);
    expect(parseReserve("12.5")).toBe(12.5);
    expect(parseReserve("1000000")).toBe(1_000_000);
    for (const bad of ["", "-1", "x", "1.234", "1000001", "1,5", "$5"]) expect(parseReserve(bad), bad).toBeNull();
  });
});

describe("ApiCreditsSettings", () => {
  const field = async () => ({ limit: await screen.findByTestId("api-limit"), day: await screen.findByTestId("api-day") });

  it("shows the monthly limit and the reset day from the hub, with Save off until something changes", async () => {
    render(<ApiCreditsSettings />);
    const { limit, day } = await field();
    await waitFor(() => expect(limit).toHaveValue("200"));
    expect(day).toHaveValue("13");
    expect(screen.getByRole("heading", { name: "API credits" })).toBeInTheDocument();
    expect(screen.getByLabelText("Monthly limit (USD)")).toBe(limit);
    expect(screen.getByLabelText("Reset day (1–28)")).toBe(day);
    expect(screen.getByTestId("api-save")).toBeDisabled();
  });

  it("falls back to the defaults (200, day 1) while an older hub sends neither", async () => {
    mocks.adminSettings.mockResolvedValue({ ...SETTINGS, apiMonthlyLimitUsd: undefined, apiResetDay: undefined });
    render(<ApiCreditsSettings />);
    const { limit, day } = await field();
    await waitFor(() => expect(limit).toHaveValue("200"));
    expect(day).toHaveValue("1");
  });

  it("saves both values with PATCH /api/admin/settings and mirrors them into the account", async () => {
    mocks.patchAdminSettings.mockResolvedValue({ ...SETTINGS, apiMonthlyLimitUsd: 350.5, apiResetDay: 5 });
    render(<ApiCreditsSettings />);
    const { limit, day } = await field();
    await waitFor(() => expect(limit).toHaveValue("200"));
    await userEvent.clear(limit);
    await userEvent.type(limit, "350.5");
    await userEvent.clear(day);
    await userEvent.type(day, "5");
    await userEvent.click(screen.getByTestId("api-save"));
    await waitFor(() => expect(mocks.patchAdminSettings).toHaveBeenCalledWith({ apiMonthlyLimitUsd: 350.5, apiResetDay: 5 }));
    await waitFor(() => expect(useApp.getState().me?.settings).toMatchObject({ apiMonthlyLimitUsd: 350.5, apiResetDay: 5 }));
    expect(useToasts.getState().toasts.map((t) => t.title)).toContain("API credits saved");
    await waitFor(() => expect(screen.getByTestId("api-save")).toBeDisabled());
  });

  it("an invalid limit or reset day is flagged, explained in one line, and cannot be saved", async () => {
    render(<ApiCreditsSettings />);
    const { limit, day } = await field();
    await waitFor(() => expect(limit).toHaveValue("200"));
    await userEvent.clear(day);
    await userEvent.type(day, "29");
    expect(day).toHaveAttribute("aria-invalid", "true");
    expect(limit).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByRole("alert")).toHaveTextContent("Limit must be 0 or more, reset day 1–28.");
    expect(screen.getByTestId("api-save")).toBeDisabled();

    await userEvent.clear(day);
    await userEvent.type(day, "28");
    await userEvent.clear(limit);
    await userEvent.type(limit, "-5");
    expect(limit).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("api-save")).toBeDisabled();
    await userEvent.click(screen.getByTestId("api-save"));
    expect(mocks.patchAdminSettings).not.toHaveBeenCalled();

    await userEvent.clear(limit);
    await userEvent.type(limit, "0"); // 0 is valid: no session can start
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("api-save")).toBeEnabled();
  });

  it("has no default billing and no plan reserve", async () => {
    render(<ApiCreditsSettings />);
    await field();
    expect(screen.queryByTestId("api-default-billing")).not.toBeInTheDocument();
    expect(screen.queryByTestId("api-reserve")).not.toBeInTheDocument();
  });

  it("shows Service reserve (USD) from the hub, 2 when an older hub sends none", async () => {
    mocks.adminSettings.mockResolvedValue({ ...SETTINGS, serviceReserveUsd: 5 });
    const first = render(<ApiCreditsSettings />);
    const input = await screen.findByTestId("api-service-reserve");
    await waitFor(() => expect(input).toHaveValue("5"));
    expect(screen.getByLabelText("Service reserve (USD)")).toBe(input);
    first.unmount();
    mocks.adminSettings.mockResolvedValue(SETTINGS);
    render(<ApiCreditsSettings />);
    await waitFor(() => expect(screen.getByTestId("api-service-reserve")).toHaveValue("2"));
    expect(screen.getByTestId("api-save")).toBeDisabled();
  });

  it("saves a changed service reserve as serviceReserveUsd and mirrors it into the account", async () => {
    mocks.patchAdminSettings.mockResolvedValue({ ...SETTINGS, serviceReserveUsd: 0 });
    render(<ApiCreditsSettings />);
    const input = await screen.findByTestId("api-service-reserve");
    await waitFor(() => expect(input).toHaveValue("2"));
    await userEvent.clear(input);
    await userEvent.type(input, "0");
    await userEvent.click(screen.getByTestId("api-save"));
    await waitFor(() => expect(mocks.patchAdminSettings).toHaveBeenCalledWith({ apiMonthlyLimitUsd: 200, apiResetDay: 13, serviceReserveUsd: 0 }));
    await waitFor(() => expect(useApp.getState().me?.settings).toMatchObject({ serviceReserveUsd: 0 }));
  });

  it("an invalid service reserve is flagged and cannot be saved", async () => {
    render(<ApiCreditsSettings />);
    const input = await screen.findByTestId("api-service-reserve");
    await waitFor(() => expect(input).toHaveValue("2"));
    for (const bad of ["-1", "abc", "", "1.234", "1000001"]) {
      await userEvent.clear(input);
      if (bad) await userEvent.type(input, bad);
      expect(input, bad).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("alert")).toHaveTextContent("Service reserve must be between 0 and 1,000,000.");
      expect(screen.getByTestId("api-save"), bad).toBeDisabled();
    }
  });

  it("a failed save toasts the hub's message and keeps the edit", async () => {
    mocks.patchAdminSettings.mockRejectedValue(new Error("apiResetDay must be a whole day 1-28"));
    render(<ApiCreditsSettings />);
    const { day } = await field();
    await waitFor(() => expect(day).toHaveValue("13"));
    await userEvent.clear(day);
    await userEvent.type(day, "2");
    await userEvent.click(screen.getByTestId("api-save"));
    await waitFor(() => expect(useToasts.getState().toasts.length).toBeGreaterThan(0));
    expect(useToasts.getState().toasts[0]).toMatchObject({ title: "Couldn't save settings" });
    expect(day).toHaveValue("2");
  });
});
