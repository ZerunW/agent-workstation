/**
 * The hub's own calls to the Anthropic Messages API (Agent Workstation's services: the docs assistant, routes/readme.ts,
 * answered to the client as SSE; and the Claude Haiku helpers of helper.ts: search ranking, session summaries, the
 * download check and the price check).
 *
 * Plain fetch to `[billing] upstream` (the official SDK is not a dependency of the hub) with the key from the
 * ApiKeyStore, always streaming. These calls bypass the key proxy, so each records its own api_requests row (same
 * usage parsing and price table as the proxy; session_id NULL, the service's purpose, user = the caller). Request and
 * answer texts are never logged or stored: only status codes and error messages of the transport are.
 */
import type { FastifyReply } from "fastify";
import { isCreditBalanceText, meteredCostUsd } from "../billing.js";
import type { Hub } from "../hub.js";
import type { Caller } from "../identity.js";
import { DEFAULT_UPSTREAM, UsageMeter } from "../keyProxy.js";
import { COMMON_SECURITY_HEADERS } from "../securityHeaders.js";
import { errorMessage } from "../util/errors.js";

export const ANTHROPIC_VERSION = "2023-06-01";

export const sseEvent = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Who a request counts against for rate limits: the Tailscale login, else the username, else the address. */
export function rateKey(caller: Caller, user: string | null): string {
  if (caller.kind === "tailscale") return `ts:${caller.login}`;
  if (user) return `user:${user}`;
  return `ip:${caller.ip ?? caller.source}`;
}

export interface SseStream {
  send(event: string, data: unknown): void;
  /** Aborted when the client goes away or the time limit passes. */
  signal: AbortSignal;
  end(): void;
}

