import { History } from "lucide-react";
import { Link } from "react-router-dom";
import { t } from "../../i18n";
import { EmptyState, Skeleton } from "../ui/primitives";
import { ProjectHistory } from "./ProjectHistory";
import { useSessionProject } from "./useSessionProject";

/** Right-panel "History" tab: the project's sync/snapshot/accept/trash timeline. */
export function HistoryTab({ sessionId }: { sessionId: string | null }) {
  const { session, project, projectsStatus } = useSessionProject(sessionId);
  if (!sessionId) return <EmptyState icon={<History className="size-6" />} title={t("changes.noSession.title")} />;
  if (!session) return <div className="space-y-2 p-3" aria-busy><Skeleton className="h-9" /><Skeleton className="h-9" /></div>;
  if (!project)
    return (
      <EmptyState
        icon={<History className="size-6" />}
        title={t("changes.noProject.title")}
        action={
          <Link to="/projects" className="inline-flex h-8 items-center rounded-lg bg-active px-3 text-[13px] font-medium hover:bg-strong">
            {t("changes.noProject.projects")}
          </Link>
        }
      />
    );
  if (!project.id) {
    if (projectsStatus === "idle" || projectsStatus === "loading") return <div className="space-y-2 p-3" aria-busy><Skeleton className="h-9" /><Skeleton className="h-9" /></div>;
    return <EmptyState icon={<History className="size-6" />} title={t("changes.projectUnknown.title")}>{t("changes.projectUnknown.body", { name: project.name })}</EmptyState>;
  }
  return <ProjectHistory projectId={project.id} projectName={project.name} />;
}
