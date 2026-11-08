import { Check, ChevronDown, ChevronUp, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { t } from "../../i18n";
import { Button, IconButton } from "../ui/primitives";

export interface DiffHeaderProps {
  path?: string;
  additions: number;
  deletions: number;
  /** Number of changed regions (hunks/chunks). */
  changes?: number;
  /** Clicking the path asks the host to open the file. */
  onOpenFile?: (path: string) => void;
  onAcceptAll?: () => void;
  onRejectAll?: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  busy?: boolean;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}

export function DiffHeader({ path, additions, deletions, changes, onOpenFile, onAcceptAll, onRejectAll, onNext, onPrev, busy, disabled, className, children }: DiffHeaderProps) {
  return (
    <div className={cn("flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-bg px-3 py-1.5", className)} data-testid="diff-header">
      {path &&
        (onOpenFile ? (
          <button type="button" onClick={() => onOpenFile(path)} title={t("diff.openFile", { path })} className="min-w-0 max-w-full truncate rounded px-1 font-mono text-[12.5px] font-medium text-fg hover:bg-hover hover:text-accent">
            {path}
          </button>
        ) : (
          <span className="min-w-0 max-w-full truncate px-1 font-mono text-[12.5px] font-medium">{path}</span>
        ))}
      <span className="flex items-center gap-2 font-mono text-xs tabular-nums" aria-label={`+${additions} −${deletions}`}>
        <span className="text-ok">+{additions}</span>
        <span className="text-danger">−{deletions}</span>
      </span>
      {changes != null && changes > 0 && <span className="text-xs text-muted">{changes === 1 ? t("diff.change") : t("diff.changes", { n: changes })}</span>}
      <div className="ml-auto flex items-center gap-1">
        {children}
        {onPrev && (
          <IconButton label={t("diff.prev")} size="xs" onClick={onPrev}>
            <ChevronUp className="size-3.5" />
          </IconButton>
        )}
        {onNext && (
          <IconButton label={t("diff.next")} size="xs" onClick={onNext}>
            <ChevronDown className="size-3.5" />
          </IconButton>
        )}
        {onRejectAll && (
          <Button size="xs" variant="outline" icon={<X className="size-3 text-danger" />} onClick={onRejectAll} disabled={disabled} loading={busy}>
            {t("diff.rejectFile")}
          </Button>
        )}
        {onAcceptAll && (
          <Button size="xs" variant="primary" icon={<Check className="size-3" />} onClick={onAcceptAll} disabled={disabled} loading={busy}>
            {t("diff.acceptFile")}
          </Button>
        )}
      </div>
    </div>
  );
}
