# @agent-workstation/status (`workstation-status`)

Metrics collector, health checks and the live status page for the Agent Workstation server. A separate process from the
hub (so it keeps reporting while the hub is down), TypeScript ESM on Node 22: Fastify 5, better-sqlite3, smol-toml,
pino, zod. The page is a small Vite + TypeScript app with uPlot, no framework.

- Service: `workstation-status`, listens on `/run/agent-workstation/status.sock` (mode 0660, group `workstation-proxy`; only nginx connects) and calls the hub through the hub's local socket. With `[status].listen = "tcp"` (development, the default outside systemd) it listens on `[status].host`:`[status].port` (9100) and asks the hub over TCP.
- Page: behind nginx `https://<name>/status/` (`/` redirects there); in development `http://<host>:9100/status/`.
- Contract: `STATUS_ROUTES`, `MetricsResponse`, `HealthResponse`, `UsageLimits` from `@agent-workstation/protocol`.

## Run

```sh
npm run build -w packages/status      # tsc -> dist/, vite -> dist/ui
npm run start -w packages/status      # node dist/main.js
npm run dev -w packages/status        # tsx watch src/main.ts
npm run dev:ui -w packages/status     # Vite dev server on :5174, proxies /status/api to :9100
npm run demo -w packages/status       # synthetic data on 127.0.0.1 (temp DB), for UI work on a Mac
npm test -w packages/status           # vitest (no Linux needed)
npm run typecheck -w packages/status  # server + tests + UI
```

On the server the systemd unit (`deploy/systemd/workstation-status.service`) runs `node packages/status/dist/main.js` with
`WORKSTATION_CONFIG=/etc/agent-workstation/workstation.toml`.

## Configuration

Same lookup as the hub: `$WORKSTATION_CONFIG` (must exist if set), `./config/workstation.toml`, `/etc/agent-workstation/workstation.toml`,
then built-in defaults. Only these keys matter here:

| Key | Default | Meaning |
|---|---|---|
| `[server].listen` / `local_socket` / `proxy_group` | like the hub | how the hub is reached (its local socket when it listens on sockets) and the group of this service's socket |
| `[server].host` / `port` | `127.0.0.1` / `9000` | the hub's TCP address, used only when the hub listens on TCP (`http://127.0.0.1:<port>`; a concrete `host` is used instead of loopback) |
| `[server].public_url` | none | used for the "Manage usage" link and, when it is a DNS name, for the DNS check |
| `[paths].data_dir` | `/var/lib/agent-workstation` | SQLite file is `<data_dir>/status.sqlite` |
| `[paths].users_root` | `/srv/agent-workstation/users` | its filesystem is the second disk-usage series |
| `[limits].disk_warn_percent` / `disk_block_percent` | 80 / 95 | thresholds **drawn** on the disk chart, never acted on |
| `[status].listen` / `socket` | like `[server].listen` / `/run/agent-workstation/status.sock` | the service's public socket (0660, group `[server].proxy_group`) |
| `[status].port` | 9100 | with `listen = "tcp"` only |
| `[status].sample_interval_s` | 10 | collector period (2..300) |
| `[status].health_interval_s` | 60 | health tick (5..3600) |
| `[status].interfaces` | `["tailscale0"]` | interfaces to graph; missing ones give null points |
| `[status].speed_probe_interval_min` | 60 | periodic bandwidth probe, 0 = off |
| `[status].hub_socket` / `hub_url` | `[server].local_socket` / derived | where the hub is: its local socket, or over TCP at `hub_url` (development) |
| `[status].host` | `127.0.0.1` | bind address with `listen = "tcp"` |
| `[status].hub_user` | `status` | `X-Workstation-User` sent to the hub (health checks and `/api/usage/limits`); the only name the service sends, never one from a caller |
| `[status].dns_check_host` | host of `public_url` if it is a name | name that must resolve to this machine's tailscale IP |
| `[status].nvme_device` | `nvme0n1` | block device for IO counters and SMART |

Unknown keys under `[status]` are reported as warnings in the log.

## What it collects

