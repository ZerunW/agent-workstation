import type { BrowserSiteGrant } from "@agent-workstation/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ browserSites: vi.fn(), removeBrowserSite: vi.fn() }));
vi.mock("../lib/api", async (orig) => {
  const actual = await orig<typeof import("../lib/api")>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

import { ApiError } from "../lib/api";
import { useToasts } from "../store/toasts";
import { TestRouter } from "../test/router";
import BrowserSitesPage from "./BrowserSitesPage";

const grant = (origin: string, usedAgoMs: number | null): BrowserSiteGrant => ({
  origin,
  grantedAt: new Date(Date.now() - 86_400_000 * 10).toISOString(),
  lastUsedAt: usedAgoMs == null ? null : new Date(Date.now() - usedAgoMs).toISOString(),
});
const LIST = [grant("https://github.com", 3_600_000), grant("http://localhost:3000", null)];
const renderPage = () =>
  render(
    <TestRouter initialEntries={["/browser-sites"]}>
      <Routes>
        <Route path="/browser-sites" element={<BrowserSitesPage />} />
      </Routes>
    </TestRouter>,
  );
const rows = () => screen.getAllByTestId("browser-site");

beforeEach(() => {
  vi.clearAllMocks();
  useToasts.setState({ toasts: [] });
  mocks.browserSites.mockResolvedValue(LIST);
  mocks.removeBrowserSite.mockResolvedValue(undefined);
});

describe("BrowserSitesPage", () => {
  it("lists host and last used as relative time, full origin in the tooltip", async () => {
    renderPage();
    await screen.findAllByTestId("browser-site");
    expect(screen.getByRole("heading", { name: "Browser sites" })).toBeInTheDocument();
    expect(within(rows()[0]!).getByTestId("browser-site-host")).toHaveTextContent("github.com");
    expect(within(rows()[0]!).getByTitle("https://github.com")).toBeInTheDocument();
    expect(within(rows()[0]!).getByTestId("browser-site-used")).toHaveTextContent(/1\s?h/);
    expect(within(rows()[1]!).getByTestId("browser-site-host")).toHaveTextContent("localhost:3000");
    expect(within(rows()[1]!).getByTestId("browser-site-used")).toHaveTextContent("—");
  });

  it("removes a site by origin and drops its row", async () => {
    renderPage();
    await screen.findAllByTestId("browser-site");
    await userEvent.click(within(rows()[0]!).getByRole("button", { name: "Remove github.com" }));
    expect(mocks.removeBrowserSite).toHaveBeenCalledWith("https://github.com");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveAttribute("data-origin", "http://localhost:3000");
  });

  it("a failed removal keeps the row and toasts", async () => {
    mocks.removeBrowserSite.mockRejectedValue(new ApiError(500, "nope"));
    renderPage();
    await screen.findAllByTestId("browser-site");
    await userEvent.click(within(rows()[0]!).getByRole("button", { name: "Remove github.com" }));
    await waitFor(() => expect(useToasts.getState().toasts.some((x) => x.tone === "error" && x.title.includes("nope"))).toBe(true));
    expect(rows()).toHaveLength(2);
  });

  it("empty: the title and a one-line No sites state, no paragraph", async () => {
    mocks.browserSites.mockResolvedValue([]);
    const { container } = renderPage();
    expect(await screen.findByTestId("browser-sites-empty")).toHaveTextContent(/^No sites$/);
    expect(screen.queryByTestId("browser-sites-list")).toBeNull();
    expect(screen.getByRole("heading", { name: "Browser sites" })).toBeInTheDocument();
    expect(container.querySelector("p")).toBeNull();
  });

  it("an older hub without the route (404) shows No sites, not an error", async () => {
    mocks.browserSites.mockRejectedValue(new ApiError(404, "not found"));
    renderPage();
    expect(await screen.findByTestId("browser-sites-empty")).toHaveTextContent(/^No sites$/);
    expect(screen.queryByTestId("browser-sites-list")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Browser sites" })).toBeInTheDocument();
  });

  it("offers a retry on other failures", async () => {
    mocks.browserSites.mockRejectedValueOnce(new ApiError(500, "db down")).mockResolvedValue(LIST);
    renderPage();
    expect(await screen.findByText("Couldn't load browser sites")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findAllByTestId("browser-site")).toHaveLength(2);
  });
});
