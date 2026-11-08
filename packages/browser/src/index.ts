/**
 * @agent-workstation/browser — the per-user server browser (headless Chromium + Playwright MCP for agents + CDP live view).
 * In-process library for packages/hub; no routes. See README.md.
 */
export { BrowserManager, type BrowserFrame, type McpEndpoint, type BrowserManagerEvents, type BrowserManagerDeps, type SiteAllowed } from "./manager.js";
export { siteNotAllowedMessage } from "./mcp/gateway.js";
export {
  resolveBrowserConfig,
  autoMaxConcurrent,
  effectiveMaxConcurrent,
  DEFAULT_BROWSER_CONFIG,
  type BrowserConfig,
  type BrowserConfigInput,
  type ChromiumFlavor,
  type McpCapability,
} from "./config.js";
export { BrowserError, isBrowserError, type BrowserErrorCode } from "./errors.js";
export { BROWSER_TOOL_POLICY, classifyBrowserTool, isAllowedBrowserTool, stripMcpPrefix, type BrowserToolClass } from "./mcp/policy.js";
export { resolveExecutable, chromiumArgs, playwrightCacheDir, spawnChromium, type BrowserLauncher, type LaunchSpec, type LaunchedBrowser, type ResolvedExecutable } from "./launcher.js";
export { mapInput, keyDefinition, newInputState, isAllowedNavigation, type CdpCommand, type InputState } from "./input.js";
export type { CdpClient, CdpConnector } from "./cdp.js";
