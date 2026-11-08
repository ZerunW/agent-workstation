import type { Memory } from "@agent-workstation/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ memories: vi.fn(), createMemory: vi.fn(), updateMemory: vi.fn(), deleteMemory: vi.fn(), patchPreferences: vi.fn() }));
vi.mock("../lib/api", async (orig) => {
  const actual = await orig<typeof import("../lib/api")>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

import { ApiError } from "../lib/api";
import { useApp } from "../store/app";
import { useToasts } from "../store/toasts";
import { TestRouter } from "../test/router";
import MemoryPage from "./MemoryPage";

const mem = (id: string, text: string, source: Memory["source"] = "claude", ageMs = 3_600_000): Memory => {
  const at = new Date(Date.now() - ageMs).toISOString();
  return { id, text, source, sessionId: null, createdAt: at, updatedAt: at };
};
const LIST: Memory[] = [mem("m2", "Prefers metric units.", "user", 60_000), mem("m1", "Works on a weather app.", "claude", 86_400_000 * 3)];
const setMe = (memoryEnabled?: boolean) => useApp.setState({ me: { user: { name: "u", isAdmin: false, ...(memoryEnabled === undefined ? {} : { memoryEnabled }) } } as never });
const renderPage = () =>
  render(
    <TestRouter initialEntries={["/memory"]}>
      <Routes>
        <Route path="/memory" element={<MemoryPage />} />
      </Routes>
    </TestRouter>,
  );
const items = () => screen.getAllByTestId("memory-item");
const texts = () => items().map((i) => within(i).getByTestId("memory-text").textContent);

beforeEach(() => {
  vi.clearAllMocks();
  useToasts.setState({ toasts: [] });
  useApp.setState({ memoriesTick: 0 });
  setMe();
  mocks.memories.mockResolvedValue(LIST);
  mocks.createMemory.mockImplementation(async (text: string) => mem("new", text, "user", 0));
  mocks.updateMemory.mockImplementation(async (id: string, text: string) => ({ ...mem(id, text, "user", 0) }));
  mocks.deleteMemory.mockResolvedValue(undefined);
  mocks.patchPreferences.mockImplementation(async (b: { memoryEnabled?: boolean }) => ({ name: "u", isAdmin: false, ...b }));
});

describe("MemoryPage list", () => {
  it("lists memories in the order the hub sent them, with a source chip and a relative time", async () => {
    renderPage();
    await screen.findAllByTestId("memory-item");
    expect(texts()).toEqual(["Prefers metric units.", "Works on a weather app."]);
    expect(within(items()[0]!).getByTestId("memory-source")).toHaveTextContent("You");
    expect(within(items()[1]!).getByTestId("memory-source")).toHaveTextContent("Claude");
    expect(items()[1]).toHaveTextContent(/3\s?d/);
    expect(items()[0]).toHaveTextContent(/1\s?m/);
  });

  it("says so in one line when there is nothing saved", async () => {
    mocks.memories.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByTestId("memory-empty")).toHaveTextContent("Nothing saved yet.");
    expect(screen.queryByTestId("memory-item")).toBeNull();
  });

  it("explains an old hub without the route, and offers a retry on other failures", async () => {
    mocks.memories.mockRejectedValue(new ApiError(404, "not found"));
    const a = renderPage();
    expect(await screen.findByText("This hub has no Memory yet.")).toBeInTheDocument();
    a.unmount();

    mocks.memories.mockReset();
    mocks.memories.mockRejectedValueOnce(new ApiError(500, "db down")).mockResolvedValue(LIST);
    renderPage();
    expect(await screen.findByText("Couldn't load memory")).toBeInTheDocument();
    expect(screen.getByText("db down")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findAllByTestId("memory-item")).toHaveLength(2);
  });

  it("refetches when a memories_changed event arrives", async () => {
    renderPage();
    await screen.findAllByTestId("memory-item");
    expect(mocks.memories).toHaveBeenCalledTimes(1);
    mocks.memories.mockResolvedValue([mem("m3", "Saved by Claude just now", "claude", 0), ...LIST]);
    act(() => useApp.getState().bumpMemories());
    await waitFor(() => expect(items()).toHaveLength(3));
    expect(mocks.memories).toHaveBeenCalledTimes(2);
    expect(texts()[0]).toBe("Saved by Claude just now");
  });
});

describe("MemoryPage add / edit / delete", () => {
  it("adds a memory at the top, clears the box, and keeps Add disabled while it is empty", async () => {
    renderPage();
    await screen.findAllByTestId("memory-item");
    const add = screen.getByTestId("memory-add");
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByTestId("memory-add-input"), "  Likes tea  ");
    expect(add).toBeEnabled();
    await userEvent.click(add);
    expect(mocks.createMemory).toHaveBeenCalledWith("Likes tea");
    await waitFor(() => expect(texts()[0]).toBe("Likes tea"));
    expect(items()).toHaveLength(3);
    expect(within(items()[0]!).getByTestId("memory-source")).toHaveTextContent("You");
    expect(screen.getByTestId("memory-add-input")).toHaveValue("");
    expect(add).toBeDisabled();
  });

  it("an add the hub rejects keeps the text and toasts the reason", async () => {
    mocks.createMemory.mockRejectedValue(new ApiError(400, "at most 200 memories per user"));
    renderPage();
    await screen.findAllByTestId("memory-item");
    await userEvent.type(screen.getByTestId("memory-add-input"), "One more");
    await userEvent.click(screen.getByTestId("memory-add"));
    await waitFor(() => expect(useToasts.getState().toasts.some((x) => x.tone === "error" && x.title.includes("at most 200"))).toBe(true));
    expect(screen.getByTestId("memory-add-input")).toHaveValue("One more");
    expect(items()).toHaveLength(2);
  });

  it("edits inline: Save sends the new text, Cancel puts the old one back", async () => {
    renderPage();
    await screen.findAllByTestId("memory-item");
    const first = () => items()[0]!;

    await userEvent.click(within(first()).getByTestId("memory-edit"));
    const input = within(first()).getByTestId("memory-edit-input");
    expect(input).toHaveValue("Prefers metric units.");
    expect(within(first()).getByTestId("memory-save")).toBeDisabled(); // unchanged
    await userEvent.clear(input);
    await userEvent.type(input, "Prefers short answers.");
    await userEvent.click(within(first()).getByTestId("memory-cancel"));
    expect(texts()[0]).toBe("Prefers metric units.");
    expect(mocks.updateMemory).not.toHaveBeenCalled();

    await userEvent.click(within(first()).getByTestId("memory-edit"));
    expect(within(first()).getByTestId("memory-edit-input")).toHaveValue("Prefers metric units."); // the abandoned draft is gone
    await userEvent.clear(within(first()).getByTestId("memory-edit-input"));
    await userEvent.type(within(first()).getByTestId("memory-edit-input"), "Prefers short answers.");
    await userEvent.click(within(first()).getByTestId("memory-save"));
    expect(mocks.updateMemory).toHaveBeenCalledWith("m2", "Prefers short answers.");
    await waitFor(() => expect(texts()[0]).toBe("Prefers short answers."));
    expect(screen.queryByTestId("memory-edit-input")).toBeNull();
    expect(items()).toHaveLength(2); // replaced in place, not duplicated
  });

  it("deletes only after the confirmation; cancelling deletes nothing", async () => {
    renderPage();
    await screen.findAllByTestId("memory-item");

    await userEvent.click(within(items()[1]!).getByTestId("memory-delete"));
    let dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete this memory?");
    expect(dialog).toHaveTextContent("Works on a weather app.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.deleteMemory).not.toHaveBeenCalled();
    expect(items()).toHaveLength(2);

    await userEvent.click(within(items()[1]!).getByTestId("memory-delete"));
    dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(mocks.deleteMemory).toHaveBeenCalledWith("m1");
    await waitFor(() => expect(items()).toHaveLength(1));
    expect(texts()).toEqual(["Prefers metric units."]);
  });

  it("a failed delete keeps the row and toasts", async () => {
    mocks.deleteMemory.mockRejectedValue(new ApiError(500, "nope"));
    renderPage();
    await screen.findAllByTestId("memory-item");
    await userEvent.click(within(items()[0]!).getByTestId("memory-delete"));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(useToasts.getState().toasts.some((x) => x.tone === "error" && x.title.includes("nope"))).toBe(true));
    expect(items()).toHaveLength(2);
  });
});

