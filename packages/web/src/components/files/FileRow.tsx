import type { FileEntry } from "@agent-workstation/protocol";
import { ChevronRight, Download, File, FileArchive, FileCode, FileImage, FileText, Folder, FolderOpen, Link2, Loader2, Trash2 } from "lucide-react";
import { memo } from "react";
import { cn } from "../../lib/cn";
import { formatBytes, relativeTime } from "../../lib/format";
import { t } from "../../i18n";
import { dirOfEntry, imageMimeForPath } from "./fileTree";

const CODE_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "rs", "go", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "json", "yml", "yaml", "toml", "html", "css", "scss", "sql", "lua", "xml"]);
const TEXT_EXT = new Set(["md", "markdown", "txt", "log", "csv", "tsv", "rst", "ini", "conf", "env"]);
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "tgz", "zst", "bz2", "xz", "7z", "rar"]);

export function FileIcon({ entry, open }: { entry: Pick<FileEntry, "kind" | "name">; open: boolean }) {
  const cls = "size-4";
  if (entry.kind === "dir") return open ? <FolderOpen className={cn(cls, "text-accent")} /> : <Folder className={cn(cls, "text-accent")} />;
  if (entry.kind === "symlink") return <Link2 className={cn(cls, "text-info")} aria-label={t("files.symlink")} />;
  const ext = entry.name.toLowerCase().split(".").pop() ?? "";
  if (imageMimeForPath(entry.name)) return <FileImage className={cn(cls, "text-muted")} />;
  if (ARCHIVE_EXT.has(ext)) return <FileArchive className={cn(cls, "text-muted")} />;
  if (CODE_EXT.has(ext)) return <FileCode className={cn(cls, "text-muted")} />;
  if (TEXT_EXT.has(ext)) return <FileText className={cn(cls, "text-muted")} />;
  return <File className={cn(cls, "text-muted")} />;
}

const STATUS_LABEL = { added: "files.status.added", modified: "files.status.modified", deleted: "files.status.deleted", renamed: "files.status.renamed" } as const;
const STATUS_LETTER = { added: "A", modified: "M", deleted: "D", renamed: "R" } as const;
const STATUS_TONE = { added: "text-ok bg-ok-soft", modified: "text-warn bg-warn-soft", deleted: "text-danger bg-danger-soft", renamed: "text-info bg-info-soft" } as const;

export interface FileRowProps {
  id: string;
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  loading: boolean;
  focused: boolean;
  selected: boolean;
  changed: boolean;
  dropTarget: boolean;
  onActivate: (entry: FileEntry) => void;
  onSelect: (entry: FileEntry) => void;
  onDownload: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
}

function FileRowImpl({ id, entry, depth, expanded, loading, focused, selected, changed, dropTarget, onActivate, onSelect, onDownload, onDelete }: FileRowProps) {
  const isDir = entry.kind === "dir";
  return (
    <div
      id={id}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={isDir ? expanded : undefined}
      aria-selected={selected}
      data-dir-target={dirOfEntry(entry)}
      data-path={entry.path}
      onClick={() => onActivate(entry)}
      title={`${entry.path}${entry.kind === "file" ? ` · ${formatBytes(entry.size)}` : ""} · ${relativeTime(entry.mtime)}`}
      style={{ paddingLeft: 4 + depth * 14 }}
      className={cn(
        "group flex h-7 cursor-pointer select-none items-center gap-1 rounded-md pr-1 text-[13px]",
        focused ? "bg-active" : "hover:bg-hover",
        selected && "bg-accent-soft",
        dropTarget && "bg-accent-soft ring-1 ring-accent",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-subtle">
        {isDir ? loading ? <Loader2 className="size-3 animate-spin" /> : <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} /> : null}
      </span>
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <span className={cn(selected ? "invisible" : "group-hover:invisible")}>
          <FileIcon entry={entry} open={expanded} />
        </span>
        <input
          type="checkbox"
          tabIndex={-1}
          checked={selected}
          aria-label={t("files.select", { name: entry.name })}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onSelect(entry)}
          className={cn("absolute inset-0 m-auto size-3.5 cursor-pointer accent-[var(--accent)]", selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100")}
        />
      </span>
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {changed && <span role="img" aria-label={t("files.changedMark")} title={t("files.changedMark")} data-testid="changed-dot" className="size-1.5 shrink-0 rounded-full bg-accent" />}
      {entry.reviewStatus && (
        <span title={t(STATUS_LABEL[entry.reviewStatus])} className={cn("shrink-0 rounded px-1 font-mono text-[10px] font-semibold leading-4", STATUS_TONE[entry.reviewStatus])}>
          {STATUS_LETTER[entry.reviewStatus]}
        </span>
      )}
      {entry.kind === "file" && <span className={cn("shrink-0 text-[11px] tabular-nums text-subtle", focused ? "hidden" : "group-hover:hidden")}>{formatBytes(entry.size)}</span>}
      <span className={cn("shrink-0 items-center gap-0.5", focused ? "flex" : "hidden group-hover:flex")}>
        <button
          type="button"
          aria-label={`${t("files.download")} ${entry.name}`}
          title={t("files.download")}
          onClick={(e) => {
            e.stopPropagation();
            onDownload(entry);
          }}
          className="flex size-5 items-center justify-center rounded text-muted hover:bg-strong hover:text-fg"
        >
          <Download className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={`${t("files.delete")} ${entry.name}`}
          title={t("files.delete")}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(entry);
          }}
          className="flex size-5 items-center justify-center rounded text-muted hover:bg-danger-soft hover:text-danger"
        >
          <Trash2 className="size-3.5" />
        </button>
      </span>
    </div>
  );
}

export const FileRow = memo(FileRowImpl);
