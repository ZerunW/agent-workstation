import { ArrowLeft, ArrowRight, Globe, RotateCw, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { frameWidthFor, normalizeUrl } from "../../lib/browser";
import { NO_AUTOFILL } from "../../lib/noAutofill";
import { cn } from "../../lib/cn";
import { t } from "../../i18n";
import { useBrowser } from "../../store/browser";
import { sendBrowserInput, sendBrowserView } from "../../store/hub";
import { toast } from "../../store/toasts";
import { Badge, Button, IconButton } from "../ui/primitives";
import { BrowserView } from "./BrowserView";

/** True while the page itself is visible (not a background tab / minimised window). */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/**
 * Right-panel Browser: the server's Chromium (shared with the agent) as a live view with back / forward / reload, an
 * address bar and who is driving. Frames are only requested while this tab is showing and the page is visible.
 */
export function BrowserTab({ active }: { active: boolean }) {
  const state = useBrowser((s) => s.state);
  const running = !!state?.running;
  const [busy, setBusy] = useState(false);
  const pageVisible = usePageVisible();
  const on = active && pageVisible;
  const areaRef = useRef<HTMLDivElement>(null);
  const sentWidth = useRef(0);

  // current state whenever the tab is opened (push updates cover the rest)
  useEffect(() => {
    if (!active) return;
    let live = true;
    api.browser().then(
      (s) => live && useBrowser.getState().setState(s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [active]);

  // frames flow only while the view is on screen; re-ask when the panel is resized noticeably
  const widthNow = useCallback(() => frameWidthFor(areaRef.current?.clientWidth ?? 0, window.devicePixelRatio), []);
  useEffect(() => {
    if (!on) return;
    sentWidth.current = widthNow();
    sendBrowserView(true, sentWidth.current);
    const el = areaRef.current;
    const ro = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      const w = widthNow();
      if (Math.abs(w - sentWidth.current) < 80) return;
      sentWidth.current = w;
      sendBrowserView(true, w);
    }) : null;
    if (el) ro?.observe(el);
    return () => {
      ro?.disconnect();
      sendBrowserView(false);
    };
  }, [on, widthNow]);

  const toggle = async (start: boolean) => {
    setBusy(true);
    try {
      useBrowser.getState().setState(await (start ? api.startBrowser() : api.stopBrowser()));
    } catch (e) {
      toast.error(t(start ? "browser.startFailed" : "browser.stopFailed"), e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        <IconButton label={t("browser.back")} size="xs" disabled={!running} onClick={() => sendBrowserInput({ kind: "history", action: "back" })}>
          <ArrowLeft className="size-3.5" />
        </IconButton>
        <IconButton label={t("browser.forward")} size="xs" disabled={!running} onClick={() => sendBrowserInput({ kind: "history", action: "forward" })}>
          <ArrowRight className="size-3.5" />
        </IconButton>
        <IconButton label={t("browser.reload")} size="xs" disabled={!running} onClick={() => sendBrowserInput({ kind: "history", action: "reload" })}>
          <RotateCw className="size-3.5" />
        </IconButton>
        <AddressBar url={state?.url ?? null} title={state?.title ?? null} disabled={!running} />
        {running && state?.controlledBy && (
          <Badge tone={state.controlledBy === "agent" ? "accent" : "neutral"} data-testid="browser-control">
            {t(state.controlledBy === "agent" ? "browser.agent" : "browser.you")}
          </Badge>
        )}
        {running && (
          <IconButton label={t("browser.stop")} size="xs" disabled={busy} onClick={() => void toggle(false)}>
            <Square className="size-3 fill-current" />
          </IconButton>
        )}
      </div>
      <div ref={areaRef} className="relative min-h-0 flex-1">
        {running ? (
          <BrowserView />
        ) : (
          <div className={cn("flex h-full flex-col items-center justify-center gap-3 text-[13px] text-muted")}>
            <Globe className="size-5 text-subtle" />
            <div>{t("browser.notRunning")}</div>
            <Button variant="primary" loading={busy} onClick={() => void toggle(true)}>
              {t("browser.start")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function AddressBar({ url, title, disabled }: { url: string | null; title: string | null; disabled: boolean }) {
  const [draft, setDraft] = useState(url ?? "");
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(url ?? "");
  }, [url, editing]);

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const next = normalizeUrl(draft);
    if (!next) return setInvalid(true);
    setInvalid(false);
    setDraft(next);
    sendBrowserInput({ kind: "navigate", url: next });
    (e.currentTarget.elements.namedItem("address") as HTMLInputElement | null)?.blur();
  };

  return (
    <form onSubmit={submit} className="mx-0.5 min-w-0 flex-1">
      <input
        name="address"
        type="text"
        value={draft}
        disabled={disabled}
        title={title ?? undefined}
        aria-label={t("browser.address")}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        {...NO_AUTOFILL}
        onChange={(e) => (setDraft(e.target.value), setInvalid(false))}
        onFocus={(e) => (setEditing(true), e.currentTarget.select())}
        onBlur={() => (setEditing(false), setInvalid(false))}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(url ?? "");
            e.currentTarget.blur();
          }
        }}
        className={cn("h-6 w-full min-w-0 rounded-md bg-sunken px-2 text-xs text-fg outline-none placeholder:text-subtle focus:ring-1 focus:ring-accent disabled:opacity-50", invalid && "ring-1 ring-danger")}
      />
    </form>
  );
}