describe("MemoryPage toggle", () => {
  it("is on unless the user turned it off", async () => {
    const a = renderPage();
    await screen.findAllByTestId("memory-item");
    expect(screen.getByTestId("memory-toggle")).toHaveAttribute("aria-checked", "true");
    a.unmount();
    setMe(false);
    renderPage();
    expect(screen.getByTestId("memory-toggle")).toHaveAttribute("aria-checked", "false");
  });

  it("flips at once, saves memoryEnabled through the preferences, and keeps the new value in `me`", async () => {
    let release: () => void = () => {};
    mocks.patchPreferences.mockImplementation((b: { memoryEnabled?: boolean }) => new Promise((r) => (release = () => r({ name: "u", isAdmin: false, ...b }))));
    renderPage();
    await screen.findAllByTestId("memory-item");
    await userEvent.click(screen.getByTestId("memory-toggle"));
    // optimistic: already off while the request is in flight
    expect(screen.getByTestId("memory-toggle")).toHaveAttribute("aria-checked", "false");
    expect(useApp.getState().me?.user.memoryEnabled).toBe(false);
    expect(mocks.patchPreferences).toHaveBeenCalledWith({ memoryEnabled: false });
    expect(screen.getByTestId("memory-toggle")).toBeDisabled();
    await act(async () => release());
    expect(screen.getByTestId("memory-toggle")).toBeEnabled();
    expect(screen.getByTestId("memory-toggle")).toHaveAttribute("aria-checked", "false");

    await userEvent.click(screen.getByTestId("memory-toggle"));
    expect(mocks.patchPreferences).toHaveBeenLastCalledWith({ memoryEnabled: true });
  });

  it("goes back and toasts when the save fails", async () => {
    mocks.patchPreferences.mockRejectedValue(new ApiError(500, "db down"));
    renderPage();
    await screen.findAllByTestId("memory-item");
    await userEvent.click(screen.getByTestId("memory-toggle"));
    await waitFor(() => expect(screen.getByTestId("memory-toggle")).toHaveAttribute("aria-checked", "true"));
    expect(useApp.getState().me?.user.memoryEnabled).toBe(true);
    expect(useToasts.getState().toasts.some((x) => x.tone === "error" && x.title.includes("db down"))).toBe(true);
  });
});
