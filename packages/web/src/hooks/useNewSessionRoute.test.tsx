import { render, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestRouter } from "../test/router";
import { useApp } from "../store/app";
import { useComposer } from "../store/composer";
import { useProjects } from "../store/projects";
import { useNewSessionRoute } from "./useNewSessionRoute";

function Probe() {
  useNewSessionRoute();
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

const open = (url: string) =>
  render(
    <TestRouter initialEntries={[url]}>
      <Probe />
    </TestRouter>,
  );

describe("useNewSessionRoute", () => {
  beforeEach(() => {
    useComposer.setState({ newCwd: "stale", drafts: {} });
    useApp.setState({ mode: "chat" });
  });

  it("opens a Code draft in the folder and cleans the query", async () => {
    open("/?new=code&cwd=projects%2Fapp");
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent(/^\/$/));
    expect(useComposer.getState().newCwd).toBe("projects/app");
    expect(useApp.getState().mode).toBe("code");
  });

  it("a projects/ folder refreshes the project list (a folder the Mac app just linked)", async () => {
    const load = vi.spyOn(useProjects.getState(), "load").mockResolvedValue();
    open("/?new=code&cwd=projects%2Fsample-app");
    await waitFor(() => expect(load).toHaveBeenCalled());
    load.mockRestore();
  });

  it("an invalid cwd is a plain new Code draft", async () => {
    open("/?new=code&cwd=..%2Fsecret");
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent(/^\/$/));
    expect(useComposer.getState().newCwd).toBe("");
    expect(useApp.getState().mode).toBe("code");
  });

  it("leaves other URLs alone", () => {
    open("/?foo=1");
    expect(screen.getByTestId("loc")).toHaveTextContent("/?foo=1");
    expect(useComposer.getState().newCwd).toBe("stale");
    expect(useApp.getState().mode).toBe("chat");
  });

  it("?panel=sync opens the Sync tab on a session URL and drops only that parameter", async () => {
    useApp.setState({ rightOpen: false, rightTab: "files" });
    open("/s/abc?panel=sync");
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent(/^\/s\/abc$/));
    expect(useApp.getState().rightOpen).toBe(true);
    expect(useApp.getState().rightTab).toBe("sync");
  });

  it("?panel=sync works with a new Code draft", async () => {
    useApp.setState({ rightOpen: false, rightTab: "files" });
    open("/?new=code&cwd=projects%2Fapp&panel=sync");
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent(/^\/$/));
    expect(useApp.getState().rightTab).toBe("sync");
    expect(useComposer.getState().newCwd).toBe("projects/app");
  });

  it("an unknown panel is ignored", async () => {
    useApp.setState({ rightOpen: false, rightTab: "files" });
    open("/s/abc?panel=nope");
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent(/^\/s\/abc$/));
    expect(useApp.getState().rightOpen).toBe(false);
  });
});
