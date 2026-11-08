import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type ProjectInfo } from "../../lib/api";
import { t } from "../../i18n";
import { useApp } from "../../store/app";
import { useProjects } from "../../store/projects";
import { toast } from "../../store/toasts";
import { Banner, Button } from "../ui/primitives";
import { Modal } from "../ui/overlays";
import { canConfirmDelete, hasRemaining } from "./deleteState";
import { NO_AUTOFILL } from "../../lib/noAutofill";

type Counts = { pending: number; undownloaded: number };

/**
 * Two-step project delete. Step 1 re-reads the pending/undownloaded counts from the hub and refuses to go on
 * silently when anything exists only on the server (the user can review first, or explicitly continue to discard).
 * Step 2 asks for the project name and, when counts are non-zero, the "discard remaining changes" box that
 * becomes `discardRemaining: true`.
 */
export function DeleteProjectDialog({ project, onClose }: { project: ProjectInfo | null; onClose: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notEmpty, setNotEmpty] = useState(false);
  const setDisk = useApp((s) => s.setDisk);

  const check = useCallback(async (p: ProjectInfo) => {
    setCounts(null);
    setCheckError(null);
    try {
      // The project row has the live pending count; the disk status carries the undownloaded count per project.
      const [fresh, disk] = await Promise.all([api.project(p.id), api.disk()]);
      setDisk(disk);
      const row = disk.projects.find((x) => x.id === p.id);
      setCounts({ pending: row ? Math.max(fresh.pendingFiles, row.pendingFiles) : fresh.pendingFiles, undownloaded: row?.undownloadedFiles ?? 0 });
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : String(e));
    }
  }, [setDisk]);

  useEffect(() => {
    if (!project) return;
    setStep(1);
    setTyped("");
    setDiscard(false);
    setNotEmpty(false);
    void check(project);
  }, [project, check]);

  if (!project) return null;
  const remaining = counts ? hasRemaining(counts.pending, counts.undownloaded) : false;

  const remove = async () => {
    if (!counts) return;
    setBusy(true);
    try {
      await api.deleteProject(project.id, remaining && discard);
      useProjects.getState().remove(project.id);
      toast.success(t("projects.delete.done", { name: project.name }));
      api.disk().then(setDisk, () => {});
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === "project_not_empty") {
        setNotEmpty(true);
        setStep(1);
        void check(project);
      } else toast.error(t("projects.delete.failed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const countsText = counts ? t("projects.delete.counts", counts) : null;

  return (
    <Modal
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={t("projects.delete.title", { name: project.name })}
      width="md"
      footer={
        step === 1 ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("app.cancel")}
            </Button>
            {remaining ? (
              <>
                <Button variant="outline" className="text-danger" onClick={() => setStep(2)} data-testid="delete-discard-anyway">
                  {t("projects.delete.discardAnyway")}
                </Button>
                <Link to={`/projects/${project.id}`} onClick={onClose} className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg hover:bg-accent-hover">
                  {t("projects.delete.reviewFirst")}
                </Link>
              </>
            ) : (
              <Button variant="danger" disabled={!counts} onClick={() => setStep(2)} data-testid="delete-continue">
                {t("projects.delete.continue")}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStep(1)} disabled={busy}>
              {t("app.back")}
            </Button>
            <Button variant="danger" loading={busy} disabled={!counts || !canConfirmDelete({ projectName: project.name, typed, pending: counts.pending, undownloaded: counts.undownloaded, discard })} onClick={() => void remove()} data-testid="delete-confirm">
              {t("projects.delete.confirm")}
            </Button>
          </>
        )
      }
    >
      {step === 1 ? (
        <div className="space-y-3 pb-1" data-testid="delete-step-1">
          {notEmpty && <Banner tone="warn" role="alert" className="rounded-lg border">{t("projects.delete.notEmpty")}</Banner>}
          {checkError ? (
            <div role="alert" className="space-y-2 text-[13px] text-danger">
              <p>{t("projects.delete.checkFailed", { error: checkError })}</p>
              <Button size="xs" onClick={() => void check(project)}>
                {t("app.retry")}
              </Button>
            </div>
          ) : !counts ? (
            <p className="text-[13px] text-muted">{t("projects.delete.checking")}</p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-2 text-[13px]">
                <div className="rounded-lg border border-line px-3 py-2">
                  <dt className="text-xs text-muted">{t("projects.col.pending")}</dt>
                  <dd className={counts.pending ? "text-lg font-semibold text-warn" : "text-lg font-semibold"} data-testid="count-pending">
                    {counts.pending}
                  </dd>
                </div>
                <div className="rounded-lg border border-line px-3 py-2">
                  <dt className="text-xs text-muted">{t("projects.col.undownloaded")}</dt>
                  <dd className={counts.undownloaded ? "text-lg font-semibold text-warn" : "text-lg font-semibold"} data-testid="count-undownloaded">
                    {counts.undownloaded}
                  </dd>
                </div>
              </dl>
            </>
          )}
        </div>
      ) : (
        <form
          className="space-y-3 pb-1"
          data-testid="delete-step-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (counts && canConfirmDelete({ projectName: project.name, typed, pending: counts.pending, undownloaded: counts.undownloaded, discard }) && !busy) void remove();
          }}
        >
          {remaining && countsText && <p className="text-[13px] text-warn">{countsText}</p>}
          <label className="block text-xs font-medium text-muted" htmlFor="delete-project-name">
            {t("projects.delete.typeName")}
          </label>
          <input {...NO_AUTOFILL}
            id="delete-project-name"
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={project.name}
            spellCheck={false}
            className="h-9 w-full rounded-lg border border-line bg-bg px-3 font-mono text-[13px] outline-none focus:border-danger"
          />
          {remaining && counts && (
            <label className="flex cursor-pointer items-start gap-2 text-[13px]">
              <input type="checkbox" checked={discard} onChange={(e) => setDiscard(e.target.checked)} className="mt-0.5" />
              <span>{t("projects.delete.discard", counts)}</span>
            </label>
          )}
        </form>
      )}
    </Modal>
  );
}
