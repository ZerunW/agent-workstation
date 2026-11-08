import type { SyncDecisionInput, SyncEntry, SyncPendingItem } from "@agent-workstation/protocol";
import { Check, ChevronRight, File, Folder, FolderOpen, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { cn } from "../../lib/cn";
import { basename, formatBytes } from "../../lib/format";
import { pendingDefault, syncBridge, syncCheck, useSyncStatus, type SyncCheck } from "../../lib/sync";
import { t } from "../../i18n";
import { Button, IconButton } from "../ui/primitives";

const errorText = (e: unknown) => t("sync.error", { message: e instanceof Error ? e.message : String(e) });
const fileCount = (n: number) => (n === 1 ? t("sync.file.one") : t("sync.file.many", { n }));

function SourceMark({ source }: { source: "rule" | "ai" | "you" }) {
  if (source !== "rule") return null;
  return <span className="shrink-0 rounded border border-line px-1 text-[9px] font-medium uppercase leading-3 text-subtle">{t("sync.source.rule")}</span>;
}

/** Folder/file semantics of one row: approved folder, folder whose new items ask, skipped, inherited, waiting. */
const BOX: Record<SyncCheck, string> = {
  approved: "border-accent bg-accent text-accent-fg",
  mixed: "border-accent bg-accent text-accent-fg",
  skip: "border-muted bg-surface",
  "inherit-sync": "border-line bg-active text-muted",
  "inherit-skip": "border-line bg-surface opacity-60",
  waiting: "border-dashed border-muted bg-surface",
};

function SyncCheckbox({ entry, locked, onSet }: { entry: SyncEntry; locked: boolean; onSet: (entry: SyncEntry, decision: "sync" | "skip" | null) => void }) {
  const { state, checked } = syncCheck(entry, locked);
  const name = basename(entry.path);
  const clear = () => {
    if (entry.decision !== null) onSet(entry, null);
  };
  const onClick = (e: MouseEvent) => {
    if (e.altKey) return clear();
    onSet(entry, (entry.decision ?? entry.effective) === "sync" ? "skip" : "sync");
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      clear();
    }
  };
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={t("sync.select", { name })}
      title={state === "mixed" ? t("sync.mixed") : undefined}
      disabled={locked}
      data-testid="sync-check"
      data-state={locked ? "locked" : state}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={cn("relative mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border outline-none focus-visible:ring-2 focus-visible:ring-accent", BOX[state], locked && "cursor-default")}
    >
      {checked && <Check className="size-3" strokeWidth={3} aria-hidden />}
      {state === "mixed" && <span aria-hidden data-testid="sync-partial" className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full border border-bg bg-warn" />}
    </button>
  );
}

interface TreeProps {
  dirs: Record<string, SyncEntry[]>;
  open: Set<string>;
  onToggle: (path: string) => void;
  onSet: (entry: SyncEntry, decision: "sync" | "skip" | null) => void;
}

function TreeLevel({ dir, depth, locked, ...p }: TreeProps & { dir: string; depth: number; locked: boolean }) {
  const rows = p.dirs[dir];
  if (!rows) return null;
  return (
    <ul>
      {rows.map((e) => {
        const isDir = e.kind === "folder";
        const isOpen = isDir && p.open.has(e.path);
        const name = basename(e.path);
        const showReason = !!e.reason && (e.source === "rule" || e.source === "ai");
        return (
          <li key={e.path} data-testid="sync-row" data-path={e.path}>
            <div className={cn("flex items-start gap-1 rounded-md py-1 pr-2 text-[13px] hover:bg-hover", locked && "opacity-50")} style={{ paddingLeft: 8 + depth * 14 }}>
              {isDir ? (
                <button type="button" aria-label={t("sync.expand", { name })} aria-expanded={isOpen} onClick={() => p.onToggle(e.path)} className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded text-subtle outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent">
                  <ChevronRight className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} />
                </button>
              ) : (
                <span className="size-4 shrink-0" />
              )}
              <SyncCheckbox entry={e} locked={locked} onSet={p.onSet} />
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                {isDir ? isOpen ? <FolderOpen className="size-4 text-accent" /> : <Folder className="size-4 text-accent" /> : <File className="size-4 text-muted" />}
              </span>
              <div className="min-w-0 flex-1" onClick={isDir ? () => p.onToggle(e.path) : undefined} title={e.reason ?? undefined}>
                <div className={cn("truncate", isDir && "cursor-pointer")}>{name}</div>
                {showReason && (
                  <div className="flex items-center gap-1 text-[11px] text-muted">
                    {e.source && <SourceMark source={e.source} />}
                    <span className="truncate" data-testid="sync-reason">{e.reason}</span>
                  </div>
                )}
              </div>
              <span className="mt-0.5 shrink-0 text-[11px] tabular-nums text-subtle" title={e.files != null ? fileCount(e.files) : undefined}>
                {formatBytes(e.bytes)}
              </span>
            </div>
            {isOpen && <TreeLevel {...p} dir={e.path} depth={depth + 1} locked={locked || e.decision === "skip"} />}
          </li>
        );
      })}
    </ul>
  );
}

function PendingRow({ item, checked, onChange }: { item: SyncPendingItem; checked: boolean; onChange: (v: boolean) => void }) {
  const isDir = item.kind === "folder";
  return (
    <li data-testid="sync-pending-row" data-path={item.path} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-hover">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={t("sync.select", { name: item.path })} className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-[var(--accent)]" />
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">{isDir ? <Folder className="size-4 text-accent" /> : <File className="size-4 text-muted" />}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate" title={item.path}>{item.path}</div>
        {item.reason ? (
          <div className="flex items-center gap-1 text-[11px] text-muted">
            {item.source && <SourceMark source={item.source} />}
            <span className="truncate" title={item.reason} data-testid="sync-reason">{item.reason}</span>
          </div>
        ) : null}
      </div>
      <span className={cn("shrink-0 tabular-nums", item.large ? "text-[13px] font-semibold text-warn" : "mt-0.5 text-[11px] text-subtle")} data-testid={item.large ? "sync-large" : undefined}>
        {isDir && item.files != null ? `${fileCount(item.files)} · ` : ""}
        {formatBytes(item.bytes)}
      </span>
    </li>
  );
}

