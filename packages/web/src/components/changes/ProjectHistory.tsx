import type { Snapshot } from "@agent-workstation/protocol";
import { History, RotateCcw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { api, isUnavailable } from "../../lib/api";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { groupHistory, validRestorePath, type HistoryKind } from "../../lib/history";
import { shortCommit } from "../../lib/projects";
import { useFetch } from "../../hooks/useFetch";
import { t } from "../../i18n";
import { useReview } from "../../store/review";
import { toast } from "../../store/toasts";
import { Badge, Button, EmptyState, Skeleton } from "../ui/primitives";
import { Modal } from "../ui/overlays";
import { NO_AUTOFILL } from "../../lib/noAutofill";

const PAGE = 25;
const KIND_TONE: Record<HistoryKind, "info" | "accent" | "ok" | "warn"> = { sync: "info", snapshot: "accent", accept: "ok", trash: "warn" };

type RestoreTarget = { snap: Snapshot; mode: "file" | "all" };

function whenLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function Row({ snap, onRestore }: { snap: Snapshot; onRestore: (mode: "file" | "all") => void }) {
  return (
    <li className="border-b border-line/60 px-3 py-2" data-testid="history-row" data-ref={snap.ref}>
      <div className="flex items-baseline gap-2">
        <time dateTime={snap.at} title={whenLabel(snap.at)} className="shrink-0 text-[11.5px] tabular-nums text-subtle">
          {relativeTime(snap.at) || "—"}
        </time>
        <span className="min-w-0 flex-1 break-words text-[13px] leading-snug">{snap.message || <span className="text-subtle">—</span>}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {snap.turn != null && <span className="rounded bg-active px-1.5 text-[11px] text-muted">{t("history.turn", { n: snap.turn })}</span>}
        <code className="rounded bg-sunken px-1 font-mono text-[11px] text-subtle" title={snap.ref}>
          {shortCommit(snap.ref)}
        </code>
        <span className="ml-auto flex gap-1">
          <Button size="xs" variant="ghost" onClick={() => onRestore("file")}>
            {t("history.restoreFile")}
          </Button>
          <Button size="xs" variant="ghost" icon={<RotateCcw className="size-3" />} onClick={() => onRestore("all")}>
            {t("history.restoreAll")}
          </Button>
        </span>
      </div>
    </li>
  );
}

/** Project history grouped by kind, with restore of one file or the whole project (the hub writes a trash ref first). */
export function ProjectHistory({ projectId, projectName }: { projectId: string; projectName?: string }) {
  const version = useReview((s) => s.version[projectId] ?? 0);
  const bump = useReview((s) => s.bump);
  const history = useFetch(() => api.projectHistory(projectId), [projectId, version]);
  const [limits, setLimits] = useState<Partial<Record<HistoryKind, number>>>({});
  const [target, setTarget] = useState<RestoreTarget | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => groupHistory(history.data ?? []), [history.data]);
  const name = projectName ?? projectId.slice(0, 8);

  const close = useCallback(() => {
    if (busy) return;
    setTarget(null);
    setPath("");
  }, [busy]);

  const restore = useCallback(async () => {
    if (!target) return;
    const file = target.mode === "file" ? path.trim() : undefined;
    setBusy(true);
    try {
      await api.restoreProject(projectId, file ? { ref: target.snap.ref, path: file } : { ref: target.snap.ref });
      toast.success(t("history.restored", { what: file ?? t("history.restored.all") }));
      setTarget(null);
      setPath("");
      bump(projectId); // the review list and this history both refetch
    } catch (e) {
      toast.error(t("history.restoreFailed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [target, path, projectId, bump]);

  if (history.error && !history.data) {
    const unavailable = isUnavailable(history.error);
    return (
      <EmptyState icon={<History className="size-6" />} title={unavailable ? t("review.unavailable.title") : t("history.loadFailed")} action={<Button onClick={history.reload}>{t("app.retry")}</Button>}>
        {unavailable ? null : history.error.message}
      </EmptyState>
    );
  }
  if (!history.data)
    return (
      <div className="space-y-2 p-3" aria-busy>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  if (groups.length === 0) return <EmptyState icon={<History className="size-6" />} title={t("history.empty.title")} />;

  const filePathValid = validRestorePath(path);
  const when = target ? whenLabel(target.snap.at) : "";

  return (
    <div className="h-full overflow-y-auto" data-testid="project-history">
      {groups.map((g) => {
        const limit = limits[g.kind] ?? PAGE;
        return (
          <section key={g.kind} aria-label={t(`history.kind.${g.kind}` as const)} data-testid={`history-group-${g.kind}`}>
            <header className="sticky top-0 z-[1] flex items-center gap-2 border-b border-line bg-bg px-3 py-1.5">
              <Badge tone={KIND_TONE[g.kind]}>{t(`history.kind.${g.kind}` as const)}</Badge>
              <span className="text-xs tabular-nums text-subtle">{g.items.length}</span>
            </header>
            <ul>
              {g.items.slice(0, limit).map((s) => (
                <Row
                  key={`${s.kind}-${s.ref}-${s.at}`}
                  snap={s}
                  onRestore={(mode) => {
                    setPath("");
                    setTarget({ snap: s, mode });
                  }}
                />
              ))}
            </ul>
            {g.items.length > limit && (
              <button type="button" className={cn("w-full px-3 py-1.5 text-left text-xs font-medium text-accent hover:underline")} onClick={() => setLimits((l) => ({ ...l, [g.kind]: limit + PAGE }))}>
                {g.items.length - limit} more…
              </button>
            )}
          </section>
        );
      })}

      <Modal
        open={target !== null}
        onOpenChange={(o) => !o && close()}
        width="md"
        title={target?.mode === "all" ? t("history.confirm.title.all", { project: name }) : t("history.restoreFile.title")}
        description={when}
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              {t("app.cancel")}
            </Button>
            <Button variant="danger" loading={busy} disabled={target?.mode === "file" && !filePathValid} onClick={() => void restore()} data-testid="restore-confirm">
              {target?.mode === "all" ? t("history.confirm.all.button") : t("history.restoreFile.confirm")}
            </Button>
          </>
        }
      >
        {target?.mode === "file" && (
          <div className="space-y-1.5 pb-1">
            <label htmlFor="restore-path" className="block text-xs font-medium text-muted">
              {t("history.restoreFile.path", { project: name })}
            </label>
            <input {...NO_AUTOFILL}
              id="restore-path"
              autoFocus
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={t("history.restoreFile.placeholder")}
              spellCheck={false}
              aria-invalid={path.length > 0 && !filePathValid}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filePathValid && !busy) void restore();
              }}
              className="h-9 w-full rounded-lg border border-line bg-bg px-3 font-mono text-[13px] outline-none focus:border-accent"
            />
            {path.length > 0 && !filePathValid && <p className="text-xs text-danger">{t("history.restoreFile.invalid")}</p>}
          </div>
        )}
      </Modal>
    </div>
  );
}
