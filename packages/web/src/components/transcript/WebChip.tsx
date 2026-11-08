import { AlertCircle, Check, ChevronRight, FileText, Globe, Loader2, Search } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { attachmentLabel, fetchUrl, parseLinks, searchQuery, shortUrl, type WebTool } from "../../lib/webTools";
import { t } from "../../i18n";
import { useTranscriptHost } from "./host";

export type WebChipState = "streaming" | "pending" | "done" | "failed";

interface Props {
  kind: WebTool;
  input: unknown;
  result?: string;
  state: WebChipState;
}

function ExternalLink({ url, className, children }: { url: string; className?: string; children: React.ReactNode }) {
  const host = useTranscriptHost();
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className={className}
      title={url}
      onClick={(e) => {
        if (host.openExternal) {
          e.preventDefault();
          host.openExternal(url);
        }
      }}
    >
      {children}
    </a>
  );
}

/** Compact stand-in for web search / fetch and (in chats) attachment reads: "Searched · query", "Read · example.com/x", "Read · file.pdf (pages 3–5)". */
export function WebChip({ kind, input, result, state }: Props) {
  const [open, setOpen] = useState(false);
  const live = state === "streaming" || state === "pending";
  const failed = state === "failed";
  const head = t(kind === "search" ? (live ? "web.searching" : "web.searched") : live ? "web.reading" : "web.read");
  const url = kind === "fetch" ? fetchUrl(input) : "";
  const label = kind === "search" ? searchQuery(input) : kind === "fetch" ? (url ? shortUrl(url) : "") : attachmentLabel(input);
  const links = kind === "search" && !failed && !live ? parseLinks(result) : [];
  const expandable = failed ? !!result : kind === "search" && !live && (links.length > 0 || !!result);
  const Icon = kind === "search" ? Search : kind === "fetch" ? Globe : FileText;
  const status = live ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted" aria-label={t("tx.tool.running")} /> : failed ? <AlertCircle className="size-3.5 shrink-0 text-danger" aria-label={t("tx.tool.error")} /> : <Check className="size-3.5 shrink-0 text-ok" />;
  const title = (
    <>
      <span className="font-medium">{head}</span>
      {label && <span className="text-muted"> · {label}</span>}
    </>
  );
  return (
    <div className={cn("w-fit max-w-full overflow-hidden rounded-lg border bg-surface/60 text-[13px]", failed ? "border-danger/40" : "border-line")} data-testid="web-chip" data-kind={kind} data-state={state}>
      <div className="flex items-center hover:bg-hover">
        {expandable ? (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={t("web.results")} className="flex shrink-0 items-center gap-2 py-1.5 pl-3 pr-2" data-testid="web-chip-toggle">
            <ChevronRight className={cn("size-3.5 text-subtle transition-transform", open && "rotate-90")} />
            <Icon className="size-3.5 text-muted" />
          </button>
        ) : (
          <span className="flex shrink-0 items-center py-1.5 pl-3 pr-2">
            <Icon className="size-3.5 text-muted" />
          </span>
        )}
        {kind === "fetch" && url ? (
          <ExternalLink url={url} className="min-w-0 flex-1 truncate py-1.5 hover:underline">
            {title}
          </ExternalLink>
        ) : expandable ? (
          <button type="button" onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 truncate py-1.5 text-left" tabIndex={-1}>
            {title}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate py-1.5">{title}</span>
        )}
        <span className="shrink-0 py-1.5 pl-2 pr-3">{status}</span>
      </div>
      {open && expandable && (
        <div className="border-t border-line px-3 py-2" data-testid="web-chip-result">
          {!failed && links.length > 0 ? (
            <ul className="space-y-1">
              {links.map((l, i) => (
                <li key={i} className="truncate" data-testid="web-chip-link">
                  {l.url ? (
                    <ExternalLink url={l.url} className="text-accent hover:underline">
                      {l.title}
                    </ExternalLink>
                  ) : (
                    <span>{l.title}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <pre className={cn("max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed", failed ? "text-danger" : "text-muted")}>{result}</pre>
          )}
        </div>
      )}
    </div>
  );
}
