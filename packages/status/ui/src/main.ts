import "./style.css";
import { api, openStream, type ConnState } from "./api";
import { ChartCard, buildSpecs, readTheme } from "./charts";
import { clear, h, setChildren } from "./dom";
import { fmtAgo, fmtBitRate, fmtBytes, fmtDuration, fmtEventTime, fmtMbps, fmtUntil } from "./format";
import { agentsValue, systemRows } from "./systemModel";
import { resetLine, usageGroups, type UsageCard, type UsageGroup } from "./usageModel";
import { RANGES, type HealthCheck, type HealthResponse, type HealthState, type MetricsResponse, type ProbeState, type Range, type SystemInfo, type UsageLimits } from "./types";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface LiveMetrics {
  range: Range;
  stepS: number;
  xs: number[];
  series: Map<string, Array<number | null>>;
}

const state = {
  range: loadRange(),
  system: null as SystemInfo | null,
  systemAt: 0,
  health: null as HealthResponse | null,
  usage: null as UsageLimits | null,
  probe: null as ProbeState | null,
  metrics: null as LiveMetrics | null,
  latest: {} as Record<string, number | null>,
  conn: "connecting" as ConnState,
  apiOk: true,
  eventsExpanded: false,
};

const STATE_TEXT: Record<HealthState, string> = { ok: "OK", warn: "Degraded", fail: "Failing", unknown: "Unknown / not installed" };

const RANGE_KEY = "workstation-status-range";
function loadRange(): Range {
  try {
    const stored = localStorage.getItem(RANGE_KEY);
    if (stored && (RANGES as readonly string[]).includes(stored)) return stored as Range;
  } catch {
    /* storage unavailable (private mode) */
  }
  return "1h";
}

