# Features

Agent Workstation is a self-hosted AI workstation: Claude running on a Linux server, reached from a web
browser or the Agent Workstation app for macOS over a private Tailscale network. This page is an overview; open a section for the
details.

## Chat

A conversation with Claude. History stays on the server and follows your name to every device.

<details>
<summary>What a chat can do</summary>

- **Attachments:** paste or drop images (up to 8 MB each), PDFs and other files, up to 20 per message. Large files
  are read a part at a time.
- **Web:** search the web and read pages; results show as small chips you can open.
- **Its own folder:** every chat has a small folder where it can run code (Python, shell) to calculate, convert or
  test something. Commands run there in a sandbox without asking. Files it makes
  appear as download chips under the answer. The sandbox can reach only PyPI (to install Python packages).
- **Downloads:** a chat can download a file from the web into its folder (one https link, up to 2 GB by default).
  Well-known hosts (GitHub, PyPI, npm, Hugging Face, arXiv, …) are fetched directly; any other host is checked first
  and you get a card to approve it if it does not look safe. Downloads run in an isolated environment.
- **Memory:** Claude remembers facts about you across chats. The memories are kept on the server and are the same on
  every device (Memory page in the gear menu; switch it off there).
- **Past conversations:** the AI can look up your earlier chats when you refer to them.
- **Visuals:** diagrams and charts drawn as SVG, interactive HTML widgets and mermaid diagrams, right in the answer.
</details>

<details>
<summary>Incognito chats</summary>

Switch on the ghost icon next to **New chat**. An incognito chat is never listed or searched, uses no memory and no
past conversations, and its messages are deleted when you leave it or close the tab. Only token counts are kept.
</details>

## Code

A full coding agent (Claude Code) working in a folder on the server: your workspace, or a folder synced
from your Mac. It reads and edits files, runs commands and tests, and hands the result back for review.

<details>
<summary>Working folder and safety</summary>

- Each session is fixed to one folder, shown in the message box. The agent works only there: file tools refuse other
  paths. Commands run in Claude Code's sandbox and can write only to that folder and a private temp folder; the rest
  of the workspace is hidden from them.
- Network: the sandbox filters it: well-known package and code hosts work, another host may need your approval
  (or is refused in the automatic modes), and the server's local network is never reachable.
- Anything that **sends data out** (git push, publishing a package, uploads, ssh/scp) always asks you, in every mode.
- Agents never get administrator (sudo) rights. When something needs them, the agent tells you the command to run.
</details>

<details>
<summary>Permission modes</summary>

Pick one in the message box: **Ask before edits** (default), **Accept edits**, **Plan mode** (it proposes a plan
first), **Auto**, **Bypass permissions**. A permission card shows exactly what the agent wants to do (a diff for
edits, the command for shell) with Allow, Allow with edits, Deny and "Always allow for this session". If you do not
answer a card within 10 minutes, the agent stops and waits for your next message instead of carrying on without you.
</details>

<details>
<summary>Models, effort and cost</summary>

- The model pill lists the newest Claude models first and older versions under "More models".
- **Effort** sets how hard the model thinks (Low → Max).
- **Cost:** everything runs on the Anthropic API key the admin set up on the server, within the monthly budget the admin sets.
  Session defaults (gear menu) set your usual model and effort.
- The small **ring** next to Send shows how full the conversation's context is; hover it for tokens left before the
  conversation is compacted automatically, and the API credits left in the current period.
</details>

<details>
<summary>Helpers inside a session</summary>

- `/` opens the command palette (including your skills); `@` mentions a file.
- **Subagents:** the agent can propose a batch of helper agents (up to 6) for parallel work. You
  approve the batch once. In Code each helper may edit only the files it declared, so they do not collide.
- **Browser:** a real browser on the server that the agent can use (and you can watch and drive in the Browser
  tab). It keeps logins. You allow it per website.
- **Heads-up cards:** short caveats the agent wants you to know before acting. "Knew this already" hides that kind
  for good.
- **End-of-turn box:** after real work, a short recap and, when you need to decide, a question with buttons.
</details>

## Messages and search

<details>
<summary>Message actions</summary>

- **Code:** Copy, **Rewind** (back to before a message; in a synced folder it can restore the files too), **Fork**
  (a new session up to that point), **Pin** (listed in Overview), Read aloud.
- **Chat:** Retry, Edit (rewinds and re-sends), Copy, Read aloud.
- The latest turn's actions are always visible; older ones on hover.
</details>

<details>
<summary>Search</summary>

- **⌘K** searches all your sessions: keyword matches with highlighted snippets, and "Relevant" results ranked by
  meaning (ranked by Claude Haiku).
- **⌘F** inside a session finds text in the whole conversation.
</details>

## The side panel

On wide screens the tab buttons are in the top bar and the panel header shows the open tab's name. On narrow
screens the panel overlays the page and keeps its own tab row.

<details>
<summary>Overview, Files, Changes, History, Terminal, Browser, Sync</summary>

- **Overview:** the server, folder and model; a per-session notification switch; context use with a breakdown and
  "Compact session"; files this session created; pinned messages; background tasks (long commands, subagents) with
  a stop button.
