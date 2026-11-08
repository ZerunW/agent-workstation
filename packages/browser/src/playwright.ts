/**
 * Lazy access to `@playwright/mcp` and the exact `playwright-core` build it ships with. Both are resolved from the MCP
 * package's own location, so the BrowserContext handed to `createConnection` comes from the same module instance the
 * MCP tools use (the workspace root also has an older playwright-core for the web e2e suite). Nothing is loaded until
 * the first MCP session or executable lookup.
 */
import { createRequire } from "node:module";

/** The subset of Playwright's API this package touches. */
export interface PwPage {
  bringToFront(): Promise<void>;
  url(): string;
}
export interface PwCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  detach(): Promise<void>;
  on(event: "event", handler: (e: { method: string; params?: any }) => void): unknown;
  on(event: "close", handler: () => void): unknown;
}
export interface PwContext {
  pages(): PwPage[];
  on(event: "page", handler: (page: PwPage) => void): void;
  on(event: "close", handler: () => void): void;
  newCDPSession(page: PwPage): Promise<PwCdpSession>;
  browser(): PwBrowser | null;
  close(): Promise<void>;
}
export interface PwBrowser {
  isConnected(): boolean;
  newBrowserCDPSession(): Promise<PwCdpSession>;
  on(event: "disconnected", handler: () => void): void;
}
export interface PwLaunchOptions {
  executablePath: string;
  headless: boolean;
  args: string[];
  env: Record<string, string>;
  /** null = no emulated viewport (the window size decides). */
  viewport: null;
  chromiumSandbox: boolean;
  handleSIGINT: boolean;
  handleSIGTERM: boolean;
  handleSIGHUP: boolean;
  timeout: number;
  logger?: { isEnabled(name: string, severity: string): boolean; log(name: string, severity: string, message: string | Error): void };
}
export interface PwChromium {
  executablePath(): string;
  /** Playwright starts Chromium with `--remote-debugging-pipe` (fds 3/4 owned by this process); no TCP port. */
  launchPersistentContext(userDataDir: string, options: PwLaunchOptions): Promise<PwContext>;
}

/** What `createConnection` resolves to: an MCP SDK `Server` (from Playwright's bundled copy of the SDK). */
export interface McpServerLike {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}
export type CreateConnection = (config: Record<string, unknown>, contextGetter: () => Promise<PwContext>) => Promise<McpServerLike>;

export interface PlaywrightBundle {
  createConnection: CreateConnection;
  chromium: PwChromium;
  mcpVersion: string;
  coreVersion: string;
}

let cached: PlaywrightBundle | undefined;

export function loadPlaywright(): PlaywrightBundle {
  if (cached) return cached;
  const req = createRequire(import.meta.url);
  const mcpPkgPath = req.resolve("@playwright/mcp/package.json");
  const mcpReq = createRequire(mcpPkgPath);
  const mcp = mcpReq("./index.js") as { createConnection: CreateConnection };
  const core = mcpReq("playwright-core") as { chromium: PwChromium };
  cached = {
    createConnection: mcp.createConnection,
    chromium: core.chromium,
    mcpVersion: (mcpReq("./package.json") as { version: string }).version,
    coreVersion: (mcpReq("playwright-core/package.json") as { version: string }).version,
  };
  return cached;
}