function saveRange(r: Range): void {
  try {
    localStorage.setItem(RANGE_KEY, r);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const ui = (() => {
  const heading = h("h1", null, "Agent Workstation status");
  const hostLine = h("p", { class: "host" });
  const uptime = h("span", { class: "uptime" });
  const conn = h("span", { class: "conn" });
  const rangeButtons = new Map<Range, HTMLButtonElement>();
  const rangeBar = h("div", { class: "ranges", role: "group", "aria-label": "Time range" });
  for (const r of RANGES) {
    const b = h("button", { type: "button", class: "range", "aria-pressed": String(r === state.range), onclick: () => setRange(r) }, r);
    rangeButtons.set(r, b);
    rangeBar.append(b);
  }
  const banner = h("div", { class: "banner", hidden: true, role: "alert" });
  const kpis = h("section", { class: "kpis", "aria-label": "Current values" });
  const healthSummary = h("div", { class: "summary" });
  const healthList = h("ul", { class: "hlist" });
  const eventsList = h("ul", { class: "events" });
  const eventsToggle = h("button", { type: "button", class: "link-btn", onclick: () => toggleEvents() });
  const usageBody = h("div", { class: "usage-body" });
  const usageLink = h("a", { class: "link", href: "#", target: "_blank", rel: "noopener" }, "Manage usage →");
  const chartsHost = h("section", { class: "charts" });
  const systemBody = h("dl", { class: "sysgrid" });

  const app = document.getElementById("app");
  if (!app) throw new Error("#app missing");
  setChildren(
    app,
    h(
      "header",
      { class: "top" },
      h("div", { class: "brand" }, h("img", { class: "mark", src: `${import.meta.env.BASE_URL}favicon.svg`, alt: "", width: 36, height: 36 }), h("div", null, heading, hostLine)),
      h("div", { class: "top-meta" }, uptime, conn),
    ),
    h("nav", { class: "toolbar" }, h("span", { class: "toolbar-label" }, "Charts"), rangeBar),
    h(
      "main",
      null,
      banner,
      kpis,
      h(
        "div",
        { class: "cols" },
        h("article", { class: "card" }, h("header", { class: "card-head" }, h("h2", null, "Health"), healthSummary), healthList),
        h(
          "article",
          { class: "card" },
          h("header", { class: "card-head" }, h("h2", null, "Usage"), h("div", { class: "head-right" }, usageLink)),
          usageBody,
        ),
      ),
      h("article", { class: "card" }, h("header", { class: "card-head" }, h("h2", null, "Recent events")), eventsList, eventsToggle),
      chartsHost,
      h("article", { class: "card" }, h("header", { class: "card-head" }, h("h2", null, "System")), systemBody),
    ),
  );
  return { heading, hostLine, uptime, conn, rangeButtons, banner, kpis, healthSummary, healthList, eventsList, eventsToggle, usageBody, usageLink, chartsHost, systemBody };
})();

// ---------------------------------------------------------------------------
// Connection, header, banner
// ---------------------------------------------------------------------------

function renderConn(): void {
  const live = state.conn === "live" && state.apiOk;
  ui.conn.className = `conn ${live ? "live" : state.conn === "connecting" ? "pending" : "down"}`;
  ui.conn.textContent = live ? "Live" : state.conn === "connecting" ? "Connecting…" : "Reconnecting…";
  if (!state.apiOk) {
    ui.banner.hidden = false;
    ui.banner.textContent = "Cannot reach the status service.";
  } else {
    ui.banner.hidden = true;
  }
}

function renderHeader(): void {
  const sys = state.system;
  ui.heading.textContent = sys?.model ?? "Agent Workstation status";
  ui.hostLine.textContent = sys ? `${sys.hostname} · ${sys.kernel} · ${sys.arch}` : "";
  const hub = hubBase();
  ui.usageLink.setAttribute("href", `${hub}/usage`);
}

function hubBase(): string {
  const links = state.system?.links;
  if (links?.hubPublicUrl) return links.hubPublicUrl.replace(/\/+$/, "");
  if (links) return `${location.protocol}//${location.hostname}:${links.hubPort}`;
  return location.origin;
}

function currentUptime(): number | null {
  const live = state.latest.uptime_s;
  if (typeof live === "number") return live + (Date.now() - lastLatestAt) / 1000;
  if (state.system) return state.system.uptimeS + (Date.now() - state.systemAt) / 1000;
  return null;
}
let lastLatestAt = Date.now();

// ---------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------

type Tone = "ok" | "warn" | "crit" | "";

function kpiTiles(): Array<{ label: string; value: string; sub: string; tone: Tone; compact?: boolean }> {
  const L = state.latest;
  const sys = state.system;
  const num = (k: string): number | null => (typeof L[k] === "number" ? (L[k] as number) : null);
  const pct = (v: number | null): string => (v === null ? "—" : `${v.toFixed(v < 10 ? 1 : 0)}%`);

  const cpu = num("cpu_total_pct");
  const load = [num("load_1"), num("load_5"), num("load_15")];
  const memPct = num("mem_used_pct");
  const memUsed = num("mem_used_bytes");
  const temp = num("temp_c");
  const disk = num("disk_root_used_pct");
  const warnAt = sys?.thresholds.diskWarnPercent ?? 80;
  const blockAt = sys?.thresholds.diskBlockPercent ?? 95;

  const ifaces = sys?.interfaces ?? [];
  const iface = ifaces.find((i) => num(`net_${i}_rx_bps`) !== null) ?? ifaces[0];
  const rx = iface ? num(`net_${iface}_rx_bps`) : null;
  const tx = iface ? num(`net_${iface}_tx_bps`) : null;

  return [
    { label: "CPU", value: pct(cpu), sub: load.every((v) => v === null) ? "" : `load ${load.map((v) => (v === null ? "—" : v.toFixed(2))).join(" / ")}`, tone: cpu !== null && cpu >= 90 ? "warn" : "" },
    { label: "Memory", value: pct(memPct), sub: memUsed !== null && sys ? `${fmtBytes(memUsed)} of ${fmtBytes(sys.memTotalBytes)}` : "", tone: memPct !== null && memPct >= 90 ? "warn" : "" },
    { label: "Temperature", value: temp === null ? "—" : `${temp.toFixed(0)} °C`, sub: "CPU", tone: temp !== null && temp >= 85 ? "crit" : temp !== null && temp >= 75 ? "warn" : "" },
    { label: "Disk /", value: pct(disk), sub: sys?.disks[0] ? `${fmtBytes(sys.disks[0].usedBytes)} of ${fmtBytes(sys.disks[0].totalBytes)}` : "", tone: disk !== null && disk >= blockAt ? "crit" : disk !== null && disk >= warnAt ? "warn" : "" },
    { label: "Network", value: rx === null && tx === null ? "—" : `↓ ${rx === null ? "—" : fmtBitRate(rx)}`, sub: rx === null && tx === null ? (iface ?? "") : `↑ ${tx === null ? "—" : fmtBitRate(tx)} · ${iface ?? ""}`, tone: "", compact: true },
    { label: "Agents", value: agentsValue(num("claude_procs")), sub: "", tone: "", compact: true },
  ];
}

function renderKpis(): void {
  const tiles = kpiTiles();
  if (ui.kpis.childElementCount !== tiles.length) {
    clear(ui.kpis);
    for (const t of tiles) ui.kpis.append(h("div", { class: "kpi" }, h("span", { class: "kpi-label" }, t.label), h("span", { class: "kpi-value" }), h("span", { class: "kpi-sub" })));
  }
  tiles.forEach((t, i) => {
    const el = ui.kpis.children[i];
    if (!el) return;
    el.className = `kpi ${t.tone}${t.compact ? " compact" : ""}`;
    const value = el.querySelector(".kpi-value");
    const sub = el.querySelector(".kpi-sub");
    if (value) value.textContent = t.value;
    if (sub) sub.textContent = t.sub;
  });
}

// ---------------------------------------------------------------------------
// Health and events
// ---------------------------------------------------------------------------

function healthRow(c: HealthCheck): HTMLElement {
  const at = Date.parse(c.checkedAt);
  return h(
    "li",
    { class: "hrow" },
    h("span", { class: `dot ${c.state}`, role: "img", "aria-label": STATE_TEXT[c.state], title: STATE_TEXT[c.state] }),
    h("div", { class: "hmain" }, h("div", { class: "hlabel" }, c.label), h("div", { class: "hdetail" }, c.detail ?? "")),
    h(
      "div",
      { class: "hmeta" },
      c.latencyMs !== null ? h("span", { class: "lat" }, `${Math.round(c.latencyMs)} ms`) : null,
      h("span", { class: "ago", "data-ago": at }, fmtAgo(Date.now() - at)),
    ),
  );
}

function renderHealth(): void {
  const hr = state.health;
  if (!hr) {
    setChildren(ui.healthList, h("li", { class: "muted" }, "Loading…"));
    return;
  }
  const count = (s: HealthState): number => hr.checks.filter((c) => c.state === s).length;
  const fail = count("fail");
  const warn = count("warn");
  const unknown = count("unknown");
  const ok = count("ok");
  setChildren(
    ui.healthSummary,
    fail > 0 ? h("span", { class: "pill fail" }, `${fail} failing`) : null,
    warn > 0 ? h("span", { class: "pill warn" }, `${warn} degraded`) : null,
    fail === 0 && warn === 0 ? h("span", { class: "pill ok" }, `${ok} OK`) : null,
    unknown > 0 ? h("span", { class: "pill unknown" }, `${unknown} n/a`) : null,
  );
  setChildren(ui.healthList, ...hr.checks.map(healthRow));
  document.title = fail > 0 ? `(${fail} failing) Agent Workstation status` : warn > 0 ? `(${warn} degraded) Agent Workstation status` : "Agent Workstation status";
  renderEvents();
}

function stateBadge(s: string): HTMLElement {
  const known = s === "ok" || s === "warn" || s === "fail" || s === "unknown";
  return h("span", { class: `badge s-${known ? s : "unknown"}` }, known ? STATE_TEXT[s as HealthState].split(" ")[0] ?? s : s);
}

const EVENTS_COLLAPSED = 8;

function renderEvents(): void {
  const hr = state.health;
  const events = hr?.events ?? [];
  const labels = new Map((hr?.checks ?? []).map((c) => [c.id, c.label]));
  const shown = state.eventsExpanded ? events : events.slice(0, EVENTS_COLLAPSED);
  if (events.length === 0) {
    setChildren(ui.eventsList, h("li", { class: "muted" }, "No state changes recorded yet."));
  } else {
    setChildren(
      ui.eventsList,
      ...shown.map((e) =>
        h(
          "li",
          { class: "event" },
          h("time", { datetime: e.at, class: "etime" }, fmtEventTime(Date.parse(e.at), Date.now())),
          h("span", { class: "elabel" }, labels.get(e.id) ?? e.id),
          h("span", { class: "etrans" }, stateBadge(e.from), " → ", stateBadge(e.to)),
          e.detail ? h("span", { class: "edetail" }, e.detail) : null,
        ),
      ),
    );
  }
  ui.eventsToggle.hidden = events.length <= EVENTS_COLLAPSED;
  ui.eventsToggle.textContent = state.eventsExpanded ? "Show fewer" : `Show all ${events.length}`;
}

function toggleEvents(): void {
  state.eventsExpanded = !state.eventsExpanded;
  renderEvents();
}

// ---------------------------------------------------------------------------
// Usage: the API-credit card
// ---------------------------------------------------------------------------

function usageCard(c: UsageCard): HTMLElement {
  const pct = c.percent;
  const reset = c.resetsAtMs === null ? null : resetLine(c.resetsAtMs, Date.now());
  return h(
    "div",
    { class: "ucard", "data-severity": c.severity },
    h("div", { class: "uhead" }, h("span", { class: "ulabel" }, c.label), h("span", { class: "upct" }, c.valueLabel ?? (pct === null ? "n/a" : `${pct.toFixed(0)}%`))),
    h(
      "div",
      { class: `bar sev-${c.severity}`, role: "progressbar", "aria-label": c.label, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": pct === null ? undefined : String(Math.round(pct)) },
      h("div", { class: "fill", style: `width:${Math.max(0, Math.min(100, pct ?? 0))}%` }),
    ),
    reset
      ? h("div", { class: "ureset" }, "Resets ", h("span", { "data-until": c.resetsAtMs }, reset.until), ` · ${reset.at}`)
      : h("div", { class: "ureset" }, "Reset time unknown"),
  );
}

function usageGroup(g: UsageGroup): HTMLElement {
  return h(
    "section",
    { class: "ugroup", "data-group": g.id },
    h(
      "div",
      { class: "ughead" },
      h("h3", null, g.title),
    ),
    ...g.cards.map(usageCard),
    ...g.notes.map((n) => h("p", { class: n.tone === "notice" ? "notice" : "muted small" }, n.text)),
  );
}

function renderUsage(): void {
  const u = state.usage;
  if (!u) {
    setChildren(ui.usageBody, h("p", { class: "muted" }, "Loading…"));
    return;
  }
  setChildren(ui.usageBody, ...usageGroups(u).map(usageGroup));
}

// ---------------------------------------------------------------------------
// System card
// ---------------------------------------------------------------------------

function renderSystem(): void {
  const s = state.system;
  if (!s) {
    setChildren(ui.systemBody, h("p", { class: "muted" }, "Loading…"));
    return;
  }
  setChildren(ui.systemBody, ...systemRows(s, Date.now()).flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v ?? "—")]));
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

let cards: ChartCard[] = [];
let cardsKey = "";
let probeUi: { button: HTMLButtonElement; note: HTMLElement } | null = null;

function ensureCharts(): void {
  const m = state.metrics;
  const names = new Set(m ? m.series.keys() : []);
  const specs = buildSpecs(names, state.system);
  const key = JSON.stringify(specs.map((s) => [s.id, s.series.length, s.subtitle ?? "", s.refLines?.map((r) => r.value) ?? []]));
  if (key === cardsKey) return;
  cardsKey = key;
  for (const c of cards) c.destroy();
  const theme = readTheme();
  cards = specs.map((s) => new ChartCard(s, theme));
  setChildren(ui.chartsHost, ...cards.map((c) => c.el));
  probeUi = null;
  const probeCard = cards.find((c) => c.spec.id === "probes");
  if (probeCard) {
    const button = h("button", { type: "button", class: "btn", onclick: () => void runSpeedTest() }, "Run speed test");
    const note = h("p", { class: "probe-note small", "aria-live": "polite" });
    probeCard.actions.append(button);
    probeCard.el.querySelector(".plot-wrap")?.before(note);
    probeUi = { button, note };
    renderProbe();
  }
}

function updateCharts(): void {
  const m = state.metrics;
  ensureCharts();
  if (!m) return;
  for (const c of cards) c.setData(m.xs, m.series);
}

function setMetrics(resp: MetricsResponse): void {
  const first = resp.series[0];
  const xs = first ? first.points.map((p) => p.t) : [];
  const series = new Map<string, Array<number | null>>();
  for (const s of resp.series) {
    if (s.points.length === xs.length) series.set(s.name, s.points.map((p) => p.v));
    else {
      const byT = new Map(s.points.map((p) => [p.t, p.v]));
      series.set(s.name, xs.map((t) => byT.get(t) ?? null));
    }
    // Seed the KPI tiles with the newest value of every series.
    for (let i = s.points.length - 1; i >= 0; i--) {
      const v = s.points[i]?.v;
      if (typeof v === "number") {
        if (state.latest[s.name] === undefined || state.latest[s.name] === null) state.latest[s.name] = v;
        break;
      }
    }
  }
  state.metrics = { range: resp.range as Range, stepS: resp.stepS, xs, series };
  lastLatestAt = Date.now();
  updateCharts();
  renderKpis();
}

/** Append a live sample to the 1 h view without refetching. */
function pushLive(t: number, values: Record<string, number | null>): void {
  const m = state.metrics;
  if (!m || m.range !== "1h") return;
  const last = m.xs[m.xs.length - 1];
  if (last !== undefined && t <= last) return;
  m.xs.push(t);
  for (const [name, col] of m.series) col.push(typeof values[name] === "number" ? (values[name] as number) : null);
  const cutoff = t - 3600;
  while (m.xs.length > 0 && (m.xs[0] ?? t) < cutoff) {
    m.xs.shift();
    for (const col of m.series.values()) col.shift();
  }
}

// ---------------------------------------------------------------------------
// Speed test
// ---------------------------------------------------------------------------

function renderProbe(): void {
  if (!probeUi) return;
  const p = state.probe;
  const { button, note } = probeUi;
  button.disabled = p?.running === true;
  button.textContent = p?.running ? "Running…" : "Run speed test";
  if (p?.last) {
    const l = p.last;
    const at = Date.parse(l.finishedAt);
    setChildren(
      note,
      l.error ? `Last run ${fmtAgo(Date.now() - at)} had a problem: ${l.error}. ` : "",
      `Last result: ↓ ${fmtMbps(l.downMbps)} · ↑ ${fmtMbps(l.upMbps)} (${l.trigger}, `,
      h("span", { "data-ago": at }, fmtAgo(Date.now() - at)),
      ")",
    );
  } else {
    setChildren(note, "No speed test has run since the service started.");
  }
}

let noteTimer: ReturnType<typeof setTimeout> | undefined;
function flashProbeNote(text: string): void {
  if (!probeUi) return;
  const note = probeUi.note;
  setChildren(note, text);
  clearTimeout(noteTimer);
  noteTimer = setTimeout(renderProbe, 6000);
}

async function runSpeedTest(): Promise<void> {
  if (!probeUi) return;
  probeUi.button.disabled = true;
  try {
    const r = await api.startSpeedTest();
    if (r.ok) {
      state.probe = { running: true, last: state.probe?.last ?? null, nextManualAt: Date.now() + 60_000 };
      renderProbe();
    } else if (r.status === 429) {
      flashProbeNote(`Try again in ${r.retryAfterS ?? 60} s.`);
      probeUi.button.disabled = false;
    } else if (r.status === 409) {
      flashProbeNote("A speed test is already running.");
    } else {
      flashProbeNote(`Could not start the speed test (${r.message ?? `HTTP ${r.status}`}).`);
      probeUi.button.disabled = false;
    }
  } catch {
    flashProbeNote("Could not reach the status service.");
    probeUi.button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadMetrics(): Promise<void> {
  try {
    const resp = await api.metrics(state.range);
    state.apiOk = true;
    setMetrics(resp);
    scheduleMetricsRefresh(resp.stepS);
  } catch {
    state.apiOk = false;
  }
  renderConn();
}

async function loadHealth(): Promise<void> {
  try {
    state.health = await api.health();
    state.apiOk = true;
    renderHealth();
  } catch {
    state.apiOk = false;
  }
  renderConn();
}

async function loadSystem(): Promise<void> {
  try {
    state.system = await api.system();
    state.systemAt = Date.now();
    renderHeader();
    renderSystem();
    renderKpis();
    ensureCharts();
    if (state.metrics) updateCharts();
  } catch {
    /* the system card keeps its last content */
  }
}

async function loadUsage(): Promise<void> {
  try {
    state.usage = await api.usage();
    renderUsage();
  } catch {
    /* keep the previous block */
  }
}

async function loadProbe(): Promise<void> {
  try {
    state.probe = await api.speedState();
    renderProbe();
  } catch {
    /* ignore */
  }
}

let metricsTimer: ReturnType<typeof setInterval> | undefined;
function scheduleMetricsRefresh(stepS: number): void {
  clearInterval(metricsTimer);
  // The 1 h view is fed by SSE, so it only needs an occasional resync.
  const every = state.range === "1h" ? 5 * 60_000 : Math.max(30_000, stepS * 500);
  metricsTimer = setInterval(() => void loadMetrics(), every);
}

function setRange(r: Range): void {
  if (r === state.range) return;
  state.range = r;
  saveRange(r);
  for (const [range, b] of ui.rangeButtons) b.setAttribute("aria-pressed", String(range === r));
  void loadMetrics();
}

function refreshAll(): void {
  void loadMetrics();
  void loadHealth();
  void loadUsage();
  void loadSystem();
  void loadProbe();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let healthRefetch: ReturnType<typeof setTimeout> | undefined;

renderConn();
renderHealth();
renderUsage();
renderSystem();
renderKpis();
ensureCharts();
refreshAll();

openStream({
  onState(s) {
    state.conn = s;
    renderConn();
  },
  onMetrics({ t, values }) {
    for (const [k, v] of Object.entries(values)) state.latest[k] = v;
    lastLatestAt = Date.now();
    pushLive(t, values);
    if (state.metrics?.range === "1h") updateCharts();
    renderKpis();
  },
  onHealth(hr: HealthResponse) {
    state.health = hr;
    renderHealth();
    // Latency / process-count samples are written by the health run; pick them up for the 1 h view.
    if (state.range === "1h") {
      clearTimeout(healthRefetch);
      healthRefetch = setTimeout(() => void loadMetrics(), 1500);
    }
  },
  onProbe(p: ProbeState) {
    const wasRunning = state.probe?.running === true;
    state.probe = p;
    renderProbe();
    if (wasRunning && !p.running) void loadMetrics();
  },
  onReconnect() {
    refreshAll();
  },
});

setInterval(() => void loadUsage(), 60_000);
setInterval(() => void loadSystem(), 5 * 60_000);

// Relative times and uptime tick once a second without touching the rest of the DOM.
setInterval(() => {
  const now = Date.now();
  for (const el of document.querySelectorAll<HTMLElement>("[data-ago]")) el.textContent = fmtAgo(now - Number(el.dataset.ago));
  for (const el of document.querySelectorAll<HTMLElement>("[data-until]")) el.textContent = fmtUntil(Number(el.dataset.until), now);
  const up = currentUptime();
  ui.uptime.textContent = up === null ? "" : `up ${fmtDuration(up)}`;
}, 1000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshAll();
});

// Follow the system colour scheme: charts read their colours from CSS variables when built.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const theme = readTheme();
  for (const c of cards) c.restyle(theme);
});
