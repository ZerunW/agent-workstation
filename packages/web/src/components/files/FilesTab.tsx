import type { FileEntry } from "@agent-workstation/protocol";
import { Download, Folder, FolderPlus, RefreshCw, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { api } from "../../lib/api";
import { runDownload } from "../../lib/downloadToasts";
import { cn } from "../../lib/cn";
import { formatBytes, joinPath } from "../../lib/format";
import { uploadFilesWithToasts } from "../../lib/uploadToasts";
import { t } from "../../i18n";
import { useApp } from "../../store/app";
import { useChanged } from "../../store/changed";
import { useComposer } from "../../store/composer";
import { useLoadOutputs, useMergedChanged } from "../../store/outputs";
import { useSessions } from "../../store/sessions";
import { toast } from "../../store/toasts";
import { Button, EmptyState, IconButton, Skeleton } from "../ui/primitives";
import { Modal } from "../ui/overlays";
import { FilePreview } from "./FilePreview";
import { FileRow } from "./FileRow";
import { dirOfEntry, flattenRows, foldersToReveal, isChangedEntry, scopeChanged, summarizeTree, validFolderName, type Row, type TreeSummary } from "./fileTree";
import { useFileTree } from "./useFileTree";
import { NO_AUTOFILL } from "../../lib/noAutofill";

const DEFAULT_UPLOAD_DIR = "inbox";

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

interface DeleteState {
  entry: FileEntry;
  /** null while a folder's size is still being computed */
  summary: TreeSummary | null;
  sizeFailed: boolean;
  busy: boolean;
}

export function FilesTab({ sessionId }: { sessionId: string | null }) {
  // The API user header is only set once the shell has bootstrapped (`me` loaded); don't fire before that.
  const ready = useApp((s) => !!s.me || !!s.meError);
  // A Code session's tree is rooted at its working directory (workspace-relative); everything else shows the workspace.
  const cwd = useSessions((s) => {
    const sess = sessionId ? (s.views[sessionId]?.session ?? s.sessions[sessionId]) : undefined;
    return sess?.kind === "code" ? sess.cwd : null;
  });
  // A new Code draft (no session yet) shows the folder it will start in, e.g. one just dropped on the start page.
  const codeMode = useApp((s) => s.mode === "code");
  const newCwd = useComposer((s) => s.newCwd);
  const draftCwd = !sessionId && codeMode && newCwd ? newCwd : null;
  const rooted = cwd !== null;
  // The folder header and the empty state: a session's folder or a draft's.
  const showsFolder = rooted || draftCwd !== null;
  const root = (cwd ?? draftCwd ?? "").replace(/^\.?\/+|\/+$/g, "");
  const { dirs, expanded, toggle, expand, collapse, expandMany, refreshAll, refreshDir, load } = useFileTree(ready, root, sessionId ?? "");
  const diskBlocked = useApp((s) => s.disk?.level === "block");
  const allChanged = useMergedChanged(sessionId);
  useLoadOutputs(sessionId, rooted);
  const changedMap = useMemo(() => scopeChanged(allChanged, root), [allChanged, root]);
  const tick = useChanged((s) => s.tick);

  const onlyChanged = useApp((s) => s.filesChangedOnly);
  const setOnlyChanged = useApp((s) => s.setFilesChangedOnly);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [del, setDel] = useState<DeleteState | null>(null);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ---- derived rows ---------------------------------------------------------------------
  const rows = useMemo(() => flattenRows(dirs, expanded, { changed: onlyChanged ? changedMap : null, root }), [dirs, expanded, onlyChanged, changedMap, root]);
  const entryRows = useMemo(() => rows.filter((r): r is Extract<Row, { kind: "entry" }> => r.kind === "entry"), [rows]);
  const entryByPath = useMemo(() => {
    const m = new Map<string, FileEntry>();
    for (const [, st] of Object.entries(dirs)) for (const e of st.entries ?? []) m.set(e.path, e);
    return m;
  }, [dirs]);
  const rootState = dirs[root];
  const focusEntry = focusPath ? entryByPath.get(focusPath) : undefined;
  const activeDir = focusEntry ? dirOfEntry(focusEntry) : root;
  const defaultDir = root || DEFAULT_UPLOAD_DIR;
  const uploadDir = activeDir || defaultDir;

  // Another session (or root): drop selection, preview and focus that belong to the old tree.
  const scopeKey = `${sessionId ?? ""}\0${root}`;
  const lastScope = useRef(scopeKey);
  useEffect(() => {
    if (lastScope.current === scopeKey) return;
    lastScope.current = scopeKey;
    setFocusPath(null);
    setSelected(new Set());
    setPreviewOpen(false);
    setPreviewPath(null);
    setDel(null);
    setDropDir(null);
  }, [scopeKey]);

  // Closing the preview hands keyboard focus back to the tree (the list was inert while it was open).
  const detailRef = useRef<HTMLDivElement>(null);
  const wasPreviewOpen = useRef(false);
  useEffect(() => {
    if (previewOpen) {
      // the list goes inert while the preview is open: move focus into the detail view
      const id = requestAnimationFrame(() => detailRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true }));
      wasPreviewOpen.current = true;
      return () => cancelAnimationFrame(id);
    }
    if (wasPreviewOpen.current) listRef.current?.focus({ preventScroll: true });
    wasPreviewOpen.current = false;
  }, [previewOpen, previewPath]);

  // ---- live updates -----------------------------------------------------------------------
  const firstTick = useRef(tick);
  useEffect(() => {
    if (tick === firstTick.current) return;
    const id = setTimeout(refreshAll, 400);
    return () => clearTimeout(id);
  }, [tick, refreshAll]);

  useEffect(() => {
    if (onlyChanged) expandMany(foldersToReveal(changedMap, root));
  }, [onlyChanged, changedMap, root, expandMany]);

  useEffect(() => {
    if (!focusPath) return;
    const idx = entryRows.findIndex((r) => r.entry.path === focusPath);
    if (idx >= 0) listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(rowId(rows, focusPath))}`)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPath]);

  // ---- actions --------------------------------------------------------------------------------
  const openPreview = useCallback((path: string) => {
    setPreviewPath(path);
    setPreviewOpen(true);
  }, []);

  // Overview → Outputs opens a file here; the request is consumed so a later remount does not replay it.
  const openRequest = useApp((s) => s.openFileRequest);
  useEffect(() => {
    if (!openRequest) return;
    useApp.setState({ openFileRequest: null });
    setFocusPath(openRequest);
    openPreview(openRequest);
  }, [openRequest, openPreview]);

  const activate = useCallback(
    (entry: FileEntry) => {
      setFocusPath(entry.path);
      if (entry.kind === "dir") toggle(entry.path);
      else if (entry.kind === "file") openPreview(entry.path);
    },
    [toggle, openPreview],
  );

  const toggleSelect = useCallback((entry: FileEntry) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  }, []);

  const downloadEntry = useCallback((entry: FileEntry) => void runDownload([entry.path], entry.name), []);
  const downloadPath = useCallback((path: string) => void runDownload([path], path.split("/").pop() || path), []);

  const requestDelete = useCallback((entry: FileEntry) => {
    if (entry.kind !== "dir") {
      setDel({ entry, summary: { files: 1, bytes: entry.size }, sizeFailed: false, busy: false });
      return;
    }
    setDel({ entry, summary: null, sizeFailed: false, busy: false });
    api.filesTree(entry.path, 10).then(
      (list) => setDel((cur) => (cur && cur.entry.path === entry.path ? { ...cur, summary: summarizeTree(list) } : cur)),
      () => setDel((cur) => (cur && cur.entry.path === entry.path ? { ...cur, sizeFailed: true } : cur)),
    );
  }, []);

  const confirmDelete = async () => {
    if (!del) return;
    const { entry } = del;
    setDel({ ...del, busy: true });
    try {
      await api.filesDelete(entry.path);
      toast.success(t("files.delete.done", { name: entry.name }));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(entry.path);
        return next;
      });
      if (previewPath && (previewPath === entry.path || previewPath.startsWith(`${entry.path}/`))) setPreviewOpen(false);
      collapse(entry.path);
      refreshDir(dirOfEntry({ ...entry, kind: "file" }));
      setDel(null);
    } catch (e) {
      toast.error(t("files.delete.failed"), e instanceof Error ? e.message : String(e));
      setDel((cur) => (cur ? { ...cur, busy: false } : cur));
    }
  };

  const uploadInto = useCallback(
    async (files: File[], dir: string) => {
      if (files.length === 0) return;
      if (dir) expand(dir);
      await uploadFilesWithToasts(files, { dir });
      refreshDir(dir);
    },
    [expand, refreshDir],
  );

  const submitFolder = async (e: FormEvent) => {
    e.preventDefault();
    if (!validFolderName(folderName)) {
      setFolderError(t("files.newFolder.invalid"));
      return;
    }
    setFolderBusy(true);
    setFolderError(null);
    try {
      await api.filesMkdir(joinPath(activeDir, folderName.trim()));
      setFolderOpen(false);
      setFolderName("");
      if (activeDir) expand(activeDir);
      refreshDir(activeDir);
    } catch (err) {
      setFolderError(`${t("files.newFolder.failed")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setFolderBusy(false);
    }
  };

  // ---- keyboard -------------------------------------------------------------------------------
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || (e.metaKey && e.key !== "Backspace")) return;
    const n = entryRows.length;
    if (n === 0) return;
    const idx = entryRows.findIndex((r) => r.entry.path === focusPath);
    const move = (i: number) => {
      e.preventDefault();
      setFocusPath(entryRows[Math.max(0, Math.min(n - 1, i))]!.entry.path);
    };
    const cur = idx >= 0 ? entryRows[idx]! : null;
    switch (e.key) {
      case "ArrowDown":
        return move(idx < 0 ? 0 : idx + 1);
      case "ArrowUp":
        return move(idx < 0 ? 0 : idx - 1);
      case "Home":
        return move(0);
      case "End":
        return move(n - 1);
      case "ArrowRight":
        if (cur?.entry.kind === "dir") {
          e.preventDefault();
          if (!expanded.has(cur.entry.path)) expand(cur.entry.path);
          else if (entryRows[idx + 1] && entryRows[idx + 1]!.depth > cur.depth) setFocusPath(entryRows[idx + 1]!.entry.path);
        }
        return;
      case "ArrowLeft":
        if (!cur) return;
        e.preventDefault();
        if (cur.entry.kind === "dir" && expanded.has(cur.entry.path)) collapse(cur.entry.path);
        else if (cur.depth > 0) {
          const parent = dirOfEntry({ ...cur.entry, kind: "file" });
          if (parent) setFocusPath(parent);
        }
        return;
      case "Enter":
        if (cur) {
          e.preventDefault();
          activate(cur.entry);
        }
        return;
      case " ":
        if (cur) {
          e.preventDefault();
          toggleSelect(cur.entry);
        }
        return;
      case "Delete":
      case "Backspace":
        if (cur && (e.key === "Delete" || e.metaKey)) {
          e.preventDefault();
          requestDelete(cur.entry);
        }
        return;
    }
  };

  // ---- drag & drop (folder-level upload target) -----------------------------------------------
  const targetDirOf = (e: DragEvent): string => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-dir-target]");
    return el ? (el.dataset.dirTarget ?? "") || defaultDir : uploadDir;
  };
  const onDragEnterOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation(); // keep the window-level inbox drop in Workbench from also firing
    e.dataTransfer.dropEffect = diskBlocked ? "none" : "copy";
    const dir = targetDirOf(e);
    setDropDir((cur) => (cur === dir ? cur : dir));
  };
  const onDragLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.stopPropagation();
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDropDir(null);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = targetDirOf(e);
    setDropDir(null);
    if (diskBlocked) {
      toast.error(t("disk.blocked.upload"));
      return;
    }
    void uploadInto(Array.from(e.dataTransfer.files), dir);
  };

  // ---- render -----------------------------------------------------------------------------------
  const rootEmpty = !!rootState?.entries && rootState.entries.length === 0;
  const changedNone = onlyChanged && entryRows.length === 0 && !!rootState?.entries && !rootState.loading;
  const detailEntry = previewPath ? entryByPath.get(previewPath) : undefined;

  return (
    <div className="relative h-full overflow-hidden" data-testid="files-tab">
      <div
        className="flex h-full min-h-0 flex-col"
        onDragEnter={onDragEnterOver}
        onDragOver={onDragEnterOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        aria-hidden={previewOpen || undefined}
        {...(previewOpen ? ({ inert: "" } as Record<string, string>) : {})}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
          <Button
            size="xs"
            variant="outline"
            icon={<Upload className="size-3.5" />}
            disabled={diskBlocked}
            title={diskBlocked ? t("disk.blocked.upload") : undefined}
            onClick={() => fileInput.current?.click()}
          >
            {t("files.upload")}
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="upload-input"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void uploadInto(files, uploadDir);
            }}
          />
          <IconButton label={t("files.newFolder")} title={diskBlocked ? t("disk.blocked.upload") : t("files.newFolder")} size="xs" disabled={diskBlocked} onClick={() => setFolderOpen(true)}>
            <FolderPlus className="size-3.5" />
          </IconButton>
          <IconButton label={t("files.refresh")} title={t("files.refresh")} size="xs" onClick={refreshAll}>
            <RefreshCw className="size-3.5" />
          </IconButton>
          <button
            type="button"
            role="switch"
            aria-checked={onlyChanged}
            onClick={() => setOnlyChanged(!onlyChanged)}
            title={t("files.changedOnly")}
            className={cn("ml-auto flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium", onlyChanged ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg")}
          >
            <span className={cn("size-1.5 rounded-full", onlyChanged ? "bg-accent" : "bg-subtle")} />
            {t("files.changedOnly")}
          </button>
        </div>

        {selected.size > 0 ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-line bg-accent-soft px-3 py-1 text-xs">
            <span className="font-medium">{t("files.selected", { n: selected.size })}</span>
            <Button size="xs" variant="primary" icon={<Download className="size-3" />} className="ml-auto" onClick={() => void runDownload([...selected], t("files.downloadSelected", { n: selected.size }))}>
              {selected.size > 1 ? t("files.downloadSelected", { n: selected.size }) : t("files.download")}
            </Button>
            <IconButton label={t("files.clearSelection")} size="xs" onClick={() => setSelected(new Set())}>
              <X className="size-3.5" />
            </IconButton>
          </div>
        ) : (
          diskBlocked && <div className="shrink-0 truncate px-3 pt-1.5 text-[11px] text-subtle">{t("disk.blocked.upload")}</div>
        )}

        {showsFolder && (
          <div data-testid="files-root" data-path={root} title={root || undefined} className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line px-3 text-[13px] font-medium">
            <Folder className="size-4 shrink-0 text-accent" />
            <span className="min-w-0 truncate">{root ? root.split("/").pop() : t("sidebar.workspace")}</span>
          </div>
        )}

        <div
          ref={listRef}
          role="tree"
          aria-label={t("files.tree")}
          aria-multiselectable
          tabIndex={0}
          aria-activedescendant={focusPath ? rowId(rows, focusPath) : undefined}
          onKeyDown={onKeyDown}
          onFocus={(e) => {
            if (e.target === e.currentTarget && !focusPath && entryRows[0]) setFocusPath(entryRows[0].entry.path);
          }}
          className="relative min-h-0 flex-1 overflow-y-auto px-1.5 py-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
        >
          {!rootState || (rootState.loading && !rootState.entries) ? (
            <div className="space-y-1.5 p-1.5" aria-busy>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-5" />
              ))}
            </div>
          ) : rootState.error && !rootState.entries ? (
            <EmptyState title={t("files.loadFailed")} action={<Button onClick={() => void load(root)}>{t("app.retry")}</Button>}>
              {rootState.error}
            </EmptyState>
          ) : rootEmpty ? (
            <EmptyState title={showsFolder ? t("files.folderEmpty") : t("files.empty.title")} action={<Button icon={<Upload className="size-3.5" />} disabled={diskBlocked} onClick={() => fileInput.current?.click()}>{t("files.upload")}</Button>} />
          ) : changedNone ? (
            <EmptyState title={t("files.changedOnly.empty")} />
          ) : (
            rows.map((row, i) => {
              if (row.kind === "status") {
                const pad = 4 + row.depth * 14 + 20;
                if (row.status === "loading") return <Skeleton key={`s-${row.dir}-${i}`} className="my-1 h-4 w-1/2" />;
                if (row.status === "empty")
                  return (
                    <div key={`s-${row.dir}-${i}`} style={{ paddingLeft: pad }} className="h-6 text-xs leading-6 text-subtle">
                      {t("files.folderEmpty")}
                    </div>
                  );
                return (
                  <div key={`s-${row.dir}-${i}`} style={{ paddingLeft: pad }} className="flex h-6 items-center gap-2 text-xs text-danger">
                    <span className="truncate">{row.message ?? t("files.loadFailed")}</span>
                    <button type="button" className="font-medium text-accent hover:underline" onClick={() => void load(row.dir)}>
                      {t("app.retry")}
                    </button>
                  </div>
                );
              }
              const { entry, depth } = row;
              return (
                <FileRow
                  key={entry.path}
                  id={rowId(rows, entry.path)}
                  entry={entry}
                  depth={depth}
                  expanded={expanded.has(entry.path)}
                  loading={!!dirs[entry.path]?.loading && !dirs[entry.path]?.entries}
                  focused={focusPath === entry.path}
                  selected={selected.has(entry.path)}
                  changed={isChangedEntry(entry, changedMap)}
                  dropTarget={dropDir !== null && entry.kind === "dir" && dropDir === entry.path}
                  onActivate={activate}
                  onSelect={toggleSelect}
                  onDownload={downloadEntry}
                  onDelete={requestDelete}
                />
              );
            })
          )}
          {dropDir !== null && !diskBlocked && (
            <div className="pointer-events-none absolute inset-x-2 bottom-2 rounded-lg border border-dashed border-accent bg-surface/95 px-3 py-2 text-center text-xs font-medium text-accent shadow-sm">{t("files.dropHere", { dir: dropDir })}</div>
          )}
        </div>
      </div>

      {/* detail: preview slides over the list */}
      <div
        ref={detailRef}
        // visibility flips instantly when opening (so focus can move in) but waits out the slide when closing
        className={cn("absolute inset-0 bg-bg duration-200", previewOpen ? "visible translate-x-0 transition-transform" : "invisible translate-x-full transition-[transform,visibility]")}
        aria-hidden={!previewOpen}
        data-testid="file-detail"
        onKeyDown={(e) => {
          if (e.key === "Escape" && previewOpen) {
            e.stopPropagation();
            setPreviewOpen(false);
          }
        }}
      >
        {previewPath && <FilePreview key={previewPath} path={previewPath} entry={detailEntry} onBack={() => setPreviewOpen(false)} onDownload={downloadPath} />}
      </div>

      <Modal
        open={!!del}
        onOpenChange={(o) => !o && !del?.busy && setDel(null)}
        title={t("files.delete.title", { name: del?.entry.name ?? "" })}
        description={del ? deleteDescription(del) : undefined}
        width="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDel(null)} disabled={del?.busy}>
              {t("app.cancel")}
            </Button>
            <Button variant="danger" loading={del?.busy} disabled={!del || (!del.summary && !del.sizeFailed)} onClick={() => void confirmDelete()}>
              {t("files.delete")}
            </Button>
          </>
        }
      />

      <Modal
        open={folderOpen}
        onOpenChange={setFolderOpen}
        title={t("files.newFolder.title")}
        width="sm"
      >
        <form onSubmit={submitFolder} className="space-y-2 pb-1">
          <input {...NO_AUTOFILL}
            autoFocus
            value={folderName}
            onChange={(e) => {
              setFolderName(e.target.value);
              setFolderError(null);
            }}
            placeholder={t("files.newFolder.placeholder")}
            aria-label={t("files.newFolder.placeholder")}
            aria-invalid={!!folderError}
            maxLength={200}
            spellCheck={false}
            className={cn("h-9 w-full rounded-lg border bg-bg px-3 text-sm outline-none focus:border-accent", folderError ? "border-danger" : "border-line")}
          />
          {folderError && <p className="text-xs text-danger">{folderError}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setFolderOpen(false)}>
              {t("app.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={folderBusy} disabled={!folderName.trim()}>
              {t("files.newFolder.create")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/** Row ids are positional (`frow-<index among visible rows>`) so aria-activedescendant stays valid. */
function rowId(rows: Row[], path: string): string {
  const i = rows.findIndex((r) => r.kind === "entry" && r.entry.path === path);
  return `frow-${i}`;
}

function deleteDescription(del: DeleteState): string {
  const { entry, summary } = del;
  if (entry.kind !== "dir") return t("files.delete.file", { size: formatBytes(entry.size) });
  if (!summary) return del.sizeFailed ? t("files.delete.folderUnknown") : t("files.delete.calculating");
  if (summary.files === 0) return t("files.delete.folderEmpty");
  if (summary.files === 1) return t("files.delete.folderOne", { size: formatBytes(summary.bytes) });
  return t("files.delete.folder", { count: summary.files, size: formatBytes(summary.bytes) });
}
