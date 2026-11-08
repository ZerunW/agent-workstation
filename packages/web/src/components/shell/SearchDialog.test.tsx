import type { SearchHit } from "@agent-workstation/protocol";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ search: vi.fn(), searchRelevant: vi.fn() }));
vi.mock("../../lib/api", async (orig) => {
  const actual = await orig<typeof import("../../lib/api")>();
  return { ...actual, api: { ...actual.api, search: mocks.search, searchRelevant: mocks.searchRelevant } };
});

import { ApiError } from "../../lib/api";
import { clearRelevantCache } from "../../hooks/useSearchResults";
import { useApp } from "../../store/app";
import { session } from "../../test/fixtures";
import { TestRouter } from "../../test/router";
import { SearchDialog } from "./SearchDialog";

const ID = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const hit = (n: number, title: string, at: string, extra: Partial<SearchHit> = {}, sess: Parameters<typeof session>[0] = {}): SearchHit => ({
  session: session({ id: ID(n), title, kind: "chat", ...sess }),
  snippet: null,
  at,
  ...extra,
});

const keywordHits = [
  hit(1, "Older notes", "2026-10-20T10:00:00Z", { snippet: "we talked about «debounce» in search" }),
  hit(2, "Search box design", "2026-10-30T10:00:00Z", { snippet: "a «debounce» of 200 ms is fine" }),
];
const relevantHits = [
  hit(3, "Typing delay", "2026-01-15T10:00:00Z", { snippet: "Summary", reason: "Discusses how long to wait after typing." }),
  hit(4, "Throttling", "2026-10-25T10:00:00Z", { reason: "Compares throttling with debouncing." }),
];

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}

const open = () => {
  useApp.setState({ searchOpen: true });
  return render(
    <TestRouter initialEntries={["/"]}>
      <Routes>
        <Route path="*" element={<><SearchDialog /><Where /></>} />
      </Routes>
    </TestRouter>,
  );
};

let user: ReturnType<typeof userEvent.setup>;
const typeFast = async (text: string) => {
  const input = screen.getByTestId("search-input");
  await user.type(input, text);
  return input;
};
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const col = (kind: "keyword" | "relevant") => screen.getByTestId(`search-col-${kind}`);

beforeEach(() => {
  vi.useFakeTimers();
  // Testing Library detects fake timers through a `jest` global (it would otherwise wait on a real timer forever)
  (globalThis as unknown as { jest?: unknown }).jest = { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) };
  user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
  vi.clearAllMocks();
  clearRelevantCache();
  mocks.search.mockResolvedValue({ hits: keywordHits });
  mocks.searchRelevant.mockResolvedValue({ hits: relevantHits, model: "claude-haiku-5-5", cached: false });
  useApp.setState({ me: { user: { name: "alice" }, apiAvailable: true } as never, mode: "code", searchOpen: false });
});
afterEach(() => {
  delete (globalThis as unknown as { jest?: unknown }).jest;
  cleanup();
  vi.useRealTimers();
  useApp.setState({ searchOpen: false });
});

