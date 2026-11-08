import "../usage/testMatchers";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  users: vi.fn(),
  adminUsage: vi.fn(),
  models: vi.fn(),
  adminOverview: vi.fn(),
  adminSettings: vi.fn(),
  patchAdminSettings: vi.fn(),
  patchUser: vi.fn(),
  adminPricing: vi.fn(),
}));

vi.mock("../../lib/api", () => ({ api: mocks, getApiUser: () => null, setApiUser: () => {} }));

import { useToasts } from "../../store/toasts";
import { AdminDashboard } from "./AdminDashboard";

const user = (over = {}) => ({ name: "alice", createdAt: "2026-10-01T00:00:00Z", isAdmin: false, enabled: true, terminalEnabled: true, weeklyTokenLimit: 1_000_000, modelAllowlist: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  useToasts.setState({ toasts: [] });
  mocks.users.mockResolvedValue([user(), user({ name: "root", isAdmin: true, weeklyTokenLimit: null })]);
  mocks.adminUsage.mockResolvedValue({
    users: [
      { user: "alice", weeklyTokens: 500_000, weeklyLimit: 1_000_000, costUsd: 1.25, sessions: 3 },
      { user: "root", weeklyTokens: 10, weeklyLimit: null, costUsd: 0, sessions: 1 },
    ],
    buckets: [],
  });
  mocks.models.mockResolvedValue([{ value: "opus", displayName: "Opus" }]);
  mocks.adminOverview.mockRejectedValue(new Error("404"));
  mocks.adminPricing.mockResolvedValue({ models: [], lastCheck: null, checks: [], nextCheckAt: null });
  mocks.adminSettings.mockResolvedValue({ remoteClaudeEnabled: true, diskWarnPercent: 80, diskBlockPercent: 95, defaultWeeklyTokenLimit: 0 });
});

async function editLimit(text: string) {
  const u = userEvent.setup();
  await u.click(await screen.findByRole("button", { name: "Edit weekly limit for alice" }));
  const input = screen.getByRole("textbox", { name: "Edit weekly limit for alice" });
  await u.clear(input);
  if (text) await u.type(input, text);
  return { u, input };
}

describe("AdminDashboard", () => {
  it("joins users with usage and derives overview cards when the overview endpoint is missing", async () => {
    render(<AdminDashboard />);
    const row = await screen.findByTestId("user-row-alice");
    expect(row).toHaveTextContent("500k");
    expect(row).toHaveTextContent("$1.25");
    expect(row).toHaveTextContent("1.00M");
    const cards = await screen.findByTestId("overview-cards");
    await waitFor(() => expect(cards).toHaveTextContent("Sessions (7 days)"));
    expect(cards).toHaveTextContent("2"); // users
    expect(cards).toHaveTextContent("4"); // 3 + 1 sessions
  });

  it("commits an inline weekly limit edit with Enter and sends the parsed value", async () => {
    mocks.patchUser.mockResolvedValue(user({ weeklyTokenLimit: 2_000_000 }));
    render(<AdminDashboard />);
    const { u } = await editLimit("2m");
    await u.keyboard("{Enter}");
    await waitFor(() => expect(mocks.patchUser).toHaveBeenCalledWith("alice", { weeklyTokenLimit: 2_000_000 }));
    expect(await screen.findByRole("button", { name: "Edit weekly limit for alice" })).toHaveTextContent("2.00M");
  });

  it("sends null for an emptied limit (unlimited) on blur", async () => {
    mocks.patchUser.mockResolvedValue(user({ weeklyTokenLimit: null }));
    render(<AdminDashboard />);
    const { u } = await editLimit("");
    await u.tab();
    await waitFor(() => expect(mocks.patchUser).toHaveBeenCalledWith("alice", { weeklyTokenLimit: null }));
  });

  it("Escape cancels without calling the API", async () => {
    render(<AdminDashboard />);
    const { u } = await editLimit("999");
    await u.keyboard("{Escape}");
    expect(mocks.patchUser).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Edit weekly limit for alice" })).toHaveTextContent("1.00M");
  });

  it("rejects invalid input and does not call the API", async () => {
    render(<AdminDashboard />);
    const { u } = await editLimit("lots");
    await u.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/whole number/);
    expect(mocks.patchUser).not.toHaveBeenCalled();
  });

  it("rolls the value back and toasts when the patch fails", async () => {
    mocks.patchUser.mockRejectedValue(new Error("hub said no"));
    render(<AdminDashboard />);
    const { u } = await editLimit("5m");
    await u.keyboard("{Enter}");
    await waitFor(() => expect(mocks.patchUser).toHaveBeenCalledWith("alice", { weeklyTokenLimit: 5_000_000 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit weekly limit for alice" })).toHaveTextContent("1.00M"));
    expect(useToasts.getState().toasts.some((x) => x.tone === "error" && /hub said no/.test(x.title))).toBe(true);
  });

  it("toggles terminal access optimistically and rolls back on failure", async () => {
    mocks.patchUser.mockRejectedValue(new Error("nope"));
    render(<AdminDashboard />);
    const sw = await screen.findByRole("switch", { name: "Allow terminal for alice" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    await userEvent.setup().click(sw);
    await waitFor(() => expect(mocks.patchUser).toHaveBeenCalledWith("alice", { terminalEnabled: false }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Allow terminal for alice" })).toHaveAttribute("aria-checked", "true"));
  });

  it("does not let an admin be disabled from the table", async () => {
    render(<AdminDashboard />);
    expect(await screen.findByRole("switch", { name: "Enable root" })).toBeDisabled();
  });
});
