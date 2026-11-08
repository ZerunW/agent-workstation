/** Error codes the hub maps to HTTP statuses / WebSocket `error` events. */
export type BrowserErrorCode =
  /** `[browser] enabled = false`. → 503 */
  | "disabled"
  /** Username fails `[a-z0-9_-]{1,32}`. → 400 */
  | "bad_user"
  /** `<usersRoot>/<user>` does not exist (the package never creates user folders). → 404 */
  | "no_user_dir"
  /** No Chromium binary found (run `npm run install-browser -w packages/browser`). → 503 */
  | "not_installed"
  /** `maxConcurrent` browsers are already running for other users. → 503 */
  | "too_many"
  /** Less than `minFreeMemoryMB` available. → 503 */
  | "low_memory"
  /** Chromium exited or never printed its DevTools endpoint. → 500 */
  | "launch_failed"
  /** Another Chromium (not started by this manager) holds the profile lock. → 409 */
  | "profile_in_use"
  /** input() / navigation while the user's browser is stopped. → 409 */
  | "not_running"
  /** Only http:, https: and about:blank can be opened from the live view. → 400 */
  | "bad_url"
  /** mcpEndpoint() before start(). → 500 */
  | "not_started";

export class BrowserError extends Error {
  readonly code: BrowserErrorCode;
  constructor(code: BrowserErrorCode, message: string) {
    super(message);
    this.name = "BrowserError";
    this.code = code;
  }
}

export const isBrowserError = (e: unknown): e is BrowserError => e instanceof BrowserError;
