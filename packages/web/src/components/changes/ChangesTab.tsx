import { Download, FolderTree, GitCompare, Link2 } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { runDownload } from "../../lib/downloadToasts";
import { t } from "../../i18n";
import { useApp } from "../../store/app";
import { useChanged } from "../../store/changed";
import { Button, EmptyState, Skeleton } from "../ui/primitives";
import { ProjectReview } from "./ProjectReview";
import { useSessionProject } from "./useSessionProject";

/** Paths this session added or modified (deleted ones cannot be downloaded). */
function useSessionFilePaths(sessionId: string | null): string[] {
  const bySession = useChanged((s) => (sessionId ? s.bySession[sessionId] : undefined));
  return useMemo(() => (bySession ? Object.entries(bySession).filter(([, c]) => c.kind === "add" || c.kind === "change").map(([p]) => p).sort() : []), [bySession]);
}

/** Shown for a Code session that works outside every project: offers the session's files instead. */
function NoProject({ sessionId }: { sessionId: string }) {
  const paths = useSessionFilePaths(sessionId);
  const setRight = useApp((s) => s.setRight);
  const setFilesChangedOnly = useApp((s) => s.setFilesChangedOnly);
  return (
    <EmptyState
      icon={<Link2 className="size-6" />}
      title={t("changes.noProject.title")}
      action={
        <div className="flex flex-col items-center gap-2">
          <Button
            variant="primary"
            icon={<Download className="size-3.5" />}
            disabled={paths.length === 0}
            title={paths.length === 0 ? t("changes.downloadSession.none") : t("changes.downloadSession.label", { n: paths.length })}
            onClick={() => void runDownload(paths, t("changes.downloadSession.label", { n: paths.length }))}
            data-testid="download-session-files"
          >
            {t("changes.downloadSession")}
          </Button>
          {paths.length === 0 && <span className="text-xs text-subtle">{t("changes.downloadSession.none")}</span>}
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              icon={<FolderTree className="size-3" />}
              onClick={() => {
                setFilesChangedOnly(true);
                setRight(true, "files");
              }}
            >
              {t("changes.showInFiles")}
            </Button>
            <Link to="/projects" className="inline-flex h-6 items-center rounded-md px-2 text-xs font-medium text-muted hover:bg-hover hover:text-fg">
              {t("changes.noProject.projects")}
            </Link>
          </div>
        </div>
      }
    />
  );
}

/** Right-panel "Changes" tab: the review list of the session's project, or an explanation when there is none. */
export function ChangesTab({ sessionId }: { sessionId: string | null }) {
  const { session, project, projectsStatus } = useSessionProject(sessionId);
  if (!sessionId) return <EmptyState icon={<GitCompare className="size-6" />} title={t("changes.noSession.title")} />;
  if (!session) return <div className="space-y-2 p-3" aria-busy><Skeleton className="h-9" /><Skeleton className="h-9" /></div>;
  if (!project) return <NoProject sessionId={sessionId} />;
  if (!project.id) {
    if (projectsStatus === "idle" || projectsStatus === "loading") return <div className="space-y-2 p-3" aria-busy><Skeleton className="h-9" /><Skeleton className="h-9" /></div>;
    return (
      <EmptyState icon={<GitCompare className="size-6" />} title={t("changes.projectUnknown.title")}>
        {t("changes.projectUnknown.body", { name: project.name })}
      </EmptyState>
    );
  }
  return <ProjectReview projectId={project.id} projectName={project.name} sessionId={sessionId} />;
}
