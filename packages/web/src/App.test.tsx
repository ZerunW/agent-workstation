import { render, screen, waitFor } from "@testing-library/react";
import type { WhoAmIResponse } from "@agent-workstation/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { api, ApiError } from "./lib/api";
import { resetAutoSignIn } from "./lib/whoami";
import { bootstrap } from "./store/hub";
import { useApp } from "./store/app";

vi.mock("./store/hub", () => ({
  bootstrap: vi.fn(),
  connectHub: vi.fn(),
  disconnectHub: vi.fn(),
  getSocket: vi.fn(() => null),
  refreshProjects: vi.fn(),
  refreshSessions: vi.fn(),
}));
vi.mock("./pages/Workbench", () => ({
  default: () => <div data-testid="workbench">{window.location.pathname}</div>,
}));
vi.mock("./components/shell/SearchDialog", () => ({ SearchDialog: () => null }));

const who = (suggested: string | null): WhoAmIResponse => ({
  tailscale: { login: "person@example.com", node: "macbook" },
  users: suggested ? [suggested] : [],
  suggested,
});

describe("sign-in on start", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetAutoSignIn();
    useApp.getState().setUser(null);
    vi.mocked(bootstrap).mockReset();
    vi.mocked(bootstrap).mockResolvedValue("ok");
    window.history.pushState({}, "", "/s/abc");
  });

  it("signs in with the suggested name and stays on the page it was opened at", async () => {
    vi.spyOn(api, "whoami").mockResolvedValue(who("alice"));
    render(<App />);
    expect(await screen.findByTestId("workbench")).toHaveTextContent("/s/abc");
    expect(useApp.getState().user).toBe("alice");
    expect(window.localStorage.getItem("workstation.user")).toBe("alice");
  });

  it("shows the login page when nothing is suggested", async () => {
    vi.spyOn(api, "whoami").mockResolvedValue(who(null));
    render(<App />);
    expect(await screen.findByTestId("login-name")).toBeInTheDocument();
    expect(screen.queryByTestId("workbench")).toBeNull();
    expect(window.location.pathname).toBe("/login");
  });

  it("shows the login page when the hub has no whoami", async () => {
    vi.spyOn(api, "whoami").mockRejectedValue(new ApiError(404, "nope"));
    render(<App />);
    expect(await screen.findByTestId("login-name")).toBeInTheDocument();
  });

  it("keeps a stored name without asking who is calling", async () => {
    useApp.getState().setUser("old");
    const whoami = vi.spyOn(api, "whoami").mockResolvedValue(who("alice"));
    render(<App />);
    expect(await screen.findByTestId("workbench")).toBeInTheDocument();
    await waitFor(() => expect(bootstrap).toHaveBeenCalled());
    expect(whoami).not.toHaveBeenCalled();
    expect(useApp.getState().user).toBe("old");
  });

  it("user_bound: drops the stored name and signs in with the suggested one", async () => {
    useApp.getState().setUser("old");
    vi.mocked(bootstrap).mockResolvedValueOnce("user_bound");
    vi.spyOn(api, "whoami").mockResolvedValue(who("alice"));
    render(<App />);
    await waitFor(() => expect(useApp.getState().user).toBe("alice"));
    expect(await screen.findByTestId("workbench")).toHaveTextContent("/s/abc");
    expect(screen.queryByTestId("login-name")).toBeNull();
    await waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
  });

  it("user_bound without a suggestion ends on the login page", async () => {
    useApp.getState().setUser("old");
    vi.mocked(bootstrap).mockResolvedValueOnce("user_bound");
    vi.spyOn(api, "whoami").mockResolvedValue(who(null));
    render(<App />);
    expect(await screen.findByTestId("login-name")).toBeInTheDocument();
    expect(useApp.getState().user).toBeNull();
  });

  it("does not loop when the suggested name is refused too", async () => {
    vi.mocked(bootstrap).mockResolvedValue("unauthorized");
    const whoami = vi.spyOn(api, "whoami").mockResolvedValue(who("alice"));
    render(<App />);
    expect(await screen.findByTestId("login-name")).toBeInTheDocument();
    expect(useApp.getState().user).toBeNull();
    expect(whoami.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
