# macOS app

`AgentWorkstation.app` is the native client for the server: the full web UI in a WKWebView, plus what only a Mac can do:
folder sync with a selection window and the Sync tab, a native review and history window, notifications, downloads
to `~/Downloads`, keeping running after the window closes, and signed update checks. It talks to the hub over the
same REST and WebSocket protocol as the browser ([PROTOCOL.md](PROTOCOL.md)). Apple Silicon (`mac`) and Intel
(`mac-intel`) builds are separate; `/download` on the server recommends the right one once a build has been published.

Contents: [Build](#building-without-xcode) · [Signing and first launch](#signing-and-first-launch) ·
[Developer ID and notarization](#developer-id-and-notarization) ·
[What needs Xcode](#what-needs-xcode) · [Connecting to the hub](#connecting-to-the-hub) ·
[Folder sync](#linking-a-folder-and-syncing) · [Review](#reviewing-claudes-changes) ·
[Conflicts](#echo-suppression-and-conflicts) · [Pull back and remove](#pull-back-and-remove) ·
[Notifications and window](#notifications-and-window-behaviour)

## Building without Xcode

The app is a Swift package, so the Command Line Tools are enough. You need macOS 14 or newer
and a Swift 6 toolchain (`xcode-select --install` if `swift --version` fails).

```bash
cd apps/mac
./scripts/swiftpm.sh build -c release     # compile
./scripts/swiftpm.sh test                 # unit tests (sync engine, manifest reconciliation, ...)
cd ../..
bash scripts/make-app.sh                  # build, assemble and sign both apps (Apple Silicon and Intel)
```

`apps/mac/scripts/swiftpm.sh` is a thin wrapper for machines that only have the Command Line
Tools: it adds `--build-system native` (the default build system can trip over stray SDK
folders in the Command Line Tools) and links the Swift Testing framework, which the Command
Line Tools ship in place of XCTest. With Xcode installed it just runs plain `swift`, so
`swift build` and `swift test` work too.

`scripts/make-app.sh` runs `swift build -c release` for arm64 and for x86-64 (cross-compiled), assembles both
bundles (executable, the writer XPC service, `Info.plist`, icon, bundled web assets), signs them, and writes
`AgentWorkstation-arm64.dmg` and `AgentWorkstation-intel.dmg` with a signed `release-*.json` next to each into
`apps/mac/dist/` (git-ignored, as is `apps/mac/.build/`). The version comes from `apps/mac/VERSION` and is bumped
automatically on a real build; set `WORKSTATION_VERSION=0.1.0` to pin it. The first run must be in a Terminal: it creates
the Ed25519 key that signs the release files in your login Keychain, and the app embeds the matching public key and
refuses updates that key did not sign. Open the result with:

```bash
open apps/mac/dist/AgentWorkstation.app
```

To offer the build at `/download` and to the in-app updater, run `deploy/deploy.sh` from the same Mac: it copies
`apps/mac/dist` to the server's `releases` folder, each version in its own folder, and never deletes an older one.

You can also open the `apps/mac` folder in Xcode; it is a normal Swift package. CI builds and tests it on a macOS
runner with plain `swift build` and `swift test`.

## Signing and first launch

The default distribution is **free**: the app is signed ad hoc, runs in the App Sandbox (network client, read-only access
to the folders you pick, read-write `~/Downloads`; every write into a linked folder is done by a separate sandboxed
writer service) and is not in the App Store.

- **On the Mac that built it** it opens directly.
- **On another Mac** (copied by AirDrop, a download or a disk image) macOS 15 and newer
  blocks the first launch with "Apple could not verify ... is free of malware". Allow it once
  per Mac:
  1. Try to open the app, then dismiss the dialog.
  2. Open **System Settings**, **Privacy & Security**, scroll to the **Security** section.
  3. Click **Open Anyway** next to the message about Agent Workstation, authenticate, and confirm
     **Open** in the next dialog.

  After that it launches normally. (Since macOS 15 the old Control-click, Open shortcut no
  longer offers this; the Settings route is the supported one.) From a terminal the same
  effect is `xattr -dr com.apple.quarantine /Applications/AgentWorkstation.app`.
- An ad hoc signature changes with every build. After you rebuild, macOS may ask again for
  access to folders such as Documents or Desktop, which is why the Developer ID path below
  gives a calmer experience if you rebuild often.

## Developer ID and notarization

With an Apple Developer Program membership ($99 per year) the `.dmg` opens with a double
click on any Mac, with no "Open Anyway" step:

1. Create a **Developer ID Application** certificate (in the developer portal, or with
   Xcode's account panel) and install it in your keychain.
2. Store notarization credentials once, using an app-specific password:

   ```bash
   xcrun notarytool store-credentials agent-workstation --apple-id you@example.com --team-id TEAMID
   ```

3. Build with both variables set. `make-app.sh` then signs with the hardened runtime, signs the disk images, submits
   them to Apple, waits for the result and staples the ticket:

   ```bash
   SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" NOTARY_PROFILE=agent-workstation bash scripts/make-app.sh
   ```

Releases are tagged `vX.Y.Z` (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## What needs Xcode

Almost nothing day to day. SwiftPM compiles SwiftUI and WebKit apps, and `codesign`,
`iconutil` and `notarytool` ship with the Command Line Tools. You do need the full Xcode for:

- **App Store distribution** (not set up: it needs its own review and entitlements).
- Nice-to-haves: SwiftUI live previews, the graphical debugger and Instruments, and creating a free development
  certificate from an Apple ID.

## Connecting to the hub

On first launch the app asks for the hub address (for example `https://workstation.example.com`; Settings → General
changes it later). Sign-in is the web sign-in: with Tailscale identity on, the app opens straight into your
workspace; the first device of a new Tailscale login types a name once. Session defaults (model, effort)
live in the web gear menu and follow your name everywhere.

When the hub cannot be reached the app shows **Can't reach your hub**; when the address is a tailnet address and
Tailscale is off, it says so with a button that opens the Tailscale app. Banners in the page cover remote use paused by an admin, the weekly token limit, rate limits and low disk space.

## Linking a folder and syncing

Link a folder from the composer's folder button, by dropping it on the window or the Dock icon, or with File → Link
Folder or File… (⇧⌘O). Claude works in the server copy as a project (`projects/<name>` in your workspace).

**The selection window.** Before anything is uploaded the app shows the folder's first level and, under each
first-level folder, up to 3 items (the rest as "+N more"), everything checked. Unchecking keeps that file or folder on
the Mac. There are no built-in rules, no .gitignore matching and no AI pass; `.git` never syncs. The window appears for
every way of linking (drop on the window or start page, the composer's folder button, the Dock icon, File → Link Folder,
a typed path). After the window is confirmed, on every later decision change and at every app start the app sends the
unchecked paths to the server (`PUT /api/projects/:id/excludes`); the server excludes only `.git` and those paths, so files
the agent creates in an unchecked folder stay out of review.

**After linking.** A new or changed item in a folder that contains something unchecked waits in the web UI's **Sync**
tab (side panel, Mac app only) with a notification; in a folder where nothing is unchecked it syncs on its own; nothing
inside an unchecked folder ever syncs. Files over 100 MB (`SYNC_LARGE_FILE_PROMPT_BYTES`) always ask first and then sync
as large files (chunked uploads, a pointer in the review git, review in Changes, History). Skipping something already
on the server only stops syncing it; the server copy stays. A manifest check on launch, focus and every few minutes
catches anything the watcher missed. The Sync tab also shows the whole tree, where any folder or file can be changed.

**Cloud folders.** Files that are only in the cloud (OneDrive, iCloud Drive, Google Drive, Dropbox, Box: any file
with the `dataless` flag) are never read, because reading one makes macOS fetch it first. Linking waits while any file
that would sync is cloud-only, names the provider's Finder command for keeping the folder on the Mac (OneDrive "Always Keep on This Device", iCloud "Keep Downloaded", Google Drive "Available offline", Dropbox and Box "Make available offline"), and continues on
its own once they are local. A synced file the provider later evicts is not treated as a change; new cloud-only files
wait until they are local. The sync status shows how many files are only in the cloud.

What is **not** touched:

- **Your folder never becomes a git repository.** The app does not run `git init` in it.
- If the folder already is a git repository, its `.git` is neither synced nor modified. Your local git history and
  the server's review history are independent.
- The server keeps its review repository *outside* the project directory, so `git` commands in the project do not
  disturb it. See [ARCHITECTURE.md](ARCHITECTURE.md#folder-sync-and-review-macos-app).

## Reviewing Claude's changes

The **Changes** panel for a linked project lists everything that differs between what you have
(`local`) and what is on the server now: new, modified, deleted and renamed files, with line
counts and which session, turn and tool touched each file last. A filter limits the list to the
current session. Click a file for a side-by-side diff.

| Action | What happens |
|---|---|
| **Accept file** | The file's server content becomes your version; the app writes it into your folder. |
| **Accept hunk(s)** | Only the selected blocks are applied to your version; the others stay pending in the panel. |
| **Accept all** | Every pending change is accepted. |
| **Reject file / hunk(s) / all** | The server copy is put back to your version. The rejected content is saved to history first. |
| **Download** | Saves the server version without changing any sync state. |

The computation happens on the server; the app only writes the resulting files. Binary files
can only be accepted or rejected as a whole.

**History** lists a snapshot taken at the end of every Claude turn (plus syncs, accepts and
the backups made before destructive actions). From it you can restore a file or the whole
project to a snapshot. A restore changes the server copy; like any other server change it then
appears in **Changes** and reaches your Mac when you accept it.

## Echo suppression and conflicts

- **No ping-pong.** When you accept a change the app writes the file to your folder, remembers
  exactly what it wrote, and ignores the file-watcher event that write causes. The server in turn
  treats a push that equals what it already has as a no-op. So accepting a change never sends it
  back as if you had edited it.
- **Edits on both sides.** If you edit a file locally while Claude has a pending change to the
  same file, the server first tries to merge the two (three-way, like git). Non-overlapping edits
  just merge. If they overlap, only that file is held back and you get a conflict prompt; the
  default is to merge and ask only when that is impossible. Choosing **local wins** first saves
  Claude's version to history, so it can be restored.
- **Nothing is lost silently.** Overwrites and rejections always write a backup to history first.

## Pull back and remove

The server is a working copy, not the source of truth; your folder is. When the server runs low
on space (warning at 80 %, read-only at 95 %), every client shows what is pending per project.
In the Linked Folders window (⇧⌘L), each project has two separate actions:

- **Pull Back…** accepts every pending change on the server and offers the files as incoming changes (the "Apply to Mac"
  sheet). Nothing is written to your folder until you apply, and the server copy stays.
- **Remove from Server…** deletes the server's project copy and its review repository after you confirm; you see how much
  space it frees. Your folder is not touched and syncing for it stops. When changes exist only on the server, the dialog
  offers **Pull Back First** or **Discard Them and Remove**. The web Projects page has the same two-step delete.

Nothing is ever deleted automatically; to work on the project again, link the folder again and the app re-uploads it.

## Notifications and window behaviour

- Notifications: a permission is needed; a long turn (5 minutes or more) finished; a session has waited for you for
  a minute; sync conflicts; new items to decide; low server storage; downloads. Switch them per session (Overview)
  or everywhere (web gear menu); Settings → General has the Mac-wide switch.
- Closing the window (⌘W) hides it; the app, its hub connection and notifications keep running. ⌘Q quits; ⌘1 or a
  Dock click brings the window back.
- Usage, Memory, Instructions, Skills, Admin and the docs are web pages inside the window (Go and Help menus).
- Updates: checked on first connection and daily; a download is verified (Ed25519 signature and SHA-256) and shown
  in Finder; the app never installs itself. The update channel follows the build (`mac` or `mac-intel`).

## Folders as a session's directory (drop or folder button)

Dropping a **file** on the composer attaches it (web upload, as in a browser). Dropping a **folder** (or choosing one
with the folder button next to the paperclip, shown only inside AgentWorkstation.app) makes that folder the working directory
of a Code session:

1. **Page → shell:** the injected bootstrap script defines `window.__workstationShell.pickFolder()`, which posts
   `{type:"pick_folder"}`. The shell answers with an `NSOpenPanel` limited to folders (one folder). The page cannot pass
   a path: the person picks it in the native panel, so the security rule above still holds (nothing the page posts
   reaches folder sync without a native click).
2. **Drops:** the shell's web view takes drags that contain at least one folder (the page never sees them); drags of
   plain files go to the page unchanged. In a mixed drop only the folders are used.
3. **Link:** a folder that is not linked yet opens the selection window in the main window; **Link and Upload** links it
   with the decisions made there (read-only security-scoped bookmark, project created on the hub, baseline upload to
   `projects/<name>`), Cancel creates nothing. A folder that is already linked is reused (no window, no second baseline). A folder inside a linked folder reuses that project with `projects/<name>/<subpath>` as the
   directory; a folder that contains a linked folder is refused (one line). With several folders dropped, the first one is used.
4. **Shell → page:** when the project is ready, the shell loads `<hub>/?new=code&cwd=projects/<name>` in the main frame.
   The web app opens a new Code session draft whose working directory is that path; the composer shows it as a
   directory chip; the first send creates the session with that `cwd`. Changes Claude makes there come back to the
   Mac as described in "Server changes back to the Mac" below.

In a plain browser there is no folder button (no shell); a dropped folder is uploaded file by file to
`inbox/<name>/` on the server and becomes the new Code session's directory the same way (`/?new=code&cwd=inbox/<name>`),
one way only.

## Server changes back to the Mac

Accepting in the web Changes tab **inside AgentWorkstation.app** is the decision to write those files to the linked folder;
the app then writes them without asking again. Anything else that changes the server's accepted state is confirmed
natively first. The reason: the accept API can be called by anything that reaches the hub as you (a script, another tab); it cannot,
however, post a message into the app's own window.

1. **Page → shell after a successful accept** (`POST /api/projects/:id/review/accept` returned 200): if
   `window.__workstationShell.reportAccepted` exists, the web app calls it with
   `{ projectId, localCommit, files: [{ path, sha256 | null }] }`: `path` project-relative as in AcceptResponse,
   `sha256` = hex SHA-256 of the accepted content (`contentBase64` decoded), `null` for a deletion. The bootstrap
   posts it as `{type:"accepted", ...}`. Nothing else is sent; a reject or a failed accept sends nothing.
2. **Shell:** keeps each report for 5 minutes. When incoming server changes for a linked project arrive, an item is
   written automatically only if a live report for that project lists the same path with the same content hash (or
   `null` for a deletion). Writes keep the old version in History; deletions go to the Trash; a file with unsynced
   local edits is never overwritten (conflict sheet).
3. **Everything else** (an accept made in a browser or by an API call, a restore, any item whose hash does not match
   a report) opens a native sheet on the main window by itself (and a notification when the app is not frontmost):
   the file list with added/changed/deleted marks, `Apply to Mac` (default) and `Later`. `Later` keeps the items staged
   (the Linked Folders window still lists them) and the sheet returns when new items arrive. Restores started from the
   app's own History window count as the person's decision and are written directly.

