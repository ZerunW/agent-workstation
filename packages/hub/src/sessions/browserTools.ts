/**
 * The server browser (@agent-workstation/browser) in agent sessions: its MCP server, the permission policy for its tools, and the
 * agents' file tools kept out of the browser's profile folder.
 *
 * `mcpServers.browser = { type: "http", url, headers }` (tools `mcp__browser__browser_*`).
 * Policy: every browser tool call first needs the website it touches to be allowed (browserSiteTarget, then
 * BrowserSites: a stored grant, an "allow this session" answer, or a browser-site card — asked in every permission
 * mode and in chats). Then (classifyBrowserTool) "read" tools run; "act" tools follow the session's permission mode (a
 * card in default mode) and are refused while the person controls the browser from the live view; tools the package
 * does not offer are refused. Chats get the read tools only; incognito chats get no browser (its profile keeps history
 * and cookies).
 */
import { isAbsolute, join, relative, resolve } from "node:path";
import { classifyBrowserTool, isAllowedNavigation, stripMcpPrefix, type BrowserToolClass } from "@agent-workstation/browser";
import { BROWSER_DIRNAME } from "../files/paths.js";

/** The MCP server name. */
export const BROWSER_SERVER = "browser";
export const BROWSER_TOOL_PREFIX = `mcp__${BROWSER_SERVER}__`;

/** What the runtime needs from the BrowserManager (adapted in hub.ts). */
export interface SessionBrowser {
  /** The MCP endpoint for a session's agent; null = no browser tools (disabled, or the endpoint is not up). */
  endpoint(user: string, sessionId: string): { url: string; headers: Record<string, string> } | null;
  /** Who acted on the user's browser last (BrowserState.controlledBy). */
  controlledBy(user: string): "agent" | "user" | null;
  /**
   * URL of the page a tool acts on: the active tab (BrowserState.url), or with `tab` the agent's tab of that index when
   * it can be told. null = no such page or not known (an unknown tab falls back to the active tab).
   */
  pageUrl(user: string, tab?: number): string | null;
}

export const BROWSER_TOOL_UNAVAILABLE = "This browser tool is not available.";
export const BROWSER_USER_CONTROL = "The user is using the browser right now (live view). Do not act on the page until they are done: wait, or ask them.";
export const BROWSER_CHAT_READ_ONLY = "In this chat the browser is read-only: you can open and look at pages, but not click, type or run scripts in them.";
export const BROWSER_DIR_DENIED = "That folder holds the server browser's profile; file tools cannot be used on it.";
export const BROWSER_BAD_URL = "Only http(s) pages (and about:blank) can be opened in the server browser.";
export const BROWSER_SITE_DENIED = "The user did not allow the browser on this website. Do not try it again unless they ask you to.";
export const BROWSER_SITE_NO_ASK = "Using the browser on this website needs the user's permission, which this session does not ask for.";

/** The wording the agents get lives in guide.ts (the Agent Workstation guide); re-exported here for the policy's callers and tests. */
export { BROWSER_CHAT_GUIDANCE, BROWSER_GUIDANCE } from "./guide.js";

/** The browser tool's class, or undefined when `toolName` is not a browser tool (null = a browser tool not offered). */
export function browserToolClass(toolName: string, input: unknown): BrowserToolClass | null | undefined {
  if (!toolName.startsWith(BROWSER_TOOL_PREFIX)) return undefined;
  return classifyBrowserTool(toolName.slice(BROWSER_TOOL_PREFIX.length), input);
}

export type BrowserVerdict = { behavior: "allow" } | { behavior: "deny"; message: string } | { behavior: "mode" };

/** The hub's decision for a browser tool call; "mode" = an act tool in a code session: the permission mode decides. */
export function browserVerdict(cls: BrowserToolClass | null, kind: "chat" | "code", controlledBy: "agent" | "user" | null): BrowserVerdict {
  if (cls === null) return { behavior: "deny", message: BROWSER_TOOL_UNAVAILABLE };
  if (cls === "read") return { behavior: "allow" };
  if (kind === "chat") return { behavior: "deny", message: BROWSER_CHAT_READ_ONLY };
  if (controlledBy === "user") return { behavior: "deny", message: BROWSER_USER_CONTROL };
  return { behavior: "mode" };
}

