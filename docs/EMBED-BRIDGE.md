# Embed bridge - web ↔ macOS app contract

`packages/web` has a second Vite entry, `embed.html`, that renders the shared transcript, diff viewer or a terminal on its
own for a host app's `WKWebView`. The macOS app itself shows the full web UI and uses a different, smaller bridge
(`apps/mac/README.md`, "Talking to the web app"); this contract is for hosts that load the embed entry. The embedded page is **self-sufficient**: it talks to the hub
itself over REST + WebSocket (same code paths as the browser UI, minus the shell). The
bridge between Swift and the page is therefore thin and one-directional per message.

## Loading

The host loads `embed.html` (second Vite entry, built to `packages/web/dist/embed.html`)
from the hub (`<hubUrl>/embed.html`). It cannot load it from the app bundle: a page opened from a file has the opaque
`file://` origin, which the hub refuses (403 `cross_site`). Before the document loads, a
`WKUserScript` (injection time: document start) defines the config. The hub refuses requests from web origins it does
not know (403 `cross_site`, see SECURITY.md): a page loaded from the hub is same-origin and needs nothing; a host that
serves the page from another origin must list that origin in `[server] allowed_origins`.


```js
window.workstationEmbedConfig = {
  hubUrl: "http://localhost:9000",   // base URL, no trailing slash
  user: "alice",                          // sent as X-Workstation-User
  mode: "transcript" | "diff" | "terminal",
  sessionId: "<uuid>",                    // transcript mode
  projectId: "<uuid>", path: "src/a.ts",  // diff mode
  terminalId: "<id>",                     // terminal mode
  theme: "light" | "dark",
  platform: "mac"
};
```

The page reads the config on startup. If it is missing, the page renders a small
"not configured" state (useful when opening `embed.html` directly in a browser with
`?hubUrl=&user=&mode=&sessionId=` query parameters, which are also accepted).

## Page → host

`window.webkit.messageHandlers.workstation.postMessage(message)` with a JSON object. The page
must feature-detect `window.webkit?.messageHandlers?.workstation` and otherwise `console.debug`
the message (browser fallback).

| message | when |
|---|---|
| `{ type: "ready", mode }` | page mounted and config applied |
| `{ type: "state", sessionId, status, queuePosition }` | session status changed (mirror of `session_state`) |
| `{ type: "settings", sessionId, model, permissionMode, effort }` | settings changed (mirror of `session_settings`) |
| `{ type: "permission", sessionId, requestId, toolName, summary }` | a permission request arrived (host may show a native notification) |
| `{ type: "permission_resolved", sessionId, requestId }` | answered or cancelled |
| `{ type: "turn_done", sessionId, costUsd, durationMs, subtype }` | a `result` arrived |
| `{ type: "open_file", path, projectId? }` | user clicked a file reference |
| `{ type: "open_external", url }` | user clicked an external link (host opens in default browser) |
| `{ type: "notice", level, code, message }` | hub `notice`/`error` the host may surface natively |
| `{ type: "title", sessionId, title }` | session title changed |

## Host → page

The page exposes `window.workstationEmbed` with:

| function | effect |
|---|---|
| `setTheme("light" \| "dark")` | switch theme immediately |
| `navigate({ sessionId })` / `navigate({ projectId, path })` / `navigate({ terminalId })` | switch what is shown without reloading |
| `setUser(user)` | switch identity (reconnects) |
| `focusComposer()` | focus the input |
| `insertText(text)` | append text to the composer |
| `attachFile({path, name?, size?})` | attach a workspace file as a tile in the composer (native drag-and-drop after upload, "Attach to message" in the Files inspector); it is sent as a `file_ref` attachment, never as text |
| `stop()` | same as the Stop button |
| `applySettings({ model?, permissionMode?, effort? })` | the host changed settings from its native pickers; page PATCHes the hub |
| `acceptHunks(indices)` / `acceptFile()` / `rejectHunks(indices)` / `rejectFile()` | diff mode: forward to the review API |

All functions are synchronous no-ops when the mode does not apply.

## Transcript mode contents

Transcript mode renders the message list **and the composer** (textarea, `/` palette,
`@` file completion, image paste, Send). Model / permission mode / effort pickers and
Stop live in the native toolbar and reach the page through `applySettings` / `stop`;
the page still reflects `session_settings` events so both stay in sync.

## Diff mode contents

Diff mode renders one file (`@codemirror/merge`) with per-hunk accept/reject buttons
that call the review API directly, and posts `open_file` when the user clicks a path.

## Terminal mode contents

Terminal mode renders a single xterm attached to `terminalId` (the host creates the
terminal via `POST /api/terminals`).