- **Files:** browse, preview, upload, download (folders and selections as zip), delete. In a new Code draft it shows
  the folder the session will start in.
- **Changes:** what the agent changed in a synced project, as a diff. Accept or reject per file, per hunk, or all.
- **History:** snapshots per turn, per sync and per accept; restore a file or everything.
- **Terminal:** real shells on the server, kept running when you close the page. It is off for new users until an admin turns it on (admins have it from the start).
- **Browser:** the server's browser, live.
- **Sync** (Mac app only): what syncs from the linked folder, and new items waiting for a decision.
</details>

## Agent Workstation for macOS

The whole web app in a native window, plus what only a Mac can do: folder sync, notifications, downloads to your
Downloads folder, updates.

<details>
<summary>Folder sync and what goes to the server</summary>

Link a local folder (drop it on the window or the start page, use the folder button in the message box, the Dock
icon, File → Link Folder, or type a path). Your Mac stays the original; the server gets a working copy for the agent.

- **Choosing what to sync:** before anything is uploaded, a window shows the folder's first level and up to 3 items
  inside each folder (the rest as "+N more"), all checked. Uncheck what should stay on your Mac. There are no
  built-in rules and no `.gitignore` matching: only your choices count.
- **New files later:** a new or changed item in a folder where you unchecked something waits in the **Sync** tab
  (with a notification) until you decide; in a folder where everything syncs, it syncs on its own. Nothing inside an
  unchecked folder ever syncs or asks. The linked folder itself follows the same rule. `.git` never syncs.
- **On the server:** only `.git` and what you unchecked are left out. Files the agent creates in an unchecked folder
  stay out of Changes.
- **Large files:** files over 100 MB always ask first, because every version of them is kept on the server. Once
  approved they sync like any file (chunked uploads that resume if interrupted), show in Changes (accept or reject the
  whole file) and appear in History.
- **Afterwards:** you can change any folder or file in the **Sync** tab at any time.
- **Cloud folders:** a folder in OneDrive, iCloud Drive, Google Drive, Dropbox or Box may hold files that are only in
  the cloud. Agent Workstation never downloads them itself: it tells you how many there are and which Finder command keeps the
  folder on your Mac ("Always Keep on This Device" in OneDrive, "Keep Downloaded" in iCloud Drive, "Available
  offline" in Google Drive, "Make available offline" in Dropbox and Box), then continues once they are local. A file
  the provider later removes from your Mac is not treated as a change.
- **Server → Mac:** nothing is written to your Mac unless you accepted it in the Changes tab (or restored it from
  History). Overwritten files are backed up; deleted ones go to the Trash. A conflict with your own unsynced edit
  always asks.
</details>

<details>
<summary>Notifications and window</summary>

- Notifications when a permission is needed, when a long turn (5 min or more) finishes, when a session has waited for
  you for a minute, for sync conflicts and low storage. Switch them per session (Overview) or everywhere (gear
  menu).
- Closing the window keeps Agent Workstation running in the background; ⌘Q quits.
- Updates are checked daily and verified before download; Agent Workstation never installs on its own.
</details>

## Usage, limits and storage

<details>
<summary>Usage page</summary>

API credits spent and left in the current budget period, and your token use and estimated cost by model.
</details>

<details>
<summary>Storage never empties itself</summary>

Agent Workstation never deletes anything on its own. When the server's disk is 80 % full you get a warning showing what uses the
space; at 95 % the server becomes read-only (no sending or uploading) until you free space. You delete things yourself,
with a confirmation that shows what you would lose.
</details>

<details>
<summary>Admin</summary>

The admin page: a switch to pause remote AI use, disk thresholds, weekly token limits, model allowlists and terminal
access (new users start without a terminal), the monthly API budget (with a small reserve kept for Agent Workstation's own services, such as the docs assistant and search), current model prices (checked daily),
and token use over time. The status page (`/status/`) shows the server's CPU, memory, temperature, disk, network,
service health and API credits with timelines.
</details>

## Privacy and access

<details>
<summary>Who can reach Agent Workstation</summary>

Only devices in your Tailscale network can reach it; it is closed to the internet and to the server's local network.
There are no passwords: your Tailscale account identifies you. Agents run under a separate account without
administrator rights and cannot read Agent Workstation's own data. All users' agents and terminals share that one
account, and another username's agent could read your workspace files: Agent Workstation is for personal use, not for sharing.

Every AI request is made by the server, never by your device. Your devices talk only to the server:
images linked in answers are not loaded until you click them, libraries for interactive visuals come from the server,
and read aloud uses your device's own voices.
</details>

<details>
<summary>Project settings</summary>

A project's own settings files (`.claude/settings.json`, `.mcp.json`) are not read by default, because their hooks,
helper commands and servers would run on the server as the agent account. The project's `CLAUDE.md` and
`.claude/CLAUDE.md` still guide the session, and its skills, commands and agents still load; they appear as
`/project:<name>`, and your own and the global skills as `/workstation:<name>`. An admin can turn the settings files on in
the server's configuration (`[sessions] project_settings`) for projects they trust.
</details>
