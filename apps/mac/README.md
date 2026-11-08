# Agent Workstation for macOS (`apps/mac`)

A thin native shell around the hub's **full web app**. The main window is one `WKWebView`
showing `<hub>/` - the same React app a browser gets (sessions, transcript, composer, files,
terminal, Usage, Memory, Projects review, Skills, Admin, login). The native side keeps only
what genuinely needs native code:

| Native | Why |
|---|---|
| Hub address (first-run sheet, Settings, offline view) | the web app is served *by* the hub, so something has to know where the hub is |
| Folder sync + Linked Folders, selection, review and History windows | file system access (read-only), FSEvents, the selection window, approval of what is written to the Mac, the writer (the only code that writes into linked folders) |
| Notifications + Dock badge | permission requests, finished turns, server storage, sync conflicts - while the window is hidden or in the background |
| Menus and shortcuts | mapped to web routes and the web app's own ⌘-shortcuts |
| Downloads | `WKDownload` → `~/Downloads` (never overwrites), notification, Dock stack bounce |
| Offline state | a native "Can't reach your hub" view with Try Again / Change Address and background retries |
| Titlebar strip | the traffic lights sit on a thin strip painted in the page's own top-edge colours |

Everything else is the web app (there is no native sidebar, toolbar picker, model menu, inspector, native
transcript or composer, Usage, Memory, Projects or Admin window).
The web app knows nothing about the shell; the shell only observes it (see *Talking to the web app*).

> **Interactive QA must be done by a human on their own Mac.** Automated checks here are
> headless: unit tests, the injected JavaScript run in JavaScriptCore, shell flows against an
> in-process mock hub, offscreen snapshots of the native screens, and an opt-in live test that
> loads the real web app in an offscreen web view. Nothing in this folder launches the app or
> drives the desktop.

## Layout

```
apps/mac/
  Package.swift                 SwiftPM package (swift-tools 5.9, macOS 14+, no dependencies)
  Sources/WorkstationCore/           Foundation-only
    Shell/                      ShellURLs + NavigationPolicy + ShellDestination, ShellCommand → ShellAction map,
                                ZoomSteps, DownloadPlanner, FolderDrop, SyncBridge (the web Sync tab), TailnetHint,
                                WebScripts (injected JS) + ShellMessage parsing
    Sync/                       SyncEngine, SyncSelection + SelectionScanner + SyncRules (what syncs), LinkTarget
                                (+ read-only Bookmarks), LineDiff, LocalScanner, CloudFiles, SyncBatchBuilder, EchoSuppressor,
                                BaselineArchiver, LargeFileUpload, FolderWatcher, LinkedProjectStore
    Writer/                     WriteBatch + WriteBatchExecutor (validation, atomic writes, Trash), XPCWriter, HistoryStore
    Protocol/  API/  Settings/  Codable mirrors of packages/protocol, HubClient / HubSocket, AppSettings
  Sources/WorkstationWriter/         the WorkstationWriter XPC service (executes approved WriteBatches; nothing else)
  Sources/WorkstationUI/             SwiftUI + AppKit + WebKit
    Models/                     ShellModel (root), ProjectsModel (links, engines, approvals), ReviewModel
    Web/WebShellController.swift  the WKWebView: data store, user script, link policy, downloads, file panel, JS dialogs
    Views/                      ShellRootView, first run + Settings, LinkedFoldersView, LinkSelectionView (selection window),
                                ReviewView (diff), HistoryView
    Scenes.swift                ShellWindows (main, Linked Folders, Review, History windows) and ShellCommands (menus)
  Sources/AgentWorkstation/               @main App (Settings scene + commands) + AppDelegate (Dock drops)
  Packaging/                    AgentWorkstation.entitlements, WorkstationWriter-Info.plist, DocumentTypes.plist (see "Sandbox")
  Tests/WorkstationCoreTests/        unit tests: engine, writer, diff, link targets, injected JS (+ opt-in LiveHubTests)
  Tests/WorkstationUITests/          shell + folder flows vs mock hub, offscreen snapshots (+ opt-in LiveShellTests)
```

## Build, test, package (Command Line Tools only)

