import { MAX_USER_INSTRUCTIONS } from "@agent-workstation/protocol";
import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { relativeTime } from "../lib/format";
import { NO_AUTOFILL } from "../lib/noAutofill";
import { t } from "../i18n";
import { useApp } from "../store/app";
import { useHeadsUp } from "../store/headsUp";
import { toast } from "../store/toasts";
import { PageShell } from "../components/shell/PageShell";
import { Button, IconButton } from "../components/ui/primitives";

const MIN_ROWS = 12;

/** Heads-ups marked "Knew this already": the agent does not repeat them. Hidden when there are none. */
function KnownHeadsUps() {
  const known = useHeadsUp((s) => s.known);
  useEffect(() => {
    void useHeadsUp.getState().load(true);
  }, []);
  if (known.length === 0) return null;
  const remove = async (id: string) => {
    try {
      await useHeadsUp.getState().remove(id);
    } catch (e) {
      toast.error(t("instructions.known.failed", { error: e instanceof Error ? e.message : String(e) }));
    }
  };
  return (
    <section className="mt-8" aria-labelledby="known-heads-ups-h" data-testid="known-heads-ups">
      <h2 id="known-heads-ups-h" className="mb-1.5 text-[13px] font-semibold">
        {t("instructions.known")}
      </h2>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {known.map((k) => (
          <li key={k.id} className="flex items-center gap-3 px-3 py-1.5 text-[13px]" data-testid="known-heads-up">
            <span className="min-w-0 flex-1 truncate" title={k.text}>
              {k.text}
            </span>
            <time dateTime={k.at} className="shrink-0 text-[12px] text-subtle">
              {relativeTime(k.at)}
            </time>
            <IconButton label={t("instructions.known.remove", { text: k.text })} size="xs" onClick={() => void remove(k.id)} data-testid="known-heads-up-remove">
              <X className="size-3.5" />
            </IconButton>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The user's own instructions for every agent: one free-text field. */
export default function InstructionsPage() {
  const me = useApp((s) => s.me);
  const saved = me?.user.instructions ?? "";
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const lastSaved = useRef(saved);

  // `me` arrives after a reload, or another tab saved: follow the stored text unless there are unsaved edits
  useEffect(() => {
    setText((cur) => (cur.trimEnd() === lastSaved.current ? saved : cur));
    lastSaved.current = saved;
  }, [saved]);

  useLayoutEffect(() => {
    const ta = area.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [text]);

  const over = text.trimEnd().length > MAX_USER_INSTRUCTIONS;
  const canSave = !!me && !busy && !over && text.trimEnd() !== saved;

  const save = async () => {
    if (!canSave || !me) return;
    setBusy(true);
    try {
      const user = await api.patchPreferences({ instructions: text.trimEnd() });
      useApp.getState().setMe({ ...(useApp.getState().me ?? me), user });
      setText(user.instructions ?? text.trimEnd());
      toast.success(t("instructions.saved"));
    } catch (e) {
      toast.error(t("instructions.failed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell title={t("instructions.title")} maxWidth="max-w-3xl">
      <textarea {...NO_AUTOFILL}
        ref={area}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
        rows={MIN_ROWS}
        aria-label={t("instructions.title")}
        className="block w-full resize-none overflow-hidden rounded-lg border border-line bg-bg px-3 py-2 text-[14px] leading-relaxed outline-none focus:border-accent"
        data-testid="instructions-input"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className={cn("text-[12px] tabular-nums", over ? "text-danger" : "text-subtle")} data-testid="instructions-count" data-over={over}>
          {text.trimEnd().length.toLocaleString("en-US")} / {MAX_USER_INSTRUCTIONS.toLocaleString("en-US")}
        </span>
        <Button variant="primary" loading={busy} disabled={!canSave} onClick={() => void save()} data-testid="instructions-save">
          {t("app.save")}
        </Button>
      </div>
      <KnownHeadsUps />
    </PageShell>
  );
}
