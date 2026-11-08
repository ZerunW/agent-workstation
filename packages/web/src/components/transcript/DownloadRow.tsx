import { AlertCircle, Loader2 } from "lucide-react";
import { useContext } from "react";
import { downloadName, downloadResult, parseDownload } from "../../lib/download";
import { joinPath } from "../../lib/format";
import { t } from "../../i18n";
import { useSessions } from "../../store/sessions";
import { FileCard } from "../ui/FileCard";
import { TranscriptSessionContext } from "./host";
import { save } from "./OutputChips";

export type DownloadState = "streaming" | "pending" | "done" | "failed";

/** A `download_file` call: "Downloaded name" with the file as a download chip and the host muted; the error when it failed. */
export function DownloadRow({ input, result, state }: { input: unknown; result?: string; state: DownloadState }) {
  const sessionId = useContext(TranscriptSessionContext);
  const cwd = useSessions((s) => (sessionId ? (s.views[sessionId]?.session ?? s.sessions[sessionId])?.cwd : "") ?? "");
  const call = parseDownload(input);
  const live = state === "streaming" || state === "pending";
  const failed = state === "failed";
  const saved = state === "done" ? downloadResult(result) : {};
  const name = saved.path ? saved.path.split("/").pop()! : downloadName(call);
  const path = joinPath(cwd, saved.path ?? name);
  return (
    <div className="space-y-1.5 py-0.5 pl-1.5 text-[12.5px]" data-testid="download-row" data-state={state}>
      <div className="flex min-w-0 items-center gap-2">
        {live ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted" aria-label={t("tx.tool.running")} /> : failed ? <AlertCircle className="size-3.5 shrink-0 text-danger" aria-label={t("tx.tool.error")} /> : null}
        <span className={failed ? "min-w-0 truncate text-danger" : "min-w-0 truncate font-medium text-fg"} data-testid="download-label" title={failed ? result : undefined}>
          {live ? t("download.live") : failed ? ((result ?? "").trim() || t("tx.tool.error")) : t("download.done", { name })}
        </span>
        {call.host && (
          <span className="shrink-0 text-[11.5px] text-muted" data-testid="download-host">
            {call.host}
          </span>
        )}
      </div>
      {state === "done" && <FileCard name={name} size={saved.size} onClick={() => save(path)} />}
    </div>
  );
}
