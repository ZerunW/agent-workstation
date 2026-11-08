import type { AppPlatform, AppRelease } from "@agent-workstation/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ appReleases: vi.fn(), detectDevice: vi.fn() }));
vi.mock("../lib/api", async (orig) => {
  const actual = await orig<typeof import("../lib/api")>();
  return { ...actual, api: { ...actual.api, appReleases: mocks.appReleases } };
});
vi.mock("../lib/appPlatform", async (orig) => ({ ...(await orig<typeof import("../lib/appPlatform")>()), detectDevice: mocks.detectDevice }));

import { useApp } from "../store/app";
import App from "../App";
import DownloadPage from "./DownloadPage";

const rel = (platform: AppPlatform, version: string, day: number, sizeBytes = 15_000_000): AppRelease => ({
  platform,
  version,
  build: String(20261000000000 + day * 1000 + (platform === "mac" ? 0 : 1)),
  sizeBytes,
  sha256: "0".repeat(64),
  publishedAt: `2026-10-${String(day).padStart(2, "0")}T12:00:00Z`,
  signature: `${"A".repeat(86)}==`,
});
const RELEASES = [
  rel("mac", "0.3.0", 20),
  rel("mac", "0.2.1", 5),
  rel("mac-intel", "0.3.0", 20, 16_000_000),
  rel("mac-intel", "0.2.0", 1),
];

const mac = (platform: AppPlatform) => mocks.detectDevice.mockResolvedValue({ mac: true, platform });

describe("DownloadPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApp.getState().setUser(null);
    mocks.appReleases.mockResolvedValue(RELEASES);
    mac("mac");
  });

  it("renders without a user: icon, title, version, requirement", async () => {
    render(<DownloadPage />);
    expect(await screen.findByTestId("download-primary")).toBeInTheDocument();
    expect(screen.getByTestId("download-icon")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent Workstation for macOS" })).toBeInTheDocument();
    expect(screen.getByTestId("download-version")).toHaveTextContent("0.3.0");
    expect(screen.getByText("Requires macOS 14 or later")).toBeInTheDocument();
    expect(useApp.getState().user).toBeNull();
  });

  it("is reachable at /download without signing in", async () => {
    window.history.pushState({}, "", "/download");
    render(<App />);
    expect(await screen.findByTestId("download-primary")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/download");
    window.history.pushState({}, "", "/");
  });

  it("one button for the recommended build → /download/<platform>/latest", async () => {
    render(<DownloadPage />);
    const buttons = await screen.findAllByTestId("download-primary");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("Download for Apple Silicon");
    expect(buttons[0]).toHaveAttribute("href", "/download/mac/latest");
  });

  it("recommends Intel on an Intel Mac", async () => {
    mac("mac-intel");
    render(<DownloadPage />);
    const button = await screen.findByTestId("download-primary");
    expect(button).toHaveTextContent("Download for Intel");
    expect(button).toHaveAttribute("href", "/download/mac-intel/latest");
  });

  it("lists the other architecture's latest first, then older versions, behind a link", async () => {
    render(<DownloadPage />);
    await screen.findByTestId("download-primary");
    expect(screen.queryByTestId("download-others")).toBeNull();
    await userEvent.click(screen.getByText("Download other versions"));
    const rows = within(screen.getByTestId("download-others")).getAllByTestId("download-other");
    expect(rows.map((r) => r.getAttribute("href"))).toEqual([
      "/download/mac-intel/0.3.0",
      "/download/mac/0.2.1",
      "/download/mac-intel/0.2.0",
    ]);
    expect(rows[0]).toHaveTextContent("Intel · 0.3.0");
    expect(rows[0]).toHaveTextContent(/Oct 20/);
    expect(rows[0]).toHaveTextContent("15.3 MB");
    expect(rows[1]).toHaveTextContent("Apple Silicon · 0.2.1");
  });

  it("non-Mac devices: both builds, equal", async () => {
    mocks.detectDevice.mockResolvedValue({ mac: false });
    render(<DownloadPage />);
    const buttons = await screen.findAllByTestId("download-primary");
    expect(buttons.map((b) => b.getAttribute("href"))).toEqual(["/download/mac/latest", "/download/mac-intel/latest"]);
    expect(buttons[0].className).toBe(buttons[1].className);
    await userEvent.click(screen.getByText("Download other versions"));
    expect(screen.getAllByTestId("download-other").map((r) => r.getAttribute("href"))).toEqual(["/download/mac/0.2.1", "/download/mac-intel/0.2.0"]);
  });

  it("hides a platform without a release", async () => {
    mocks.appReleases.mockResolvedValue(RELEASES.filter((r) => r.platform === "mac-intel"));
    render(<DownloadPage />); // recommended: Apple Silicon, which has none
    const buttons = await screen.findAllByTestId("download-primary");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute("href", "/download/mac-intel/latest");
    await userEvent.click(screen.getByText("Download other versions"));
    expect(screen.getAllByTestId("download-other").map((r) => r.getAttribute("href"))).toEqual(["/download/mac-intel/0.2.0"]);
  });

  it("no list link when there is nothing else to offer", async () => {
    mocks.appReleases.mockResolvedValue([rel("mac", "0.3.0", 20)]);
    render(<DownloadPage />);
    await screen.findByTestId("download-primary");
    expect(screen.queryByText("Download other versions")).toBeNull();
  });

  it("shows 'No release yet' when there is none", async () => {
    mocks.appReleases.mockResolvedValue([]);
    render(<DownloadPage />);
    expect(await screen.findByTestId("download-empty")).toHaveTextContent("No release yet");
    expect(screen.queryByTestId("download-primary")).toBeNull();
    expect(screen.queryByText("Requires macOS 14 or later")).toBeNull();
    expect(screen.queryByText("Download other versions")).toBeNull();
  });

  it("says so when the releases cannot be loaded", async () => {
    mocks.appReleases.mockRejectedValue(new Error("down"));
    render(<DownloadPage />);
    await waitFor(() => expect(screen.getByTestId("download-empty")).toHaveTextContent("Couldn't load the releases"));
  });
});
