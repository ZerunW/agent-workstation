# Contributing

Thanks for helping. This page covers how changes flow into the repository, how to run and
test each part, and the rules that keep the pieces compatible. Start with the
[README](../README.md) and [ARCHITECTURE.md](ARCHITECTURE.md) for what the system is.

## Workflow

Agent Workstation uses **trunk-based development**.

- `main` is always deployable. CI (below) must be green on every commit that lands there.
- Small changes go straight to `main` through a pull request that is merged quickly.
- Open a short-lived branch only when a change spans several days, or when two people are
  touching the same area at once. Keep it rebased on `main` and delete it after merging.
  Long-lived feature branches are not used.
- Releases are tags of the form `vX.Y.Z` on `main`; the version is declared in the root and package `package.json`
  files and in `apps/mac/VERSION`. The macOS `.dmg` is attached to the GitHub Release for the tag; the server side is
  installed or updated from the tag ([INSTALL.md](INSTALL.md)).
- Add a line to [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

Pull requests use the template in `.github/PULL_REQUEST_TEMPLATE.md`. Bug reports and feature
requests have templates under `.github/ISSUE_TEMPLATE/`.

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

- on Ubuntu with Node 22: `npm ci`, `npm run build:libs` (protocol, sync-core and browser), `npm run typecheck`,
  `npm run lint`, `npm test`, `npm run build`, and the protocol documentation drift check;
- the deploy scripts: `bash -n` on each and `bash deploy/test/proxy-trust.test.sh`;
- a secret scan (`bash scripts/test/check-secrets.test.sh`, then `bash scripts/check-secrets.sh`: API keys and tokens of common services, private key blocks, committed key or `.env` files; run it before committing);
- on a macOS runner: `swift build` and `swift test` in `apps/mac`.

Run the same commands locally before you push.

## Repository layout

| Path | What |
|---|---|
| `packages/protocol` | The wire contract: zod schemas and the inferred TypeScript types. Everything else imports it. |
| `packages/sync-core` | The server-side git machinery behind sync, review, snapshots and restore. |
| `packages/hub` | `workstation-hub` backend: Fastify, WebSocket, SQLite, Claude Agent SDK sessions, files, terminal, usage, admin, disk guard, sync and review. |
| `packages/browser` | The per-user server browser (headless Chromium) service. |
| `packages/web` | React/Vite web UI. Its `src/embed` entry is a separate transcript/diff/terminal page for host apps ([EMBED-BRIDGE.md](EMBED-BRIDGE.md)). |
| `packages/status` | `workstation-status`: metrics collector, health checks, bandwidth probe, status page (`ui/`). |
| `apps/mac` | SwiftUI macOS app as a Swift package ([MAC-APP.md](MAC-APP.md)). |
| `deploy/` | systemd units, install and deploy scripts, nginx, nftables, sshd hardening. |
| `config/` | `workstation.example.toml`; your copy `workstation.toml` is git-ignored. |
| `scripts/` | `bootstrap.sh`, `gen-protocol-docs.mts`, `make-app.sh` (macOS bundle), maintenance helpers. |
| `docs/` | Documentation. `PROTOCOL.md` is generated. |

The root `package.json` defines npm workspaces for `packages/*`. Node 22 or newer is required.

## Rules that keep the pieces compatible

These hold for every change. The reasoning behind most of them is in [ARCHITECTURE.md](ARCHITECTURE.md) and [SECURITY.md](SECURITY.md).

1. **Protocol first.** Change `packages/protocol/src/index.ts`, rebuild it, regenerate the docs, then the hub, then the
   clients (web and the Swift mirror). Never change a payload in one place only.
2. **Never delete user data automatically.** No expiry, cleanup timers or "free space" jobs. Disk: warn at 80 %,
   read-only at 95 %, the user deletes. Destructive project operations write a backup ref first.
3. **Never write to the user's Mac without their decision.** Server to Mac writes happen only for changes the user
   accepted (Changes tab) or restored (History), with backups. Mac to server follows the sync selection rules (the
   "Sync selection" block in the protocol).
4. **Sessions never get sudo.** They run as a separate unprivileged account through `deploy/workstation-agent-exec`.
   Code that needs root documents the exact command for the administrator instead.
5. **Sandbox and network rules are security boundaries.** Code sessions are confined to their working directory;
   outbound commands (push, publish, upload, ssh/scp) always ask; chat sandboxes reach only PyPI. Do not loosen these
   without a maintainer's decision, and keep the guide text (`packages/hub/src/sessions/guide.ts`) true.
6. **No secrets or personal values in the repository.** Hostnames, emails, tokens and admin lists live in the
   git-ignored `config/workstation.toml` or on the server. Use `example.com` names in docs and tests. Never read or
   print `/etc/agent-workstation/*.env` or `/etc/agent-workstation/*.ini` on a server.
7. **UI copy is terse.** No subtitles, hint paragraphs or explanatory empty states; explanations belong in
   `docs/readme/`.

### When you change...

- **What a session can do** (tools, sandbox, network, permissions): update `guide.ts`, its budget tests
  (`packages/hub/test/guide.test.ts`) and [AGENT-GUIDE.md](AGENT-GUIDE.md) in the same change.
- **Anything a user sees**: update `docs/readme/features.md` (or `getting-started.md`) and add a line to
  [CHANGELOG.md](CHANGELOG.md).
- **Deploy-time behaviour** (units, wrapper, nginx, firewall): update [INSTALL.md](INSTALL.md), [DEPLOY.md](DEPLOY.md) and
  `deploy/README.md`.

### Pitfalls

- `deploy/workstation-agent-exec` is a template. Installing it unrendered makes every agent process exit 126; render it
  with the server's values (as `deploy/install.sh` does) before `install -m 0755`.
- `deploy/deploy.sh` restarts the hub, which ends running sessions. Deploy only when nothing is busy.
- `scripts/make-app.sh` and `apps/mac/dist` belong to the maintainers (signed builds); leave them out of a contribution.
- `MAX_SYNC_FILE_BYTES` (100 MB): larger files are "large files": chunked uploads, a pointer in the review git, content
  in a per-project store. Never read one into memory or pass it through git buffers.
- Claude Code's sandbox needs `CLAUDE_CODE_TMPDIR` of at most 44 bytes, or it silently falls back to a shared temp
  directory.
- The macOS developer shell is zsh: an unquoted variable holding several words is one argument.

## Setting up

```bash
git clone <repository URL> && cd agent-workstation
bash scripts/bootstrap.sh       # npm install, builds the protocol package, installs the Playwright browser,
                                # creates config/workstation.toml from the example with header identity and an `admin` user
```

The hub needs an Anthropic API key (`[auth] anthropic_api_key_file`, see `config/workstation.example.toml`) to start real
sessions. Everything else, including the whole web UI, can be exercised without one.

## Running each package in development

| Package | Command | Notes |
|---|---|---|
| protocol | `npm run build -w packages/protocol` | Other packages consume `packages/protocol/dist`; rebuild after editing the schemas. |
| hub | `npm run dev:hub` | `tsx watch`, one TCP listener on `http://localhost:9000` (`[server] host`/`port`; development only, a deployed hub listens on Unix sockets). Reads `config/workstation.toml`; point `WORKSTATION_USERS_ROOT` and `WORKSTATION_DATA_DIR` at scratch directories to keep your machine clean. |
| web | `npm run dev:web` | Vite on `http://localhost:5173`, proxies `/api` and `/ws` to the hub (the hub refuses other web origins: set `allowed_origins = ["http://localhost:5173"]` under `[server]` in `config/workstation.toml`). `npm run mock -w packages/web` starts a mock hub if you have no API key. |
| status | `npm run dev:status` | `http://localhost:9100/status`. `WORKSTATION_STATUS_DEMO=1` (`npm run demo -w packages/status`) serves synthetic data on machines that are not the server. |
| mac | `cd apps/mac && ./scripts/swiftpm.sh build` | The wrapper works around Command Line Tools-only setups (plain `swift` is fine with Xcode). `bash scripts/make-app.sh` builds an `.app` bundle ([MAC-APP.md](MAC-APP.md)). |

## Tests

| Part | Command |
|---|---|
| Everything (Node packages) | `npm run build:libs`, then `npm run typecheck` and `npm test` at the root |
| hub | `npm test -w packages/hub` (Vitest) |
| web | `npm test -w packages/web` (Vitest, jsdom, Testing Library); `npm run lint -w packages/web` |
| web end to end | `E2E_BASE_URL=http://localhost:9000 npm run e2e -w packages/web` (Playwright against a running development hub or the mock hub; without the variable the specs skip themselves) |
| status | `npm test -w packages/status` (Vitest) |
| sync-core, browser | `npm test -w packages/sync-core`, `npm test -w packages/browser` (Vitest) |
| deploy scripts | `bash deploy/test/proxy-trust.test.sh` (the wrapper test, `deploy/test/workstation-agent-exec.test.sh`, needs a Linux host) |
| protocol | `npm test -w packages/protocol` (Vitest) and `npm run typecheck -w packages/protocol`; the generated documentation must be current (below) |
| mac | `cd apps/mac && ./scripts/swiftpm.sh test` (Swift Testing; plain `swift test` with Xcode) |

New behavior comes with a test in the package that owns it. Hub tests use the recording
broadcaster instead of real sockets; status checks are tested with injected `exec`/`fetch`
doubles rather than the real system.

## Changing the protocol

`packages/protocol` is the only place where a route or event is defined. When a change touches
the wire:

1. **Edit `packages/protocol/src/index.ts` first.** Add or change the zod schema, export it,
   add the route to `ROUTES` (or the event to `ClientEvent` / `ServerEvent`). Prefer additive
   changes: new optional fields, new routes, new event types. Bump `PROTOCOL_VERSION` only for
   a breaking change.
2. **Describe it.** Put JSDoc on the schema and on non-obvious fields; the doc generator reads
   it. Declaration order and the banner comments decide where things appear in the docs.
3. **Regenerate the reference:**

   ```bash
   npm run build -w packages/protocol
   npx tsx scripts/gen-protocol-docs.mts          # rewrites docs/PROTOCOL.md
   ```

   The generator needs to know which schemas a new route uses: add an entry to `ENDPOINTS`
   (or `STATUS_ENDPOINTS`) at the top of `scripts/gen-protocol-docs.mts`, and a line to
   `EVENT_NOTES` for a new event. CI runs `npx tsx scripts/gen-protocol-docs.mts --check` and
   fails when `docs/PROTOCOL.md` is stale or a route has no mapping. Commit the regenerated
   file with the change.
4. **Then update both sides**: the hub (`packages/hub`), and the clients (`packages/web`, the
   Swift API client in `apps/mac`). Never change a payload shape in one place only.

## Coding conventions

- **TypeScript, strict.** `tsconfig.base.json` enables `strict` and `noUncheckedIndexedAccess`;
  keep it that way. ES modules and Node 22 APIs. No `any` without a comment saying why.
- **zod at the boundaries.** Everything that enters the hub from a socket, a request, a file
  or the SDK's loosely typed output is parsed with a schema from the protocol package (or a
  local one for internal config). Inside the code, work with the inferred types. Tolerate
  unknown fields from the SDK (its `usage_report` is experimental).
