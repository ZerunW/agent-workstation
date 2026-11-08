# @agent-workstation/browser

The per-user **server browser**: one headless Chromium per user with a persistent profile (logins stick), driven by
Claude through a browser-automation MCP endpoint, and watched and controlled live by the user (CDP
screencast + input). An in-process library for `packages/hub`: no routes, no WebSocket of its own.

```sh
npm run typecheck -w packages/browser
npm test          -w packages/browser   # unit tests (fake CDP) + real-Chromium integration (skipped if none installed)
npm run build     -w packages/browser   # dist/ with .d.ts (the hub imports dist)
npm run install-browser -w packages/browser            # chrome-headless-shell for the pinned playwright-core
npm run install-browser -w packages/browser -- all     # + the full Chromium (flavor = "chromium")
```

## Pieces

| File | Role |
|---|---|
| `src/manager.ts` | `BrowserManager`: lifecycle (on demand, one per user, idle stop, `maxConcurrent`, free-memory floor), state events, frames, input, MCP endpoint |
| `src/launcher.ts` | **The only place that starts a browser**: binary lookup, Chromium switches, minimal env; launches through playwright-core's `launchPersistentContext` (`--remote-debugging-pipe`, no port) |
| `src/cdp.ts` | CDP client derived from that BrowserContext (browser-level session for `Target.*`/`Browser.*`, one per-tab session for screencast and input) |
| `src/instance.ts` | One running Chromium: CDP client, tab tracking, viewport, live view, person input queue |
| `src/targets.ts` | Tabs and the "active" tab the live view follows |
| `src/liveView.ts`, `src/frameGate.ts` | `Page.startScreencast` on the active tab while someone watches; rate limit + acks + final-state capture |
| `src/input.ts` | `BrowserInput` → `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText` |
| `src/mcp/gateway.ts` | Loopback HTTP endpoint (Streamable HTTP, bearer token per user) hosting `@playwright/mcp` in-process |
| `src/mcp/shim.ts` | Transport shim: roots = the user's folder, tool allowlist, activity reporting |
| `src/mcp/policy.ts` | Tool classification (`read` / `act`) = allowlist |
| `src/profileLock.ts` | pid file so a second hub or an orphan never shares a profile (headless-shell has no ProcessSingleton); `ensurePrivateDir` (0700, owned by the running account) |

## Hub integration

```ts
import { BrowserManager, BrowserError, classifyBrowserTool } from "@agent-workstation/browser";

const browsers = new BrowserManager({ usersRoot: cfg.paths.users_root, ...cfg.browser /* camelCase */ }, { log });
await browsers.start();                       // binds the MCP endpoint on 127.0.0.1:<random>
process.on("SIGTERM", () => browsers.close()); // stops all browsers gracefully (profiles stay)

// REST
GET  /api/browser       → browsers.state(user)
POST /api/browser/start → await browsers.ensure(user)
POST /api/browser/stop  → await browsers.stop(user)

// WebSocket
browsers.on("state", (user, state) => sendToUser(user, { type: "browser_state", state }));
on browser_view {on:true, maxWidth}: unsub = browsers.subscribeFrames(user, connId, { maxWidth }, (f) => {
  if (ws.bufferedAmount < 1_000_000) ws.send(JSON.stringify({ type: "browser_frame", ...f })); // drop when slow
});
on browser_view {on:false} or socket close: unsub()
on browser_input {input}: await browsers.input(user, input)   // BrowserError → { type: "error", code: "browser_" + e.code }

// Agents
const ep = browsers.mcpEndpoint(user, { sessionId });   // { url, headers }
claudeOptions.mcpServers.browser = { type: "http", url: ep.url, headers: ep.headers };   // tools mcp__browser__browser_*
permission layer: classifyBrowserTool(toolName, args) → "read" | "act" | null (null = not offered)
```

`BrowserError.code` → HTTP: `disabled` 503, `bad_user` 400, `no_user_dir` 404, `not_installed` 503, `too_many` 503,
`low_memory` 503, `launch_failed` 500, `profile_in_use` 409, `not_running` 409, `bad_url` 400, `not_started` 500.

### Semantics

- **Start** on `ensure()` (REST start, or the first agent tool call: the MCP endpoint starts Chromium on demand).
  `subscribeFrames` never starts the browser; viewers registered early get frames once it runs.
- **Stop** after `idleMinutes` with no tool call, no person input and no viewer (a running tool call or an open live
  view holds it), on `stop()`, or on `close()`. Stopping is `Browser.close` (cookies flushed) → SIGTERM → SIGKILL.
  The profile `<usersRoot>/<user>/.browser/profile` is **never deleted** by this package; agent output files
  (auto-named screenshots, PDFs) go to `<usersRoot>/<user>/.browser/output` and are never evicted.
- **MCP sessions outlive the browser**: after an idle stop the next tool call relaunches Chromium and reconnects.
- **controlledBy**: `"agent"` on every MCP tool call (`sessionId` from the `X-Workstation-Session` header the endpoint
  carries), `"user"` on live-view input, `null` again `controlIdleSeconds` after the last action or when stopped.
