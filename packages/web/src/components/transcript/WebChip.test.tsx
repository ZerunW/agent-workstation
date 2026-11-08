import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { assistant, session, SID, toolResult, userText } from "../../test/fixtures";
import { openToolGroups } from "../../test/groups";
import { TestRouter } from "../../test/router";
import { emptyView, insertMessages, type SessionView } from "../../lib/session-reducer";
import { attachmentLabel, parseLinks, shortUrl } from "../../lib/webTools";

vi.mock("../../store/hub", () => ({ sendPermissionResponse: vi.fn(), backfill: vi.fn(), loadEarlier: vi.fn() }));

import { Transcript } from "./Transcript";

const viewWith = (messages: ReturnType<typeof userText>[], kind: "chat" | "code" = "code", status: "idle" | "running" = "idle"): SessionView => ({ ...insertMessages(emptyView(SID, session({ status, kind })), messages), snapshotReceived: true });
const call = (name: string, input: unknown, id = "w1") => assistant(2, [{ type: "tool_use", id, name, input }]);
const renderTx = (view: SessionView) => {
  const r = render(<TestRouter><Transcript view={view} /></TestRouter>);
  openToolGroups();
  return r;
};

const LINKS = 'Web search results for query: "x"\n\nLinks: [{"title":"Alpha","url":"https://a.example/1"},{"title":"Beta","url":"https://b.example/2"}]\n\nSummary';

describe("search chip", () => {
  for (const kind of ["chat", "code"] as const) {
    it(`WebSearch in a ${kind} session: 'Searched · query' with result links`, async () => {
      renderTx(viewWith([userText(1, "q"), call("WebSearch", { query: "rust async" }), toolResult(3, "w1", LINKS)], kind));
      const chip = screen.getByTestId("web-chip");
      expect(chip).toHaveTextContent("Searched · rust async");
      expect(chip).toHaveAttribute("data-state", "done");
      expect(screen.queryByTestId("tool-card")).not.toBeInTheDocument();
      expect(screen.queryByTestId("web-chip-result")).not.toBeInTheDocument();
      await userEvent.click(within(chip).getByTestId("web-chip-toggle"));
      const links = screen.getAllByTestId("web-chip-link");
      expect(links).toHaveLength(2);
      expect(within(links[0]!).getByRole("link", { name: "Alpha" })).toHaveAttribute("href", "https://a.example/1");
    });
  }

  it("a search result falls back to collapsed raw text", async () => {
    renderTx(viewWith([userText(1, "q"), call("WebSearch", { query: "weather" }), toolResult(3, "w1", "It is sunny.")], "chat"));
    expect(screen.getByTestId("web-chip")).toHaveTextContent("Searched · weather");
    await userEvent.click(screen.getByTestId("web-chip-toggle"));
    expect(screen.getByTestId("web-chip-result")).toHaveTextContent("It is sunny.");
  });

  it("spinner and 'Searching…' while running; danger style with collapsed error on failure", async () => {
    const a = renderTx(viewWith([userText(1, "q"), call("WebSearch", { query: "q1" })], "chat", "running"));
    expect(screen.getByTestId("web-chip")).toHaveAttribute("data-state", "pending");
    expect(screen.getByTestId("web-chip")).toHaveTextContent("Searching…");
    a.unmount();
    renderTx(viewWith([userText(1, "q"), call("WebSearch", { query: "q1" }), toolResult(3, "w1", "rate limited", true)]));
    const chip = screen.getByTestId("web-chip");
    expect(chip).toHaveAttribute("data-state", "failed");
    expect(chip.className).toContain("border-danger");
    expect(screen.queryByTestId("web-chip-result")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("web-chip-toggle"));
    expect(screen.getByTestId("web-chip-result")).toHaveTextContent("rate limited");
  });
});

