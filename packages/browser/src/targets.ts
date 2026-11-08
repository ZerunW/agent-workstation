/**
 * Tracks the browser's page targets (tabs) and which one is "active" — the tab the live view shows and person input
 * goes to. Headless Chromium has no focused-tab notion visible over CDP (all tabs report `visible`), so the active
 * tab follows what the agent and the person do:
 *   - a new tab or popup becomes active (agents open tabs to work in them, OAuth popups need the person);
 *   - the agent selecting a tab (Playwright `bringToFront`, reported through `activate()`) makes it active;
 *   - when the active tab closes, the most recently active remaining tab takes over.
 */
import { EventEmitter } from "node:events";
import type { CdpClient } from "./cdp.js";

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
  openerId?: string;
  browserContextId?: string;
}

/** Tabs only: not DevTools, not the full browser's own WebUI surfaces (omnibox popup etc. are "page" targets too). */
const isTab = (t: TargetInfo): boolean => t.type === "page" && !t.url.startsWith("devtools://") && !/^chrome(-untrusted)?:\/\/[^/]*top-chrome/.test(t.url);

export interface TargetTrackerEvents {
  /** The active tab changed (null = no tabs). */
  active: [targetId: string | null];
  /** URL or title of the active tab changed. */
  info: [info: TargetInfo];
  /** A tab appeared (after start). */
  created: [info: TargetInfo];
}

export class TargetTracker extends EventEmitter<TargetTrackerEvents> {
  private readonly tabs = new Map<string, TargetInfo>();
  /** Activation order, most recent last. */
  private readonly recency: string[] = [];
  private activeId: string | null = null;
  private started = false;
  private readonly unsubs: (() => void)[] = [];

  constructor(private readonly cdp: CdpClient) {
    super();
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.cdp.on("Target.targetCreated", (p: { targetInfo: TargetInfo }) => this.onCreated(p.targetInfo)),
      this.cdp.on("Target.targetInfoChanged", (p: { targetInfo: TargetInfo }) => this.onChanged(p.targetInfo)),
      this.cdp.on("Target.targetDestroyed", (p: { targetId: string }) => this.onDestroyed(p.targetId)),
    );
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = await this.cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    for (const t of targetInfos) if (isTab(t) && !this.tabs.has(t.targetId)) this.add(t);
    this.started = true;
    const last = this.recency[this.recency.length - 1] ?? null;
    if (last) this.setActive(last);
  }

  stop(): void {
    for (const u of this.unsubs.splice(0)) u();
  }

  get active(): string | null {
    return this.activeId;
  }

  activeInfo(): TargetInfo | null {
    return this.activeId ? (this.tabs.get(this.activeId) ?? null) : null;
  }

  list(): TargetInfo[] {
    return [...this.tabs.values()];
  }

  /** Re-read url/title of the active tab (Target.getTargetInfo has the current title). */
  async refresh(): Promise<void> {
    const id = this.activeId;
    if (!id) return;
    try {
      const { targetInfo } = await this.cdp.send<{ targetInfo: TargetInfo }>("Target.getTargetInfo", { targetId: id });
      this.onChanged(targetInfo);
    } catch {
      // tab closed meanwhile
    }
  }

  /** Make a known tab active (agent selected it, or the hub asks). Unknown ids are ignored. */
  activate(targetId: string): void {
    if (this.tabs.has(targetId)) this.setActive(targetId);
  }

  private add(t: TargetInfo): void {
    this.tabs.set(t.targetId, { ...t });
    this.recency.push(t.targetId);
  }

  private setActive(id: string | null): void {
    if (id) {
      const i = this.recency.indexOf(id);
      if (i >= 0) this.recency.splice(i, 1);
      this.recency.push(id);
    }
    if (id === this.activeId) return;
    this.activeId = id;
    this.emit("active", id);
  }

  private onCreated(t: TargetInfo): void {
    if (!isTab(t) || this.tabs.has(t.targetId)) return;
    this.add(t);
    if (!this.started) return;
    this.emit("created", { ...t });
    this.setActive(t.targetId);
  }

  private onChanged(t: TargetInfo): void {
    const known = this.tabs.get(t.targetId);
    if (!known) {
      // e.g. a target that was not a tab before (prerender) or arrived before start
      if (this.started) this.onCreated(t);
      return;
    }
    if (!isTab(t)) {
      this.onDestroyed(t.targetId);
      return;
    }
    const changed = known.url !== t.url || known.title !== t.title;
    known.url = t.url;
    known.title = t.title;
    if (changed && t.targetId === this.activeId) this.emit("info", { ...known });
  }

  private onDestroyed(id: string): void {
    if (!this.tabs.delete(id)) return;
    const i = this.recency.indexOf(id);
    if (i >= 0) this.recency.splice(i, 1);
    if (id === this.activeId) {
      this.activeId = null;
      this.setActive(this.recency[this.recency.length - 1] ?? null);
      if (this.activeId === null) this.emit("active", null);
    }
  }
}
