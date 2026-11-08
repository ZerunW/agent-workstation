import { Code, Copy, Download, Ellipsis, Image as ImageIcon, Maximize2, Workflow, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useIsDark } from "../../hooks/useIsDark";
import { saveBlob } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { highlightToHtml } from "../../lib/highlight";
import { mermaidErrorLine, renderMermaid } from "../../lib/mermaid";
import { exportSvg, sanitizeSvg, svgBlob, svgToPng, visualFilename, VISUAL_MSG, visualSrcdoc, visualThemeCss } from "../../lib/visual";
import { useComposer } from "../../store/composer";
import { t } from "../../i18n";
import { toast } from "../../store/toasts";
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, Menu, MenuContent, MenuItem, MenuTrigger } from "../ui/overlays";
import { Skeleton } from "../ui/primitives";
import { CopyButton } from "./CodeBlock";

// ---------------------------------------------------------------------------
// Mermaid: a fenced ```mermaid block rendered as a diagram, toggling to its source
// ---------------------------------------------------------------------------
type MermaidState = { status: "loading" } | { status: "ok"; svg: string } | { status: "error"; error: string };

/** Streaming text changes the source every few ms; render once it has settled. */
const RENDER_DEBOUNCE_MS = 200;

export const MermaidBlock = memo(function MermaidBlock({ code }: { code: string }) {
  const dark = useIsDark();
  const [state, setState] = useState<MermaidState>({ status: "loading" });
  const [source, setSource] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      renderMermaid(code).then(
        (svg) => !cancelled && setState({ status: "ok", svg }),
        (e: unknown) => !cancelled && setState({ status: "error", error: mermaidErrorLine(e) }),
      );
    }, RENDER_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, dark]);

  const failed = state.status === "error";
  const showCode = source || failed;
  const html = useMemo(() => (showCode ? highlightToHtml(code, "mermaid") : ""), [code, showCode]);
  return (
    <div className={cn("group/code relative my-3 overflow-hidden rounded-lg border bg-code", failed ? "border-danger/40" : "border-line")} data-testid="mermaid-block" data-state={state.status} data-view={showCode ? "source" : "diagram"}>
      <div className="flex h-7 items-center gap-2 px-3 text-[11px] text-subtle">
        <span className="font-mono">mermaid</span>
        {failed && (
          <span className="min-w-0 flex-1 truncate text-danger" role="alert" data-testid="mermaid-error">
            {state.error}
          </span>
        )}
        {!failed && <span className="flex-1" />}
        {!failed && state.status === "ok" && (
          <button
            type="button"
            aria-label={source ? t("viz.diagram") : t("viz.source")}
            title={source ? t("viz.diagram") : t("viz.source")}
            aria-pressed={source}
            onClick={() => setSource((v) => !v)}
            className="inline-flex size-6 items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg"
            data-testid="mermaid-toggle"
          >
            {source ? <Workflow className="size-3.5" /> : <Code className="size-3.5" />}
          </button>
        )}
        <CopyButton text={code} label={t("tx.copyCode")} className="opacity-0 focus-visible:opacity-100 group-hover/code:opacity-100" />
      </div>
      {showCode ? (
        <pre className="overflow-x-auto px-3 pb-3 font-mono text-[12.5px] leading-relaxed">
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      ) : state.status === "ok" ? (
        <div className="workstation-visual flex justify-center overflow-x-auto bg-surface/60 p-3" data-testid="mermaid-diagram" dangerouslySetInnerHTML={{ __html: state.svg }} />
      ) : (
        <div className="px-3 pb-3" role="status" aria-label={t("viz.loading")}>
          <Skeleton className="h-24" />
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// show_visual figure
// ---------------------------------------------------------------------------
const DEFAULT_FRAME_HEIGHT = 320;
const MIN_FRAME_HEIGHT = 80;
const MAX_FRAME_HEIGHT = 1600;
/** Smallest height a frame shrinks to when it fits its content. */
const MIN_FIT_HEIGHT = 24;
const MAX_PROMPT_CHARS = 4000;
/** Added to a reported content height so sub-pixel rounding never leaves a scrollbar inside the frame. */
const HEIGHT_SLACK = 4;

/**
 * An HTML visual in an iframe with an opaque origin: `sandbox="allow-scripts"` (never same-origin, navigation, popups
 * or forms) and a CSP in the document. The frame talks to the app by postMessage only: it reports its content height
 * (the frame grows to fit, capped, then scrolls) and `sendPrompt(text)` hands text to `onPrompt`. Messages count only
 * when their source is this frame's window. The theme is pushed by message, so a theme change keeps the frame's state.
 */
export function HtmlFrame({ html, title, height, onHeight, onPrompt, fill }: { html: string; title: string; height?: number; onHeight?: (h: number) => void; onPrompt?: (text: string) => void; fill?: boolean }) {
  const dark = useIsDark();
  const frame = useRef<HTMLIFrameElement>(null);
  const initialDark = useRef(dark);
  const srcDoc = useMemo(() => visualSrcdoc(html, initialDark.current), [html]);
  const drag = useRef<{ y: number; h: number } | null>(null);
  const [own, setOwn] = useState(DEFAULT_FRAME_HEIGHT);
  const h = height ?? own;
  const setH = onHeight ?? setOwn;
  const set = (n: number) => setH(Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.round(n))));
  const live = useRef({ setH, onPrompt });
  live.current = { setH, onPrompt };

  const pushTheme = useCallback(() => void frame.current?.contentWindow?.postMessage({ source: VISUAL_MSG, type: "theme", dark, css: visualThemeCss(dark) }, "*"), [dark]);
  useEffect(pushTheme, [pushTheme]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const d: unknown = e.data;
      if (typeof d !== "object" || d === null || (d as { source?: unknown }).source !== VISUAL_MSG) return;
      const m = d as { type?: unknown; height?: unknown; text?: unknown };
      if (m.type === "height" && typeof m.height === "number" && Number.isFinite(m.height) && m.height >= 0) {
        live.current.setH(Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FIT_HEIGHT, Math.ceil(m.height) + HEIGHT_SLACK)));
      } else if (m.type === "prompt" && typeof m.text === "string" && m.text.trim()) {
        live.current.onPrompt?.(m.text.slice(0, MAX_PROMPT_CHARS));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className={cn(fill && "flex h-full min-h-0 flex-col")}>
      <iframe ref={frame} title={title} sandbox="allow-scripts" srcDoc={srcDoc} referrerPolicy="no-referrer" onLoad={pushTheme} className={cn("block w-full border-0 bg-transparent", fill && "min-h-0 flex-1")} style={fill ? undefined : { height: h }} data-testid="visual-frame" />
      {!fill && onHeight && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-valuenow={h}
          aria-valuemin={MIN_FRAME_HEIGHT}
          aria-valuemax={MAX_FRAME_HEIGHT}
          tabIndex={0}
          className="group/grip flex h-2.5 cursor-ns-resize touch-none items-center justify-center"
          onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
            drag.current = { y: e.clientY, h };
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e: PointerEvent<HTMLDivElement>) => drag.current && set(drag.current.h + e.clientY - drag.current.y)}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
            const step = e.key === "ArrowDown" ? 40 : e.key === "ArrowUp" ? -40 : 0;
            if (!step) return;
            e.preventDefault();
            set(h + step);
          }}
          data-testid="visual-grip"
        >
          <span className="h-0.5 w-8 rounded-full bg-line-strong opacity-0 transition-opacity group-hover/grip:opacity-100 group-focus-visible/grip:opacity-100" />
        </div>
      )}
    </div>
  );
}

