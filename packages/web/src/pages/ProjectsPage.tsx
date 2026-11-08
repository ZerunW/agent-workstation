import { Download, FolderGit2, GitCompare, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ProjectInfo } from "../lib/api";
import { runDownload } from "../lib/downloadToasts";
import { formatBytes, relativeTime } from "../lib/format";
import { shortCommit } from "../lib/projects";
import { t } from "../i18n";
import { useApp } from "../store/app";
import { useProjects } from "../store/projects";
import { DeleteProjectDialog } from "../components/projects/DeleteProjectDialog";
import { PageShell } from "../components/shell/PageShell";
import { Button, EmptyState, Skeleton } from "../components/ui/primitives";

const th = "whitespace-nowrap px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-subtle";

function Row({ p, undownloaded, onDelete }: { p: ProjectInfo; undownloaded: number | null; onDelete: () => void }) {
  return (
    <tr className="border-b border-line/70 last:border-0 hover:bg-hover/60" data-testid="project-row" data-name={p.name}>
      <td className="px-3 py-2.5">
        <Link to={`/projects/${p.id}`} className="font-medium hover:text-accent hover:underline">
          {p.name}
        </Link>
        {p.origin && <div className="text-[11.5px] text-subtle">{p.origin}</div>}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted">{formatBytes(p.sizeBytes)}</td>
      <td className={`whitespace-nowrap px-3 py-2.5 tabular-nums ${p.pendingFiles ? "font-medium text-warn" : "text-muted"}`} data-testid="cell-pending">
        {p.pendingFiles}
      </td>
      <td className={`whitespace-nowrap px-3 py-2.5 tabular-nums ${undownloaded ? "font-medium text-warn" : "text-muted"}`} data-testid="cell-undownloaded">
        {undownloaded ?? "—"}
      </td>
      <td className="px-3 py-2.5">
        <code className="font-mono text-xs text-muted" title={p.localCommit ?? undefined}>
          {shortCommit(p.localCommit)}
        </code>
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-muted" title={p.createdAt}>
        {relativeTime(p.createdAt) || "—"}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex justify-end gap-1" role="group" aria-label={t("projects.rowActions", { name: p.name })}>
          <Link to={`/projects/${p.id}`} className="inline-flex h-6 items-center gap-1 rounded-md bg-active px-2 text-xs font-medium hover:bg-strong">
            <GitCompare className="size-3" />
            {t("projects.review")}
          </Link>
          <Button size="xs" variant="secondary" icon={<Download className="size-3" />} onClick={() => void runDownload([p.path], `${p.name}.zip`)}>
            {t("projects.download")}
          </Button>
          <Button size="xs" variant="ghost" icon={<Trash2 className="size-3 text-danger" />} onClick={onDelete} className="text-danger hover:text-danger">
            {t("projects.delete")}
          </Button>
        </div>
      </td>
    </tr>
  );
}

export default function ProjectsPage() {
  const list = useProjects((s) => s.list);
  const status = useProjects((s) => s.status);
  const error = useProjects((s) => s.error);
  const load = useProjects((s) => s.load);
  const disk = useApp((s) => s.disk);
  const [deleting, setDeleting] = useState<ProjectInfo | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const undownloaded = (id: string): number | null => disk?.projects.find((p) => p.id === id)?.undownloadedFiles ?? null;
  const loading = status === "idle" || (status === "loading" && list.length === 0);

  return (
    <PageShell title={t("projects.title")} maxWidth="max-w-5xl">
      {loading ? (
        <div className="space-y-2" aria-busy>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : status === "unavailable" ? (
        <EmptyState icon={<FolderGit2 className="size-6" />} title={t("review.unavailable.title")} />
      ) : status === "error" && list.length === 0 ? (
        <EmptyState icon={<FolderGit2 className="size-6" />} title={t("projects.loadFailed")} action={<Button onClick={() => void load()}>{t("app.retry")}</Button>}>
          {error}
        </EmptyState>
      ) : list.length === 0 ? (
        <EmptyState icon={<FolderGit2 className="size-6" />} title={t("projects.empty.title")} className="py-16" />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[720px] text-[13px]" data-testid="projects-table">
            <thead className="border-b border-line bg-sunken/60">
              <tr>
                <th className={th}>{t("projects.col.name")}</th>
                <th className={th}>{t("projects.col.size")}</th>
                <th className={th}>{t("projects.col.pending")}</th>
                <th className={th}>{t("projects.col.undownloaded")}</th>
                <th className={th}>{t("projects.col.commit")}</th>
                <th className={th}>{t("projects.col.created")}</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <Row key={p.id} p={p} undownloaded={undownloaded(p.id)} onDelete={() => setDeleting(p)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DeleteProjectDialog project={deleting} onClose={() => setDeleting(null)} />
    </PageShell>
  );
}
