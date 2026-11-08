/**
 * Loopback proxy in front of the Anthropic API, so API-billed Claude processes never hold the real API key.
 *
 * Listens on 127.0.0.1 (`[billing] proxy_port`, default 0 = a random port per hub start). For every API-billed Claude
 * child the hub issues a token (`hsk-` + 32 random bytes, base64url) bound to the session; the child gets
 * `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and `ANTHROPIC_API_KEY=<token>` (billing.ts `billingEnv`). The token is
 * revoked when that child ends and when its session is closed or deleted; stopping the proxy revokes everything.
 *
 * - Routes: the calls Claude Code makes against its base URL with an API key (CLI 2.1.x / Agent SDK 0.3.316):
 *   `POST /v1/messages` (the CLI adds `?beta=true`), `POST /v1/messages/count_tokens`, and the read-only model lookups
 *   `GET /v1/models` and `GET /v1/models/<id>`. Anything else: 404, before authentication.
 * - Auth: `x-api-key` (or `Authorization: Bearer`) must equal a live token (constant-time compare); else 401 and
 *   nothing reaches upstream.
 * - Forwarding: to `[billing] upstream` (default https://api.anthropic.com) with the real key, read from the
 *   ApiKeyStore per request, in `x-api-key`; the client's `x-api-key` / `authorization` and hop-by-hop headers are
 *   dropped, every other header and the body pass through unchanged. The response (SSE included) is streamed as it
 *   arrives with its status and headers; a client that disconnects aborts the upstream request.
 * - Gate: before a `POST /v1/messages` is forwarded, `gate(owner)` may refuse it: 429 `rate_limit_error` in the API's
 *   error shape while the budget is used up, and 403 `permission_error` for a `model` the owner's user may not use
 *   (when the gate returns an allowlist check, the request body is read first, up to MAX_GATED_BODY_BYTES).
 * - Metering: a 2xx `POST /v1/messages` response is metered while it streams through. The client's stream is never
 *   delayed or buffered: a copy of each chunk (decompressed when the response is gzip / deflate / br encoded) feeds a
 *   parser (`UsageMeter`) that keeps the latest usage from SSE `message_start` / `message_delta` events, or from a JSON
 *   body (copy capped at 16 MB). When the response ends — completely, because the client disconnected, or because
 *   upstream failed mid-stream (Anthropic bills what it produced) — `onMetered` gets one record: the token's owner
 *   (session id), model and token counts. count_tokens / models calls and non-2xx answers are not metered.
 * - Never logs or records keys, tokens, headers or bodies.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { Transform } from "node:stream";
import { constants as zc, createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { errorMessage, HttpError } from "./util/errors.js";
import type { Logger } from "./util/log.js";

/** Usage of one API request as the response reported it (latest value of each field). */
export interface MeteredUsage {
  /** The response's model id (null = none seen). */
  model: string | null;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  webSearchRequests: number;
  /** `fast` in fast mode (null = not reported). */
  speed: string | null;
}

/** What the proxy reports when a metered request ends. */
export interface MeteredRequest extends MeteredUsage {
  /** The token's owner (a session id). */
  owner: string;
  /** When the response ended. */
  at: string;
  /** The whole response arrived and its usage was read (false = ended early or could not be read fully). */
  complete: boolean;
}

/** The JSON copy is capped at this many (decoded) bytes. */
export const MAX_JSON_METER_BYTES = 16 * 1024 * 1024;
/** An SSE line longer than this is skipped (usage events are small). */
const MAX_SSE_LINE = 1024 * 1024;
const MODEL_RE = /^[A-Za-z0-9._:@[\]-]{1,100}$/;
const SPEED_RE = /^[a-z_]{1,20}$/;
const SSE_EVENTS = new Set(["message_start", "message_delta", "message_stop"]);

const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * Reads the usage out of a Messages API response body, fed in chunks as they pass (never holds an SSE body; a JSON body
 * up to MAX_JSON_METER_BYTES).
 */
export class UsageMeter {
  private model: string | null = null;
  private input: number | null = null;
  private cacheCreate: number | null = null;
  private write5m: number | null = null;
  private write1h: number | null = null;
  private cacheRead: number | null = null;
  private output: number | null = null;
  private webSearch: number | null = null;
  private speed: string | null = null;
  /** SSE: message_stop seen; JSON: body parsed. */
  private finished = false;
  private ended = false;
  /** The JSON body went over the cap. */
  overflow = false;
  // SSE state
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private skipLine = false;
  private event = "";
  private data: string[] = [];
  // JSON state
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(readonly kind: "sse" | "json") {}

