import type { SyncEntry, SyncPendingItem } from "@agent-workstation/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useComposer } from "../store/composer";
import { useProjects } from "../store/projects";
import { useSessions } from "../store/sessions";

export type SyncBridge = NonNullable<NonNullable<Window["__workstationShell"]>["sync"]>;
export type SyncStatus = { folder: string; pending: number };

/** AgentWorkstation.app's sync bridge; null in a plain browser or an older app. */
export function syncBridge(): SyncBridge | null {
  return typeof window === "undefined" ? null : (window.__workstationShell?.sync ?? null);
}

/** Runs `cb` whenever AgentWorkstation.app reports a change for `projectId`; chains whatever handler was installed before. */
export function onSyncChanged(projectId: string, cb: () => void): () => void {
  const prev = window.__workstationSyncChanged;
  let live = true;
  const handler = (id: string) => {
    prev?.(id);
    if (live && id === projectId) cb();
  };
  window.__workstationSyncChanged = handler;
  return () => {
    live = false;
    if (window.__workstationSyncChanged === handler) window.__workstationSyncChanged = prev;
  };
}

/**
 * The sync status of a project (null: no bridge, no project, or not linked on this Mac). `rev` counts the changes
 * AgentWorkstation.app reported, so a view can reload its own data.
 */
export function useSyncStatus(projectId: string | null): { status: SyncStatus | null; rev: number } {
  const [got, setGot] = useState<{ id: string; status: SyncStatus | null } | null>(null);
  const [rev, setRev] = useState(0);
  const seq = useRef(0);
  const refresh = useCallback(() => {
    const bridge = syncBridge();
    const n = ++seq.current;
    if (!bridge || !projectId) return;
    bridge.status(projectId).then(
      (s) => {
        if (n === seq.current) setGot({ id: projectId, status: s });
      },
      () => {
        // a failed read keeps what is shown
      },
    );
  }, [projectId]);
  useEffect(() => {
    refresh();
    if (!projectId || !syncBridge()) return;
    return onSyncChanged(projectId, () => {
      setRev((r) => r + 1);
      refresh();
    });
  }, [projectId, refresh]);
  return { status: projectId && got?.id === projectId && syncBridge() ? got.status : null, rev };
}

/** The `projectId` of a session (null: none, or no session). */
/** The session's project; for a new Code draft (no session yet), the project its folder lies in. */
export function useSyncProjectId(sessionId: string | null): string | null {
  const fromSession = useSessions((s) => (sessionId ? (s.views[sessionId]?.session ?? s.sessions[sessionId])?.projectId ?? null : null));
  const draftCwd = useComposer((s) => s.newCwd);
  const fromDraft = useProjects((s) =>
    sessionId || !draftCwd ? null : (s.list.find((p) => draftCwd === p.path || draftCwd.startsWith(`${p.path}/`))?.id ?? null),
  );
  return sessionId ? fromSession : fromDraft;
}

/** Checked by default: what was suggested; without a suggestion everything but large files. */
export function pendingDefault(item: Pick<SyncPendingItem, "suggestion" | "large">): boolean {
  if (item.suggestion === "sync") return true;
  if (item.suggestion === "skip") return false;
  return !item.large;
}

export type SyncCheck = "approved" | "mixed" | "skip" | "inherit-sync" | "inherit-skip" | "waiting";

/** How a tree row's checkbox looks; `locked` rows sit inside a skipped folder and are not editable. */
export function syncCheck(e: Pick<SyncEntry, "kind" | "decision" | "effective" | "mixed">, locked: boolean): { state: SyncCheck; checked: boolean; dimmed: boolean } {
  if (locked) return { state: "skip", checked: false, dimmed: true };
  if (e.decision === "sync") return { state: e.kind === "folder" && e.mixed ? "mixed" : "approved", checked: true, dimmed: false };
  if (e.decision === "skip") return { state: "skip", checked: false, dimmed: false };
  if (e.effective === "sync") return { state: "inherit-sync", checked: true, dimmed: true };
  if (e.effective === "skip") return { state: "inherit-skip", checked: false, dimmed: true };
  return { state: "waiting", checked: false, dimmed: false };
}
