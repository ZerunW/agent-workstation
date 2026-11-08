/**
 * SQLite persistence for workstation-status (WAL mode).
 *
 *   samples_raw  (t, name, v)                      10 s samples, kept 48 h
 *   samples_1m   (t, name, v, vmin, vmax, n)       1-minute aggregates, kept 90 d
 *   samples_1h   (t, name, v, vmin, vmax, n)       1-hour aggregates, kept forever
 *   events       state transitions of health checks
 *   health_state last known state per check (so a restart does not invent transitions)
 *   kv           rollup watermarks and small scalars
 *
 * `t` is a Unix timestamp in whole seconds (UTC). `v` is NULL when the source was missing
 * (for example the tailscale0 interface before Tailscale is installed): the gap is stored
 * explicitly so charts show a hole instead of a misleading zero.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { naturalCompare } from "./collect/parsers.js";
import { gridBounds, RETENTION_S, type Resolution } from "./ranges.js";

export interface EventRow {
  at: string;
  id: string;
  from: string;
  to: string;
  detail: string | null;
}

export interface HealthStateRow {
  id: string;
  state: string;
  detail: string | null;
  checkedAt: string;
  latencyMs: number | null;
}

export interface SeriesResult {
  name: string;
  points: Array<{ t: number; v: number | null }>;
}

const MAX_EVENT_ROWS = 5000;
const MINUTE_CHUNK_S = 6 * 3600;
const HOUR_CHUNK_S = 7 * 86400;
/** How far back to re-fold when the system clock jumped backwards. */
const REWIND_S = 86400;

