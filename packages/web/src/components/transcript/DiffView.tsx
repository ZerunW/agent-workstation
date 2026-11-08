import { useMemo, useState } from "react";
import { buildDiff } from "../../lib/lineDiff";
import { cn } from "../../lib/cn";
import type { EditSpec } from "../../lib/toolSummary";
import { t } from "../../i18n";

/** Inline unified diff for Edit / MultiEdit / Write tool inputs (no external dependency on file state). */
export function DiffView({ spec, maxRows = 60, className }: { spec: EditSpec; maxRows?: number; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const { hunks, additions, deletions } = useMemo(() => {
    const all = spec.edits.map((e) => buildDiff(e.oldText, e.newText));
    return {
      hunks: all.flatMap((d, i) => d.hunks.map((h) => ({ ...h, editIndex: i }))),
      additions: all.reduce((n, d) => n + d.stats.additions, 0),
      deletions: all.reduce((n, d) => n + d.stats.deletions, 0),
    };
  }, [spec]);

  const total = hunks.reduce((n, h) => n + h.rows.length, 0);
  let budget = expanded ? Infinity : maxRows;

  return (
    <div className={cn("overflow-hidden rounded-md border border-line bg-code font-mono text-[12.5px] leading-[1.55]", className)} data-testid="diff-view">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 font-sans text-xs">
        <span className="min-w-0 flex-1 truncate text-muted">{spec.path}</span>
        {spec.isWrite && <span className="rounded bg-active px-1.5 text-[10.5px] text-muted">{t("tx.tool.newFile")}</span>}
        <span className="text-ok">+{additions}</span>
        <span className="text-danger">−{deletions}</span>
      </div>
      <div className="overflow-x-auto">
        {hunks.length === 0 && <div className="px-3 py-2 font-sans text-muted">No changes</div>}
        {hunks.map((h, hi) => {
          if (budget <= 0) return null;
          const rows = h.rows.slice(0, Math.max(0, budget));
          budget -= rows.length;
          return (
            <div key={hi} className="min-w-max">
              {(hi > 0 || spec.edits.length > 1) && <div className="bg-sunken px-3 py-0.5 text-[11px] text-subtle">{h.header}</div>}
              {rows.map((r, ri) => (
                <div key={ri} className={cn("flex whitespace-pre", r.kind === "add" && "bg-[var(--diff-add)]", r.kind === "del" && "bg-[var(--diff-del)]")}>
                  <span className="w-9 shrink-0 select-none pr-1 text-right text-subtle">{r.oldNo ?? ""}</span>
                  <span className="w-9 shrink-0 select-none pr-1 text-right text-subtle">{r.newNo ?? ""}</span>
                  <span className={cn("w-4 shrink-0 select-none text-center", r.kind === "add" ? "text-ok" : r.kind === "del" ? "text-danger" : "text-subtle")}>{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
                  <span className="pr-3">{r.text || " "}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {!expanded && total > maxRows && (
        <button type="button" onClick={() => setExpanded(true)} className="w-full border-t border-line px-3 py-1 text-left font-sans text-xs text-accent hover:bg-hover">
          {t("tx.diff.more", { n: total - maxRows })}
        </button>
      )}
    </div>
  );
}
