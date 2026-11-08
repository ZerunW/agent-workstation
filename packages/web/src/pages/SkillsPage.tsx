import type { Skill } from "@agent-workstation/protocol";
import { FileUp, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, isUnavailable, type SkillScope } from "../lib/api";
import { invalidateCommands } from "../lib/commands";
import { relativeTime } from "../lib/format";
import { findSkillMd, readZip } from "../lib/zip";
import { skillNameForUpload, skillTemplate, validSkillName } from "../lib/skills";
import { useFetch } from "../hooks/useFetch";
import { t } from "../i18n";
import { useApp } from "../store/app";
import { toast } from "../store/toasts";
import { PageShell } from "../components/shell/PageShell";
import { Badge, Button, EmptyState, Skeleton } from "../components/ui/primitives";
import { ConfirmDialog, Modal } from "../components/ui/overlays";

/** Content of an uploaded `.md` or the SKILL.md inside a `.zip`. Throws a user-facing message. */
export async function readSkillUpload(file: File): Promise<{ content: string; extraIgnored: number }> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return { content: await file.text(), extraIgnored: 0 };
  if (lower.endsWith(".zip")) {
    const entries = readZip(await file.arrayBuffer());
    const { skill, others } = findSkillMd(entries);
    if (!skill) throw new Error(t("skills.upload.noSkillMd"));
    return { content: new TextDecoder("utf-8").decode(await skill.data()), extraIgnored: others };
  }
  throw new Error(t("skills.upload.unsupported"));
}

function SkillRow({ skill, canEdit, onDelete }: { skill: Skill; canEdit: boolean; onDelete: () => void }) {
  return (
    <li className="group flex items-start gap-3 border-b border-line/70 px-4 py-3 last:border-0" data-testid="skill-row" data-name={skill.name} data-scope={skill.scope}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link to={`/skills/${skill.scope}/${encodeURIComponent(skill.name)}`} className="font-mono text-[13.5px] font-medium hover:text-accent hover:underline">
            /{skill.name}
          </Link>
          {skill.scope === "global" && <Badge tone="info">global</Badge>}
        </div>
        <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-muted">{skill.description || "—"}</p>
        <p className="mt-0.5 text-[11.5px] text-subtle">{t("skills.updated", { when: relativeTime(skill.updatedAt) || "—" })}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Link to={`/skills/${skill.scope}/${encodeURIComponent(skill.name)}`} className="inline-flex h-6 items-center gap-1 rounded-md bg-active px-2 text-xs font-medium hover:bg-strong">
          <Pencil className="size-3" />
          {canEdit ? t("skills.edit") : t("skills.view")}
        </Link>
        {canEdit && (
          <Button size="xs" variant="ghost" icon={<Trash2 className="size-3 text-danger" />} onClick={onDelete} className="text-danger hover:text-danger" aria-label={`${t("skills.delete")} ${skill.name}`}>
            {t("skills.delete")}
          </Button>
        )}
      </div>
    </li>
  );
}

