# Project status

Version 0.1.0, the initial release, a preview.

The test suites pass on macOS and the agent wrapper's tests pass on Linux (arm64 and x86-64). `deploy/install.sh` has not
yet been run end to end on a freshly installed server (from an empty system through `npm ci`, the build, the units,
nginx and Tailscale, and a reboot), so a first install may hit problems no test covers. Reports are welcome.

## Stable

- Chat and Code sessions on the Anthropic API, permission cards and modes, subagents, skills, memory.
- Files, terminal, usage and budget, the status page, the admin page.
- Tailscale identity and the nginx tailnet setup.
- Folder sync and review for the macOS app, including large files and History.
- The wire protocol is versioned (`PROTOCOL_VERSION` is 1); additive changes keep the version.

## Experimental

- The server browser (a per-user headless Chromium) and its live view.
- Subagent batches that edit files in parallel (each helper may edit only the files it declared).
- Per-command memory limits: off by default; they need root steps on the server and a change to the agent wrapper that is not included ([deploy/README.md](../deploy/README.md)).
- The macOS app is signed ad hoc by default; Developer ID signing and notarization are supported by the build script but
  depend on your own Apple Developer account.

## Known limits

- Personal use: one person, one server. Usernames are separate in the UI and API, but all of them run their agents and
  terminals as one account (`workstation-agent`) and can read each other's workspaces and see each other's processes, so
  it is not built to be shared ([SECURITY.md](SECURITY.md#limits-between-users)).
- The terminal is a real shell as the agent account (no sudo). It is off for new non-admin users; admins switch it on or
  off per person.
- A project's own Claude Code settings files (hooks, MCP servers, `env`, helper commands) are not read unless
  `[sessions] project_settings` is on, and then they run as the agent account ([SECURITY.md](SECURITY.md#project-provided-agent-settings)).
- Outbound-command detection reads the command line; it cannot see inside scripts.
- Snapshots at turn end run in the background: if the next queued turn writes immediately, a few of its changes can land in
  the previous turn's snapshot. Writes made by Bash are not recorded as file touches (snapshots capture them).
- Files over 100 MB sync as large files: every version is kept on the server, and review accepts or rejects them whole.
- The Mac app does not read cloud-only files (OneDrive, iCloud Drive, Google Drive, Dropbox, Box) until they are local.
- Debian and Ubuntu with systemd are the supported server platforms; the install script supports arm64 and x86-64.
- A server restart or deploy ends running sessions; terminals survive.
