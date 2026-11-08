/**
 * Minimal Chrome DevTools Protocol client (flattened-session style API) for target tracking, the screencast and person
 * input. There is no socket: Chromium is launched by Playwright over `--remote-debugging-pipe` and this client is
 * derived from the very same BrowserContext the agents' Playwright MCP uses — a browser-level CDP session for
 * `Target.*` / `Browser.*` and one per-tab session for `Page.*` / `Input.*`.
 */
import type { PwCdpSession, PwContext, PwPage } from "./playwright.js";

export type CdpHandler = (params: any, sessionId?: string) => void;

export interface CdpClient {
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  /** Subscribe to an event (all sessions); returns an unsubscribe function. */
  on(method: string, handler: CdpHandler): () => void;
  /** Called once when the connection drops (browser exit or close()). */
  onClose(handler: () => void): void;
  readonly closed: boolean;
  close(): Promise<void>;
}

/** Derives the manager's CDP client from a launched browser's BrowserContext. */
export type CdpConnector = (browser: { context: PwContext }) => Promise<CdpClient>;

export class CdpError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = "CdpError";
  }
}

/** Default connector: CDP sessions of the pipe-connected BrowserContext. */
export const connectCdp: CdpConnector = async ({ context }) => {
  const browser = context.browser();
  if (!browser) throw new CdpError("connect", "the browser context has no browser");
  return new ContextCdpClient(context, await browser.newBrowserCDPSession());
};

const ATTACH_WAIT_MS = 5000;

class ContextCdpClient implements CdpClient {
  private readonly handlers = new Map<string, Set<CdpHandler>>();
  private readonly closeHandlers: (() => void)[] = [];
  /** Our flattened "sessionId" → the Playwright session of one tab. */
  private readonly sessions = new Map<string, PwCdpSession>();
  private readonly targetIds = new WeakMap<PwPage, Promise<string>>();
  private nextSession = 1;
  private isClosed = false;

  constructor(
    private readonly context: PwContext,
    private readonly root: PwCdpSession,
  ) {
    root.on("event", (e) => this.dispatch(e.method, e.params));
    root.on("close", () => this.finish());
    context.on("close", () => this.finish());
    context.browser()?.on("disconnected", () => this.finish());
  }

  get closed(): boolean {
    return this.isClosed;
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.isClosed) throw new CdpError(method, "connection closed");
    try {
      if (sessionId) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("session closed");
        return (await s.send(method, params)) ?? {};
      }
      switch (method) {
        case "Target.attachToTarget":
          return (await this.attach(String(params.targetId))) as T;
        case "Target.detachFromTarget":
          await this.detach(String(params.sessionId));
          return {} as T;
        case "Browser.close":
          await this.context.close();
          return {} as T;
        default:
          return (await this.root.send(method, params)) ?? {};
      }
    } catch (e) {
      throw e instanceof CdpError ? e : new CdpError(method, (e as Error).message);
    }
  }

  on(method: string, handler: CdpHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  onClose(handler: () => void): void {
    if (this.isClosed) queueMicrotask(handler);
    else this.closeHandlers.push(handler);
  }

  /** Drops our sessions only; the browser itself lives and dies with its launcher handle. */
  async close(): Promise<void> {
    const open = [...this.sessions.values(), this.root];
    this.finish();
    await Promise.all(open.map((s) => s.detach().catch(() => undefined)));
  }

  /** A tab's CDP session. Playwright learns about a new tab slightly after the browser announces it: wait for it. */
  private async attach(targetId: string): Promise<{ sessionId: string }> {
    const deadline = Date.now() + ATTACH_WAIT_MS;
    for (;;) {
      for (const page of this.context.pages()) {
        if ((await this.targetIdOf(page).catch(() => null)) !== targetId) continue;
        const session = await this.context.newCDPSession(page);
        const sessionId = `pw-${this.nextSession++}`;
        this.sessions.set(sessionId, session);
        session.on("event", (e) => this.dispatch(e.method, e.params, sessionId));
        session.on("close", () => {
          if (this.sessions.delete(sessionId)) this.dispatch("Target.detachedFromTarget", { sessionId });
        });
        return { sessionId };
      }
      if (Date.now() > deadline || this.isClosed) throw new Error("No target with given id found");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private targetIdOf(page: PwPage): Promise<string> {
    let id = this.targetIds.get(page);
    if (!id) {
      id = (async () => {
        const s = await this.context.newCDPSession(page);
        try {
          const { targetInfo } = (await s.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
          return targetInfo.targetId;
        } finally {
          await s.detach().catch(() => undefined);
        }
      })();
      id.catch(() => this.targetIds.delete(page));
      this.targetIds.set(page, id);
    }
    return id;
  }

  private async detach(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    await s.detach().catch(() => undefined);
  }

  private dispatch(method: string, params: unknown, sessionId?: string): void {
    const set = this.handlers.get(method);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h(params ?? {}, sessionId);
      } catch {
        // a faulty listener must not break the connection
      }
    }
  }

  private finish(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.sessions.clear();
    for (const h of this.closeHandlers.splice(0)) {
      try {
        h();
      } catch {
        // ignore
      }
    }
  }
}