Every `sample_interval_s`, on a wall-clock aligned grid (so timestamps are exact multiples of the interval):

| Metric | Source |
|---|---|
| `cpu_total_pct`, `cpu_core<N>_pct` | `/proc/stat` deltas |
| `load_1`, `load_5`, `load_15` | `/proc/loadavg` |
| `mem_used_pct`, `mem_used_bytes`, `mem_available_bytes` | `/proc/meminfo` (used = total - MemAvailable) |
| `zram_used_bytes`, `zram_orig_bytes` | `/sys/block/zram*/mm_stat` |
| `disk_root_used_pct/_bytes`, `disk_users_used_pct/_bytes` | `statfs` of `/` and `paths.users_root` (`df` semantics) |
| `disk_io_read_bps`, `disk_io_write_bps`, `disk_io_util_pct` | `/proc/diskstats` for `nvme_device` |
| `net_<iface>_rx_bps`, `net_<iface>_tx_bps` | `/proc/net/dev`, bytes per second |
| `temp_c` | max of `/sys/class/thermal/thermal_zone*/temp` |
| `uptime_s` | `/proc/uptime` |
| `probe_down_mbps`, `probe_up_mbps` | bandwidth probe |
| `latency_ping_ms`, `latency_https_ms`, `claude_procs` | reported by the health checks when they run |

The unit is implied by the suffix (`_pct` %, `_bytes`, `_bps` bytes/s, `_c` degrees C, `_mbps`, `_ms`, `_s`). Rates are
`null` on the first tick and whenever a counter goes backwards. A missing source (no `tailscale0` yet, no zram, no
sensors) stores an explicit `NULL`, which the API returns as `v: null`.

Storage (`status.sqlite`, WAL): raw samples 48 h, 1-minute aggregates (avg/min/max/n) 90 days, 1-hour aggregates forever.
Rollups run every minute from persisted watermarks (idempotent, resumes after downtime, weights by sample count);
retention runs every 10 minutes. Nothing here ever deletes user data; disk thresholds are display only.

## Health checks

Every `health_interval_s`, in parallel, each with its own timeout. State changes are persisted as events (the last 100
are returned). The first observation of a check is not a transition, and the last state is stored, so restarts do not
produce fake events.

| id | what | notes |
|---|---|---|
| `unit-workstation-hub`, `unit-workstation-status`, `unit-ssh` | `systemctl is-active` | `unknown` when systemctl is missing |
| `https-proxy` | the `nginx` or `caddy` unit, whichever is installed (nginx first) | running is `ok`, installed but stopped `fail`, neither installed `unknown / not installed` |
| `unit-tailscaled` | same as the units above | optional: "not installed" is `unknown` (grey), not red |
| `hub` | `GET <hub>/healthz` (falls back to `/api/health` on 404) | latency, version from the JSON body |
| `tailscale` | `tailscale status --json`, `Self.Online` | `unknown / not installed` when Tailscale is absent |
| `dns` | `dns_check_host` resolves to the `tailscale0` IP | `unknown` without a DNS name or tailscale |
| `internet-ping` | `ping -c1 -W2 1.1.1.1` | latency |
| `internet-https` | `HEAD https://api.anthropic.com` | any HTTP answer is reachable; latency |
| `api-credits` | the `api` block of the hub's `GET /api/usage/limits` (this period's API-credit spend against the admin's monthly budget) | every 5 min; `ok` below the warning level, `warn` at warning severity, `fail` at critical severity or when the budget is used up (100%), `unknown` when `api` is null / absent or the hub is unreachable |
| `claude-procs` | `processes` of the hub's `GET /api/health` (live Claude session processes) | "Claude N"; `unknown` when the hub is unreachable or does not report it |
| `nvme-smart` | `smartctl -H /dev/<nvme_device>` | every 30 min; runs `sudo -n smartctl`; `unknown` when the sudo rule or smartmontools is missing |
| `inotify` | watches in use vs `fs.inotify.max_user_watches` | every 5 min; warn at 90 %, fail at 98 % |

States: `ok` (green), `warn` (amber), `fail` (red), `unknown` (grey).