- **Active tab** (what the live view shows and input goes to): a new tab or popup becomes active; the agent selecting a
  tab (`browser_tabs select`) switches to it; closing the active tab falls back to the most recently active one.
- **Frames**: `{ data (base64 JPEG), width, height (the page's CSS viewport: the same space as input coordinates),
  at (ISO) }`. At most `screencast.maxFps` (15) per second, always the newest picture; nothing while nobody watches.
- **Input**: mouse `down`/`up` with the client's `clickCount` → `mousePressed`/`mouseReleased` (the page derives
  click/dblclick natively); `click`/`dblclick` still accepted. Held buttons/modifiers are tracked per tab.
  Meta+letter is sent as Control+letter (Mac viewer, Linux browser). Live-view navigation: http(s) and about:blank only.

## Agent tools (`@playwright/mcp` 0.0.84, in-process)

Offered (see `src/mcp/policy.ts`): **read**: `browser_navigate`, `browser_navigate_back`, `browser_snapshot`,
`browser_take_screenshot`, `browser_find`, `browser_wait_for`, `browser_console_messages`, `browser_network_requests`,
`browser_network_request`, `browser_tabs` (close → act), `browser_resize`, `browser_close` (only resets the agent's MCP
state); **act**: `browser_click`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_drag`, `browser_drop`,
`browser_select_option`, `browser_fill_form`, `browser_file_upload`, `browser_evaluate`, `browser_handle_dialog`,
`browser_emulate_media`. Optional capability groups: `vision` (coordinate mouse tools; `browser_mouse_wheel` is read)
and `pdf` (`browser_pdf_save`, read).

Never offered: `browser_run_code_unsafe` (runs JavaScript in the MCP server process, i.e. the hub: RCE-equivalent),
and anything not in the table (a future @playwright/mcp tool stays hidden until classified). File access by the
tools (uploads, explicit screenshot names) is confined to `<usersRoot>/<user>` and the output dir.

## Measured on a small arm64 server (8 GB)

| | chrome-headless-shell (default) | full Chromium (`flavor = "chromium"`) |
|---|---|---|
| launch + attach | 0.2 s | 0.6 s |
| idle (about:blank), PSS of the process tree | 176 MB (7 processes) | 371 MB (9) |
| one tab on github.com | 373 MB | 685 MB |
| hub process, after loading Playwright MCP | +~30 MB RSS (once) | same |
| live view, animated page, 1280 px JPEG q60 | 15.2 fps, ~9 KB/frame, Chromium ~136 % of one core | 15.2 fps, ~125 % |
| same page, nobody watching | 0 frames, ~20 % | ~19 % |
| person click → first new frame | 89 ms | 89 ms |
| MCP `browser_navigate` (local page) / `browser_click` | 0.4 s / 0.9 s | 0.4 s / 0.8 s |

Why the frame gate: `everyNthFrame > 1` loses the final state of a change on a static page, and Chromium captures
nothing while 3 frames are unacknowledged. The gate keeps `everyNthFrame = 1`, delivers ≤ `maxFps`, releases one ack
per tick (Chromium then produces ~`maxFps` instead of 60 fps: ~200 % → ~130 % CPU on an animated page) and, once a
throttled burst is quiet for `settleMs`, captures one screenshot so the last state always arrives.

## System requirements

Playwright's arm64 build needs these Ubuntu 22.04 packages (all present on a desktop image; list for a
minimal image): `libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2
libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libwayland-client0 libx11-6 libxcb1 libxcomposite1 libxdamage1
libxext6 libxfixes3 libxkbcommon0 libxrandr2`, fonts `fonts-liberation fonts-noto-cjk` and `fonts-noto-color-emoji`. No X server / xvfb is needed. The distro `chromium-browser` (110) is
too old and not used.

## Security notes

- The MCP endpoint listens on loopback only, checks a per-user bearer token (constant-time) and the Host header.
- **No DevTools port.** Chromium has no authentication on its DevTools port, so none is opened: the browser is
  launched by the hub through Playwright with `--remote-debugging-pipe` (fds 3/4 of the hub process). No local process
  can attach to the user's logged-in sessions; the browser also exits when the hub dies (the pipe closes). The
  manager's CDP sessions (screencast, input, tab tracking) and the agents' Playwright MCP share the one BrowserContext
  the hub launched: there is no `connectOverCDP`. `extraArgs` may not contain `--remote-debugging-*`, `--user-data-dir`
  or `--headless` (config error), and the tests assert that no such flag is passed and that the browser's process
  tree owns no listening TCP socket.
- The profile and output dirs (`<user>/.browser/`, `profile/`, `output/`) are created/tightened to mode 0700 and must be
  owned by the account running the hub (else `launch_failed`); the browser runs as that account.
- **`wrapper` is not supported** (a non-empty value makes `ensure()` fail with `launch_failed`): the pipe's file
  descriptors do not survive `sudo`, and the browser must be a direct child of the hub. Running it under its own
  account would need a different transport (e.g. a unix socket owned by the hub).
- Hide `<user>/.browser/` from agents' file tools and from file listings/sync.
