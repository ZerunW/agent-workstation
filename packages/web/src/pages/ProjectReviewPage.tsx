import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { ProjectHistory } from "../components/changes/ProjectHistory";
import { ProjectReview } from "../components/changes/ProjectReview";
import { PageShell } from "../components/shell/PageShell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/overlays";
import { EmptyState } from "../components/ui/primitives";
import { t } from "../i18n";
import { useProjects } from "../store/projects";

/** `/projects/:id` — review and history of one project outside any session (Projects page, disk modal, sidebar badge). */
export default function ProjectReviewPage() {
  const { id = "" } = useParams();
  const project = useProjects((s) => s.list.find((p) => p.id === id));
  const status = useProjects((s) => s.status);
  const load = useProjects((s) => s.load);
  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);
  const name = project?.name;

  return (
    <PageShell title={name ? `${t("projects.title")} / ${name}` : t("projects.title")} maxWidth="max-w-4xl">
      {!project && (status === "ready" || status === "unavailable") ? (
        <EmptyState title={t("changes.projectUnknown.title")} />
      ) : (
        <Tabs defaultValue="changes" className="overflow-hidden rounded-xl border border-line bg-surface">
          <TabsList className="border-b border-line px-2 py-1.5">
            <TabsTrigger value="changes">{t("changes.tabs.changes")}</TabsTrigger>
            <TabsTrigger value="history">{t("changes.tabs.history")}</TabsTrigger>
          </TabsList>
          <TabsContent value="changes" className="h-[min(70vh,720px)]">
            <ProjectReview projectId={id} projectName={name} />
          </TabsContent>
          <TabsContent value="history" className="h-[min(70vh,720px)]">
            <ProjectHistory projectId={id} projectName={name} />
          </TabsContent>
        </Tabs>
      )}
    </PageShell>
  );
}