Checks that read the hub (`api-credits`, `claude-procs`) that cannot reach it (down, refused, timed out) are run
again after 30 s, then 60 s, then 120 s, up to their normal interval.

## HTTP API

| Route | Response |
|---|---|
| `GET /status/api/metrics?range=1h\|6h\|24h\|7d\|30d` | `MetricsResponse`: `{range, stepS, series:[{name, unit, points:[{t, v}]}]}` |
| `GET /status/api/health` | `HealthResponse`: `{checks, events}` |
| `GET /status/api/stream` | SSE, see below |
| `POST /status/api/speedtest` | starts a probe: `202`, `409` while running, `429` + `Retry-After` within a minute of the last manual run |
| `GET /status/api/speedtest` | `{running, last, nextManualAt}` |
| `GET /status/api/system` | server model (`/proc/device-tree/model`), kernel, uptime, disks, Node, service versions, thresholds, links |
| `GET /status/api/usage` | proxy of the hub's `GET /api/usage/limits` (`UsageLimits`: the `api` block), asked as `[status].hub_user`; on failure `{api: null, error}` |
| `GET /healthz`, `GET /status/healthz` | `{ok, service, version}` |
| `GET /status/`, `/status/*` | the UI (SPA fallback); `/` redirects here |

Every route under `/status/api/` refuses (`403 cross_site`) a request with an `Origin` that is not `[server].public_url`,
this server's Tailscale name or address, or loopback, and any request with `Sec-Fetch-Site: cross-site` (`src/origin.ts`,
the hub's rule); curl and other tools that send neither header are unaffected.

`t` is Unix **seconds**. Every series in a response shares the same regular grid (gaps are `v: null`), so clients can
feed uPlot directly. Resolution per range:

| Range | Tier | Step | Points |
|---|---|---|---|
| 1h | raw | `sample_interval_s` (10 s) | 360 |
| 6h | 1 min | 60 s | 360 |
| 24h | 1 min | 120 s | 720 |
| 7d | 1 min | 900 s | 672 |
| 30d | 1 h | 3600 s | 720 |

SSE events (`retry: 3000`, a `: keepalive` comment every 15 s): `hello` `{serverTime, sampleIntervalS, healthIntervalS}`,
`metrics` `{t, values}` every tick, `health` (`HealthResponse`) after every health run and once on connect, `probe`
`{running, last, nextManualAt}` when a speed test starts and finishes.

The speed probe downloads 20 MB from `https://speed.cloudflare.com/__down?bytes=20000000` and uploads 10 MB to
`https://speed.cloudflare.com/__up` with a browser-like `User-Agent` (the server refuses requests without one). The
periodic run is scheduled from the last probe time stored in the database, so redeploys do not trigger extra runs.

## The page

Header (server name, uptime, live indicator), a strip of current values, the health list with recent events, the usage
card (an API-credits group from `UsageLimits.api`: one compact full-width card with the bar and "Resets in … · Jan 15, 3:20 PM"
(one reset-time format everywhere: local time, date always, no seconds); it reads "This period" with "$12.00 / $100.00", or says why there is
nothing to show; a link to the hub's `/usage`), charts with
a 1h/6h/24h/7d/30d selector (CPU, load, memory, temperature, one network chart per interface, disk IO, disk usage with
the 80 % / 95 % lines, bandwidth probes with a "Run speed test" button, internet latency, Claude processes), and a system
card. Light and dark follow the system; layout works from phone width. The 1h view is fed live by SSE; longer ranges
refetch periodically. The bundle is about 75 kB (32 kB gzipped).

## Notes and limits

- `/api/usage/limits` needs a username at the hub: the service always asks as `[status].hub_user` (default `status`), never
  as a name a browser sends.
- The DNS check needs a name: set `[status].dns_check_host` or make `server.public_url` an `https://<name>` URL.
- Disk thresholds come from `[limits]` in the config file; runtime changes the hub's admin makes are not visible here.
- The first `ping`/`smartctl`/`tailscale` call fails softly (grey, "not installed") when the tool is absent.
