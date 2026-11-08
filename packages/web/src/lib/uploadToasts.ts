import { uploadFile } from "./upload";
import { basename, joinPath } from "./format";
import { useApp } from "../store/app";
import { toast } from "../store/toasts";
import { t } from "../i18n";

export interface UploadBatchOptions {
  /** Destination directory relative to the workspace root (default "inbox"). */
  dir?: string;
  /** Called once per file after it finished uploading (path as stored by the hub). */
  onUploaded?: (path: string, file: File) => void;
  /** Called when the whole batch is done (success paths only). */
  onDone?: (paths: string[]) => void;
}

let seq = 0;

/**
 * Upload files via the chunked endpoint with a progress toast per file (retry action on failure).
 * Shared by the composer, the global drop target and the Files tab.
 */
export async function uploadFilesWithToasts(files: File[], opts: UploadBatchOptions = {}): Promise<string[]> {
  if (useApp.getState().disk?.level === "block") {
    toast.error(t("disk.blocked.upload"));
    return [];
  }
  const dir = opts.dir ?? "inbox";
  const done: string[] = [];
  for (const file of files) {
    const path = joinPath(dir, basename(file.name));
    const id = `upload-${++seq}`;
    const run = async (): Promise<void> => {
      toast.progress(id, t("composer.upload.start", { name: file.name }), 0);
      try {
        const res = await uploadFile(file, {
          path,
          onProgress: (p) => {
            const frac = p.totalBytes > 0 ? p.sentBytes / p.totalBytes : 1;
            toast.update(id, { title: t("composer.upload.progress", { name: file.name, percent: Math.round(frac * 100) }), progress: frac });
          },
        });
        toast.update(id, { tone: "success", title: t("composer.upload.done", { name: file.name, path: res.path }), progress: 1, duration: 3500, action: undefined });
        done.push(res.path);
        opts.onUploaded?.(res.path, file);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.update(id, {
          tone: "error",
          title: t("composer.upload.failed", { name: file.name, error: msg }),
          duration: null,
          action: { label: t("app.retry"), onClick: () => void run() },
        });
      }
    };
    await run();
  }
  if (done.length) opts.onDone?.(done);
  return done;
}