  /** A copy of (decoded) response bytes. */
  push(chunk: Buffer): void {
    if (this.ended) return;
    if (this.kind === "json") {
      if (this.overflow) return;
      if (this.bytes + chunk.length > MAX_JSON_METER_BYTES) {
        this.overflow = true;
        this.chunks = [];
        return;
      }
      this.chunks.push(Buffer.from(chunk));
      this.bytes += chunk.length;
      return;
    }
    this.feed(this.decoder.write(chunk));
  }

  /** The body ended (or was cut off): parses what is left. */
  end(): void {
    if (this.ended) return;
    if (this.kind === "json") {
      if (!this.overflow && this.bytes > 0) {
        try {
          const body = obj(JSON.parse(Buffer.concat(this.chunks).toString("utf8")));
          if (body) {
            this.setModel(body.model);
            this.applyUsage(body.usage);
            this.finished = obj(body.usage) !== null;
          }
        } catch {
          // a truncated body: nothing readable
        }
      }
      this.chunks = [];
    } else {
      this.feed(this.decoder.end());
      if (this.pending && !this.skipLine) this.line(this.pending);
      this.pending = "";
      this.dispatch();
    }
    this.ended = true;
  }

  /** Whether the usage was read from a complete body (SSE: message_stop seen; JSON: usage parsed). */
  get complete(): boolean {
    return this.finished;
  }

  usage(): MeteredUsage {
    const created = this.cacheCreate ?? 0;
    const w1h = this.write1h ?? 0;
    // The TTL split when reported (anything it leaves out counts at the 5-minute rate), else every write is 5-minute.
    const w5m = this.write5m === null && this.write1h === null ? created : Math.max(this.write5m ?? 0, created - w1h);
    return {
      model: this.model,
      input: this.input ?? 0,
      cacheWrite5m: w5m,
      cacheWrite1h: w1h,
      cacheRead: this.cacheRead ?? 0,
      output: this.output ?? 0,
      webSearchRequests: this.webSearch ?? 0,
      speed: this.speed,
    };
  }

