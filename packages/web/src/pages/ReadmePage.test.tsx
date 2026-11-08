import type { ReadmeDocName, ReadmeDocResponse } from "@agent-workstation/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readmeDoc: vi.fn(), readmeAsk: vi.fn(), appReleases: vi.fn(), detectDevice: vi.fn(), whoami: vi.fn() }));
vi.mock("../lib/api", async (orig) => {
  const actual = await orig<typeof import("../lib/api")>();
  return { ...actual, api: { ...actual.api, readmeDoc: mocks.readmeDoc, readmeAsk: mocks.readmeAsk, appReleases: mocks.appReleases, whoami: mocks.whoami } };
});
vi.mock("../lib/appPlatform", async (orig) => ({ ...(await orig<typeof import("../lib/appPlatform")>()), detectDevice: mocks.detectDevice }));

import App from "../App";
import { ApiError } from "../lib/api";
import { useApp } from "../store/app";
import { TestRouter } from "../test/router";
import DownloadPage from "./DownloadPage";
import PickUserPage from "./PickUserPage";
import ReadmePage from "./ReadmePage";

const DOCS: Record<ReadmeDocName, string> = {
  features: [
    "# Agent Workstation",
    "",
    "Intro text.",
    "",
    "## Chat and Code",
    "",
    "Body one.",
    "",
    "<details>",
    "<summary>Permission modes</summary>",
    "",
    "Folded **detail** text.",
    "",
    "</details>",
    "",
    "## Usage",
    "",
    "Body two.",
  ].join("\n"),
  "getting-started": "# Get started\n\n## Install\n\nInstall steps.\n\n## Sign in\n\nSign-in steps.\n",
};
const respond = (assistant: boolean) => async (doc: ReadmeDocName): Promise<ReadmeDocResponse> => ({ doc, markdown: DOCS[doc], assistant });

const renderAt = (path = "/readme") =>
  render(
    <TestRouter initialEntries={[path]}>
      <Routes>
        <Route path="/readme/*" element={<ReadmePage />} />
        <Route path="/" element={<div data-testid="home" />} />
      </Routes>
    </TestRouter>,
  );

/** A Response whose SSE body the test feeds chunk by chunk. */
function sseResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push: (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    end: () => controller.close(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useApp.getState().setUser(null);
  mocks.readmeDoc.mockImplementation(respond(false));
  mocks.appReleases.mockResolvedValue([]);
  mocks.detectDevice.mockResolvedValue({ mac: false });
  mocks.whoami.mockResolvedValue({ tailscale: null, users: [], suggested: null });
  window.history.pushState({}, "", "/");
});

describe("ReadmePage", () => {
  it("shows two tabs; Features is the page at /readme and loads that doc", async () => {
    renderAt("/readme");
    expect(await screen.findByRole("heading", { name: "Chat and Code" })).toBeInTheDocument();
    expect(mocks.readmeDoc).toHaveBeenCalledWith("features", expect.anything());
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Features", "Get started"]);
    expect(tabs[0]).toHaveAttribute("href", "/readme");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("href", "/readme/get-started");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
  });

  it("Get started is /readme/get-started and loads getting-started; the tab switches pages", async () => {
    renderAt("/readme");
    await screen.findByRole("heading", { name: "Chat and Code" });
    await userEvent.click(screen.getByRole("tab", { name: "Get started" }));
    expect(await screen.findByRole("heading", { name: "Install" })).toBeInTheDocument();
    expect(mocks.readmeDoc).toHaveBeenCalledWith("getting-started", expect.anything());
    expect(screen.queryByRole("heading", { name: "Chat and Code" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Get started" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Features" }));
    expect(await screen.findByRole("heading", { name: "Chat and Code" })).toBeInTheDocument();
  });

  it("opens the Get started page directly and sends an unknown subpath to /readme", async () => {
    const { unmount } = renderAt("/readme/get-started");
    expect(await screen.findByRole("heading", { name: "Install" })).toBeInTheDocument();
    unmount();
    renderAt("/readme/nope");
    expect(await screen.findByRole("heading", { name: "Chat and Code" })).toBeInTheDocument();
  });

  it("renders <details> as a folded disclosure row with Markdown inside", async () => {
    renderAt();
    const summary = await screen.findByText("Permission modes");
    expect(summary.tagName).toBe("SUMMARY");
    const details = summary.closest("details")!;
    expect(details).toHaveClass("readme-details");
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("detail").tagName).toBe("STRONG");
    // the raw tags never show up as text
    expect(screen.queryByText(/<details>/)).toBeNull();
  });

  it("builds a table of contents from the ## headings, linking to their anchors", async () => {
    renderAt();
    const toc = await screen.findByTestId("readme-toc");
    const links = within(toc).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Chat and Code", "Usage"]);
    expect(links[0]).toHaveAttribute("href", "#readme-chat-and-code");
    const target = screen.getByRole("heading", { name: "Usage" });
    expect(target).toHaveAttribute("id", "readme-usage");
    const scroll = vi.spyOn(target, "scrollIntoView");
    await userEvent.click(links[1]);
    expect(scroll).toHaveBeenCalled();
  });

  it("says so when a page cannot be loaded, and retries", async () => {
    mocks.readmeDoc.mockRejectedValueOnce(new Error("down"));
    renderAt();
    expect(await screen.findByTestId("readme-failed")).toHaveTextContent("Couldn't load this page");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Chat and Code" })).toBeInTheDocument();
  });

  it("is reachable at /readme and /readme/get-started without signing in", async () => {
    window.history.pushState({}, "", "/readme/get-started");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Install" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/readme/get-started");
    expect(useApp.getState().user).toBeNull();
  });
});

