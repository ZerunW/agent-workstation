/**
 * `fetch` for the hub. The hub's user API is on Unix sockets in production; the status service calls it through the
 * hub's local socket (`[status] hub_socket`), which only the service account and root can connect to. Requests to
 * any other URL (the internet checks) use the normal fetch. With no socket configured (development, TCP) this is
 * plain fetch.
 */
import { request } from "node:http";
import { Readable } from "node:stream";
import type { AppConfig } from "./config.js";

export function hubAwareFetch(config: Pick<AppConfig, "hubUrl" | "hubSocket">, base: typeof fetch = globalThis.fetch): typeof fetch {
  const socketPath = config.hubSocket;
  if (!socketPath) return base;
  const prefix = config.hubUrl;
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(prefix)) return base(input, init);
    return viaSocket(socketPath, new URL(href), init);
  }) as typeof fetch;
}

function viaSocket(socketPath: string, url: URL, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    // The hub answers to its own host names; the socket has no host of its own.
    headers.host = "localhost";
    const fail = (err: Error) => reject(new TypeError("fetch failed", { cause: err }));
    const req = request({ socketPath, path: url.pathname + url.search, method: init.method ?? "GET", headers, ...(init.signal ? { signal: init.signal } : {}), agent: false }, (res) => {
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, one);
      const noBody = res.statusCode === 204 || res.statusCode === 304 || init.method === "HEAD";
      if (noBody) res.resume();
      resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream), { status: res.statusCode ?? 502, headers: out }));
    });
    req.on("error", (err) => {
      // An aborted or timed-out request keeps the signal's own error (describeFetchError reads its name).
      if (init.signal?.aborted) reject(init.signal.reason);
      else fail(err);
    });
    if (typeof init.body === "string") req.write(init.body);
    req.end();
  });
}
