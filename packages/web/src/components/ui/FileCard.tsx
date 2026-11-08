import { File as FileIcon, FileArchive, FileCode, FileSpreadsheet, FileText, RotateCcw } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { t } from "../../i18n";

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  pdf: FileText, txt: FileText, md: FileText, rtf: FileText, doc: FileText, docx: FileText, tex: FileText,
  csv: FileSpreadsheet, tsv: FileSpreadsheet, xls: FileSpreadsheet, xlsx: FileSpreadsheet,
  zip: FileArchive, gz: FileArchive, tgz: FileArchive, tar: FileArchive, zst: FileArchive, "7z": FileArchive, rar: FileArchive,
  ts: FileCode, tsx: FileCode, js: FileCode, jsx: FileCode, mjs: FileCode, py: FileCode, swift: FileCode, rs: FileCode, go: FileCode,
  c: FileCode, h: FileCode, cpp: FileCode, java: FileCode, kt: FileCode, rb: FileCode, sh: FileCode, json: FileCode, yaml: FileCode,
  yml: FileCode, toml: FileCode, html: FileCode, css: FileCode, sql: FileCode,
};

/** "PDF" for report.pdf, "" for a name without an extension. */
export function fileExtLabel(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toUpperCase() : "";
}

export interface FileCardProps {
  name: string;
  size?: number;
  /** 0..1 while uploading; the meta line shows the percentage and a bar runs along the bottom edge. */
  progress?: number;
  /** Upload failure: red border, the error replaces the meta line, Retry when `onRetry` is given. */
  error?: string;
  onRetry?: () => void;
  /** Makes the card a button (download in the transcript). */
  onClick?: () => void;
  className?: string;
}

/**
 * The file "chip" used above the composer and inside sent messages: icon tile, file name, type · size.
 * Images have their own thumbnail tiles; this is for everything else.
 */
export function FileCard({ name, size, progress, error, onRetry, onClick, className }: FileCardProps) {
  const ext = fileExtLabel(name);
  const Icon = ICONS[ext.toLowerCase()] ?? FileIcon;
  const uploading = progress !== undefined && !error;
  const meta = error ? (
    <span className="truncate text-danger">{t("composer.attachment.failed")}</span>
  ) : uploading ? (
    <span>{t("composer.attachment.uploading", { percent: Math.round(progress * 100) })}</span>
  ) : (
    <span className="truncate">{[ext, size !== undefined ? formatBytes(size) : ""].filter(Boolean).join(" · ")}</span>
  );
  const body = (
    <>
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", error ? "bg-danger/10 text-danger" : "bg-accent-soft text-accent")}>
        <Icon className="size-[18px]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center text-left">
        <span className="truncate text-[12.5px] font-medium leading-tight">{name}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-tight text-muted">
          {meta}
          {error && onRetry && (
            <button type="button" onClick={onRetry} className="inline-flex shrink-0 items-center gap-0.5 font-medium text-accent hover:underline">
              <RotateCcw className="size-3" />
              {t("app.retry")}
            </button>
          )}
        </span>
      </span>
      {uploading && (
        <span className="absolute inset-x-2.5 bottom-1 h-0.5 overflow-hidden rounded-full bg-active" aria-hidden>
          <span className="block h-full bg-accent transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
      )}
    </>
  );
  const cls = cn(
    "relative flex h-14 w-[196px] max-w-full items-center gap-2.5 rounded-xl border bg-bg px-2.5",
    error ? "border-danger/60" : "border-line",
    uploading && "opacity-80",
    onClick && "cursor-pointer transition-colors hover:border-strong hover:bg-hover",
    className,
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls} title={t("tx.userFile", { name })} data-testid="file-card">
        {body}
      </button>
    );
  }
  return (
    <div className={cls} data-testid="file-card" data-state={error ? "error" : uploading ? "uploading" : "ready"}>
      {body}
    </div>
  );
}
