import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { t } from "../../i18n";
import { formatLimit, limitToInput, parseTokenLimit } from "./tokenLimit";

/**
 * Inline weekly-limit editor: click to edit, Enter/blur commits, Esc cancels, empty = unlimited.
 * Invalid input keeps the editor open (Enter) or reverts (blur) and never calls `onCommit`.
 */
export function LimitEditor({ value, user, onCommit }: { value: number | null; user: string; onCommit: (next: number | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(limitToInput(value));
  const [invalid, setInvalid] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(limitToInput(value));
  }, [value, editing]);

  const finish = (commit: boolean) => {
    if (!editing) return;
    if (commit) {
      const parsed = parseTokenLimit(draft);
      if (!parsed.ok) {
        setInvalid(true);
        return false;
      }
      if (parsed.value !== value) onCommit(parsed.value);
    }
    setEditing(false);
    setInvalid(false);
    return true;
  };

  if (!editing)
    return (
      <button
        type="button"
        aria-label={t("admin.limit.edit", { user })}
        title={t("admin.limit.edit", { user })}
        onClick={() => {
          cancelled.current = false;
          setDraft(limitToInput(value));
          setEditing(true);
        }}
        className={cn("h-7 rounded-md px-2 text-right text-[13px] tabular-nums hover:bg-hover", value == null && "text-subtle")}
      >
        {formatLimit(value)}
      </button>
    );

  return (
    <div className="relative">
      <input
        autoFocus
        onFocus={(e) => e.target.select()}
        inputMode="numeric"
        value={draft}
        aria-label={t("admin.limit.edit", { user })}
        aria-invalid={invalid}
        placeholder={t("admin.limit.unlimited")}
        onChange={(e) => {
          setDraft(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelled.current = true;
            setEditing(false);
            setInvalid(false);
          }
        }}
        onBlur={() => {
          if (cancelled.current) return;
          const parsed = parseTokenLimit(draft);
          if (parsed.ok) finish(true);
          else {
            setEditing(false);
            setInvalid(false);
          }
        }}
        className={cn("h-7 w-28 rounded-md border bg-surface px-2 text-right text-[13px] tabular-nums outline-none", invalid ? "border-danger" : "border-accent")}
      />
      {invalid && (
        <div role="alert" className="absolute right-0 top-8 z-20 w-56 rounded-lg border border-danger/30 bg-surface p-2 text-left text-xs text-danger shadow-[var(--shadow-pop)]">
          {t("admin.limit.invalid")}
        </div>
      )}
    </div>
  );
}
