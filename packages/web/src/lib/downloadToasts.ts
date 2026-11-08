import { t } from "../i18n";
import { toast, useToasts } from "../store/toasts";
import { downloadFiles } from "./api";

let seq = 0;

/** Download one or more workspace paths (several or a folder → zip) with a progress toast that turns into an error toast on failure. */
export async function runDownload(paths: string[], label: string): Promise<void> {
  const id = `download-${++seq}`;
  useToasts.getState().push({ id, tone: "progress", title: t("files.download.preparing", { name: label }) });
  try {
    await downloadFiles(paths);
    toast.dismiss(id);
  } catch (e) {
    useToasts.getState().update(id, { tone: "error", title: t("files.download.failed"), description: e instanceof Error ? e.message : String(e), duration: 8000 });
  }
}
