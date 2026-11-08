import type { FileEntry } from "@agent-workstation/protocol";
import { File, Folder } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "../../lib/cn";
import type { SlashMatch } from "../../lib/slash";
import { t } from "../../i18n";

function Highlighted({ text, indexes }: { text: string; indexes: number[] }) {
  if (indexes.length === 0) return <>{text}</>;
  const set = new Set(indexes);
  return (
    <>
      {Array.from(text).map((ch, i) =>
        set.has(i) ? (
          <span key={i} className="text-accent">
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

function PopupShell({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div role="listbox" aria-label={label} className="anim-pop absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-[var(--shadow-pop)]">
      {children}
    </div>
  );
}

function useScrollActive(active: number) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return ref;
}

export function SlashPalette({ matches, active, loading, onPick, onHover }: { matches: SlashMatch[]; active: number; loading: boolean; onPick: (m: SlashMatch) => void; onHover: (i: number) => void }) {
  const ref = useScrollActive(active);
  return (
    <div ref={ref} className="contents">
      <PopupShell label="Slash commands">
        {matches.length === 0 && <div className="px-3 py-3 text-[13px] text-muted">{loading ? t("composer.slash.loading") : t("composer.slash.empty")}</div>}
        {matches.map((m, i) => (
          <button
            key={m.command.name}
            type="button"
            role="option"
            aria-selected={i === active}
            data-idx={i}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(m)}
            onMouseMove={() => onHover(i)}
            className={cn("flex w-full items-baseline gap-2.5 rounded-lg px-2.5 py-1.5 text-left", i === active && "bg-hover")}
          >
            <span className="shrink-0 font-mono text-[13px] font-medium">
              /<Highlighted text={m.command.name.replace(/^\//, "")} indexes={m.nameIndexes} />
            </span>
            {m.command.argumentHint && <span className="shrink-0 font-mono text-xs text-subtle">{m.command.argumentHint}</span>}
            <span className="min-w-0 flex-1 truncate text-xs text-muted">{m.command.description}</span>
            {m.command.isSkill && <span className="shrink-0 rounded bg-accent-soft px-1.5 text-[10.5px] font-medium text-accent">{t("composer.slash.skill")}</span>}
          </button>
        ))}
      </PopupShell>
    </div>
  );
}

export function MentionPalette({ entries, active, loading, onPick, onHover }: { entries: Array<{ entry: FileEntry; indexes: number[] }>; active: number; loading: boolean; onPick: (e: FileEntry) => void; onHover: (i: number) => void }) {
  const ref = useScrollActive(active);
  return (
    <div ref={ref} className="contents">
      <PopupShell label="Files">
        {entries.length === 0 && <div className="px-3 py-3 text-[13px] text-muted">{loading ? t("composer.mention.loading") : t("composer.mention.empty")}</div>}
        {entries.map(({ entry, indexes }, i) => {
          const Icon = entry.kind === "dir" ? Folder : File;
          return (
            <button
              key={entry.path}
              type="button"
              role="option"
              aria-label={entry.path + (entry.kind === "dir" ? "/" : "")}
              aria-selected={i === active}
              data-idx={i}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(entry)}
              onMouseMove={() => onHover(i)}
              className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]", i === active && "bg-hover")}
            >
              <Icon className={cn("size-4 shrink-0", entry.kind === "dir" ? "text-accent" : "text-muted")} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                <Highlighted text={entry.path + (entry.kind === "dir" ? "/" : "")} indexes={indexes} />
              </span>
            </button>
          );
        })}
      </PopupShell>
    </div>
  );
}