- **Paths.** Every path from a client is relative to the user's workspace root. Resolve and
  check it with the shared helpers in `packages/hub/src/files/paths.ts`; reject `..`, absolute
  paths and symlink escapes. Never join a client path into a filesystem path by hand.
- **No secrets, no personal values.** Server addresses, domains, admin lists and tokens go in
  the git-ignored `config/workstation.toml` or on the server; the example file contains placeholders
  only. Never commit tokens, `.env` files, SQLite files or logs. Use `example.com` style names
  in documentation and tests.
- **Never delete automatically.** The system must not remove user data on its own: no expiry,
  no cleanup timers, no "free space" jobs. Every deletion (sessions, uploads, generated files,
  project copies) is started by a user click, shows what it will free, and asks for
  confirmation. Destructive operations on project copies write a backup ref first. If a feature
  needs space, it warns and waits.
- **Sessions are database rows; Claude processes are a cache.** Do not add state that only
  lives in a process. Anything the UI needs after a reload is persisted or can be rebuilt from
  the database and the snapshot.
- **Errors.** REST failures return the protocol's `ErrorBody` with a stable `code` from
  `ERROR_CODES` (add a code there, and a line in the generator, for a new failure class).
- **Style.** `.editorconfig` applies (two spaces, LF, final newline; four spaces for Swift).
  Prefer small modules and plain functions; comment the *why*.