```bash
bash scripts/mac-headless-check.sh              # from the repo root: build, test, package, list artifacts
cd apps/mac
./scripts/swiftpm.sh build -c release
./scripts/swiftpm.sh test                       # 239 tests (the opt-in live ones skip without WORKSTATION_LIVE_HUB); .build/snapshots/*.png
cd ../.. && bash scripts/make-app.sh            # → apps/mac/dist/: both apps, AgentWorkstation-arm64.dmg and -intel.dmg with signed release-*.json (ad-hoc signed)
```

Why the wrapper exists (`scripts/swiftpm.sh`):

* **Build system.** Swift 6.4's default `swiftbuild` fails on some Command Line Tools
  installs ("Unknown error parsing property list"), for example when the SDK folder holds
  broken SDKs. `--build-system native` is unaffected.
* **Tests.** The CLT ship *Swift Testing* but not XCTest, and SwiftPM's generated runner
  only links Swift Testing when the framework is on the compiler search path, which only
  command-line flags reach. All tests use `import Testing`.
* With Xcode installed the wrapper runs plain `swift build` / `swift test`.

`@State` is an attached macro in the macOS 27 SDK that only Xcode's `SwiftUIMacros` plugin
implements, so views use `@ViewState` (`Support/ViewState.swift`, a `@StateObject`-backed equivalent).

**Opening in Xcode:** `open apps/mac/Package.swift`, run the `Agent Workstation` scheme. `swift run Agent Workstation`
also works. Notifications and "Open at login" are disabled outside a `.app` bundle.

**Live tests** (read-only for LiveShell; LiveHub creates a `macsmoke` user and cleans up):

```bash
WORKSTATION_LIVE_HUB=https://workstation.example-tailnet.ts.net ./scripts/swiftpm.sh test --filter Live
```

## Windows

* **Main window** (AppKit `NSWindow` + `NSHostingView`): full-size content view, transparent
  titlebar, no title. ⌘W hides it (the web app keeps its state); the Dock icon, ⌘1, the Window
  menu and notification clicks bring it back. Frame is autosaved.