describe("fetch chip", () => {
  it("WebFetch: 'Read · domain/path' linking to the URL in a new tab", () => {
    renderTx(viewWith([userText(1, "q"), call("WebFetch", { url: "https://www.example.com/docs/page?x=1", prompt: "p" }), toolResult(3, "w1", "content")]));
    const chip = screen.getByTestId("web-chip");
    expect(chip).toHaveTextContent("Read · example.com/docs/page?x=1");
    const a = within(chip).getByRole("link");
    expect(a).toHaveAttribute("href", "https://www.example.com/docs/page?x=1");
    expect(a).toHaveAttribute("target", "_blank");
  });

  it("a fetch in its running state", () => {
    renderTx(viewWith([userText(1, "q"), call("WebFetch", { url: "https://news.site/a" })], "chat", "running"));
    const chip = screen.getByTestId("web-chip");
    expect(chip).toHaveTextContent("Reading…");
    expect(chip).toHaveTextContent("news.site/a");
  });

  it("failed fetch: danger chip, error collapsed", async () => {
    renderTx(viewWith([userText(1, "q"), call("WebFetch", { url: "https://x.test/" }), toolResult(3, "w1", "404 not found", true)]));
    expect(screen.getByTestId("web-chip")).toHaveAttribute("data-state", "failed");
    await userEvent.click(screen.getByTestId("web-chip-toggle"));
    expect(screen.getByTestId("web-chip-result")).toHaveTextContent("404 not found");
  });
});

describe("attachment Read chip", () => {
  it("chat: 'Read · file name', with the page range when given", () => {
    renderTx(viewWith([userText(1, "q"), call("Read", { file_path: "/data/uploads/report.pdf", pages: "3-5" }), toolResult(3, "w1", "text")], "chat"));
    expect(screen.getByTestId("web-chip")).toHaveTextContent("Read · report.pdf (pages 3–5)");
    expect(screen.queryByTestId("tool-card")).not.toBeInTheDocument();
  });

  it("chat: no range", () => {
    renderTx(viewWith([userText(1, "q"), call("Read", { file_path: "/a/b/notes.txt" }), toolResult(3, "w1", "text")], "chat"));
    expect(screen.getByTestId("web-chip")).toHaveTextContent(/^Read · notes\.txt/);
    expect(screen.getByTestId("web-chip")).not.toHaveTextContent("pages");
  });

  it("chat: running and failed", () => {
    const a = renderTx(viewWith([userText(1, "q"), call("Read", { file_path: "/a/x.pdf" })], "chat", "running"));
    expect(screen.getByTestId("web-chip")).toHaveTextContent("Reading…");
    a.unmount();
    renderTx(viewWith([userText(1, "q"), call("Read", { file_path: "/a/x.pdf" }), toolResult(3, "w1", "no such file", true)], "chat"));
    expect(screen.getByTestId("web-chip")).toHaveAttribute("data-state", "failed");
  });

  it("code session keeps the regular tool card for Read", () => {
    renderTx(viewWith([userText(1, "q"), call("Read", { file_path: "/a/x.ts" }), toolResult(3, "w1", "code")], "code"));
    expect(screen.getByTestId("tool-card")).toHaveAttribute("data-tool", "Read");
    expect(screen.queryByTestId("web-chip")).not.toBeInTheDocument();
  });
});

describe("helpers", () => {
  it("parseLinks: JSON, markdown, bare urls, none", () => {
    expect(parseLinks(LINKS).map((l) => l.title)).toEqual(["Alpha", "Beta"]);
    expect(parseLinks("1. [One](https://o.test/1)\n2. [Two](https://t.test/2)")).toEqual([{ title: "One", url: "https://o.test/1" }, { title: "Two", url: "https://t.test/2" }]);
    expect(parseLinks("Title A - https://a.test/x")[0]).toEqual({ title: "Title A", url: "https://a.test/x" });
    expect(parseLinks("just words")).toEqual([]);
  });
  it("pages and urls", () => {
    expect(attachmentLabel({ file_path: "/a/b.pdf", pages: "7" })).toBe("b.pdf (page 7)");
    expect(attachmentLabel({ file_path: "/a/b.pdf", page_start: 2, page_end: 4 })).toBe("b.pdf (pages 2–4)");
    expect(shortUrl("https://www.a.com/" + "x".repeat(80)).length).toBeLessThanOrEqual(48);
  });
});
