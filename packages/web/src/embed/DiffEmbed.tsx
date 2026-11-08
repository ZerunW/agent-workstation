import type { FileDiff, Hunk } from "@agent-workstation/protocol";
import { Check, FileQuestion, GitCompare, X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { DiffHeader } from "../components/diff/DiffHeader";
import { DiffViewer, type DiffChunkInfo, type DiffViewerHandle } from "../components/diff/DiffViewer";
import { Button, EmptyState, Skeleton } from "../components/ui/primitives";
import { t } from "../i18n";
import { ApiError, isStaleDiff } from "../lib/api";
import { buildDiff } from "../lib/lineDiff";
import { toast } from "../store/toasts";
import { accept, getReviewDiff, reject } from "./reviewApi";

/** Imperative surface the host drives through `window.workstationEmbed` (diff mode). */
export interface DiffEmbedHandle {
  /** Accept these protocol hunk indexes of the current diff. */
  acceptHunks(indices: number[]): void;
  acceptFile(): void;
  rejectHunks(indices: number[]): void;
  rejectFile(): void;
  /** Re-fetch the diff (call on `review_changed`). */
  reload(): void;
}

export interface DiffChangeEvent {
  kind: "accept" | "reject";
  path: string;
  /** Hunk indexes that were acted on; undefined = the whole file. */
  hunks?: number[];
}

export interface DiffEmbedProps {
  projectId: string;
  path: string;
  /** Posts a message to the macOS host (or logs it in a browser). Without it the path is not clickable. */
  post?: (msg: Record<string, unknown>) => void;
  layout?: "unified" | "split";
  className?: string;
  /** Called after the hub accepted a review action (before the diff is refetched). */
  onChanged?: (e: DiffChangeEvent) => void;
  /** Called when the hub answered 409 `stale_diff` (the diff is reloaded automatically). */
  onStale?: () => void;
  /** Shown above the diff (e.g. a sync-conflict alert). */
  banner?: ReactNode;
}

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; diff: FileDiff };

/** How a FileDiff is shown: texts for the merge view, raw hunks when a side is missing, or an empty/binary state. */
export type DiffMode = { kind: "binary" } | { kind: "empty" } | { kind: "text"; oldText: string; newText: string } | { kind: "hunks" };

/**
 * The hub omits `oldText`/`newText` for binary and very large files. One missing side next to a present one is a
 * file that was added or deleted (the missing side is empty); both missing with hunks present is "too large to
 * render side by side" and falls back to the raw hunks.
 */
export function diffMode(diff: FileDiff): DiffMode {
  if (diff.binary) return { kind: "binary" };
  const { oldText, newText } = diff;
  if (oldText == null && newText == null) return diff.hunks.length ? { kind: "hunks" } : { kind: "empty" };
  const o = oldText ?? "";
  const n = newText ?? "";
  return o === n ? { kind: "empty" } : { kind: "text", oldText: o, newText: n };
}

const EMPTY_DIFF = (path: string): FileDiff => ({ path, localCommit: null, diffId: "", binary: false, oldText: "", newText: "", hunks: [] });