* **Titlebar strip.** The web app's sidebar starts with the user menu at its top-left, where
  the traffic lights would sit, so the web view starts below the titlebar and the strip under the
  traffic lights is painted in the colours the page draws along its top edge (sidebar colour up
  to the sidebar's width, its border, then the main colour). It follows the theme, the sidebar
  being toggled and full screen (height 0), and drags / double-clicks like a title bar. A page
  that wants to draw under the traffic lights itself can opt in with
  `<meta name="workstation-shell-titlebar" content="overlay">`.
* **First run** (sheet): the hub address only. The username is entered on the web app's own
  login page next.
* **Offline**: health probe fails or a main-frame load fails → native view with Try Again,
  Change Address…, and automatic retries every 15 s and on app activation.
* **Settings** (⌘,): General (hub address + status, Notifications, Open at login, version) and
  Folders (the linked folders list).
* **Linked Folders** (⌘⇧L): link (Choose…, path field, drag and drop), pending changes in both
  directions with *Review…*, conflicts, *Pull Back…*, *Review on Web…*, *History…*, *Remove from
  Server…*, and Check Now / Pause / Show in Finder / Unlink in the ⋯ menu.
* **Review** (one per project): file list with checkboxes, unified diff, approval buttons.
* **History** (one per project): apply batches and server backups with Restore.

## Talking to the web app

All of it lives in `WorkstationCore/Shell/WebScripts.swift`. The web app only feature-detects `window.__workstationShell` and works the same in a browser.

* **Website data store:** `WKWebsiteDataStore.default()` (persistent), so the web login
  (`localStorage["workstation.user"]`) and cookies survive relaunches. Each hub origin has its own login.
* **User script** (document start, main frame) posting to the `workstationShell` message handler:
  * `user` - `localStorage["workstation.user"]` at load and whenever it changes (wraps
    `Storage.prototype.setItem/removeItem/clear` for `localStorage`, plus `storage` events).
    The shell also evaluates `localStorage.getItem("workstation.user")` after every load. The user drives
    the native WebSocket (`X-Workstation-User`), the sync engines and the cached `username`; `null`
    (logout) stops them.
  * `route` - `pushState` / `replaceState` / `popstate` (notification suppression for the session
    on screen, menu state).
  * `chrome` - the page's top-edge colours for the titlebar strip (canvas-normalised sRGB).
  * `pick_folder` - `__workstationShell.pickFolder()` (the composer's folder button): the shell opens a native folder
    picker; the page never names a path.
  * `accepted` - `__workstationShell.reportAccepted()` after an accept in the web Changes tab (validated; see
    `docs/MAC-APP.md`, "Server changes back to the Mac").
  * `notify` - `__workstationShell.notify()`: the web app decides a system notification is due, the shell shows it.
* **Sync tab:** a second handler, `workstationSync`, answers the web Sync tab's promise-returning calls
  (`__workstationShell.sync.status / pending / list / decide / recheck`) natively.
* **Navigation:** `history.pushState` + a `popstate` event (React Router's `BrowserRouter`
  follows it), so menu routes never reload the app; a full load before the page is ready.
* **Shortcuts:** the web app already handles ⌘N, ⌘K, ⌘/ and ⌘⇧. (`useHotkeys`). WebKit gives the
  page the first chance at a key equivalent; the menu item only fires when the page did not
  handle it, and then synthesises the same keydown, falling back to a route (⌘N → `/`, ⌘K →
  `/` then the palette).
* **User agent:** `… WorkstationMac/<version>` is appended, for optional feature detection.
* **Writes are native-only.** The page can only ask for the folder picker, report what the person just accepted and
  decide sync selection for its own project; none of the handlers can write, queue or execute a change to a linked
  folder (no `fetch` wrapping, no URL scheme). Server changes are learned from the hub over the native WebSocket;
  anything not decided in this app waits for "Apply to Mac" in a native sheet.

## Menus and shortcuts

| Shortcut | Action |
|---|---|
| ⌘N | New session (web shortcut; elsewhere → `/`) |
| ⌘K / ⌘F | The web app's search / its find bar (session search outside a session) |
| ⌘/ | Toggle the web sidebar |
| ⌘⇧. | Stop the response (web shortcut) |
| ⌘⇧H / ⌘⇧P / ⌘U / ⌘⇧M | Sessions `/`, Projects `/projects`, Usage `/usage`, Memory `/memory` (Go menu; Skills and, for admins, Admin too) |
| ⌘[ / ⌘] | Back / Forward (also two-finger swipe) |
| ⌘R | Reload the page (retry while offline) |
| ⌘= / ⌘- / ⌘0 | Zoom in / out / actual size (`pageZoom`, persisted) |
| ⌘⇧O / ⌘⇧L | Link Folder or File… / Linked Folders window |
| ⌘1 / ⌘, | Main window / Settings |

## Links, downloads, files

* Links inside the hub origin load in place; `target=_blank` / `window.open` inside the hub
  open in the same window; other origins, `mailto:` etc. open in the default browser; `file://`
  navigations (a file dropped where the page has no drop target) are cancelled.
* `<a download>` / blob saves / `Content-Disposition: attachment` / unshowable MIME types become
  `WKDownload`s into `~/Downloads/<name>` (`name (1).ext`, compound extensions like `.tar.gz` kept),
  with a "Download finished" notification that reveals the file.
* `<input type="file">` opens an `NSOpenPanel` sheet; `alert` / `confirm` / `prompt` use `NSAlert`.
* Files dragged onto the window go to the page's own drop handling (the Workbench's whole-window
  drop target: images attach inline, other files upload to `inbox/`).

## Notifications and Dock badge

The shell keeps its own hub WebSocket (`HubSocket`, events for every connection of the user):

* `permission_request` → badge = pending count, notification (not when the app is active and that
  session is on screen - the page shows the prompt); resolved / cancelled → withdrawn.
* `session_state` busy → idle → "Claude finished" while the app is in the
  background (de-duplicated within 5 s; titles from `GET /api/sessions` + `session_updated`). The web app can also ask
  for a notification itself (`notify`).
* `disk_status` warn / block → notification (opens `/projects`); block pauses sync pushes.
* `sync_conflict` and local conflicts → notification (opens Linked Folders).
* New items waiting in a linked folder → "3 new items in sample-app" (opens the web Sync tab); local changes that could not
  be synced on their own (conflicts, a blocked disk) → "3 local changes in sample-app" (opens the review window); server changes
  nobody approved in the app → the "Apply to Mac" sheet; `review_changed` triggers a server check for that project.
* Files that are only in the cloud (OneDrive, iCloud Drive, ...) in a linked folder → a notification with the provider's
  Finder command for keeping them on the Mac.
* Clicks: `sessionId` → `/s/<id>`, `route` → that route, conflicts → Linked Folders, downloads → Finder.

## Folder sync: nothing is written to the Mac without a decision

The iron rule: **nothing in a linked folder is created, modified or deleted except by the writer,
for a change the person decided.** The server side may change freely.

```
 link (Choose… / typed path / drop on window or Dock)
   → selection window: first level of the folder, everything checked; unchecked stays on the Mac
   → "Link and Upload": the first upload (tar(.zst) baseline), then the excludes (the unchecked paths) go to the server
   → watching (FSEvents; a single-file link polls its file every 5 s)

 Mac → server                                       server → Mac
 FSEvents / reconcile see a local edit             review_changed (WebSocket), launch, activation,
   → inside the checked scope: pushed on its own     every 10 min → reconcile reads the server's
   → a new item next to an unchecked one waits         `local` branch (raw?ref=local)
     in the web Sync tab (notification)               → incoming change (persisted, content kept in
   → a conflict or a blocked disk stays pending         app storage until applied)
     for the review window ("Sync … to Server")     → accepted in this window's Changes tab (or restored
   → push with baseHash = last-synced hash              in History): written, old version kept in History
                                                    → anything else: "Apply to Mac" sheet / review window
                                                    → WriteBatch → writer
```

* **Selection** (`SyncSelection`, `docs/MAC-APP.md`): the person decides once in the selection window and later only for
  new items. An unchecked folder or file never syncs and nothing inside it ever asks; a new item in a folder that
  contains something unchecked waits in the web Sync tab; in a folder with nothing unchecked it syncs on its own. Files
  that synced already keep syncing; `.git` never syncs. The unchecked paths are sent with `PUT /api/projects/:id/excludes`
  after the window, on every decision change and at app start.
* **Reconcile never writes.** A file the hub asks for whose bytes still equal the last-synced hash changed on the server
  (accepted elsewhere): it is offered as incoming, never pushed back, so accepts made in a browser or on the phone are not
  overwritten. A file this Mac changed inside the checked scope is pushed; if the server changed it too, both are shown.
* **Writer contract** (`WriteBatch`): `{root, items: [{path, op: write|delete, expectedHash,
  hash, contentBase64, mode, backedUpBlob?}]}`. Per item the writer refuses paths that are not
  relative, leave the root, contain `..`, `.git` or a symlinked component (or a symlinked root),
  content that does not match its hash, and - the key check - any file whose current sha256 is
  not `expectedHash`. Writes are atomic (temp file + `rename` in the same folder, mode kept);
  deletions go to the Trash, never a hard delete.
* **Un-synced local edits are never lost silently.** `expectedHash` is the last-synced hash, so a
  locally edited file can't be overwritten by a plain apply. For such files the review window offers:
  1. **Back up and overwrite** (default) - `POST /api/projects/:id/backups` uploads the local
     version (≤ 50 MB / 500 files per request); only when the returned git blob id matches the
     uploaded bytes does the writer replace the file (it re-checks that blob too). Greyed out
     when the hub has no backups route.
  2. **Overwrite without backup…** - needs a second destructive confirmation naming the files
     ("…will be permanently lost. This can't be undone."); the engine refuses it for any path not
     in that confirmation; no backup request is made.
  3. **Sync my version instead** - the normal local → server push; the incoming change
     for that file is dropped.
  4. **Skip.** The same applies to deleting a locally edited file. Every choice re-checks that
     the file is still the version shown in the diff.
* **Pull Back…** accepts every pending change on the server and offers the files as incoming; the
  server copy stays and nothing is written until applied. **Remove from Server…** is a separate,
  confirmed action (what is deleted on the server; the local folder is untouched; pending
  changes need the explicit "Discard Them and Remove"). No code path deletes the server copy as a
  side effect of pulling back.
* **Conflicts** (a push refused because both sides changed): *Keep Mine* forces this Mac's
  version onto the server (Claude's stays in the server's history); *Review Server's…* fetches the
  server version into the review window.
* **History** (per project): every apply batch (time, files, old / new hash, where the server keeps
  the old version) - metadata only, no local copies - plus the server's backups
  (`GET /api/projects/:id/backups`). *Restore* (per file or batch) reads the old version from the
  server with `raw?path=&ref=<commit | backup ref>`, checks its hash, and offers it in the review
  window like any incoming change.
* **Disk guard:** a `disk_status` block (or HTTP 507) refuses pushes to the server; changes stay pending.
* **Persistence:** outgoing / incoming entries, last-synced hashes and the server commit holding each
  one live in `Application Support/Agent Workstation/sync/<id>.json`; incoming content in `incoming/<id>/`;
  apply records in `history/<id>/`. Logout, hub change and relaunch keep them.
* **Large files, cloud-only files, echo suppression, baseline encoding:** files over 100 MB always wait for the person's
  decision and then sync as large files (chunked uploads); symlinks are listed as not synced; cloud-only files
  (`dataless`) are never read; the writer's own writes are not reported as local edits; `tar --zstd` is used when a `zstd`
  binary is found.

## Linking

Three inputs, one flow (a folder ends in the selection window, a single file in a confirmation sheet):

* **Choose…** / File → Link Folder or File… (⌘⇧O): `NSOpenPanel` with folders *and* files,
  multiple selection, clicking down level by level.
* **Path field:** paste or type `~/code/sample-app`, `"…/My Folder"`, `My\ Folder`, `file://…`;
  `~` is expanded; missing / unreadable / symlinked / too-large paths get a clear error. Inside the
  sandbox the picker opens at that path for one confirming click (the sandbox only grants what
  the person picks).
* **Drag and drop** onto the Linked Folders window, or onto the Dock icon (`application(_:open:)`;
  needs `CFBundleDocumentTypes`, see below). Dropping onto the web view stays the web app's upload, except a folder, which
  becomes a Code session's directory (`docs/MAC-APP.md`).

A **single file** links as a project of its own named after the file: the engine works in its
parent folder restricted to that one path (scan, upload, watch, incoming and writes all ignore
everything else). Paths already linked, inside a linked folder, or containing one are refused.

## Sandbox and the writer (OS-enforced)

* **AgentWorkstation.app** (main process) runs in the App Sandbox with exactly `Packaging/AgentWorkstation.entitlements`:
  `app-sandbox`, `network.client`, `files.user-selected.read-only`, `files.bookmarks.app-scope`,
  `files.downloads.read-write`. Linked folders / files are reopened from **read-only**
  security-scoped bookmarks for watching, hashing, diffing and uploading. The kernel refuses any
  write by the main process into a linked folder.
* **Every approved batch runs in a fresh, self-sandboxed process.** The `WorkstationWriter` XPC service
  (`Contents/XPCServices/WorkstationWriter.xpc`, reachable only from AgentWorkstation.app) does not write itself:
  for each batch it starts `WorkstationWriter --apply` with an empty environment, passes the batch on
  stdin and relays the result. Before touching any file that child calls
  `sandbox_init_with_parameters` with

  ```
  (version 1)
  (deny default)
  (allow file-read*)
  (allow file-write* (subpath (param "ROOT")))
  (allow file-write* (subpath (param "TRASH")))
  (allow sysctl-read)
  (deny network*)
  ```

  `ROOT` = the real path of the batch's linked folder (atomic-write temp files are created next
  to their target, inside ROOT); `TRASH` = the user's Trash for that folder's volume
  (`~/.Trash`, or `/Volumes/X/.Trashes/<uid>`) - the only place outside ROOT it may write;
  deletions are moved there with `rename` (no Finder "Put Back" record). Roots that would defeat
  the profile (`/`, top-level and system folders, the home folder itself) are refused. If the
  sandbox can't be applied the batch is refused (exit 3) - there is no unrestricted fallback.
  One batch = one project = one process, which exits after printing its result.
