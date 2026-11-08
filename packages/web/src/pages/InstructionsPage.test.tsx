import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ patchPreferences: vi.fn(), knownHeadsUps: vi.fn(), removeKnownHeadsUp: vi.fn() }));
vi.mock("../lib/api", async (orig) => {
  const actual = await orig<typeof import("../lib/api")>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

import { useApp } from "../store/app";
import { useHeadsUp } from "../store/headsUp";
import { useToasts } from "../store/toasts";
import { TestRouter } from "../test/router";
import InstructionsPage from "./InstructionsPage";

const setMe = (instructions?: string) => useApp.setState({ me: { user: { name: "u", isAdmin: false, ...(instructions === undefined ? {} : { instructions }) } } as never });
const renderPage = () =>
  render(
    <TestRouter initialEntries={["/instructions"]}>
      <Routes>
        <Route path="/instructions" element={<InstructionsPage />} />
      </Routes>
    </TestRouter>,
  );
const input = () => screen.getByTestId("instructions-input") as HTMLTextAreaElement;
const save = () => screen.getByTestId("instructions-save");
const count = () => screen.getByTestId("instructions-count");

beforeEach(() => {
  vi.clearAllMocks();
  useToasts.setState({ toasts: [] });
  setMe("Answer in French.");
  useHeadsUp.setState({ known: [], loaded: false, dismissed: {} });
  mocks.knownHeadsUps.mockResolvedValue([]);
  mocks.removeKnownHeadsUp.mockResolvedValue(undefined);
  mocks.patchPreferences.mockImplementation(async (b: { instructions?: string }) => ({ name: "u", isAdmin: false, ...b }));
});

describe("InstructionsPage", () => {
  it("loads the stored text into a 12-line field with a counter, Save disabled", () => {
    renderPage();
    expect(input().value).toBe("Answer in French.");
    expect(input().rows).toBeGreaterThanOrEqual(12);
    expect(count()).toHaveTextContent("17 / 12,000");
    expect(save()).toBeDisabled();
  });

  it("an older hub without the field shows an empty field", () => {
    setMe();
    renderPage();
    expect(input().value).toBe("");
    expect(count()).toHaveTextContent("0 / 12,000");
    expect(save()).toBeDisabled();
  });

  it("counts as you type, saves the trimmed text, toasts and disables Save again", async () => {
    renderPage();
    await userEvent.type(input(), " Be brief.  ");
    expect(count()).toHaveTextContent("27 / 12,000");
    expect(save()).toBeEnabled();
    await userEvent.click(save());
    await waitFor(() => expect(mocks.patchPreferences).toHaveBeenCalledWith({ instructions: "Answer in French. Be brief." }));
    await waitFor(() => expect(save()).toBeDisabled());
    expect(input().value).toBe("Answer in French. Be brief.");
    expect(useApp.getState().me?.user.instructions).toBe("Answer in French. Be brief.");
    expect(useToasts.getState().toasts.map((x) => x.title)).toContain("Instructions saved");
  });

  it("clearing the field saves an empty string", async () => {
    renderPage();
    await userEvent.clear(input());
    expect(save()).toBeEnabled();
    await userEvent.click(save());
    await waitFor(() => expect(mocks.patchPreferences).toHaveBeenCalledWith({ instructions: "" }));
    expect(useApp.getState().me?.user.instructions).toBe("");
  });

  it("turns the counter red and blocks Save over 12,000 characters", () => {
    renderPage();
    fireEvent.change(input(), { target: { value: "x".repeat(12_000) } });
    expect(count()).toHaveTextContent("12,000 / 12,000");
    expect(count().className).not.toMatch(/text-danger/);
    expect(save()).toBeEnabled();
    fireEvent.change(input(), { target: { value: "x".repeat(12_001) } });
    expect(count()).toHaveTextContent("12,001 / 12,000");
    expect(count().className).toMatch(/text-danger/);
    expect(save()).toBeDisabled();
    expect(mocks.patchPreferences).not.toHaveBeenCalled();
  });

  it("trailing whitespace past the limit does not count", () => {
    renderPage();
    fireEvent.change(input(), { target: { value: `${"x".repeat(12_000)}\n\n  ` } });
    expect(count()).toHaveTextContent("12,000 / 12,000");
    expect(save()).toBeEnabled();
  });

  it("shows an error toast and keeps the text when saving fails", async () => {
    mocks.patchPreferences.mockRejectedValue(new Error("boom"));
    renderPage();
    await userEvent.type(input(), "!");
    await userEvent.click(save());
    await waitFor(() => expect(useToasts.getState().toasts.map((x) => x.title)).toContain("Couldn't save the instructions: boom"));
    expect(input().value).toBe("Answer in French.!");
    expect(save()).toBeEnabled();
  });

  describe("known heads-ups", () => {
    const known = [
      { id: "k1", text: "Lockfile is out of date", at: new Date(Date.now() - 3 * 3600_000).toISOString() },
      { id: "k2", text: "Tests need Node 22", at: new Date(Date.now() - 2 * 86_400_000).toISOString() },
    ];

    it("is hidden when nothing is known", async () => {
      renderPage();
      await waitFor(() => expect(mocks.knownHeadsUps).toHaveBeenCalled());
      expect(screen.queryByTestId("known-heads-ups")).not.toBeInTheDocument();
    });

    it("lists text and date under the editor", async () => {
      mocks.knownHeadsUps.mockResolvedValue(known);
      renderPage();
      const rows = await screen.findAllByTestId("known-heads-up");
      expect(rows.map((r) => r.querySelector("span")?.textContent)).toEqual(["Lockfile is out of date", "Tests need Node 22"]);
      expect(rows[0]!.querySelector("time")).toHaveAttribute("datetime", known[0]!.at);
      expect(rows[0]!.querySelector("time")!.textContent).not.toBe("");
      expect(input().compareDocumentPosition(screen.getByTestId("known-heads-ups")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("× removes one entry through the API", async () => {
      mocks.knownHeadsUps.mockResolvedValue(known);
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "Remove “Lockfile is out of date”" }));
      await waitFor(() => expect(mocks.removeKnownHeadsUp).toHaveBeenCalledWith("k1"));
      await waitFor(() => expect(screen.getAllByTestId("known-heads-up")).toHaveLength(1));
      expect(screen.queryByText("Lockfile is out of date")).not.toBeInTheDocument();
    });

    it("keeps the entry and toasts when removing fails", async () => {
      mocks.knownHeadsUps.mockResolvedValue(known);
      mocks.removeKnownHeadsUp.mockRejectedValue(new Error("boom"));
      renderPage();
      await userEvent.click(await screen.findByRole("button", { name: "Remove “Tests need Node 22”" }));
      await waitFor(() => expect(useToasts.getState().toasts.map((x) => x.title)).toContain("Couldn't remove the heads-up: boom"));
      expect(screen.getAllByTestId("known-heads-up")).toHaveLength(2);
    });
  });
});
