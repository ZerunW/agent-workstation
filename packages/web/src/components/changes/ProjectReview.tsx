import type { ReviewFile } from "@agent-workstation/protocol";
import { ArrowLeft, Check, Columns2, Download, GitCompare, Rows2, TriangleAlert, X, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { fetchProjectRaw, isUnavailable, saveBlob } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { safeStorage, STORAGE_KEYS } from "../../lib/storage";
import { useFetch } from "../../hooks/useFetch";
import { DiffEmbed, type DiffChangeEvent } from "../../embed/DiffEmbed";
import { accept, getReview, reject } from "../../embed/reviewApi";
import { t } from "../../i18n";
import { useReview } from "../../store/review";
import { toast } from "../../store/toasts";
import { Banner, Button, EmptyState, IconButton, Skeleton } from "../ui/primitives";
import { ConfirmDialog } from "../ui/overlays";
import { StatusBadge } from "./StatusBadge";

const NO_CONFLICTS: Record<string, { reason: string; at: string }> = {};

export type DiffLayout = "unified" | "split";
const readLayout = (): DiffLayout => (safeStorage.get(STORAGE_KEYS.diffLayout) === "split" ? "split" : "unified");

/** Layout toggle state shared by every diff in the app (persisted). */
export function useDiffLayout(): [DiffLayout, (l: DiffLayout) => void] {
  const [layout, setLayout] = useState<DiffLayout>(readLayout);
  return [
    layout,
    (l) => {
      safeStorage.set(STORAGE_KEYS.diffLayout, l);
      setLayout(l);
    },
  ];
}

export function LayoutToggle({ layout, onChange }: { layout: DiffLayout; onChange: (l: DiffLayout) => void }) {
  return (
    <div role="radiogroup" aria-label="Diff layout" className="flex rounded-md bg-active p-0.5">
      {(["unified", "split"] as const).map((l) => {
        const Icon = l === "unified" ? Rows2 : Columns2;
        const label = t(l === "unified" ? "diff.layout.unified" : "diff.layout.split");
        return (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={layout === l}
            aria-label={label}
            title={label}
            data-testid={`layout-${l}`}
            onClick={() => onChange(l)}
            className={cn("flex h-5 w-7 items-center justify-center rounded text-muted", layout === l ? "bg-surface text-fg shadow-sm" : "hover:text-fg")}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}

export function ConflictAlert({ reason, onDismiss, className }: { reason: string; onDismiss?: () => void; className?: string }) {
  return (
    <Banner tone="danger" role="alert" onDismiss={onDismiss} className={className}>
      <span className="font-medium">{t("review.conflict.title")}</span> · {t("review.conflict.body", { reason })}
    </Banner>
  );
}

function ReviewRow({
  file,
  sessionId,
  conflict,
  busy,
  onOpen,
  onAccept,
  onReject,
}: {
  file: ReviewFile;
  sessionId: string | null;
  conflict?: string;
  busy: boolean;
  onOpen: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  // "this session" / "other" only means something next to a session; the Projects page shows neither
  const who = file.lastTouchedBy && sessionId ? (file.lastTouchedBy.sessionId === sessionId ? "this" : "other") : null;
  return (
    <li className="group relative border-b border-line/60" data-testid="review-row" data-path={file.path}>
      <button type="button" onClick={onOpen} aria-label={t("changes.openDiff", { path: file.path })} className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-hover">
        <span className="flex items-center gap-2">
          <StatusBadge status={file.status} />
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
            <span className="text-subtle">{dir}</span>
            <span className="font-medium text-fg">{base}</span>
          </span>
          {file.binary ? (
            <span className="shrink-0 rounded bg-active px-1.5 text-[11px] text-muted">{t(file.large ? "changes.large" : "changes.binary")}</span>
          ) : (
            <span className="flex shrink-0 gap-1.5 font-mono text-[11.5px] tabular-nums group-hover:invisible group-focus-within:invisible">
              <span className="text-ok">+{file.additions}</span>
              <span className="text-danger">−{file.deletions}</span>
            </span>
          )}
        </span>
        <span className="flex items-center gap-2 pl-7 text-[11.5px] text-subtle">
          <span className="tabular-nums">{file.large && file.oldSizeBytes !== undefined ? `${formatBytes(file.oldSizeBytes)} → ${formatBytes(file.sizeBytes)}` : formatBytes(file.sizeBytes)}</span>
          {who && (
            <span
              className={cn("rounded px-1", who === "this" ? "bg-accent-soft text-accent" : "bg-active text-muted")}
              title={file.lastTouchedBy ? t("changes.touchedBy", { who: t(who === "this" ? "changes.thisSession" : "changes.other"), tool: file.lastTouchedBy.tool, turn: file.lastTouchedBy.turn }) : undefined}
              data-testid="touched-by"
            >
              {t(who === "this" ? "changes.thisSession" : "changes.other")}
            </span>
          )}
          {file.oldPath && <span className="min-w-0 truncate">{t("changes.renamedFrom", { path: file.oldPath })}</span>}
        </span>
        {conflict && (
          <span className="mt-0.5 flex items-start gap-1.5 pl-7 text-[11.5px] text-danger" role="alert" data-testid="row-conflict">
            <TriangleAlert className="mt-px size-3 shrink-0" />
            <span className="min-w-0">{t("review.conflict.body", { reason: conflict })}</span>
          </span>
        )}
      </button>
      <div className="absolute right-2 top-1.5 hidden items-center gap-0.5 group-focus-within:flex group-hover:flex">
        <IconButton label={t("changes.reject", { path: file.path })} size="xs" disabled={busy} onClick={onReject} className="bg-surface shadow-[0_0_0_1px_var(--line)]">
          <X className="size-3.5 text-danger" />
        </IconButton>
        <IconButton label={t("changes.accept", { path: file.path })} size="xs" disabled={busy} onClick={onAccept} className="bg-surface shadow-[0_0_0_1px_var(--line)]">
          <Check className="size-3.5 text-ok" />
        </IconButton>
      </div>
    </li>
  );
}

export interface ProjectReviewProps {
  projectId: string;
  projectName?: string;
  /** When given, the "This session" filter and the this-session/other labels are offered. */
  sessionId?: string | null;
}

/** Review list for one project (ReviewFile rows, filters, accept all) with the per-file DiffViewer behind it. */
export function ProjectReview({ projectId, projectName, sessionId = null }: ProjectReviewProps) {
  const version = useReview((s) => s.version[projectId] ?? 0);
  const conflicts = useReview((s) => s.conflicts[projectId] ?? NO_CONFLICTS);
  const clearConflict = useReview((s) => s.clearConflict);
  const review = useFetch(() => getReview(projectId), [projectId, version]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const [layout, setLayout] = useDiffLayout();
  const [busy, setBusy] = useState(false);
  const [confirmReject, setConfirmReject] = useState<string | null>(null);

  const files = useMemo(() => [...(review.data?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path)), [review.data]);
  const shown = useMemo(() => (onlyMine && sessionId ? files.filter((f) => f.lastTouchedBy?.sessionId === sessionId) : files), [files, onlyMine, sessionId]);

  // A different project resets the view state.
  useEffect(() => {
    setOpenPath(null);
    setOnlyMine(false);
  }, [projectId]);

  // The open file left the review (accepted/rejected here or on the Mac): go back to the list.
  const { reload } = review;
  useEffect(() => {
    if (openPath && review.data && !review.loading && !files.some((f) => f.path === openPath)) setOpenPath(null);
  }, [openPath, review.data, review.loading, files]);

  const act = useCallback(
    async (kind: "accept" | "reject", path: string) => {
      setBusy(true);
      try {
        await (kind === "accept" ? accept(projectId, { path }) : reject(projectId, { path }));
        clearConflict(projectId, path);
        toast.success(t(kind === "accept" ? "changes.accepted" : "changes.rejected", { path }));
        reload();
      } catch (e) {
        toast.error(t("changes.actionFailed", { error: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(false);
      }
    },
    [projectId, clearConflict, reload],
  );

  const acceptAll = useCallback(async () => {
    setBusy(true);
    try {
      await accept(projectId, { all: true });
      for (const f of files) clearConflict(projectId, f.path);
      toast.success(t("changes.acceptedAll"));
      reload();
    } catch (e) {
      toast.error(t("changes.actionFailed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [projectId, files, clearConflict, reload]);

  const onDiffChanged = useCallback(
    (e: DiffChangeEvent) => {
      if (!e.hunks) {
        clearConflict(projectId, e.path);
        toast.success(t(e.kind === "accept" ? "changes.accepted" : "changes.rejected", { path: e.path }));
      }
      reload();
    },
    [projectId, clearConflict, reload],
  );

  const downloadRaw = useCallback(
    async (path: string) => {
      try {
        saveBlob(await fetchProjectRaw(projectId, path), path.split("/").pop() || "file");
      } catch (e) {
        toast.error(t("files.download.failed"), e instanceof Error ? e.message : String(e));
      }
    },
    [projectId],
  );

  // ---- states ------------------------------------------------------------------------------
  if (review.error && !review.data) {
    const unavailable = isUnavailable(review.error);
    return (
      <EmptyState
        icon={<GitCompare className="size-6" />}
        title={unavailable ? t("review.unavailable.title") : t("review.loadFailed")}
        action={<Button onClick={reload}>{t("app.retry")}</Button>}
      >
        {unavailable ? null : review.error.message}
      </EmptyState>
    );
  }
  if (!review.data) {
    return (
      <div className="space-y-2 p-3" aria-busy>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  }

  const openFile = openPath ? files.find((f) => f.path === openPath) : undefined;
  if (openPath) {
    const conflict = conflicts[openPath];
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="review-detail">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-1.5">
          <Button size="xs" variant="ghost" icon={<ArrowLeft className="size-3.5" />} onClick={() => setOpenPath(null)} data-autofocus>
            {t("changes.back")}
          </Button>
          {openFile && <StatusBadge status={openFile.status} />}
          <div className="ml-auto flex items-center gap-1">
            {openFile && openFile.status !== "deleted" && (
              <IconButton label={t("changes.download")} size="xs" onClick={() => void downloadRaw(openPath)}>
                <Download className="size-3.5" />
              </IconButton>
            )}
            <LayoutToggle layout={layout} onChange={setLayout} />
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <DiffEmbed
            key={`${projectId}:${openPath}`}
            projectId={projectId}
            path={openPath}
            layout={layout}
            onChanged={onDiffChanged}
            onStale={reload}
            banner={conflict ? <ConflictAlert reason={conflict.reason} onDismiss={() => clearConflict(projectId, openPath)} /> : undefined}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="project-review">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
        <span className="min-w-0 truncate px-1 text-[13px] font-medium" title={projectName}>
          {projectName ?? review.data.project.name}
        </span>
        <span className="text-xs text-muted" data-testid="pending-count">
          {t("changes.count", { n: files.length })}
        </span>
        <IconButton label={t("changes.refresh")} title={t("changes.refresh")} size="xs" onClick={reload} className="ml-auto">
          <RefreshCw className={cn("size-3.5", review.loading && "animate-spin")} />
        </IconButton>
        {sessionId && (
          <button
            type="button"
            role="switch"
            aria-checked={onlyMine}
            onClick={() => setOnlyMine((v) => !v)}
            data-testid="filter-session"
            className={cn("flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium", onlyMine ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg")}
          >
            <span className={cn("size-1.5 rounded-full", onlyMine ? "bg-accent" : "bg-subtle")} />
            {t("changes.filter.session")}
          </button>
        )}
        <Button size="xs" variant="primary" icon={<Check className="size-3" />} disabled={busy || files.length === 0} loading={busy} onClick={() => void acceptAll()} data-testid="accept-all">
          {t("changes.acceptAll")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <EmptyState icon={<GitCompare className="size-6" />} title={t("changes.empty.title")}>
            {files.length > 0 ? t("changes.empty.filtered") : null}
          </EmptyState>
        ) : (
          <ul aria-label="Changed files">
            {shown.map((f) => (
              <ReviewRow
                key={f.path}
                file={f}
                sessionId={sessionId}
                conflict={conflicts[f.path]?.reason}
                busy={busy}
                onOpen={() => setOpenPath(f.path)}
                onAccept={() => void act("accept", f.path)}
                onReject={() => setConfirmReject(f.path)}
              />
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={confirmReject !== null}
        onOpenChange={(o) => !o && setConfirmReject(null)}
        danger
        title={t("changes.rejectConfirm.title", { path: confirmReject ?? "" })}
        confirmLabel={t("changes.rejectConfirm.confirm")}
        cancelLabel={t("app.cancel")}
        onConfirm={() => (confirmReject ? act("reject", confirmReject) : undefined)}
      />
    </div>
  );
}