* `swift run` builds use the same child (`WorkstationWriter` next to the app binary); only without that
  binary does the writer run in-process (unrestricted, code checks only).
* The XPC service itself is unsandboxed (a sandboxed parent would pass its sandbox on to the child,
  which then could not write ROOT); it performs no file writes and only starts the child.
* Self-test: `WorkstationWriter --probe ROOT OUTSIDE PORT [TRASH]` applies the same profile and reports
  whether a write inside ROOT, a write to OUTSIDE, a TCP connect and a move into TRASH succeed.

## Signing and distribution

`scripts/make-app.sh` builds release, assembles `AgentWorkstation.app` (`io.github.agentworkstation`, macOS 14+,
ATS exceptions so a plain-HTTP development hub loads, local network usage string), draws the icon, signs ad
hoc and builds a UDZO `.dmg` per architecture (`AgentWorkstation-arm64.dmg`, `AgentWorkstation-intel.dmg`). Developer ID + notarization: `SIGN_IDENTITY="Developer ID
Application: …" NOTARY_PROFILE=<profile> bash scripts/make-app.sh`.

## Tests

| Suite | What |
|---|---|
| SyncEngine | first upload only after linking; local edits inside the checked scope pushed with baseHash, conflicts kept pending; sync selection (unchecked, waiting and new items); stale review refused; per-file fallback; reconcile never pushes untouched files (accepts elsewhere survive) and offers server versions; apply only on a decision with echo suppression; un-synced edits: skip / unconfirmed overwrite refused / backup verified then overwrite / 404 → unavailable / confirmed overwrite without backup makes no backup request / seen-version check / sync mine instead; pull back keeps the server copy; conflicts; disk block; **iron rule** (writer recorder + folder fingerprint across every other path); restore round trip; single-file projects; real FSEvents; store compatibility |
| Writer sandbox (real binary) | exact profile; a batch applied by the real `WorkstationWriter --apply` child inside its folder; OS denies a write outside ROOT (EPERM) and network (EPERM, with a working-listener control); a move into the TRASH allowance works; a broken profile refuses the batch (exit 3, nothing written); `/`, home and system roots refused; Trash naming |
| Writer | atomic write + mode, expected-hash refusals, paths outside the root, symlink escapes (dir, file, root), content hash, backed-up blob, duplicates, deletes, git blob id, history order |
| Line diff / link targets | hunks with context and line numbers, added / deleted / binary files; typed paths (`~`, quotes, escapes, `file://`), folders, single files, missing / symlink / unreadable / too large |
| Shell URLs, commands, messages, notifications, settings, injected JS | URLs, link policy, menu routes, message parsing, settings; no `fetch` observation, crafted page messages are not understood, review notification routes, backup contract and new routes |
| Shell flows (mock hub) | connect / web user / first run / offline / menus / notifications; folder sync with review models and diffs; typed path, drop, single file, overlaps, signed-out drop; backup / confirmed overwrite / 404; **writes are native-only** (registered handlers and scripts enumerated, crafted messages change nothing); history restore through review; the Sync tab bridge; update checks; window lifecycle |
| Snapshots | offscreen PNGs (light + dark) of the native screens in `.build/snapshots/`: main window, offline, first run, settings, linked folders, selection window, link confirmation, review, history |
| Live (opt-in) | LiveShell: the real web app in the shell's web view; LiveHub: REST / WS / projects |

Snapshots host the SwiftUI view in an `NSWindow` that is never ordered on screen (activation
policy `.prohibited`) and draw it with `cacheDisplay`. The web view itself renders out of process
and is not painted while its window is hidden, so window snapshots use a placeholder in the page's
colours; the diff view is SwiftUI for the same reason.

## Known gaps

* Interactive behaviour (menus, key equivalents reaching the page first, drag and drop onto the
  page / window / Dock, file panels, confirmation dialogs, notification clicks, the login item, the
  titlebar strip in a real window, downloads) has not been exercised by automation.
* The packaged app's sandbox and the XPC service have not been launched by automation (the
  per-batch child sandbox is tested by running the real binary). Expect to check:
  `/usr/bin/tar` (and Homebrew `zstd`) spawned from the sandbox reading a bookmarked folder,
  FSEvents on bookmarked folders, single-file links (only the file is readable - polled, not
  watched), and that existing links from the unsandboxed build are re-linked (the sandbox
  container has its own Application Support).