export const VisualFigure = memo(function VisualFigure({ title, svg, html, streaming, sessionId }: { title: string; svg?: string; html?: string; streaming?: boolean; sessionId?: string }) {
  const [large, setLarge] = useState(false);
  // `sendPrompt(text)` from the visual lands in the session's composer; the user sends it
  const onPrompt = useMemo(
    () =>
      sessionId
        ? (text: string) => {
            const c = useComposer.getState();
            c.appendText(sessionId, text);
            c.requestFocus();
          }
        : undefined,
    [sessionId],
  );
  const [frameHeight, setFrameHeight] = useState(DEFAULT_FRAME_HEIGHT);
  const host = useRef<HTMLDivElement>(null);
  const clean = useMemo(() => (svg ? sanitizeSvg(svg) : ""), [svg]);
  const kind: "svg" | "html" | null = clean ? "svg" : html ? "html" : null;

  if (streaming) {
    return (
      <figure className="my-1" aria-label={title || undefined} data-testid="visual-figure" data-state="streaming">
        <div role="status" aria-label={t("viz.loading")}>
          <Skeleton className="h-40" />
        </div>
      </figure>
    );
  }

  const exporter = async (as: "svg" | "png") => {
    try {
      const exp = exportSvg(host.current?.querySelector("svg") ?? null);
      if (!exp) throw new Error(t("viz.invalid"));
      if (as === "svg") saveBlob(svgBlob(exp.markup), visualFilename(title, "svg"));
      else saveBlob(await svgToPng(exp), visualFilename(title, "png"));
    } catch (e) {
      toast.error(t("viz.exportFailed"), e instanceof Error ? e.message : undefined);
    }
  };

  const copySource = async () => {
    if (!(await copyText(kind === "svg" ? clean : (html ?? "")))) toast.error(t("viz.exportFailed"));
  };

  return (
    <figure className="group/viz relative my-1" aria-label={title || undefined} data-testid="visual-figure" data-state="done" data-kind={kind ?? "invalid"}>
      {kind && (
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label={t("viz.more")}
              title={t("viz.more")}
              className="absolute right-1 top-1 z-10 inline-flex size-6 items-center justify-center rounded-md bg-surface/80 text-subtle opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/viz:opacity-100 group-focus-within/viz:opacity-100 data-[state=open]:opacity-100"
              data-testid="visual-menu"
            >
              <Ellipsis className="size-4" />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="min-w-[160px]">
            {kind === "svg" && (
              <>
                <MenuItem icon={<Download className="size-3.5" />} onSelect={() => void exporter("svg")}>
                  {t("viz.downloadSvg")}
                </MenuItem>
                <MenuItem icon={<ImageIcon className="size-3.5" />} onSelect={() => void exporter("png")}>
                  {t("viz.downloadPng")}
                </MenuItem>
              </>
            )}
            <MenuItem icon={<Maximize2 className="size-3.5" />} onSelect={() => setLarge(true)}>
              {t("viz.openLarger")}
            </MenuItem>
            <MenuItem icon={<Copy className="size-3.5" />} onSelect={() => void copySource()}>
              {t("viz.copySource")}
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
      <div data-testid="visual-body">
        {kind === "svg" ? (
          <div ref={host} className="workstation-visual" dangerouslySetInnerHTML={{ __html: clean }} />
        ) : kind === "html" ? (
          <HtmlFrame html={html!} title={title || t("viz.openLarger")} height={frameHeight} onHeight={setFrameHeight} onPrompt={onPrompt} />
        ) : (
          <div className="px-3 py-2 text-[12.5px] text-danger" role="alert">
            {t("viz.invalid")}
          </div>
        )}
      </div>
      {kind && (
        <DialogRoot open={large} onOpenChange={setLarge}>
          <DialogPortal>
            <DialogOverlay className="anim-fade fixed inset-0 z-50 bg-black/50" />
            <DialogContent className="anim-pop fixed inset-4 z-50 flex flex-col rounded-xl border border-line bg-surface shadow-[var(--shadow-pop)] sm:inset-8" data-testid="visual-large">
              <div className="flex items-center gap-3 px-4 pt-3">
                <DialogTitle className="min-w-0 flex-1 truncate text-[13px] font-medium text-muted">{title || t("viz.openLarger")}</DialogTitle>
                <DialogDescription className="sr-only">{title || t("viz.openLarger")}</DialogDescription>
                <button type="button" aria-label={t("app.close")} onClick={() => setLarge(false)} className="inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg">
                  <X className="size-4" />
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
                {kind === "svg" ? <div className="workstation-visual workstation-visual-large mx-auto w-full" dangerouslySetInnerHTML={{ __html: clean }} /> : <HtmlFrame html={html!} title={title || t("viz.openLarger")} fill onPrompt={onPrompt && ((text) => (onPrompt(text), setLarge(false)))} />}
              </div>
            </DialogContent>
          </DialogPortal>
        </DialogRoot>
      )}
    </figure>
  );
});