/** Takes over the reply and starts an SSE stream at once (headers flushed before any upstream work). */
export function openSse(reply: FastifyReply, timeoutMs: number): SseStream {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { ...COMMON_SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();
  const ac = new AbortController();
  let finished = false;
  res.on("close", () => {
    if (!finished) ac.abort();
  });
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  return {
    send: (event, data) => {
      if (!res.writableEnded && !res.destroyed) res.write(sseEvent(event, data));
    },
    signal: ac.signal,
    end: () => {
      clearTimeout(timer);
      finished = true;
      if (!res.writableEnded) res.end();
    },
  };
}

export interface MessagesCall {
  key: string;
  /** The Messages request (model, max_tokens, system, messages, …); `stream: true` is added. */
  request: Record<string, unknown> & { model: string };
  /** api_requests.user and .purpose. */
  user: string;
  purpose: string;
  signal: AbortSignal;
  /** For log lines, e.g. "docs assistant". */
  label: string;
  /** Each text delta as it arrives. */
  onText(text: string): void;
}

export type MessagesOutcome = { ok: true; costUsd: number } | { ok: false; code: string; message: string };

/**
 * Streams one Messages request: text deltas go to `onText`, a 2xx answer is billed (an api_requests row, once, for
 * whatever it produced, however it ends). Never throws for API or transport errors: they come back as the outcome
 * (`api_unavailable` when the credits are used up — which also pauses sessions for a while —, `api_busy`,
 * `api_error`).
 */
/** What streamMessages uses of the hub. */
export type MessagesHub = Pick<Hub, "config" | "pricing" | "store" | "usageLimits" | "billing" | "log">;

export async function streamMessages(hub: MessagesHub, call: MessagesCall): Promise<MessagesOutcome> {
  const upstream = (hub.config.billing.upstream || DEFAULT_UPSTREAM).replace(/\/+$/, "");
  const meter = new UsageMeter("sse");
  let metered = false;
  let recorded = false;
  /** The api_requests row of this request (once); returns its cost, rounded for the client. */
  const record = (): number => {
    if (recorded) return 0;
    recorded = true;
    meter.end();
    const usage = { ...meter.usage() };
    usage.model ??= call.request.model;
    const at = new Date().toISOString();
    const costUsd = meteredCostUsd(hub.pricing, usage, at);
    try {
      hub.store.insertApiRequest({
        at,
        sessionId: null,
        user: call.user,
        purpose: call.purpose,
        model: usage.model,
        input: usage.input,
        cacheWrite5m: usage.cacheWrite5m,
        cacheWrite1h: usage.cacheWrite1h,
        cacheRead: usage.cacheRead,
        output: usage.output,
        webSearchRequests: usage.webSearchRequests,
        speed: usage.speed,
        costUsd,
        complete: meter.complete && !call.signal.aborted,
      });
      hub.usageLimits.broadcast();
    } catch (err) {
      hub.log.error({ err: errorMessage(err) }, `${call.label}: could not record the API request`);
    }
    return Math.round(costUsd * 1e6) / 1e6;
  };
  try {
    let r: Response;
    try {
      r = await fetch(`${upstream}/v1/messages`, {
        method: "POST",
        signal: call.signal,
        headers: { "content-type": "application/json", "x-api-key": call.key, "anthropic-version": ANTHROPIC_VERSION, accept: "text/event-stream" },
        body: JSON.stringify({ ...call.request, stream: true }),
      });
    } catch (err) {
      if (!call.signal.aborted) hub.log.warn({ err: errorMessage(err) }, `${call.label}: could not reach the Anthropic API`);
      return { ok: false, code: "api_error", message: "The hub could not reach the Anthropic API." };
    }
    if (!r.ok || !r.body) {
      const text = (await r.text().catch(() => "")).slice(0, 4000);
      if (isCreditBalanceText(text)) {
        hub.billing.markCreditsExhausted();
        hub.usageLimits.broadcast();
        return { ok: false, code: "api_unavailable", message: "The API credits are used up." };
      }
      hub.log.warn({ status: r.status }, `${call.label}: the Anthropic API refused the request`);
      if (r.status === 401) return { ok: false, code: "api_error", message: "The API key was rejected." };
      return { ok: false, code: r.status === 429 || r.status === 529 ? "api_busy" : "api_error", message: `The Anthropic API answered ${r.status}; try again shortly.` };
    }
    // A 2xx answer is billed for what it produced, however it ends.
    metered = true;
    const decoder = new TextDecoder();
    let pending = "";
    /** An `error` event in the stream, or the stream breaking off (the API error type, e.g. overloaded_error). */
    const broke: { type: string | null } = { type: null };
    const onEvent = (block: string) => {
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) return;
      let ev: { type?: string; delta?: { type?: string; text?: string }; error?: { type?: string } };
      try {
        ev = JSON.parse(data) as typeof ev;
      } catch {
        return;
      }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string" && ev.delta.text) call.onText(ev.delta.text);
      else if (ev.type === "error") broke.type = typeof ev.error?.type === "string" ? ev.error.type : "api_error";
    };
    try {
      for await (const chunk of r.body as AsyncIterable<Uint8Array>) {
        const buf = Buffer.from(chunk);
        meter.push(buf);
        pending += decoder.decode(buf, { stream: true }).replace(/\r\n/g, "\n");
        let cut: number;
        while ((cut = pending.indexOf("\n\n")) >= 0) {
          onEvent(pending.slice(0, cut));
          pending = pending.slice(cut + 2);
        }
      }
      pending += decoder.decode();
      if (pending.trim()) onEvent(pending);
    } catch (err) {
      if (!call.signal.aborted) hub.log.warn({ err: errorMessage(err) }, `${call.label}: the answer stream broke off`);
      broke.type ??= "api_error";
    }
    const costUsd = record();
    if (broke.type) return { ok: false, code: broke.type === "overloaded_error" ? "api_busy" : "api_error", message: "The answer broke off; try again." };
    return { ok: true, costUsd };
  } finally {
    if (metered) record();
  }
}
