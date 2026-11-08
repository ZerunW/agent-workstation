import type { SyncEntry, SyncPendingItem } from "@agent-workstation/protocol";
import { vi } from "vitest";
import type { SyncBridge, SyncStatus } from "../lib/sync";

export const PID = "22222222-2222-4222-8222-222222222222";

export const entry = (over: Partial<SyncEntry> & Pick<SyncEntry, "path">): SyncEntry => ({
  kind: "file",
  decision: null,
  effective: null,
  source: null,
  reason: null,
  bytes: 1024,
  ...over,
});

export const pendingItem = (over: Partial<SyncPendingItem> & Pick<SyncPendingItem, "path">): SyncPendingItem => ({
  kind: "file",
  bytes: 2048,
  suggestion: null,
  source: null,
  reason: null,
  detectedAt: "2026-11-01T12:00:00.000Z",
  ...over,
});

export interface MockBridge extends SyncBridge {
  status: ReturnType<typeof vi.fn> & SyncBridge["status"];
  pending: ReturnType<typeof vi.fn> & SyncBridge["pending"];
  list: ReturnType<typeof vi.fn> & SyncBridge["list"];
  decide: ReturnType<typeof vi.fn> & SyncBridge["decide"];
  recheck: ReturnType<typeof vi.fn> & SyncBridge["recheck"];
}

/** A mock `__workstationShell.sync`: `tree` maps a dir to its children. */
export function makeBridge(opts: { status?: SyncStatus | null; pending?: SyncPendingItem[]; tree?: Record<string, SyncEntry[]> } = {}): MockBridge {
  const status = opts.status === undefined ? { folder: "/Users/me/proj", pending: opts.pending?.length ?? 0 } : opts.status;
  return {
    status: vi.fn().mockResolvedValue(status),
    pending: vi.fn().mockResolvedValue(opts.pending ?? []),
    list: vi.fn((_id: string, dir: string) => Promise.resolve(opts.tree?.[dir] ?? [])),
    decide: vi.fn().mockResolvedValue(undefined),
    recheck: vi.fn().mockResolvedValue(undefined),
  } as unknown as MockBridge;
}

export function installBridge(bridge: SyncBridge | null): void {
  window.__workstationShell = bridge ? { sync: bridge } : undefined;
}

export function removeBridge(): void {
  window.__workstationShell = undefined;
  window.__workstationSyncChanged = undefined;
}
