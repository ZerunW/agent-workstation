import { ArrowUp, MessageCircle, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { askReadme, type AskMessage } from "../../lib/readme";
import { IconButton } from "../ui/primitives";
import { Markdown } from "../transcript/Markdown";

/**
 * The docs assistant: a round button bottom-right that opens a small chat panel. The conversation lives in this
 * component only (the page view, no storage). A 403 (not available) or 401 (nobody signed in) from the hub: `onDenied` hides it.
 */
export function ReadmeAssistant({ onDenied }: { onDenied: () => void }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<AskMessage[]>([]);
  messagesRef.current = messages;

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open, error]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const history: AskMessage[] = [...messagesRef.current, { role: "user", text }];
    setMessages([...history, { role: "assistant", text: "" }]);
    setInput("");
    setError(false);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await askReadme(
        history,
        (delta) =>
          setMessages((m) => {
            const last = m[m.length - 1];
            return last?.role === "assistant" ? [...m.slice(0, -1), { role: "assistant", text: last.text + delta }] : m;
          }),
        ctrl.signal,
      );
    } catch (e) {
      if (ctrl.signal.aborted) return;
      if (e instanceof ApiError && (e.status === 403 || e.status === 401)) return onDenied();
      setError(true);
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setBusy(false);
        // an answer that never started leaves no empty bubble behind
        setMessages((m) => (m[m.length - 1]?.role === "assistant" && m[m.length - 1].text === "" ? m.slice(0, -1) : m));
      }
    }
  };

  const clear = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setInput("");
    setError(false);
    setBusy(false);
  };

  return (
    <div className="fixed bottom-4 right-4 z-30 flex flex-col items-end gap-3" data-testid="readme-assistant">
      {open && (
        <section
          role="dialog"
          aria-label={t("readme.ask.title")}
          className="flex h-[min(32rem,calc(100vh-6rem))] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
          data-testid="readme-panel"
        >
          <header className="flex items-center gap-1 border-b border-line py-1.5 pl-3 pr-1.5">
            <h2 className="flex-1 text-[13px] font-semibold">{t("readme.ask.title")}</h2>
            <IconButton label={t("readme.ask.clear")} size="xs" onClick={clear} disabled={messages.length === 0 && !input} data-testid="readme-clear">
              <Trash2 className="size-3.5" />
            </IconButton>
            <IconButton label={t("readme.ask.close")} size="xs" onClick={() => setOpen(false)}>
              <X className="size-3.5" />
            </IconButton>
          </header>
          <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-[13px]" data-testid="readme-messages">
            {messages.length === 0 && <p className="text-muted">{t("readme.ask.empty")}</p>}
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="ml-8 rounded-lg bg-sunken px-3 py-1.5 whitespace-pre-wrap break-words" data-testid="readme-msg-user">
                  {m.text}
                </div>
              ) : (
                <div key={i} className="text-[13px] [&_.prose-workstation]:text-[13px] [&_.prose-workstation]:leading-relaxed" data-testid="readme-msg-assistant">
                  {m.text ? <Markdown text={m.text} /> : <span className="text-subtle">…</span>}
                </div>
              ),
            )}
            {error && (
              <p className="text-xs text-muted" role="status" data-testid="readme-error">
                {t("readme.ask.error")}
              </p>
            )}
          </div>
          <form
            className="flex items-end gap-1.5 border-t border-line p-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              maxLength={4000}
              placeholder={t("readme.ask.placeholder")}
              aria-label={t("readme.ask.placeholder")}
              className="max-h-28 min-h-8 min-w-0 flex-1 resize-none rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-accent"
              data-testid="readme-input"
            />
            <button
              type="submit"
              aria-label={t("readme.ask.send")}
              disabled={busy || !input.trim()}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-40"
              data-testid="readme-send"
            >
              <ArrowUp className="size-4" />
            </button>
          </form>
        </section>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t("readme.ask.open")}
        aria-expanded={open}
        title={t("readme.ask.open")}
        className={cn(
          "inline-flex size-12 items-center justify-center rounded-full bg-accent text-accent-fg shadow-md transition-colors hover:bg-accent-hover",
          open && "opacity-90",
        )}
        data-testid="readme-fab"
      >
        {open ? <X className="size-5" /> : <MessageCircle className="size-5" />}
      </button>
    </div>
  );
}