describe("SearchDialog", () => {
  it("one input and two columns, Keyword first, with no prompt text before anything is typed", () => {
    open();
    expect(screen.getByTestId("search-input")).toHaveFocus();
    expect(within(col("keyword")).getByRole("heading", { name: /Keyword/ })).toBeInTheDocument();
    expect(within(col("relevant")).getByRole("heading", { name: /Relevant/ })).toBeInTheDocument();
    expect(screen.queryByTestId("search-prompt")).toBeNull();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.searchRelevant).not.toHaveBeenCalled();
  });

  it("stacks on narrow screens (Keyword above Relevant) and sits side by side from 640px", () => {
    open();
    const grid = screen.getByTestId("search-columns");
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("sm:grid-cols-2");
    expect(grid.firstElementChild).toBe(col("keyword"));
    expect(grid.lastElementChild).toBe(col("relevant"));
  });

  it("Keyword follows the typing with a 150 ms debounce: one request for the last query", async () => {
    open();
    await typeFast("deb");
    expect(mocks.search).not.toHaveBeenCalled();
    await advance(149);
    expect(mocks.search).not.toHaveBeenCalled();
    await advance(1);
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search.mock.calls[0]![0]).toBe("deb");
    // typing on restarts the wait and drops the stale request
    await user.type(screen.getByTestId("search-input"), "ounce");
    await advance(150);
    expect(mocks.search).toHaveBeenCalledTimes(2);
    expect(mocks.search.mock.calls[1]![0]).toBe("debounce");
  });

  it("Keyword lists newest first, with «…» rendered as <mark> and no raw guillemets", async () => {
    open();
    await typeFast("debounce");
    await advance(150);
    const hits = within(col("keyword")).getAllByTestId("search-hit");
    expect(hits.map((h) => within(h).getByTestId("search-hit-title").textContent)).toEqual(["Search box design", "Older notes"]);
    const snippet = within(hits[0]!).getByTestId("search-snippet");
    expect(snippet.querySelector("mark")?.textContent).toBe("debounce");
    expect(snippet.textContent).toBe("a debounce of 200 ms is fine");
    expect(col("keyword").textContent).not.toMatch(/[«»]/);
  });

  it("leaves a subagent's session out of both columns", async () => {
    const kid = (n: number, title: string, extra: Partial<SearchHit> = {}) => hit(n, title, "2026-10-31T10:00:00Z", extra, { parentSessionId: ID(1) });
    mocks.search.mockResolvedValue({ hits: [...keywordHits, kid(5, "Child keyword", { snippet: "«debounce»" })] });
    mocks.searchRelevant.mockResolvedValue({ hits: [...relevantHits, kid(6, "Child relevant", { reason: "r" })], model: "claude-haiku-5-5", cached: false });
    open();
    await typeFast("debounce");
    await advance(600);
    await advance(0);
    expect(within(col("keyword")).getAllByTestId("search-hit")).toHaveLength(2);
    expect(within(col("relevant")).getAllByTestId("search-hit")).toHaveLength(2);
    expect(screen.queryByText("Child keyword")).toBeNull();
    expect(screen.queryByText("Child relevant")).toBeNull();
  });

  it("Relevant waits 600 ms after typing stops, shows a skeleton meanwhile, then title, date and the one-line reason", async () => {
    open();
    await typeFast("debounce");
    expect(within(col("relevant")).getByTestId("relevant-skeleton")).toBeInTheDocument();
    await advance(599);
    expect(mocks.searchRelevant).not.toHaveBeenCalled();
    await advance(1);
    expect(mocks.searchRelevant).toHaveBeenCalledTimes(1);
    expect(mocks.searchRelevant.mock.calls[0]![0]).toBe("debounce");
    await advance(0);
    expect(within(col("relevant")).queryByTestId("relevant-skeleton")).not.toBeInTheDocument();
    const hits = within(col("relevant")).getAllByTestId("search-hit");
    expect(hits).toHaveLength(2);
    const first = hits[0]!;
    expect(within(first).getByTestId("search-hit-title")).toHaveTextContent("Typing delay");
    expect(within(first).getByTestId("search-hit-date").textContent).toMatch(/Jan 15/);
    expect(within(first).getByTestId("search-reason")).toHaveTextContent("Discusses how long to wait after typing.");
    // the right column shows reasons, not snippets
    expect(within(first).queryByTestId("search-snippet")).not.toBeInTheDocument();
  });

  it("typing again within the 600 ms asks Relevant only once, for the final query", async () => {
    open();
    await typeFast("deb");
    await advance(400);
    await user.type(screen.getByTestId("search-input"), "ounce");
    await advance(599);
    expect(mocks.searchRelevant).not.toHaveBeenCalled();
    await advance(1);
    expect(mocks.searchRelevant).toHaveBeenCalledTimes(1);
    expect(mocks.searchRelevant.mock.calls[0]![0]).toBe("debounce");
  });

  it("caches Relevant per query on the client: the same query again is instant and asks nothing", async () => {
    open();
    const input = await typeFast("debounce");
    await advance(600);
    expect(mocks.searchRelevant).toHaveBeenCalledTimes(1);
    await user.clear(input);
    await advance(10);
    expect(within(col("relevant")).queryAllByTestId("search-hit")).toHaveLength(0);
    await user.type(input, "debounce");
    await advance(0);
    // no skeleton, no wait: straight from the cache
    expect(within(col("relevant")).queryByTestId("relevant-skeleton")).not.toBeInTheDocument();
    expect(within(col("relevant")).getAllByTestId("search-hit")).toHaveLength(2);
    await advance(1000);
    expect(mocks.searchRelevant).toHaveBeenCalledTimes(1);
  });

  it("arrow keys walk the left list and then the right one; Enter opens the highlighted session; Esc closes", async () => {
    open();
    const input = await typeFast("debounce");
    await advance(600);
    const options = () => screen.getAllByTestId("search-hit");
    expect(options().map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
    await user.keyboard("{ArrowDown}");
    expect(options().map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
    await user.keyboard("{ArrowDown}"); // into the right column
    expect(options()[2]).toHaveAttribute("aria-selected", "true");
    expect(options()[2]!.getAttribute("data-kind")).toBe("relevant");
    expect(input).toHaveAttribute("aria-activedescendant", "search-relevant-0");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}"); // stops at the last one
    expect(options()[3]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(options()[0]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}"); // the first Relevant hit
    expect(screen.getByTestId("where")).toHaveTextContent(`/s/${ID(3)}`);
    expect(useApp.getState().searchOpen).toBe(false);
    expect(useApp.getState().mode).toBe("chat");
  });

  it("Enter on the first Keyword hit opens it, a click opens any hit, and Esc closes without navigating", async () => {
    open();
    await typeFast("debounce");
    await advance(600);
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("where")).toHaveTextContent(`/s/${ID(2)}`); // newest keyword hit first

    act(() => useApp.setState({ searchOpen: true }));
    await advance(0);
    await user.type(screen.getByTestId("search-input"), "again");
    await advance(600);
    await user.click(within(col("relevant")).getAllByTestId("search-hit")[1]!);
    expect(screen.getByTestId("where")).toHaveTextContent(`/s/${ID(4)}`);

    act(() => useApp.setState({ searchOpen: true }));
    await advance(0);
    await user.keyboard("{Escape}");
    expect(useApp.getState().searchOpen).toBe(false);
    expect(screen.getByTestId("where")).toHaveTextContent(`/s/${ID(4)}`);
  });

  it("no API credits (503) turns the right column into one muted line and stops asking", async () => {
    mocks.searchRelevant.mockRejectedValue(new ApiError(503, "No API key", "api_unavailable"));
    open();
    const input = await typeFast("debounce");
    await advance(600);
    expect(within(col("relevant")).getByTestId("search-unavailable")).toHaveTextContent("Relevant search needs API credits.");
    expect(within(col("relevant")).queryAllByTestId("search-hit")).toHaveLength(0);
    expect(within(col("keyword")).getAllByTestId("search-hit")).toHaveLength(2); // the left column is untouched
    await user.type(input, " more");
    await advance(1500);
    expect(mocks.searchRelevant).toHaveBeenCalledTimes(1);
    expect(within(col("relevant")).getByTestId("search-unavailable")).toBeInTheDocument();
  });

  it("when the account already says there are no API credits the right column says so without a request", async () => {
    useApp.setState({ me: { user: { name: "alice" }, apiAvailable: false } as never });
    open();
    await typeFast("debounce");
    await advance(1500);
    expect(mocks.searchRelevant).not.toHaveBeenCalled();
    expect(within(col("relevant")).getByTestId("search-unavailable")).toBeInTheDocument();
    expect(mocks.search).toHaveBeenCalledTimes(1);
  });

  it("one short line per empty state, and one for a failed Keyword search", async () => {
    mocks.search.mockResolvedValue({ hits: [] });
    mocks.searchRelevant.mockResolvedValue({ hits: [], model: "m", cached: false });
    open();
    await typeFast("zzz");
    await advance(600);
    expect(within(col("keyword")).getByTestId("search-empty-keyword")).toHaveTextContent("No matches.");
    expect(within(col("relevant")).getByTestId("search-empty-relevant")).toHaveTextContent("Nothing relevant.");

    mocks.search.mockRejectedValue(new ApiError(500, "boom"));
    await user.type(screen.getByTestId("search-input"), "q");
    await advance(600);
    expect(within(col("keyword")).getByTestId("search-error-keyword")).toHaveTextContent("Search failed.");
  });

  it("starts empty every time it opens", async () => {
    open();
    await typeFast("debounce");
    await advance(600);
    act(() => useApp.setState({ searchOpen: false }));
    await advance(0);
    act(() => useApp.setState({ searchOpen: true }));
    await advance(0);
    expect(screen.getByTestId("search-input")).toHaveValue("");
    expect(screen.queryAllByTestId("search-hit")).toHaveLength(0);
  });
});
