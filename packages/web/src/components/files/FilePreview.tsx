import type { FileEntry } from "@agent-workstation/protocol";
import { ArrowLeft, Copy, Download, FileQuestion } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, fetchFileBlob, type FileContent } from "../../lib/api";
import { basename, formatBytes } from "../../lib/format";
import { highlightToHtml, langFromPath } from "../../lib/highlight";
import { t } from "../../i18n";
import { toast } from "../../store/toasts";
import { Button, EmptyState, IconButton, Skeleton } from "../ui/primitives";
import { imageMimeForPath } from "./fileTree";

type PreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "text"; content: FileContent }
  | { status: "image"; url: string; size: number }
  | { status: "binary"; size: number };

interface Props {
  path: string;
  entry?: FileEntry;
  onBack: () => void;
  onDownload: (path: string) => void;
}

/** Detail view: text (highlighted), image or binary fallback for one file. */
export function FilePreview({ path, entry, onBack, onDownload }: Props) {
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading" });

    const showImage = async (mime: string, size: number) => {
      const { blob } = await fetchFileBlob(path);
      if (cancelled) return;
      // some servers send octet-stream; <img> needs a real image type (esp. for SVG)
      const typed = blob.type.startsWith("image/") ? blob : new Blob([blob], { type: mime });
      objectUrl = URL.createObjectURL(typed);
      setState({ status: "image", url: objectUrl, size });
    };

    (async () => {
      try {
        const byExt = imageMimeForPath(path);
        if (byExt) {
          await showImage(byExt, entry?.size ?? 0);
          return;
        }
        const content = await api.filesContent(path);
        if (cancelled) return;
        if (content.mediaType.startsWith("image/") && content.text == null) {
          await showImage(content.mediaType, content.size);
          return;
        }
        if (content.text == null) setState({ status: "binary", size: content.size });
        else setState({ status: "text", content });
      } catch (e) {
        if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, attempt, entry?.size]);

  const size = state.status === "text" ? state.content.size : state.status === "image" || state.status === "binary" ? state.size : (entry?.size ?? 0);
  const html = useMemo(() => (state.status === "text" ? highlightToHtml(state.content.text ?? "", langFromPath(path)) : ""), [state, path]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        <IconButton label={t("files.preview.back")} size="xs" onClick={onBack} data-autofocus>
          <ArrowLeft className="size-3.5" />
        </IconButton>
        <div className="min-w-0 flex-1 px-1">
          <div className="truncate text-[13px] font-medium" title={path}>
            {basename(path)}
          </div>
          <div className="truncate text-[11px] text-subtle">{[path.includes("/") ? path : null, size ? formatBytes(size) : null].filter(Boolean).join(" · ")}</div>
        </div>
        <IconButton
          label={t("files.preview.copyPath")}
          size="xs"
          onClick={() => {
            void navigator.clipboard?.writeText(path).then(() => toast.success(t("app.copied")));
          }}
        >
          <Copy className="size-3.5" />
        </IconButton>
        <IconButton label={t("files.download")} size="xs" onClick={() => onDownload(path)}>
          <Download className="size-3.5" />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {state.status === "loading" && (
          <div className="space-y-2 p-4" aria-busy aria-label={t("files.preview.loading")}>
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        )}
        {state.status === "error" && (
          <EmptyState title={t("files.preview.failed")} action={<Button onClick={() => setAttempt((n) => n + 1)}>{t("app.retry")}</Button>}>
            {state.message}
          </EmptyState>
        )}
        {state.status === "binary" && (
          <EmptyState
            icon={<FileQuestion className="size-6" />}
            title={t("files.preview.binary")}
            action={
              <Button icon={<Download className="size-3.5" />} onClick={() => onDownload(path)}>
                {t("files.download")} · {formatBytes(state.size)}
              </Button>
            }
          />
        )}
        {state.status === "image" && (
          <div className="flex min-h-full items-center justify-center bg-sunken p-4">
            <img src={state.url} alt={basename(path)} className="max-h-full max-w-full rounded-md object-contain shadow-sm" />
          </div>
        )}
        {state.status === "text" && (
          <>
            {state.content.truncated && <div className="border-b border-line bg-warn-soft px-3 py-1.5 text-xs text-fg">{t("files.preview.truncated")}</div>}
            <pre className="m-0 min-w-full w-max px-3 py-2.5 font-mono text-[12.5px] leading-[1.55] text-fg" data-testid="file-text">
              <code className="hljs" dangerouslySetInnerHTML={{ __html: html || "&nbsp;" }} />
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