describe("docs assistant", () => {
  const openPanel = async () => {
    renderAt();
    await userEvent.click(await screen.findByRole("button", { name: "Ask about Agent Workstation" }));
    return screen.getByTestId("readme-panel");
  };

  it("is not rendered at all when assistant is false", async () => {
    renderAt();
    await screen.findByRole("heading", { name: "Chat and Code" });
    expect(screen.queryByTestId("readme-assistant")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask about Agent Workstation" })).toBeNull();
  });

  it("is a round button that opens an 'Ask about Agent Workstation' panel when assistant is true", async () => {
    mocks.readmeDoc.mockImplementation(respond(true));
    renderAt();
    const fab = await screen.findByTestId("readme-fab");
    expect(fab).toHaveClass("rounded-full");
    expect(screen.queryByTestId("readme-panel")).toBeNull();
    await userEvent.click(fab);
    const panel = screen.getByTestId("readme-panel");
    expect(within(panel).getByRole("heading", { name: "Ask about Agent Workstation" })).toBeInTheDocument();
    expect(within(panel).getByTestId("readme-input")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("streams the answer as Markdown, sends the conversation, and clear empties it", async () => {
    mocks.readmeDoc.mockImplementation(respond(true));
    const s = sseResponse();
    mocks.readmeAsk.mockResolvedValueOnce(s.response);
    const panel = await openPanel();
    await userEvent.type(within(panel).getByTestId("readme-input"), "What is Agent Workstation?{Enter}");

    expect(mocks.readmeAsk).toHaveBeenCalledWith({ messages: [{ role: "user", text: "What is Agent Workstation?" }] }, expect.any(AbortSignal));
    expect(within(panel).getByTestId("readme-msg-user")).toHaveTextContent("What is Agent Workstation?");
    expect(within(panel).getByTestId("readme-input")).toHaveValue("");

    await act(async () => s.push("delta", { text: "It is a **work" }));
    await waitFor(() => expect(within(panel).getByTestId("readme-msg-assistant")).toHaveTextContent("It is a **work"));
    await act(async () => {
      s.push("delta", { text: "station**." });
      s.push("done", { costUsd: 0.01 });
      s.end();
    });
    await waitFor(() => expect(within(panel).getByText("workstation").tagName).toBe("STRONG"));
    expect(within(panel).queryByTestId("readme-error")).toBeNull();

    // the next question carries the earlier turns
    const s2 = sseResponse();
    mocks.readmeAsk.mockResolvedValueOnce(s2.response);
    await userEvent.type(within(panel).getByTestId("readme-input"), "More?{Enter}");
    expect(mocks.readmeAsk.mock.calls[1][0]).toEqual({
      messages: [
        { role: "user", text: "What is Agent Workstation?" },
        { role: "assistant", text: "It is a **workstation**." },
        { role: "user", text: "More?" },
      ],
    });
    await act(async () => {
      s2.push("done", {});
      s2.end();
    });

    await userEvent.click(within(panel).getByRole("button", { name: "Clear" }));
    expect(within(panel).queryByTestId("readme-msg-user")).toBeNull();
    expect(within(panel).queryByTestId("readme-msg-assistant")).toBeNull();
  });

  it("keeps the conversation when the panel is closed and reopened", async () => {
    mocks.readmeDoc.mockImplementation(respond(true));
    const s = sseResponse();
    mocks.readmeAsk.mockResolvedValueOnce(s.response);
    const panel = await openPanel();
    await userEvent.type(within(panel).getByTestId("readme-input"), "Hi{Enter}");
    await act(async () => {
      s.push("delta", { text: "Hello" });
      s.push("done", {});
      s.end();
    });
    await userEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("readme-panel")).toBeNull();
    await userEvent.click(screen.getByTestId("readme-fab"));
    expect(within(screen.getByTestId("readme-panel")).getByText("Hello")).toBeInTheDocument();
  });

  it("shows one muted line on an error and drops the empty answer", async () => {
    mocks.readmeDoc.mockImplementation(respond(true));
    mocks.readmeAsk.mockRejectedValueOnce(new ApiError(500, "boom", "internal"));
    const panel = await openPanel();
    await userEvent.type(within(panel).getByTestId("readme-input"), "Hi{Enter}");
    const err = await within(panel).findByTestId("readme-error");
    expect(err).toHaveTextContent("Couldn't get an answer");
    expect(err).toHaveClass("text-muted");
    expect(within(panel).queryByTestId("readme-msg-assistant")).toBeNull();
    expect(within(panel).getByTestId("readme-msg-user")).toBeInTheDocument();
  });

  it("an error event in the stream is the same muted line", async () => {
    mocks.readmeDoc.mockImplementation(respond(true));
    const s = sseResponse();
    mocks.readmeAsk.mockResolvedValueOnce(s.response);
    const panel = await openPanel();
    await userEvent.type(within(panel).getByTestId("readme-input"), "Hi{Enter}");
    await act(async () => {
      s.push("delta", { text: "Partial" });
      s.push("error", { code: "internal", message: "x" });
      s.end();
    });
    expect(await within(panel).findByTestId("readme-error")).toBeInTheDocument();
    expect(within(panel).getByTestId("readme-msg-assistant")).toHaveTextContent("Partial");
  });

  it("a 403 makes the whole assistant disappear", async () => {
    mocks.readmeDoc.mockImplementation(respond(true));
    mocks.readmeAsk.mockRejectedValueOnce(new ApiError(403, "no credits", "api_unavailable"));
    const panel = await openPanel();
    await userEvent.type(within(panel).getByTestId("readme-input"), "Hi{Enter}");
    await waitFor(() => expect(screen.queryByTestId("readme-assistant")).toBeNull());
    expect(screen.queryByTestId("readme-panel")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask about Agent Workstation" })).toBeNull();
    // switching tabs does not bring it back
    await userEvent.click(screen.getByRole("tab", { name: "Get started" }));
    await screen.findByRole("heading", { name: "Install" });
    expect(screen.queryByTestId("readme-assistant")).toBeNull();
  });

  it("a 401 hides the assistant like a 403", async () => {
    mocks.readmeDoc.mockImplementation(respond(true));
    mocks.readmeAsk.mockRejectedValueOnce(new ApiError(401, "send the user header", "user_required"));
    const panel = await openPanel();
    await userEvent.type(within(panel).getByTestId("readme-input"), "Hi{Enter}");
    await waitFor(() => expect(screen.queryByTestId("readme-assistant")).toBeNull());
  });
});

describe("entry points", () => {
  it("the login page links to /readme", async () => {
    render(
      <TestRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<PickUserPage />} />
        </Routes>
      </TestRouter>,
    );
    expect(await screen.findByTestId("login-docs")).toHaveAttribute("href", "/readme");
    expect(screen.getByTestId("login-docs")).toHaveTextContent("Docs");
  });

  it("the download page links to /readme", async () => {
    render(<DownloadPage />);
    expect(await screen.findByTestId("download-docs")).toHaveAttribute("href", "/readme");
  });
});
