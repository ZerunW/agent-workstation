/**
 * Which browser tools agents get, and how the hub's permission layer should treat them.
 *
 *   read  — looks at or moves around the web without acting on a page: navigate, back, snapshot,
 *           screenshot, waiting, console/network logs, tab list/new/select, scrolling, resizing the viewport.
 *   act   — acts on a page as the user (logged-in profile): click, type, keys, hover, drag, select, checkboxes, forms,
 *           file upload, page JavaScript (evaluate), dialogs, closing tabs.
 *
 * The table is also an allowlist: the MCP gateway hides and refuses every tool that is not listed (new tools in a
 * future @playwright/mcp stay off until classified here). Deliberately absent:
 *   browser_run_code_unsafe — runs JavaScript in the MCP server process (the hub!), RCE-equivalent;
 *   storage/cookie/route/devtools/testing tool groups — not enabled;
 *   CLI-only ("skill") tools such as browser_reload, browser_navigate_forward, browser_check — not offered over MCP
 *   by @playwright/mcp 0.0.84 (test/mcp.test.ts checks this table against the installed package).
 */

export type BrowserToolClass = "read" | "act";

export const BROWSER_TOOL_POLICY: Readonly<Record<string, BrowserToolClass>> = Object.freeze({
  // navigation (read)
  browser_navigate: "read",
  browser_navigate_back: "read",
  // observing (read)
  browser_snapshot: "read",
  browser_take_screenshot: "read",
  browser_find: "read",
  browser_wait_for: "read",
  browser_console_messages: "read",
  browser_network_requests: "read",
  browser_network_request: "read",
  browser_tabs: "read", // action "close" → act, see classifyBrowserTool
  browser_resize: "read",
  browser_close: "read", // only resets the agent's MCP state; the shared browser keeps running
  browser_mouse_wheel: "read", // vision capability: scrolling
  browser_pdf_save: "read", // pdf capability
  // acting on the page
  browser_click: "act",
  browser_type: "act",
  browser_press_key: "act",
  browser_hover: "act",
  browser_drag: "act",
  browser_drop: "act",
  browser_select_option: "act",
  browser_fill_form: "act",
  browser_file_upload: "act",
  browser_evaluate: "act",
  browser_handle_dialog: "act",
  browser_emulate_media: "act",
  browser_mouse_click_xy: "act", // vision capability
  browser_mouse_move_xy: "act",
  browser_mouse_drag_xy: "act",
  browser_mouse_down: "act",
  browser_mouse_up: "act",
});

/** `mcp__browser__browser_click`, `browser/browser_click`, `browser.browser_click` → `browser_click`. */
export function stripMcpPrefix(name: string): string {
  const i = name.lastIndexOf("browser_");
  return i > 0 && /^browser_[a-z0-9_]+$/.test(name.slice(i)) ? name.slice(i) : name;
}

/**
 * Permission class of a browser tool call, or null when the tool is not offered (unknown or blocked — the gateway
 * refuses those anyway). Accepts prefixed names. `args` refines `browser_tabs` (closing a tab acts).
 */
export function classifyBrowserTool(name: string, args?: unknown): BrowserToolClass | null {
  const tool = stripMcpPrefix(name);
  const cls = Object.prototype.hasOwnProperty.call(BROWSER_TOOL_POLICY, tool) ? BROWSER_TOOL_POLICY[tool]! : null;
  if (tool === "browser_tabs" && args && typeof args === "object" && (args as { action?: unknown }).action === "close") return "act";
  return cls;
}

export const isAllowedBrowserTool = (name: string): boolean => classifyBrowserTool(name) !== null;
