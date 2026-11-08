import type { HealthResponse, MetricsResponse, ProbeState, Range, SystemInfo, UsageLimits } from "./types";

const BASE = "/status/api";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  metrics: (range: Range) => getJson<MetricsResponse>(`/metrics?range=${range}`),
  health: () => getJson<HealthResponse>("/health"),
  system: () => getJson<SystemInfo>("/system"),
  usage: () => getJson<UsageLimits>("/usage"),
  speedState: () => getJson<ProbeState>("/speedtest"),
  /** Start a speed test. 202 = started; 409 = already running; 429 = rate limited (retryAfterS). */
  async startSpeedTest(): Promise<{ ok: boolean; status: number; message?: string; retryAfterS?: number }> {
    const res = await fetch(`${BASE}/speedtest`, { method: "POST" });
    if (res.ok) return { ok: true, status: res.status };
    const body = (await res.json().catch(() => ({}))) as { error?: string; retryAfterS?: number };
    return { ok: false, status: res.status, message: body.error, retryAfterS: body.retryAfterS };
  },
};

export type ConnState = "connecting" | "live" | "reconnecting";

export interface StreamHandlers {
  onMetrics(sample: { t: number; values: Record<string, number | null> }): void;
  onHealth(health: HealthResponse): void;
  onProbe(state: ProbeState): void;
  /** Called on every (re)connect after the first, so the page can refetch what it missed. */
  onReconnect(): void;
  onState(state: ConnState): void;
}

/** EventSource wrapper: the browser reconnects by itself (the server sends `retry: 3000`). */
export function openStream(h: StreamHandlers): { close(): void } {
  let es: EventSource | null = null;
  let opened = false;
  let closed = false;

  const connect = (): void => {
    es = new EventSource(`${BASE}/stream`);
    h.onState("connecting");
    es.addEventListener("open", () => {
      h.onState("live");
      if (opened) h.onReconnect();
      opened = true;
    });
    es.addEventListener("error", () => {
      if (closed) return;
      h.onState("reconnecting");
      // CLOSED means the browser gave up (e.g. HTTP error); retry ourselves.
      if (es && es.readyState === EventSource.CLOSED) {
        es.close();
        setTimeout(connect, 3000);
      }
    });
    const on = <T>(name: string, fn: (data: T) => void): void => {
      es?.addEventListener(name, (ev) => {
        try {
          fn(JSON.parse((ev as MessageEvent<string>).data) as T);
        } catch {
          /* ignore a malformed frame */
        }
      });
    };
    on("metrics", h.onMetrics);
    on("health", h.onHealth);
    on("probe", h.onProbe);
  };
  connect();
  return {
    close() {
      closed = true;
      es?.close();
    },
  };
}
