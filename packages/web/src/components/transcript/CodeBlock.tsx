import { Check, Copy } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { highlightToHtml } from "../../lib/highlight";
import { t } from "../../i18n";

export function CopyButton({ text, className, label }: { text: string | (() => string); className?: string; label?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      aria-label={label ?? t("tx.copy")}
      title={label ?? t("tx.copy")}
      onClick={async () => {
        const ok = await copyText(typeof text === "function" ? text() : text);
        if (ok) {
          setDone(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setDone(false), 1500);
        }
      }}
      className={cn("inline-flex size-6 items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg", className)}
    >
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export const CodeBlock = memo(function CodeBlock({ code, lang, className, maxHeight }: { code: string; lang?: string; className?: string; maxHeight?: number }) {
  const html = useMemo(() => highlightToHtml(code, lang), [code, lang]);
  return (
    <div className={cn("group/code relative my-3 overflow-hidden rounded-lg border border-line bg-code", className)}>
      <div className="flex h-7 items-center justify-between px-3 text-[11px] text-subtle">
        <span className="font-mono">{lang ?? ""}</span>
        <CopyButton text={code} label={t("tx.copyCode")} className="opacity-0 focus-visible:opacity-100 group-hover/code:opacity-100" />
      </div>
      <pre className="overflow-x-auto px-3 pb-3 font-mono text-[12.5px] leading-relaxed" style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
});
