# Agent Workstation

A self-hosted AI coding workstation. A Linux server runs the hub: sessions with Claude Code through the Anthropic API,
files, folder sync and review, a terminal, a server browser, and usage and budget controls. You reach it from a web UI
and a macOS app over [Tailscale](https://tailscale.com). It is never exposed to the internet.

Agent Workstation is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic. Claude and
Claude Code are trademarks of Anthropic, used here only to say what the software runs.

## Features

- **Chat:** conversations with their own sandboxed folder for running code, web search, memory, past-conversation
  lookup, interactive visuals and checked downloads.
- **Code:** a coding agent confined to one folder, with a streaming transcript, permission cards, model, mode and effort
  pickers, `/` commands and skills, subagents, a browser, a terminal, rewind and fork.
- **Folder sync and review (macOS app):** link a local folder, choose what syncs, let the agent work on the server copy
  and accept its changes back per file, per hunk or all. Your folder never becomes a git repository.
- **Usage and admin:** API credits metered per request against a monthly budget, daily price checks, weekly token
  limits, model allowlists and a status page with timelines.
- **Private by design:** reachable only inside your tailnet, no passwords, agents run as an unprivileged account, and
  nothing is ever deleted automatically.

## How it fits together

```
 Mac app / browser / phone      (Tailscale on each device)
              |
              |  tailnet (encrypted)
              v
 +------------------------ Linux server (Tailscale) --------------------------+
 |  nginx, bound to the Tailscale address only (HTTPS)                         |
 |    /status/   ->  workstation-status   metrics, health, API credits         |
 |    /api, /ws  ->  workstation-hub      sessions, files, sync, terminal      |
 |    /          ->  web UI (served by the hub)                                |
 |                                                                             |
 |  workstation-hub -> workstation-agent-exec -> Claude Code                   |
 |  (service account)   (root-owned wrapper)     (unprivileged agent account)  |
 +-----------------------------------------------------------+-----------------+
                                                             | HTTPS, API key
                                                             v
                                                       Anthropic API
```

### Why Tailscale

The server has no public address and opens no port to the internet. Tailscale is the access control:

- **Reachability.** nginx listens on the server's Tailscale address only, so only devices in your tailnet can connect.
  A device you have not added cannot open a connection at all.
- **Identity.** There are no passwords. The hub asks the local Tailscale daemon which Tailscale login a request comes
  from. Each username is bound to the first login that uses it, and the logins you list in the config are admins.
- **Encryption.** Traffic between your devices and the server travels through Tailscale's encrypted tunnel, and nginx
  adds HTTPS with a certificate issued for your tailnet name.

Install Tailscale on the server and on every device you use (Mac, PC, phone) and sign in. A free personal Tailscale
account is enough. [docs/INSTALL.md](docs/INSTALL.md) has the steps.

## Requirements

- A Linux server running Debian or Ubuntu with systemd, arm64 or x86-64, 4 GB of RAM or more, and an account with
  passwordless sudo.
- An [Anthropic API key](https://console.anthropic.com). Every Claude process is paid by this key, within a monthly
  budget the admin sets. Without a key, sessions are refused.
- [Tailscale](https://tailscale.com/download) on the server and on each device, with HTTPS certificates enabled for your
  tailnet.

> [!WARNING]
> Agent Workstation is for personal use: one person, on their own server, with their own API key. It is not built to be
> shared. Usernames on one server are not isolated from each other: every username's agents and terminals run as the
> same operating-system account and can read and change each other's files ([docs/SECURITY.md](docs/SECURITY.md)).

## Quick start

Follow [docs/INSTALL.md](docs/INSTALL.md), which covers the whole path: Tailscale, install, API key, HTTPS, first
sign-in, the macOS app, updates and troubleshooting.

## The macOS app

The app is the web UI in a native window plus what only a Mac can do: folder sync with a selection window, native review
and history, notifications, downloads and signed update checks. Download it from `/download` on your server (separate
builds for Apple Silicon and Intel) once a build has been published there, or build it yourself from `apps/mac`
([docs/MAC-APP.md](docs/MAC-APP.md)). The app is signed ad hoc, so macOS asks you to allow it once under System
Settings, Privacy & Security.

## Who it is for

One person, on their own server, with their own Anthropic API key. Every request is billed to that key, and you are
responsible for its use under Anthropic's terms; do not share access, resell it or charge anyone for it. Authentication
is by API key only: there is no Claude.ai sign-in and no use of Claude subscription plans.

## Security model

- The server is reachable only through your tailnet; the hub and the status service listen on Unix sockets only nginx can open (no TCP port).
- Claude Code and terminal shells run as a separate account without sudo, through a root-owned wrapper that validates
  every argument. That account cannot read the hub's data, configuration or API key, and cannot call the hub's API.
- Claude processes never see the API key. They talk to a loopback proxy in the hub with a per-process token.
- Code sessions are confined to their working directory and run commands in a sandbox. Commands that send data out
  (push, publish, upload, ssh) always ask.
- Nothing is deleted automatically (incognito chats end when you close them) and nothing is written to your Mac without
  your decision.
- No analytics or tracking. Prompts and context go to the Anthropic API; in an installed server (`[agents] run_as`)
  Claude Code's own telemetry and error reports are turned off.

Details and limits: [docs/SECURITY.md](docs/SECURITY.md). What leaves the server and what stays: [docs/PRIVACY.md](docs/PRIVACY.md).

## Documentation

| | |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Install on a server, add devices, update, uninstall, troubleshooting |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Configuration keys, API budget, operations |
| [deploy/README.md](deploy/README.md) | What the install scripts, accounts, units and firewall do |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Processes, sessions, sync and review |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model and boundaries |
| [docs/PRIVACY.md](docs/PRIVACY.md) | What leaves the server, what stays on it, who can see it, what the logs hold |
| [docs/MAC-APP.md](docs/MAC-APP.md) | Building, signing and using the macOS app |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | The wire protocol (generated) |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | Developing, testing, contributing |
| [docs/STATUS.md](docs/STATUS.md) | What is stable, what is experimental, known limits |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Release notes |

The user pages [Features](docs/readme/features.md) and [Get started](docs/readme/getting-started.md) are also served at
`/readme` on a running server.

## Third-party software

Agent Workstation is released under the MIT license. It integrates the Anthropic Claude Agent SDK and the Claude Code CLI,
which are proprietary software provided under Anthropic's terms. The MIT license of this repository does not cover them,
or any other dependency; each keeps its own license. You install them yourself, through npm (`npm ci`) and the install
script, and you are responsible for complying with Anthropic's terms when you use them. This repository does not
redistribute them. Release artifacts (archives, images, app bundles) must not bundle `node_modules` or Anthropic
binaries.

## License

MIT. Copyright (c) 2026 Zerun Wang. See [LICENSE](LICENSE).