/** Which paths of the linked folder go to the server (AgentWorkstation.app only): new items waiting, and the decision tree. */
export function SyncTab({ projectId }: { projectId: string }) {
  const { status, rev } = useSyncStatus(projectId);
  const [items, setItems] = useState<SyncPendingItem[]>([]);
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const [dirs, setDirs] = useState<Record<string, SyncEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const loaded = useRef<string[]>([""]);
  const seq = useRef<Record<string, number>>({});
  const live = useRef(true);
  // A failed decision stays on screen through the reload that follows it; the next action clears it.
  const actionFailed = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const loadPending = useCallback(() => {
    syncBridge()
      ?.pending(projectId)
      .then(
        (list) => {
          if (!live.current) return;
          setItems(list);
          setOverride((o) => Object.fromEntries(Object.entries(o).filter(([p]) => list.some((i) => i.path === p))));
        },
        (e) => live.current && setError(errorText(e)),
      );
  }, [projectId]);

  const loadDirs = useCallback(
    (keys: string[]) => {
      const bridge = syncBridge();
      if (!bridge) return;
      for (const dir of new Set(keys)) {
        const n = (seq.current[dir] = (seq.current[dir] ?? 0) + 1);
        bridge.list(projectId, dir).then(
          (rows) => {
            if (!live.current || seq.current[dir] !== n) return;
            if (!loaded.current.includes(dir)) loaded.current = [...loaded.current, dir];
            setDirs((d) => ({ ...d, [dir]: rows }));
            if (!actionFailed.current) setError(null);
          },
          (e) => live.current && seq.current[dir] === n && setError(errorText(e)),
        );
      }
    },
    [projectId],
  );

  const refresh = useCallback(() => {
    loadPending();
    loadDirs(loaded.current);
  }, [loadPending, loadDirs]);

  useEffect(refresh, [refresh, rev]);

  const decide = useCallback(
    async (decisions: SyncDecisionInput[]) => {
      actionFailed.current = false;
      try {
        await syncBridge()?.decide(projectId, decisions);
        if (live.current) setError(null);
        return true;
      } catch (e) {
        actionFailed.current = true;
        if (live.current) setError(errorText(e));
        return false;
      } finally {
        if (live.current) refresh();
      }
    },
    [projectId, refresh],
  );

  const onSet = useCallback((entry: SyncEntry, decision: "sync" | "skip" | null) => void decide([{ path: entry.path, kind: entry.kind, decision }]), [decide]);

  const onToggle = useCallback(
    (path: string) => {
      setOpen((o) => {
        const next = new Set(o);
        if (next.delete(path)) return next;
        next.add(path);
        return next;
      });
      if (!loaded.current.includes(path)) loadDirs([path]);
    },
    [loadDirs],
  );

  const checkedOf = (i: SyncPendingItem) => override[i.path] ?? pendingDefault(i);
  const confirm = async () => {
    setConfirming(true);
    const ok = await decide(items.map((i) => ({ path: i.path, kind: i.kind, decision: checkedOf(i) ? "sync" : "skip" })));
    if (live.current) {
      setConfirming(false);
      if (ok) setOverride({});
    }
  };
  const recheck = async () => {
    setRechecking(true);
    actionFailed.current = false;
    try {
      await syncBridge()?.recheck(projectId);
    } catch (e) {
      actionFailed.current = true;
      if (live.current) setError(errorText(e));
    } finally {
      if (live.current) {
        setRechecking(false);
        refresh();
      }
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="sync-tab">
      {error && <p role="alert" className="px-3 py-1.5 text-xs text-muted" data-testid="sync-error">{error}</p>}
      {items.length > 0 && (
        <section aria-label={t("sync.pending")} className="shrink-0 border-b border-line">
          <div className="flex h-9 items-center gap-2 px-3">
            <span className="text-[13px] font-medium">{t("sync.pending")}</span>
            <Button size="xs" variant="primary" className="ml-auto" loading={confirming} onClick={() => void confirm()} data-testid="sync-confirm">
              {t("sync.confirm")}
            </Button>
          </div>
          <ul className="px-1 pb-1.5" data-testid="sync-pending">
            {items.map((i) => (
              <PendingRow key={i.path} item={i} checked={checkedOf(i)} onChange={(v) => setOverride((o) => ({ ...o, [i.path]: v }))} />
            ))}
          </ul>
        </section>
      )}
      <section aria-label={t("sync.tree")} className="min-h-0 flex-1">
        <div className="flex h-8 items-center gap-1.5 border-b border-line px-3 text-[13px] font-medium">
          <span className="min-w-0 flex-1 truncate" title={status?.folder}>{status ? basename(status.folder) : t("sync.tree")}</span>
          <IconButton label={t("sync.recheck")} title={t("sync.recheck")} size="xs" disabled={rechecking} onClick={() => void recheck()} data-testid="sync-recheck">
            <RotateCcw className={cn("size-3.5", rechecking && "animate-spin")} />
          </IconButton>
        </div>
        <div className="p-1">
          <TreeLevel dirs={dirs} open={open} onToggle={onToggle} onSet={onSet} dir="" depth={0} locked={false} />
        </div>
      </section>
    </div>
  );
}