export function roundValue(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

export class Store {
  readonly db: Database.Database;
  private readonly insertRawStmt: Database.Statement;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    if (path !== ":memory:") this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
    this.insertRawStmt = this.db.prepare("INSERT OR REPLACE INTO samples_raw (t, name, v) VALUES (?, ?, ?)");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS samples_raw (
        t INTEGER NOT NULL, name TEXT NOT NULL, v REAL,
        PRIMARY KEY (t, name)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS samples_1m (
        t INTEGER NOT NULL, name TEXT NOT NULL, v REAL, vmin REAL, vmax REAL, n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (t, name)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS samples_1h (
        t INTEGER NOT NULL, name TEXT NOT NULL, v REAL, vmin REAL, vmax REAL, n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (t, name)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL, check_id TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL, detail TEXT
      );
      CREATE TABLE IF NOT EXISTS health_state (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, detail TEXT, checked_at TEXT NOT NULL, latency_ms REAL
      );
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  // -------------------------------------------------------------------------
  // Samples
  // -------------------------------------------------------------------------

  /** Store one tick of metrics at second `t`. Values are rounded to 2 decimals; non-finite becomes NULL. */
  insertSamples(t: number, values: Record<string, number | null | undefined>): void {
    const tx = this.db.transaction(() => {
      for (const [name, v] of Object.entries(values)) this.insertRawStmt.run(t, name, roundValue(v));
    });
    tx();
  }

  insertMetric(t: number, name: string, v: number | null): void {
    this.insertRawStmt.run(t, name, roundValue(v));
  }

  /**
   * Series for a chart range, gap-filled onto a regular grid so all series share the same
   * timestamps (`v: null` where nothing was recorded).
   */
  queryMetrics(res: Resolution, nowS: number): SeriesResult[] {
    const { first, last, count } = gridBounds(res, nowS);
    if (count <= 0) return [];
    const step = res.stepS;
    const select =
      res.tier === "raw"
        ? "AVG(v) AS v FROM samples_raw"
        : `SUM(v * n) / NULLIF(SUM(n), 0) AS v FROM ${res.tier === "1m" ? "samples_1m" : "samples_1h"}`;
    const rows = this.db
      .prepare(
        `SELECT name, (t / CAST(:step AS INTEGER)) * CAST(:step AS INTEGER) AS bt, ${select}
         WHERE t >= :from AND t < :to GROUP BY name, bt`,
      )
      .all({ step, from: first, to: last + step }) as Array<{ name: string; bt: number; v: number | null }>;

    const byName = new Map<string, Array<number | null>>();
    for (const row of rows) {
      let arr = byName.get(row.name);
      if (!arr) {
        arr = new Array<number | null>(count).fill(null);
        byName.set(row.name, arr);
      }
      const idx = Math.round((row.bt - first) / step);
      if (idx >= 0 && idx < count) arr[idx] = row.v === null ? null : roundValue(row.v);
    }
    return [...byName.keys()].sort(naturalCompare).map((name) => {
      const values = byName.get(name) ?? [];
      return { name, points: values.map((v, i) => ({ t: first + i * step, v })) };
    });
  }

  // -------------------------------------------------------------------------
  // Rollups and retention
  // -------------------------------------------------------------------------

  /**
   * Fold completed raw samples into 1-minute buckets and completed minutes into 1-hour buckets.
   * Idempotent: watermarks live in `kv`, and the inserts use INSERT OR REPLACE.
   */
  rollup(nowS: number): { minutes: number; hours: number } {
    const minutes = this.rollupLevel({
      source: "samples_raw",
      key: "rollup_1m_upto",
      bucketS: 60,
      chunkS: MINUTE_CHUNK_S,
      nowS,
      sql: `INSERT OR REPLACE INTO samples_1m (t, name, v, vmin, vmax, n)
            SELECT (t / 60) * 60 AS bt, name, AVG(v), MIN(v), MAX(v), COUNT(v)
            FROM samples_raw WHERE t >= ? AND t < ? GROUP BY bt, name`,
    });
    const hours = this.rollupLevel({
      source: "samples_1m",
      key: "rollup_1h_upto",
      bucketS: 3600,
      chunkS: HOUR_CHUNK_S,
      nowS,
      sql: `INSERT OR REPLACE INTO samples_1h (t, name, v, vmin, vmax, n)
            SELECT (t / 3600) * 3600 AS bt, name, SUM(v * n) / NULLIF(SUM(n), 0), MIN(vmin), MAX(vmax), SUM(n)
            FROM samples_1m WHERE t >= ? AND t < ? GROUP BY bt, name`,
    });
    return { minutes, hours };
  }

  private rollupLevel(o: { source: string; key: string; bucketS: number; chunkS: number; nowS: number; sql: string }): number {
    const end = Math.floor(o.nowS / o.bucketS) * o.bucketS; // only completed buckets
    let from = this.getKvNumber(o.key);
    if (from === null) {
      const row = this.db.prepare(`SELECT MIN(t) AS m FROM ${o.source}`).get() as { m: number | null };
      if (row.m === null) return 0;
      from = Math.floor(row.m / o.bucketS) * o.bucketS;
    }
    if (from > end) {
      // The clock went backwards. Never leave the watermark in the future (fresh rows would never be
      // folded); re-fold the last day, which is idempotent.
      from = Math.floor((end - REWIND_S) / o.bucketS) * o.bucketS;
      this.setKv(o.key, String(from));
    }
    const stmt = this.db.prepare(o.sql);
    let buckets = 0;
    while (from < end) {
      const to = Math.min(end, from + o.chunkS);
      const lo = from;
      this.db.transaction(() => {
        stmt.run(lo, to);
        this.setKv(o.key, String(to));
      })();
      buckets += Math.round((to - from) / o.bucketS);
      from = to;
    }
    if (this.getKvNumber(o.key) === null) this.setKv(o.key, String(end));
    return buckets;
  }

  /** Enforce retention: raw 48 h, 1-minute 90 d, hourly forever. Returns deleted row counts. */
  prune(nowS: number): { raw: number; minute: number } {
    const raw = this.db.prepare("DELETE FROM samples_raw WHERE t < ?").run(nowS - RETENTION_S.raw).changes;
    const minute = this.db.prepare("DELETE FROM samples_1m WHERE t < ?").run(nowS - RETENTION_S.m1).changes;
    return { raw, minute };
  }

  // -------------------------------------------------------------------------
  // Events and health state
  // -------------------------------------------------------------------------

  recordEvent(e: EventRow): void {
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO events (at, check_id, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?)").run(e.at, e.id, e.from, e.to, e.detail);
      this.db
        .prepare("DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?")
        .run(MAX_EVENT_ROWS);
    })();
  }

  /** Newest first. */
  listEvents(limit = 100): EventRow[] {
    const rows = this.db
      .prepare("SELECT at, check_id, from_state, to_state, detail FROM events ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{ at: string; check_id: string; from_state: string; to_state: string; detail: string | null }>;
    return rows.map((r) => ({ at: r.at, id: r.check_id, from: r.from_state, to: r.to_state, detail: r.detail }));
  }

  loadHealthState(): Map<string, HealthStateRow> {
    const rows = this.db.prepare("SELECT id, state, detail, checked_at, latency_ms FROM health_state").all() as Array<{
      id: string;
      state: string;
      detail: string | null;
      checked_at: string;
      latency_ms: number | null;
    }>;
    return new Map(rows.map((r) => [r.id, { id: r.id, state: r.state, detail: r.detail, checkedAt: r.checked_at, latencyMs: r.latency_ms }]));
  }

  saveHealthState(row: HealthStateRow): void {
    this.db
      .prepare(
        `INSERT INTO health_state (id, state, detail, checked_at, latency_ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, detail = excluded.detail,
           checked_at = excluded.checked_at, latency_ms = excluded.latency_ms`,
      )
      .run(row.id, row.state, row.detail, row.checkedAt, row.latencyMs);
  }

  // -------------------------------------------------------------------------
  // kv
  // -------------------------------------------------------------------------

  getKv(key: string): string | null {
    const row = this.db.prepare("SELECT v FROM kv WHERE k = ?").get(key) as { v: string } | undefined;
    return row?.v ?? null;
  }

  getKvNumber(key: string): number | null {
    const v = this.getKv(key);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  setKv(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(key, value);
  }

  close(): void {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* closing anyway */
    }
    this.db.close();
  }
}