export default function SkillsPage() {
  const navigate = useNavigate();
  const isAdmin = useApp((s) => !!s.me?.user.isAdmin);
  const skills = useFetch(() => api.skills(), []);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<SkillScope>("user");
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Skill | null>(null);
  const uploadFor = useRef<SkillScope>("user");
  const fileInput = useRef<HTMLInputElement>(null);

  const list = useMemo(() => skills.data ?? [], [skills.data]);
  const userSkills = useMemo(() => list.filter((s) => s.scope === "user").sort((a, b) => a.name.localeCompare(b.name)), [list]);
  const globalSkills = useMemo(() => list.filter((s) => s.scope === "global").sort((a, b) => a.name.localeCompare(b.name)), [list]);
  const unavailable = !!skills.error && isUnavailable(skills.error);

  const nameValid = validSkillName(newName);
  const nameTaken = list.some((s) => s.name === newName && s.scope === newScope);

  const create = async () => {
    if (!nameValid || nameTaken) return;
    setBusy(true);
    setCreateError(null);
    try {
      await api.createSkill({ name: newName, content: skillTemplate(newName), scope: newScope });
      invalidateCommands();
      setCreating(false);
      navigate(`/skills/${newScope}/${encodeURIComponent(newName)}`);
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 409 ? t("skills.name.exists", { name: newName }) : t("skills.create.failed", { error: e instanceof Error ? e.message : String(e) });
      setCreateError(msg);
    } finally {
      setBusy(false);
    }
  };

  const upload = useCallback(
    async (files: File[], scope: SkillScope) => {
      let imported = 0;
      for (const file of files) {
        try {
          const { content, extraIgnored } = await readSkillUpload(file);
          const name = skillNameForUpload(content, file.name);
          if (!name) throw new Error(t("skills.upload.noName"));
          await api.createSkill({ name, content, scope });
          imported++;
          toast.success(t("skills.upload.imported", { name }));
          if (extraIgnored > 0) toast.info(t("skills.upload.extraIgnored", { n: extraIgnored }));
        } catch (e) {
          const msg = e instanceof ApiError && e.status === 409 ? t("skills.name.exists", { name: file.name }) : e instanceof Error ? e.message : String(e);
          toast.error(t("skills.upload.failed", { file: file.name, error: msg }));
        }
      }
      if (imported) {
        invalidateCommands();
        skills.reload();
      }
    },
    [skills],
  );

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await api.deleteSkill(deleting.name, deleting.scope);
      invalidateCommands();
      toast.success(t("skills.delete.done", { name: deleting.name }));
      skills.reload();
    } catch (e) {
      toast.error(t("skills.delete.failed", { error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const section = (scope: SkillScope, items: Skill[]) => {
    const editable = scope === "user" || isAdmin;
    return (
      <section className="mb-8" data-testid={`skills-${scope}`}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-semibold">{t(scope === "user" ? "skills.section.user" : "skills.section.global")}</h2>
          <span className="text-xs tabular-nums text-subtle">{items.length}</span>
          {editable && (
            <span className="ml-auto flex gap-1.5">
              <Button
                size="sm"
                variant="outline"
                icon={<FileUp className="size-3.5" />}
                onClick={() => {
                  uploadFor.current = scope;
                  fileInput.current?.click();
                }}
                data-testid={`skills-upload-${scope}`}
              >
                {t("skills.upload")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<Plus className="size-3.5" />}
                onClick={() => {
                  setNewName("");
                  setNewScope(scope);
                  setCreateError(null);
                  setCreating(true);
                }}
                data-testid={`skills-new-${scope}`}
              >
                {t("skills.new")}
              </Button>
            </span>
          )}
        </div>
        {items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">{t(scope === "user" ? "skills.empty.user" : "skills.empty.global")}</p>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-line bg-surface">
            {items.map((s) => (
              <SkillRow key={`${s.scope}:${s.name}`} skill={s} canEdit={editable} onDelete={() => setDeleting(s)} />
            ))}
          </ul>
        )}
      </section>
    );
  };

  return (
    <PageShell title={t("skills.title")} maxWidth="max-w-3xl">
      <input
        ref={fileInput}
        type="file"
        accept=".zip,.md,.markdown"
        multiple
        hidden
        data-testid="skills-upload-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void upload(files, uploadFor.current);
        }}
      />
      {skills.loading && !skills.data && !skills.error ? (
        <div className="space-y-2" aria-busy>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : unavailable ? (
        <EmptyState icon={<Sparkles className="size-6" />} title={t("review.unavailable.title")} />
      ) : skills.error && !skills.data ? (
        <EmptyState icon={<Sparkles className="size-6" />} title={t("skills.loadFailed")} action={<Button onClick={skills.reload}>{t("app.retry")}</Button>}>
          {skills.error.message}
        </EmptyState>
      ) : (
        <>
          {section("user", userSkills)}
          {(globalSkills.length > 0 || isAdmin) && section("global", globalSkills)}
        </>
      )}

      <Modal
        open={creating}
        onOpenChange={(o) => !busy && setCreating(o)}
        title={t("skills.new.title")}
        width="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>
              {t("app.cancel")}
            </Button>
            <Button variant="primary" loading={busy} disabled={!nameValid || nameTaken} onClick={() => void create()} data-testid="skills-create">
              {t("skills.new.create")}
            </Button>
          </>
        }
      >
        <form
          className="space-y-2 pb-1"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label htmlFor="skill-name" className="block text-xs font-medium text-muted">
            {t("skills.new.name")}
          </label>
          <input
            id="skill-name"
            autoFocus
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              setCreateError(null);
            }}
            maxLength={64}
            spellCheck={false}
            autoComplete="off"
            placeholder="my-skill"
            aria-invalid={newName.length > 0 && (!nameValid || nameTaken)}
            className="h-9 w-full rounded-lg border border-line bg-bg px-3 font-mono text-[13px] outline-none focus:border-accent"
          />
          {newName.length > 0 && !nameValid && <p className="text-xs text-danger">{t("skills.name.invalid")}</p>}
          {nameTaken && <p className="text-xs text-danger">{t("skills.name.exists", { name: newName })}</p>}
          {isAdmin && (
            <div className="pt-1">
              <label htmlFor="skill-scope" className="mb-1 block text-xs font-medium text-muted">
                {t("skills.new.scope")}
              </label>
              <select id="skill-scope" value={newScope} onChange={(e) => setNewScope(e.target.value as SkillScope)} className="h-9 w-full rounded-lg border border-line bg-bg px-2 text-[13px]">
                <option value="user">{t("skills.new.scope.user")}</option>
                <option value="global">{t("skills.new.scope.global")}</option>
              </select>
            </div>
          )}
          {createError && (
            <p role="alert" className="text-xs text-danger">
              {createError}
            </p>
          )}
        </form>
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        danger
        title={t("skills.delete.title", { name: deleting?.name ?? "" })}
        confirmLabel={t("skills.delete")}
        cancelLabel={t("app.cancel")}
        onConfirm={confirmDelete}
      />
    </PageShell>
  );
}
