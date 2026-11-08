import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { WhoAmIResponse } from "@agent-workstation/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PickUserPage from "./PickUserPage";
import { api, ApiError } from "../lib/api";
import { resetAutoSignIn } from "../lib/whoami";
import { useApp } from "../store/app";

const legacy: WhoAmIResponse = { tailscale: null, users: [], suggested: null };
const tailscale = (users: string[]): WhoAmIResponse => ({
  tailscale: { login: "person@example.com", node: "macbook" },
  users,
  suggested: users[0] ?? null,
});

const Where = () => <div data-testid="where">{useLocation().pathname}</div>;

const renderPage = (from?: string) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: "/login", state: from ? { from } : null }]}>
      <Routes>
        <Route path="/login" element={<PickUserPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

describe("PickUserPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetAutoSignIn();
    useApp.getState().setUser(null);
    vi.spyOn(api, "whoami").mockResolvedValue(legacy);
  });

  it("is a plain text input that password managers ignore", async () => {
    renderPage();
    const input = (await screen.findByTestId("login-name")) as HTMLInputElement;
    expect(input.id).toBe("workstation-name");
    expect(input.type).toBe("text");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("data-1p-ignore");
    expect(input).toHaveAttribute("data-lpignore", "true");
    expect(input).toHaveAttribute("data-lastpass-ignore", "true");
    expect(input).toHaveAttribute("data-bwignore");
    expect(input).toHaveAttribute("data-form-type", "other");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(screen.getByLabelText("Name")).toBe(input);
  });

  it("carries no login signal: no form, placeholder, aria-label, or user/login ids", async () => {
    const { container } = renderPage();
    await screen.findByTestId("login-name");
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("input[placeholder]")).toBeNull();
    expect(container.querySelector("input[aria-label]")).toBeNull();
    for (const el of container.querySelectorAll("input")) {
      expect(`${el.id} ${el.getAttribute("name") ?? ""}`).not.toMatch(/user|login|email|account/i);
    }
  });

  it("continues on Enter and on the button", async () => {
    const create = vi.spyOn(api, "createUser").mockResolvedValue({} as never);
    renderPage();
    const input = await screen.findByTestId("login-name");
    fireEvent.change(input, { target: { value: "alice" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenLastCalledWith("alice");
    await waitFor(() => expect(screen.getByTestId("where")).toBeInTheDocument());

    cleanup();
    useApp.getState().setUser(null);
    renderPage();
    fireEvent.change(await screen.findByTestId("login-name"), { target: { value: "alice" } });
    const button = screen.getByTestId("login-continue");
    expect(button).toHaveAttribute("type", "button");
    fireEvent.click(button);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenLastCalledWith("alice");
  });

  describe("Tailscale sign-in", () => {
    it("signs in with the suggested name and goes where the person was headed", async () => {
      vi.mocked(api.whoami).mockResolvedValue(tailscale(["alice", "guest"]));
      renderPage("/s/abc?x=1");
      await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/s/abc"));
      expect(useApp.getState().user).toBe("alice");
    });

    it("shows the login page when nothing is suggested", async () => {
      vi.mocked(api.whoami).mockResolvedValue(tailscale([]));
      renderPage();
      await screen.findByTestId("login-name");
      expect(useApp.getState().user).toBeNull();
      expect(screen.getByTestId("login-tailscale")).toHaveTextContent("person@example.com · macbook");
      expect(screen.queryByTestId("login-user")).toBeNull();
    });

    it("keeps a stored name and lists only the names bound to this account", async () => {
      useApp.getState().setUser("old");
      vi.mocked(api.whoami).mockResolvedValue(tailscale(["alice", "guest"]));
      renderPage();
      const users = await screen.findAllByTestId("login-user");
      expect(users).toHaveLength(2);
      expect(users[0]).toHaveTextContent("alice");
      expect(users[1]).toHaveTextContent("guest");
      expect(screen.queryByText("old")).toBeNull();
      expect(useApp.getState().user).toBe("old");
      expect(screen.queryByTestId("login-continue-current")).toBeNull();
      expect(screen.getByTestId("login-tailscale")).toHaveTextContent("person@example.com · macbook");
      expect(screen.getByTestId("login-name")).toBeInTheDocument();

      fireEvent.click(users[1]);
      await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/"));
      expect(useApp.getState().user).toBe("guest");
    });

    it("says so when a new name belongs to another account", async () => {
      useApp.getState().setUser("old");
      vi.mocked(api.whoami).mockResolvedValue(tailscale(["alice"]));
      vi.spyOn(api, "createUser").mockRejectedValue(new ApiError(403, "bound", "user_bound"));
      renderPage();
      const input = await screen.findByTestId("login-name");
      fireEvent.change(input, { target: { value: "taken" } });
      fireEvent.click(screen.getByTestId("login-continue"));
      expect(await screen.findByText("Name is taken")).toBeInTheDocument();
      expect(useApp.getState().user).toBe("old");
    });

    it("uses the header identity without Tailscale (legacy)", async () => {
      useApp.getState().setUser("old");
      renderPage();
      await screen.findByTestId("login-name");
      expect(screen.queryByTestId("login-tailscale")).toBeNull();
      expect(screen.queryByTestId("login-user")).toBeNull();
      expect(screen.getByTestId("login-continue-current")).toHaveTextContent("old");
      expect(useApp.getState().user).toBe("old");
    });

    it("falls back to the legacy page when whoami is unavailable", async () => {
      vi.mocked(api.whoami).mockRejectedValue(new ApiError(404, "nope"));
      renderPage();
      expect(await screen.findByTestId("login-name")).toBeInTheDocument();
      expect(screen.queryByTestId("login-tailscale")).toBeNull();
      expect(useApp.getState().user).toBeNull();
    });
  });
});