/**
 * Playwright MCP's own completion of a URL without a scheme (Tab.checkUrlAndNavigate): `localhost…`, `127.0.0.1…`,
 * `0.0.0.0…`, `[::1]…` → http, anything else → https.
 */
export function normalizeNavigationUrl(url: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) || /^(about|data|blob|javascript):/i.test(url)) return url;
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(url) ? `http://${url}` : `https://${url}`;
}

/** What a browser tool call needs from the site check. */
export type BrowserSiteTarget =
  /** No website involved (about:blank, no page yet). */
  | { kind: "none" }
  /** The package's navigation policy refuses the URL (only http(s) and about:blank). */
  | { kind: "refused"; message: string }
  /** The origin (scheme://host[:port]) that must be allowed. */
  | { kind: "origin"; origin: string };

/** The site-check target of a page URL. */
export function siteOfUrl(url: string | null | undefined): BrowserSiteTarget {
  if (url == null || url === "" || url === "about:blank") return { kind: "none" };
  if (!isAllowedNavigation(url)) return { kind: "refused", message: BROWSER_BAD_URL };
  return { kind: "origin", origin: new URL(url).origin };
}

/**
 * The website a browser tool call touches: `browser_navigate` (and `browser_tabs` new with a url) → the target URL's
 * origin; a tool that names a tab (`browser_tabs` select/close with an index) → that tab's page; every other tool → the
 * active tab's page. `pageUrl` is SessionBrowser.pageUrl for the session's user.
 */
export function browserSiteTarget(toolName: string, input: Record<string, unknown>, pageUrl: (tab?: number) => string | null): BrowserSiteTarget {
  const tool = stripMcpPrefix(toolName);
  const target = (url: unknown): BrowserSiteTarget => (typeof url === "string" ? siteOfUrl(normalizeNavigationUrl(url.trim())) : { kind: "refused", message: BROWSER_BAD_URL });
  if (tool === "browser_navigate") return target(input.url);
  if (tool === "browser_tabs") {
    if (input.action === "new") return input.url === undefined || input.url === null || input.url === "" ? { kind: "none" } : target(input.url);
    const index = input.index;
    if ((input.action === "select" || input.action === "close") && typeof index === "number" && Number.isInteger(index) && index >= 0) {
      return siteOfUrl(pageUrl(index) ?? pageUrl());
    }
  }
  return siteOfUrl(pageUrl());
}

const under =(path: string, dir: string): boolean => {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** True when one of `paths` (absolute, or relative to `cwd`) is inside `<root>/.browser` for one of `roots`. */
export function touchesBrowserDir(paths: unknown[], cwd: string, roots: string[]): boolean {
  for (const p of paths) {
    if (typeof p !== "string" || !p) continue;
    const clean = p.startsWith("file://") ? decodeURIComponent(p.slice("file://".length)) : p;
    const abs = resolve(cwd, clean);
    if (roots.some((r) => under(abs, join(resolve(r), BROWSER_DIRNAME)))) return true;
  }
  return false;
}

/** Claude Code's file tools and where their inputs name paths. */
export const CLAUDE_FILE_TOOLS = "Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|LS";
const CLAUDE_FILE_TOOL_SET = new Set(CLAUDE_FILE_TOOLS.split("|"));
export function claudeFileToolPaths(toolName: string, input: Record<string, unknown>): unknown[] | null {
  if (!CLAUDE_FILE_TOOL_SET.has(toolName)) return null;
  const pattern = typeof input.pattern === "string" && input.pattern.startsWith("/") ? input.pattern : undefined;
  return [input.file_path, input.notebook_path, input.path, pattern];
}
