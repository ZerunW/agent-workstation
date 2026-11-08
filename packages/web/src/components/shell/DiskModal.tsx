import { Link, useNavigate } from "react-router-dom";
import { formatBytes } from "../../lib/format";
import { t } from "../../i18n";
import { useApp } from "../../store/app";
import { Button } from "../ui/primitives";
import { Modal } from "../ui/overlays";

/**
 * Shown once per page load at >= warn level (and again from the banner's "Review" action).
 * Lists where the space went and what is still unaccepted/undownloaded. Never offers automatic cleanup:
 * it only links to the Files tab where the user deletes things themselves.
 */
export function DiskModal() {
  const disk = useApp((s) => s.disk);
  const dismissed = useApp((s) => s.diskModalDismissed);
  const dismiss = useApp((s) => s.dismissDiskModal);
  const setRight = useApp((s) => s.setRight);
  const setMode = useApp((s) => s.setMode);
  const navigate = useNavigate();
  const open = !!disk && disk.level !== "ok" && !dismissed;
  if (!disk) return null;
  const rows = [...disk.breakdown].sort((a, b) => b.bytes - a.bytes);
  const max = Math.max(1, ...rows.map((r) => r.bytes));
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && dismiss()}
      title={t("disk.modal.title")}
      description={t("disk.modal.body", { used: Math.round(disk.usedPercent), warn: disk.warnPercent, block: disk.blockPercent })}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={dismiss}>
            {t("disk.modal.dismiss")}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              dismiss();
              navigate("/projects");
            }}
            data-testid="disk-open-projects"
          >
            {t("disk.modal.openProjects")}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              dismiss();
              setMode("code");
              setRight(true, "files");
              navigate("/");
            }}
          >
            {t("disk.modal.openFiles")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">{t("disk.modal.breakdown")}</h3>
          <ul className="space-y-1.5">
            {rows.map((r, i) => (
              <li key={`${r.path}-${i}`} className="text-[13px]">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {r.label}
                    {r.user ? <span className="text-subtle"> · {r.user}</span> : null}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted">{formatBytes(r.bytes)}</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-active">
                  <div className="h-full rounded-full bg-accent/70" style={{ width: `${(r.bytes / max) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">{t("disk.modal.projects")}</h3>
          {disk.projects.length === 0 ? (
            <p className="text-[13px] text-muted">{t("disk.modal.noProjects")}</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line" data-testid="disk-projects">
              {disk.projects.map((p) => (
                <li key={p.id} data-name={p.name} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                  <span className={p.pendingFiles ? "text-warn" : "text-subtle"}>{t("disk.modal.pending", { n: p.pendingFiles })}</span>
                  <span className={p.undownloadedFiles ? "text-warn" : "text-subtle"}>{t("disk.modal.undownloaded", { n: p.undownloadedFiles })}</span>
                  <span className="tabular-nums text-muted">{formatBytes(p.bytes)}</span>
                  <Link to={`/projects/${p.id}`} onClick={dismiss} className="text-xs font-medium text-accent hover:underline" data-testid="disk-project-review">
                    {t("disk.modal.review")}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
