import { ArrowLeft, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, isUnavailable, type SkillScope } from "../lib/api";
import { invalidateCommands } from "../lib/commands";
import { useFetch } from "../hooks/useFetch";
import { t } from "../i18n";
import { useApp } from "../store/app";
import { toast } from "../store/toasts";
import { MarkdownEditor } from "../components/skills/MarkdownEditor";
import { PageShell } from "../components/shell/PageShell";
import { Badge, Banner, Button, EmptyState, Skeleton } from "../components/ui/primitives";
import { ConfirmDialog } from "../components/ui/overlays";

/** `/skills/:scope/:name` — edit one SKILL.md in a markdown editor. Global skills are read-only for non-admins. */
export default function SkillEditorPage() {
  const { scope: scopeParam, name = "" } = useParams();
  const scope: SkillScope = scopeParam === "global" ? "global" : "user";
  const navigate = useNavigate();
  const me = useApp((s) => s.me);
  const canEdit = scope === "user" || !!me?.user.isAdmin;
  const skill = useFetch(() => api.skill(name, scope), [name, scope]);
  const text = useRef<string>("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // bumped after a save so `dirty` compares against what was saved
  const saved = useRef<string>("");

  useEffect(() => {
    if (skill.data) {
      text.current = skill.data.content;
      saved.current = skill.data.content;
      setDirty(false);
    }
  }, [skill.data]);

  const save = useCallback(async () => {
    if (!canEdit || saving) return;
    setSaving(true);
    try {
      const body = text.current;
      await api.updateSkill(name, { name, content: body, scope });
      saved.current = body;
      setDirty(text.current !== saved.current);
      invalidateCommands();
      toast.success(t("skills.edit.saved", { name }));
    } catch (e) {
      toast.error(t("skills.edit.saveFailed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSaving(false);
    }
  }, [canEdit, saving, name, scope]);

  // Leaving with unsaved edits asks the browser to confirm (reload/close).
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const remove = async () => {
    try {
      await api.deleteSkill(name, scope);
      invalidateCommands();
      toast.success(t("skills.delete.done", { name }));
      navigate("/skills");
    } catch (e) {
      toast.error(t("skills.delete.failed", { error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const actions = (
    <>
      {dirty && canEdit && <span className="text-xs text-warn" data-testid="skill-dirty">{t("skills.edit.unsaved")}</span>}
      {canEdit && (
        <>
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5 text-danger" />} className="text-danger hover:text-danger" onClick={() => setConfirmDelete(true)}>
            {t("skills.delete")}
          </Button>
          <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} loading={saving} disabled={!dirty} onClick={() => void save()} data-testid="skill-save">
            {t("skills.edit.save")}
          </Button>
        </>
      )}
    </>
  );

  return (
    <PageShell title={`/${name}`} actions={actions} maxWidth="max-w-4xl">
      <div className="mb-3 flex items-center gap-2 text-[13px]">
        <Link to="/skills" className="inline-flex items-center gap-1 text-muted hover:text-fg">
          <ArrowLeft className="size-3.5" />
          {t("skills.edit.back")}
        </Link>
        <span className="font-mono text-xs text-subtle">SKILL.md</span>
        {scope === "global" && <Badge tone="info">global</Badge>}
      </div>
      {skill.error ? (
        <EmptyState title={isUnavailable(skill.error) ? t("review.unavailable.title") : t("skills.edit.loadFailed")} action={<Button onClick={skill.reload}>{t("app.retry")}</Button>}>
          {skill.error.message}
        </EmptyState>
      ) : !skill.data || !me ? (
        <Skeleton className="h-[60vh] w-full" />
      ) : (
        <>
          {!canEdit && (
            <div className="mb-3">
              <Banner tone="info" className="rounded-lg border">
                {t("skills.edit.readonly")}
              </Banner>
            </div>
          )}
          <div className="h-[min(68vh,640px)] overflow-hidden rounded-xl border border-line bg-surface focus-within:border-accent">
            <MarkdownEditor
              key={`${scope}:${name}`}
              initialValue={skill.data.content}
              readOnly={!canEdit}
              ariaLabel={t("skills.edit.editor")}
              className="h-full"
              onChange={(v) => {
                text.current = v;
                setDirty(v !== saved.current);
              }}
              onSave={() => void save()}
            />
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        danger
        title={t("skills.delete.title", { name })}
        confirmLabel={t("skills.delete")}
        cancelLabel={t("app.cancel")}
        onConfirm={remove}
      />
    </PageShell>
  );
}