  private feed(text: string): void {
    let from = 0;
    for (;;) {
      const nl = text.indexOf("\n", from);
      if (nl < 0) break;
      const part = text.slice(from, nl);
      from = nl + 1;
      if (this.skipLine) {
        this.skipLine = false;
        this.pending = "";
        continue;
      }
      const line = this.pending + part;
      this.pending = "";
      this.line(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    if (this.skipLine) return;
    this.pending += text.slice(from);
    if (this.pending.length > MAX_SSE_LINE) {
      this.pending = "";
      this.skipLine = true;
    }
  }

  private line(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith("event:")) {
      this.event = line.slice(6).trim();
      return;
    }
    if (line.startsWith("data:")) {
      // Only the usage-bearing events are kept (an unnamed event is kept and checked by its type).
      if (this.event && !SSE_EVENTS.has(this.event)) return;
      const d = line.slice(5);
      this.data.push(d.startsWith(" ") ? d.slice(1) : d);
    }
  }

  private dispatch(): void {
    const data = this.data.join("\n");
    this.data = [];
    this.event = "";
    if (!data) return;
    let ev: Record<string, unknown> | null;
    try {
      ev = obj(JSON.parse(data));
    } catch {
      return;
    }
    if (!ev) return;
    if (ev.type === "message_start") {
      const message = obj(ev.message);
      if (message) {
        this.setModel(message.model);
        this.applyUsage(message.usage);
        if (typeof message.speed === "string") this.setSpeed(message.speed);
      }
    } else if (ev.type === "message_delta") {
      this.applyUsage(ev.usage);
    } else if (ev.type === "message_stop") {
      this.finished = true;
    }
  }

  private setModel(v: unknown): void {
    if (typeof v === "string" && MODEL_RE.test(v)) this.model = v;
  }

  private setSpeed(v: string): void {
    if (SPEED_RE.test(v)) this.speed = v;
  }

  /** Keeps the latest value of each field present. */
  private applyUsage(raw: unknown): void {
    const u = obj(raw);
    if (!u) return;
    this.input = count(u.input_tokens) ?? this.input;
    this.cacheCreate = count(u.cache_creation_input_tokens) ?? this.cacheCreate;
    this.cacheRead = count(u.cache_read_input_tokens) ?? this.cacheRead;
    this.output = count(u.output_tokens) ?? this.output;
    const split = obj(u.cache_creation);
    if (split) {
      this.write5m = count(split.ephemeral_5m_input_tokens) ?? this.write5m;
      this.write1h = count(split.ephemeral_1h_input_tokens) ?? this.write1h;
    }
    const tools = obj(u.server_tool_use);
    if (tools) this.webSearch = count(tools.web_search_requests) ?? this.webSearch;
    if (typeof u.speed === "string") this.setSpeed(u.speed);
  }
}

/** A decompressor for the response's content-encoding (null = identity; "unsupported" = cannot be read). */
function decoderFor(encoding: string): Transform | null | "unsupported" {
  const e = encoding.trim().toLowerCase();
  if (!e || e === "identity") return null;
  if (e === "gzip" || e === "x-gzip") return createGunzip({ finishFlush: zc.Z_SYNC_FLUSH });
  if (e === "deflate") return createInflate({ finishFlush: zc.Z_SYNC_FLUSH });
  if (e === "br") return createBrotliDecompress({ finishFlush: zc.BROTLI_OPERATION_FLUSH });
  return "unsupported";
}

/** A proxy token: what an API-billed child holds instead of the key (the agent wrapper accepts only this shape). */
export const PROXY_TOKEN_RE = /^hsk-[A-Za-z0-9_-]{43}$/;

export const DEFAULT_UPSTREAM = "https://api.anthropic.com";

/** What an API-billed Claude child is started with. */
export interface ApiCredential {
  /** `http://127.0.0.1:<port>` (ANTHROPIC_BASE_URL). */
  baseUrl: string;
  /** `hsk-...` (ANTHROPIC_API_KEY). */
  token: string;
}

/** Issue / revoke per-process credentials (implemented by KeyProxy). */
export interface ApiCredentials {
  /** A fresh credential bound to `owner` (a session id). Throws 503 api_unavailable while the proxy is not listening. */
  issue(owner: string): ApiCredential;
  revoke(token: string | null | undefined): void;
  /** Revokes every token of `owner`. */
  revokeOwner(owner: string): void;
}

/** What the proxy may do with a request of `owner` (a session id) before forwarding it. */
export interface ProxyGate {
  /** Refuse the request with this answer (an API-shaped error). */
  refuse?: { status: number; type: string; message: string };
  /** The user has a model allowlist: whether this request model may be used. */
  modelAllowed?: (model: string) => boolean;
}

/** A request body read for the model check is capped at this size (413 above it). */
export const MAX_GATED_BODY_BYTES = 64 * 1024 * 1024;

export interface KeyProxyOptions {
  /** Checked for every `POST /v1/messages` once the token is known (absent = nothing is refused here). */
  gate?: (owner: string) => ProxyGate | null;
  /** The real key, read per request (null = none configured). */
  key: () => string | null;
  log: Logger;
  /** Default https://api.anthropic.com (tests point it at a fake). */
  upstream?: string;
  /** 0 (default) = random. */
  port?: number;
  /** A metered `POST /v1/messages` request ended (never throws into the proxy: errors are logged). */
  onMetered?: (r: MeteredRequest) => void;
  clock?: () => Date;
}

const ROUTES: readonly { method: string; path: RegExp }[] = [
  { method: "POST", path: /^\/v1\/messages$/ },
  { method: "POST", path: /^\/v1\/messages\/count_tokens$/ },
  { method: "GET", path: /^\/v1\/models$/ },
  { method: "GET", path: /^\/v1\/models\/[A-Za-z0-9._:@-]{1,100}$/ },
];
const QUERY_RE = /^[A-Za-z0-9_.~=&%+-]{0,512}$/;

/** Never forwarded in either direction (RFC 9110 hop-by-hop), plus the client's own credentials on the way up. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
const CLIENT_CREDENTIALS = new Set(["x-api-key", "authorization"]);

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

function filterHeaders(h: IncomingHttpHeaders, drop: ReadonlySet<string>): OutgoingHttpHeaders {
  const listed = new Set(
    String(h.connection ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(h)) {
    const n = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(n) || listed.has(n) || drop.has(n)) continue;
    out[n] = value;
  }
  return out;
}

/** An error body in the API's shape (so Claude Code reports it like any other API error). */
function apiError(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ type: "error", error: { type, message } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

interface Entry {
  owner: string;
  digest: Buffer;
}

export class KeyProxy implements ApiCredentials {
  private server: Server | null = null;
  private listenPort: number | null = null;
  private readonly tokens = new Map<string, Entry>();
  private readonly upstream: URL;

  constructor(private readonly o: KeyProxyOptions) {
    this.upstream = new URL(o.upstream || DEFAULT_UPSTREAM);
    if (this.upstream.protocol !== "https:" && this.upstream.protocol !== "http:") throw new Error(`billing.upstream must be an http(s) URL`);
  }

  /** The bound port (null while not listening). */
  get port(): number | null {
    return this.listenPort;
  }

  get baseUrl(): string | null {
    return this.listenPort === null ? null : `http://127.0.0.1:${this.listenPort}`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: this.o.port ?? 0 }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (err) => this.o.log.error({ err: errorMessage(err) }, "API key proxy error"));
    this.server = server;
    this.listenPort = (server.address() as AddressInfo).port;
    this.o.log.info({ port: this.listenPort, upstream: this.upstream.origin }, "API key proxy listening");
  }