function HunkList({ hunks, onAccept, onReject, disabled }: { hunks: Hunk[]; onAccept: (h: Hunk) => void; onReject: (h: Hunk) => void; disabled: boolean }) {
  return (
    <div className="space-y-3 p-3" data-testid="hunk-list">
      {hunks.map((h) => (
        <section key={h.index} className="overflow-hidden rounded-lg border border-line">
          <div className="flex items-center gap-2 border-b border-line bg-sunken px-2.5 py-1">
            <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{h.header}</code>
            <Button size="xs" variant="outline" icon={<X className="size-3 text-danger" />} disabled={disabled} onClick={() => onReject(h)}>
              {t("diff.reject")}
            </Button>
            <Button size="xs" variant="primary" icon={<Check className="size-3" />} disabled={disabled} onClick={() => onAccept(h)}>
              {t("diff.accept")}
            </Button>
          </div>
          <pre className="overflow-x-auto py-1 font-mono text-[12.5px] leading-[1.55]">
            {h.lines.map((l, i) => (
              <div key={i} className={l[0] === "+" ? "bg-ok-soft px-3" : l[0] === "-" ? "bg-danger-soft px-3" : "px-3 text-muted"}>
                {l || " "}
              </div>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}

export const DiffEmbed = forwardRef<DiffEmbedHandle, DiffEmbedProps>(function DiffEmbed({ projectId, path, post, layout = "unified", className, onChanged, onStale, banner }, ref) {
  const [state, setState] = useState<Load>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const viewer = useRef<DiffViewerHandle>(null);
  const run = useRef(0);
  const busyRef = useRef(false);
  const current = useRef({ projectId, path });
  current.current = { projectId, path };
  const latestDiff = useRef<FileDiff | null>(null);
  latestDiff.current = state.status === "ready" ? state.diff : null;
  const callbacks = useRef({ onChanged, onStale });
  callbacks.current = { onChanged, onStale };

  const load = useCallback(
    (keepStale = true) => {
      const id = ++run.current;
      setState((s) => (keepStale && s.status === "ready" ? s : { status: "loading" }));
      getReviewDiff(projectId, path).then(
        (diff) => id === run.current && setState({ status: "ready", diff }),
        (e) => id === run.current && setState({ status: "error", message: e instanceof Error ? e.message : String(e) }),
      );
    },
    [projectId, path],
  );

  useEffect(() => {
    const token = run;
    load(false);
    return () => {
      token.current++; // drop responses of a superseded load
    };
  }, [load]);

  /** Apply a review action, then refetch: hunk indexes are renumbered by the hub after every change. */
  const apply = useCallback(async (kind: "accept" | "reject", hunks?: number[]) => {
    if (busyRef.current) return; // one review action at a time: hunk indexes change after each one
    const { projectId: pid, path: p } = current.current;
    busyRef.current = true;
    setBusy(true);
    try {
      // Hunk indexes are only meaningful for the diff they came from: send its diffId so the hub can refuse a stale one.
      const diffId = latestDiff.current?.diffId;
      const body = hunks && hunks.length ? { path: p, hunks, ...(diffId ? { diffId } : {}) } : { path: p };
      if (kind === "accept") await accept(pid, body);
      else await reject(pid, body);
      callbacks.current.onChanged?.({ kind, path: p, hunks: hunks && hunks.length ? hunks : undefined });
      try {
        const diff = await getReviewDiff(pid, p);
        setState({ status: "ready", diff });
      } catch (e) {
        // A fully accepted/rejected file leaves the review: the hub may answer 404 for it.
        if (e instanceof ApiError && e.status === 404) setState({ status: "ready", diff: EMPTY_DIFF(p) });
        else throw e;
      }
    } catch (e) {
      if (isStaleDiff(e)) {
        toast.info(t("diff.stale", { path: current.current.path }));
        callbacks.current.onStale?.();
        const id = ++run.current;
        getReviewDiff(pid, p).then(
          (diff) => id === run.current && setState({ status: "ready", diff }),
          (err) => id === run.current && setState({ status: "error", message: err instanceof Error ? err.message : String(err) }),
        );
      } else {
        toast.error(t(kind === "accept" ? "diff.acceptFailed" : "diff.rejectFailed", { error: e instanceof Error ? e.message : String(e) }));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      acceptHunks: (indices) => void apply("accept", indices),
      acceptFile: () => void apply("accept"),
      rejectHunks: (indices) => void apply("reject", indices),
      rejectFile: () => void apply("reject"),
      reload: () => load(true),
    }),
    [apply, load],
  );

  const diff = state.status === "ready" ? state.diff : null;
  const mode = useMemo(() => (diff ? diffMode(diff) : null), [diff]);
  const stats = useMemo(() => {
    if (!diff || !mode || mode.kind === "binary" || mode.kind === "empty") return { additions: 0, deletions: 0 };
    if (diff.hunks.length) {
      let additions = 0;
      let deletions = 0;
      for (const h of diff.hunks) {
        for (const l of h.lines) {
          if (l[0] === "+") additions++;
          else if (l[0] === "-") deletions++;
        }
      }
      return { additions, deletions };
    }
    return mode.kind === "text" ? buildDiff(mode.oldText, mode.newText).stats : { additions: 0, deletions: 0 };
  }, [diff, mode]);

  const empty = mode?.kind === "empty";
  const binary = mode?.kind === "binary";
  const canAct = !!diff && !empty && !busy;

  return (
    <div className={`flex h-full min-h-0 flex-col bg-bg ${className ?? ""}`} data-testid="diff-embed" aria-busy={state.status === "loading"}>
      <DiffHeader
        path={path}
        additions={stats.additions}
        deletions={stats.deletions}
        changes={diff && !binary ? diff.hunks.length || undefined : undefined}
        onOpenFile={post ? (p) => post({ type: "open_file", path: p, projectId }) : undefined}
        onAcceptAll={diff && !empty ? () => void apply("accept") : undefined}
        onRejectAll={diff && !empty ? () => void apply("reject") : undefined}
        onNext={mode?.kind === "text" ? () => viewer.current?.goToNext() : undefined}
        onPrev={mode?.kind === "text" ? () => viewer.current?.goToPrev() : undefined}
        busy={busy}
        disabled={!canAct}
      />
      {banner}
      <div className="min-h-0 flex-1 overflow-auto">
        {state.status === "loading" && (
          <div className="space-y-2 p-4" data-testid="diff-loading">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className={i % 3 === 0 ? "h-4 w-3/4" : "h-4 w-full"} />
            ))}
          </div>
        )}
        {state.status === "error" && (
          <EmptyState icon={<FileQuestion className="size-6" />} title={t("diff.loadFailed")} action={<button className="text-[13px] font-medium text-accent hover:underline" onClick={() => load(false)}>{t("app.retry")}</button>}>
            {state.message}
          </EmptyState>
        )}
        {diff && binary && (
          <EmptyState icon={<FileQuestion className="size-6" />} title={t("diff.binary")} />
        )}
        {diff && empty && (
          <EmptyState icon={<GitCompare className="size-6" />} title={t("diff.noChanges")} />
        )}
        {diff && mode?.kind === "hunks" && <HunkList hunks={diff.hunks} disabled={busy} onAccept={(h) => void apply("accept", [h.index])} onReject={(h) => void apply("reject", [h.index])} />}
        {diff && mode?.kind === "text" && (
          <DiffViewer
            ref={viewer}
            path={diff.path}
            oldText={mode.oldText}
            newText={mode.newText}
            hunks={diff.hunks}
            layout={layout}
            onAcceptChunk={(c: DiffChunkInfo) => void apply("accept", c.hunkIndexes)}
            onRejectChunk={(c: DiffChunkInfo) => void apply("reject", c.hunkIndexes)}
          />
        )}
      </div>
    </div>
  );
});