- **Swift.** The app talks to the hub only through the documented protocol; decode with
  `Codable` types that mirror `PROTOCOL.md`. Doc comments (`///`) on public API.

## How to add...

### A REST route

1. Protocol first (section above): request and response schemas, `ROUTES` entry, regenerate
   the docs.
2. Hub: add a handler in `packages/hub/src/routes/`, validate input with the schema, enforce
   the user and admin checks the same way the neighbouring routes do, and map failures to
   `ErrorBody`. Put the logic in a service module, not in the handler.
3. Test it in `packages/hub` (handler plus service).
4. Clients: add the call to `packages/web/src/lib/api.ts` and, if the app needs it, to the
   Swift client.

### A health check

Health checks live in `packages/status/src/health/checks.ts`.

1. Write a `CheckDef` `{ id, label, intervalS?, timeoutMs?, run(ctx) }`. `run` receives
   injected `exec`, `fetch`, `readers` and `lookupHost` and returns
   `{ state: "ok" | "warn" | "fail" | "unknown", detail?, latencyMs?, metrics? }`. Use the
   injected helpers, never the globals, so the check is testable. For a systemd unit use the
   existing `unitCheck` helper.
2. Add it to `defaultChecks` in display order.
3. Cover it in `packages/status/test/health.test.ts` with fake `exec`/`fetch` results.
4. If it needs configuration, add a key under `[status]` in `packages/status/src/config.ts`,
   `config/workstation.example.toml` and the table in [DEPLOY.md](DEPLOY.md).

State changes are recorded as events automatically; the status page and `GET /status/api/health`
pick the new check up without protocol changes.

### A UI panel

The web UI is React with Zustand stores and Radix primitives.

1. Create the component under `packages/web/src/components/<area>/` and keep fetching and
   state in `packages/web/src/store/` or a hook, so the component stays presentational.
2. Right-hand panels (files, changes, history, terminal) are tabs registered in
   `packages/web/src/components/shell/RightPanel.tsx`; full pages are routes in
   `packages/web/src/App.tsx`.
3. Use the shared primitives in `components/ui/`, support light and dark themes, and give every
   action a keyboard path where the surrounding UI has one.
4. Add a Vitest/Testing Library test next to the component.
5. The macOS app shows the full web UI, so a new panel needs no native work. If a host app should show it through the
   embed entry, extend the contract in [EMBED-BRIDGE.md](EMBED-BRIDGE.md) in the same change.
