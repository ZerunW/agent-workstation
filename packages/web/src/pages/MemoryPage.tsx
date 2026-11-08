import type { Memory } from "@agent-workstation/protocol";
import { BookMarked, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, isUnavailable } from "../lib/api";
import { relativeTime, truncate } from "../lib/format";
import { useFetch } from "../hooks/useFetch";
import { t } from "../i18n";
import { useApp } from "../store/app";
import { toast } from "../store/toasts";
import { Switch } from "../components/admin/Switch";
import { PageShell } from "../components/shell/PageShell";
import { Badge, Button, EmptyState, IconButton, Skeleton } from "../components/ui/primitives";
import { ConfirmDialog } from "../components/ui/overlays";
import { NO_AUTOFILL } from "../lib/noAutofill";

const MAX_CHARS = 2000;
const field = "w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-[14px] leading-relaxed outline-none focus:border-accent";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A saved or edited memory replaces its row in place; a new one goes first (the list is newest first). */
function upsert(list: Memory[] | undefined, m: Memory): Memory[] {
  const rows = list ?? [];
  return rows.some((x) => x.id === m.id) ? rows.map((x) => (x.id === m.id ? m : x)) : [m, ...rows];
}

function MemoryRow({ memory, onSaved, onDelete }: { memory: Memory; onSaved: (m: Memory) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.text);
  const [busy, setBusy] = useState(false);
  const next = draft.trim();
  const canSave = next.length > 0 && next !== memory.text && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      onSaved(await api.updateMemory(memory.id, next));
      setEditing(false);
    } catch (e) {
      toast.error(t("memory.update.failed", { error: errorText(e) }));
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    setEditing(false);
    setDraft(memory.text);
  };

  return (
    <li className="flex items-start gap-3 border-b border-line/70 px-4 py-3 last:border-0" data-testid="memory-item" data-id={memory.id} data-source={memory.source}>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="space-y-2">
            <textarea {...NO_AUTOFILL}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") cancel();
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
              }}
              maxLength={MAX_CHARS}
              rows={3}
              aria-label={t("memory.edit")}
              className={field}
              data-testid="memory-edit-input"
            />
            <div className="flex gap-1.5">
              <Button size="sm" variant="primary" loading={busy} disabled={!canSave} onClick={() => void save()} data-testid="memory-save">
                {t("app.save")}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={cancel} data-testid="memory-cancel">
                {t("app.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed" data-testid="memory-text">
            {memory.text}
          </p>
        )}
        <div className={`${editing ? "mt-2" : "mt-1"} flex items-center gap-2 text-[11.5px] text-subtle`}>
          <Badge tone={memory.source === "claude" ? "accent" : "neutral"} data-testid="memory-source">
            {t(memory.source === "claude" ? "memory.source.claude" : "memory.source.user")}
          </Badge>
          <span title={memory.createdAt}>{relativeTime(memory.updatedAt) || "—"}</span>
        </div>
      </div>
      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label={t("memory.edit")} size="xs" onClick={() => (setDraft(memory.text), setEditing(true))} data-testid="memory-edit">
            <Pencil className="size-3.5" />
          </IconButton>
          <IconButton label={t("memory.delete")} size="xs" onClick={onDelete} className="hover:text-danger" data-testid="memory-delete">
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
      )}
    </li>
  );
}

export default function MemoryPage() {
  const me = useApp((s) => s.me);
  const tick = useApp((s) => s.memoriesTick); // memories_changed: another device (or Claude) changed them
  const memories = useFetch(() => api.memories(), [tick]);
  const enabled = me?.user.memoryEnabled !== false;
  const [toggling, setToggling] = useState(false);
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Memory | null>(null);

  const setEnabled = async (next: boolean) => {
    const patchMe = (memoryEnabled: boolean, user?: Partial<NonNullable<typeof me>["user"]>) => {
      const cur = useApp.getState().me;
      if (cur) useApp.getState().setMe({ ...cur, user: { ...cur.user, ...user, memoryEnabled } });
    };
    patchMe(next); // optimistic
    setToggling(true);
    try {
      const user = await api.patchPreferences({ memoryEnabled: next });
      patchMe(user.memoryEnabled ?? next, user);
    } catch (e) {
      patchMe(!next);
      toast.error(t("memory.toggle.failed", { error: errorText(e) }));
    } finally {
      setToggling(false);
    }
  };

  const add = async () => {
    const value = text.trim();
    if (!value || adding) return;
    setAdding(true);
    try {
      const m = await api.createMemory(value);
      memories.setData((prev) => upsert(prev, m));
      setText("");
    } catch (e) {
      toast.error(t("memory.add.failed", { error: errorText(e) }));
    } finally {
      setAdding(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const { id } = deleting;
    try {
      await api.deleteMemory(id);
      memories.setData((prev) => (prev ?? []).filter((m) => m.id !== id));
    } catch (e) {
      toast.error(t("memory.delete.failed", { error: errorText(e) }));
    }
  };

  const list = memories.data ?? [];
  const unavailable = !!memories.error && isUnavailable(memories.error);

  return (
    <PageShell title={t("memory.title")} maxWidth="max-w-3xl">
      <div className="mb-4 flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3">
        <span className="text-[14px] font-medium">{t("memory.toggle")}</span>
        <Switch testId="memory-toggle" checked={enabled} onChange={(v) => void setEnabled(v)} label={t("memory.toggle")} disabled={!me || toggling} />
      </div>

      <form
        className="mb-6"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <textarea {...NO_AUTOFILL}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void add();
            }
          }}
          maxLength={MAX_CHARS}
          rows={2}
          placeholder={t("memory.add.placeholder")}
          aria-label={t("memory.add.placeholder")}
          className={field}
          data-testid="memory-add-input"
        />
        <div className="mt-2 flex justify-end">
          <Button type="submit" variant="primary" loading={adding} disabled={!text.trim()} data-testid="memory-add">
            {t("memory.add")}
          </Button>
        </div>
      </form>

      {memories.loading && !memories.data && !memories.error ? (
        <div className="space-y-2" aria-busy>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : unavailable ? (
        <EmptyState icon={<BookMarked className="size-6" />} title={t("memory.unavailable")} />
      ) : memories.error && !memories.data ? (
        <EmptyState icon={<BookMarked className="size-6" />} title={t("memory.loadFailed")} action={<Button onClick={memories.reload}>{t("app.retry")}</Button>}>
          {memories.error.message}
        </EmptyState>
      ) : list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted" data-testid="memory-empty">
          {t("memory.empty")}
        </p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line bg-surface" data-testid="memory-list">
          {list.map((m) => (
            <MemoryRow key={m.id} memory={m} onSaved={(saved) => memories.setData((prev) => upsert(prev, saved))} onDelete={() => setDeleting(m)} />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        danger
        title={t("memory.delete.title")}
        description={deleting ? truncate(deleting.text, 160) : undefined}
        confirmLabel={t("memory.delete")}
        cancelLabel={t("app.cancel")}
        onConfirm={confirmDelete}
      />
    </PageShell>
  );
}
