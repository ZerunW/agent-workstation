# Privacy

Agent Workstation is software you run on your own server. Nobody but you (the person who installs it) operates it: there
is no Agent Workstation service, account or company that receives your data. This page lists what the software sends
out of the server, what it keeps on it, and who can see it. [SECURITY.md](SECURITY.md) covers how access is enforced.

## What leaves the server

- **The model API (Anthropic).** Every prompt, the conversation so far, the instructions and memories the session
  carries, attached files and whatever the agent reads or a tool returns during a turn are sent to the Anthropic API
  with your API key, through the hub's key proxy. Session summaries for search are made by a short request of the same
  kind (session titles are taken from the first message on the server). Anthropic's own terms and privacy policy apply to that data.
- **Claude Code itself.** With `[agents] run_as` (what `deploy/install.sh` sets up), agent processes run through
  `deploy/workstation-agent-exec` with `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1`, so Claude Code sends no
  usage statistics or error reports of its own. A development setup without `run_as` starts Claude Code directly and
  does not set them; set them in the hub's environment yourself there.
- **Web pages the agent opens.** Web search and page reading in chats, packages a code session installs, and sites the
  server browser visits (only sites the user allows) are reached from the server like any other client would reach
  them.
- **Price check.** Once a day (`[pricing] check_time`, default 04:30) the hub reads Anthropic's public pricing page to
  notice price changes. It sends nothing about you or your usage.
- **Speed test.** Every 60 minutes by default the status service downloads 20 MB and uploads 10 MB of test data
  to and from `speed.cloudflare.com`. No user data is sent. Turn it off with `[status] speed_probe_interval_min = 0`.
- **Libraries for visuals.** When a visual in a chat uses a JavaScript library from cdnjs or jsDelivr, the hub fetches
  that library once and caches it, so the browser does not load it from the CDN.
- **Tailscale.** `tailscaled` talks to Tailscale's coordination service to run your tailnet; Tailscale's own policy
  applies. The hub only asks the local `tailscaled` who a caller is.

There is no analytics, tracking or advertising code in the hub, the web UI or the macOS app. The macOS app talks only
to your server; it checks for updates through your server, which relays releases signed by the maintainer.

## What stays on the server

Under `/var/lib/agent-workstation`, the users folder (`/srv/agent-workstation/users`) and the agent account's home:

- sessions and their transcripts, attachments and files the agents write;
- synced projects with their review history and backups;
- usage records (tokens and cost per request), memories, each user's instructions and known heads-ups;
- search indexes and session summaries;
- each user's server browser profile (cookies and logins of the sites they used);
- the username, and with Tailscale identity on, the Tailscale login (an email address) each username is bound to.

Nothing is deleted automatically: there is no expiry and no cleanup job. Users delete their own sessions, files and
memories; an administrator deletes users. The one exception is a user's own choice: an incognito chat is deleted when
it is closed, and one left open when the hub stopped is deleted when the hub starts again. Disk use is warned about at 80 % and writes stop at 95 %.

## Who can see it

- **Administrators** (in the app) see every user's usage and can delete users. Whoever can log in to the server's
  operating system as root can read everything on it.
- **Users** see their own sessions, files and memories in the UI and API.
- **Agents and terminals** of all users run as one account (`workstation-agent`), so one user's agent can read
  another user's workspace. Agent Workstation is for one person and not built to be shared
  ([STATUS.md](STATUS.md#known-limits), [SECURITY.md](SECURITY.md#limits-between-users)).

## Logs

The hub and the status service log to the systemd journal. Ordinary requests, refused ones included, are not logged; a
request that ends in a server error is (method and URL, which can hold a session ID or a file path). The hub also logs every network
attempt from an agent's sandbox (session ID, host and address, allowed or not), outbound commands (session ID and the
kind of command, such as a push or an upload), and errors. When a Claude process exits unexpectedly, the end of its
error output is logged (up to 500 characters) and shown in that session (up to 1,000); credential-shaped text in it is
masked first (as in every logged error output of an agent command, such as a failed download), but it can still contain
paths or fragments of what the process was working on. Logs are not meant to
hold prompts or file contents, and they show who used the server, when, and which hosts their agents contacted.

Who can read them and for how long follows your journald settings: by default root and members of the `adm` and
`systemd-journal` groups, kept until journald's size limits rotate them out. Before sharing a log, for example in a
public issue, remove email addresses, Tailscale addresses and names, host and device names, paths, session IDs and any
key or token.