  async stop(): Promise<void> {
    this.tokens.clear();
    const server = this.server;
    this.server = null;
    this.listenPort = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  issue(owner: string): ApiCredential {
    const baseUrl = this.baseUrl;
    if (!baseUrl) throw new HttpError(503, "api_unavailable", "API billing is not available: the hub's API key proxy is not running.");
    const token = `hsk-${randomBytes(32).toString("base64url")}`;
    this.tokens.set(token, { owner, digest: digest(token) });
    return { baseUrl, token };
  }

  revoke(token: string | null | undefined): void {
    if (token) this.tokens.delete(token);
  }

  revokeOwner(owner: string): void {
    for (const [token, e] of this.tokens) if (e.owner === owner) this.tokens.delete(token);
  }

  /** Live tokens (tests). */
  get liveTokens(): number {
    return this.tokens.size;
  }

  /**
   * The owner of the live token matching the presented credential (null = none): every live token is compared, in
   * constant time, no early exit.
   */
  private authorized(presented: string | null): string | null {
    if (!presented) return null;
    const d = digest(presented);
    let owner: string | null = null;
    for (const e of this.tokens.values()) if (timingSafeEqual(d, e.digest)) owner = e.owner;
    return owner;
  }

  /** Meters a 2xx Messages response while it streams to the client (a copy of each chunk; nothing is held back). */
  private meter(r: IncomingMessage, owner: string): void {
    const ctype = String(r.headers["content-type"] ?? "");
    const meter = new UsageMeter(/text\/event-stream/i.test(ctype) ? "sse" : "json");
    const found = decoderFor(String(r.headers["content-encoding"] ?? ""));
    const decoder = found === "unsupported" ? null : found;
    const unreadable = found === "unsupported";
    if (unreadable) {
      this.o.log.warn({ encoding: String(r.headers["content-encoding"]).slice(0, 40) }, "API key proxy: cannot read the usage of a response with this content-encoding; recorded without usage");
    } else if (decoder) {
      decoder.on("data", (c: Buffer) => meter.push(c));
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      meter.end();
      if (meter.overflow) this.o.log.warn({ limitBytes: MAX_JSON_METER_BYTES }, "API key proxy: response body too large to read its usage; recorded without usage");
      const at = (this.o.clock ?? (() => new Date()))().toISOString();
      try {
        this.o.onMetered?.({ owner, at, ...meter.usage(), complete: r.complete && meter.complete && !unreadable });
      } catch (err) {
        this.o.log.error({ err: errorMessage(err) }, "API key proxy: could not record a metered request");
      }
    };
    r.on("data", (chunk: Buffer) => {
      if (unreadable) return;
      if (!decoder) meter.push(chunk);
      else if (!decoder.destroyed) decoder.write(chunk);
    });
    r.once("close", () => {
      if (!decoder || unreadable || decoder.destroyed) return finish();
      decoder.once("end", finish);
      decoder.once("error", finish);
      decoder.once("close", finish);
      decoder.end();
    });
    if (decoder && !unreadable) decoder.on("error", () => decoder.destroy());
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const raw = req.url ?? "";
    const q = raw.indexOf("?");
    const path = q < 0 ? raw : raw.slice(0, q);
    const query = q < 0 ? "" : raw.slice(q + 1);
    if (!ROUTES.some((r) => r.method === req.method && r.path.test(path)) || !QUERY_RE.test(query)) {
      req.resume();
      apiError(res, 404, "not_found_error", "Not found.");
      return;
    }
    const xKey = req.headers["x-api-key"];
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? null;
    const presented = typeof xKey === "string" ? xKey : bearer;
    const owner = this.authorized(presented);
    if (owner === null) {
      req.resume();
      apiError(res, 401, "authentication_error", "invalid x-api-key");
      return;
    }
    const metered = req.method === "POST" && path === "/v1/messages";
    const key = this.o.key();
    if (!key) {
      req.resume();
      apiError(res, 401, "authentication_error", "No Anthropic API key is configured on the server.");
      return;
    }
    const gate = metered ? this.o.gate?.(owner) ?? null : null;
    if (gate?.refuse) {
      req.resume();
      apiError(res, gate.refuse.status, gate.refuse.type, gate.refuse.message);
      return;
    }
    if (gate?.modelAllowed) {
      this.readBody(req, res, (raw) => {
        let parsed: unknown;
        let model: unknown;
        try {
          parsed = JSON.parse(raw.toString("utf8"));
          model = (parsed as { model?: unknown } | null)?.model;
        } catch {
          model = undefined;
        }
        if (typeof model !== "string" || !gate.modelAllowed!(model)) {
          apiError(res, 403, "permission_error", `The model ${typeof model === "string" ? model.slice(0, 100) : "(none)"} is not allowed for this user.`);
          return;
        }
        // What is forwarded is what was checked: the parsed body written out again, so a body with the same key twice
        // reaches the API with the one `model` that was allowed (another parser could read the first of two).
        this.forward(req, res, { path, query, key, owner, metered, body: Buffer.from(JSON.stringify(parsed), "utf8") });
      });
      return;
    }
    this.forward(req, res, { path, query, key, owner, metered });
  }

  /** Reads the whole request body (413 above MAX_GATED_BODY_BYTES). */
  private readBody(req: IncomingMessage, res: ServerResponse, done: (body: Buffer) => void): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > MAX_GATED_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        apiError(res, 413, "request_too_large", "The request is too large.");
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!over) done(Buffer.concat(chunks));
    });
    req.on("error", () => res.destroy());
  }

  private forward(req: IncomingMessage, res: ServerResponse, f: { path: string; query: string; key: string; owner: string; metered: boolean; body?: Buffer }): void {
    const { path, query, key, owner, metered } = f;

    const target = new URL(this.upstream.href);
    target.pathname = target.pathname.replace(/\/+$/, "") + path;
    target.search = query ? `?${query}` : "";
    const headers = filterHeaders(req.headers, CLIENT_CREDENTIALS);
    headers["x-api-key"] = key;
    if (f.body) headers["content-length"] = String(f.body.length);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    let clientGone = false;
    const up = send(target, { method: req.method, headers });
    up.on("response", (r) => {
      if (clientGone) {
        r.destroy();
        return;
      }
      const status = r.statusCode ?? 502;
      res.writeHead(status, filterHeaders(r.headers, new Set()));
      res.flushHeaders();
      // Only successful Messages calls are billed (errors, count_tokens and model lookups are free).
      if (metered && status >= 200 && status < 300 && this.o.onMetered) this.meter(r, owner);
      r.on("error", () => res.destroy());
      r.pipe(res);
    });
    up.on("error", (err) => {
      if (clientGone) return;
      this.o.log.warn({ path, err: errorMessage(err) }, "API key proxy: upstream request failed");
      apiError(res, 502, "api_error", "The hub could not reach the Anthropic API.");
    });
    // The client went away before the response was complete: abort the upstream request (stops a running stream).
    res.on("close", () => {
      if (res.writableFinished) return;
      clientGone = true;
      up.destroy();
    });
    req.on("error", () => up.destroy());
    if (f.body) up.end(f.body);
    else req.pipe(up);
  }
}
