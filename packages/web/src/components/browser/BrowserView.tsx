import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { clickCount, keyInput, mapPoint, mouseButton, textInputs, wheelPixels, type Size } from "../../lib/browser";
import { t } from "../../i18n";
import { sendBrowserInput } from "../../store/hub";
import { useBrowser, type BrowserFrame } from "../../store/browser";
import { Spinner } from "../ui/primitives";

const MOVE_EVERY_MS = 40;
const FALLBACK_VIEWPORT: Size = { width: 1280, height: 800 };

/**
 * The remote page: the latest frame on a canvas (scaled to fit, aspect kept) and the person's mouse / wheel / keyboard / text
 * input sent back in viewport CSS pixels. Keys go to the page only while the view has focus (a hidden textarea holds it, so
 * IME and paste work); ⌘-shortcuts stay with the app.
 */
export function BrowserView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [capturing, setCapturing] = useState(false);
  const hasFrame = useBrowser((s) => !!s.frame);
  const frameSize = useRef<Size | null>(null);
  const viewport = useRef<Size>(FALLBACK_VIEWPORT);
  const composing = useRef(false);
  const dragging = useRef(false);
  const move = useRef<{ last: number; timer: ReturnType<typeof setTimeout> | null; pending: { x: number; y: number } | null }>({ last: 0, timer: null, pending: null });

  useEffect(() => {
    return useBrowser.subscribe((s) => {
      if (s.state?.viewport) viewport.current = s.state.viewport;
    });
  }, []);
  useEffect(() => {
    viewport.current = useBrowser.getState().state?.viewport ?? FALLBACK_VIEWPORT;
  }, []);

  // ---- drawing: at most one decode + draw per animation frame, always of the newest frame ----------------
  useEffect(() => {
    let raf = 0;
    let latest: BrowserFrame | null = useBrowser.getState().frame;
    let drawn: BrowserFrame | null = null;
    let count = 0;
    const draw = () => {
      raf = 0;
      const canvas = canvasRef.current;
      const frame = latest;
      if (!canvas || !frame || frame === drawn) return;
      drawn = frame;
      const img = new Image();
      img.onload = () => {
        if (frame !== latest) return; // a newer frame is already on its way
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        if (canvas.width !== frame.width) canvas.width = frame.width;
        if (canvas.height !== frame.height) canvas.height = frame.height;
        ctx.drawImage(img, 0, 0, frame.width, frame.height);
        frameSize.current = { width: frame.width, height: frame.height };
        canvas.dataset.frames = String(++count);
      };
      img.src = `data:image/jpeg;base64,${frame.data}`;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const unsub = useBrowser.subscribe((s) => {
      if (s.frame === latest) return;
      latest = s.frame;
      if (latest) schedule();
    });
    if (latest) schedule();
    return () => {
      unsub();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // ---- helpers ---------------------------------------------------------------------------------------
  const point = (clientX: number, clientY: number, clamp = false) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    const frame = frameSize.current ?? viewport.current;
    return mapPoint({ left: r.left, top: r.top, width: r.width, height: r.height }, frame, viewport.current, clientX, clientY, clamp);
  };
  const focusInput = () => taRef.current?.focus({ preventScroll: true });

  // ---- mouse ---------------------------------------------------------------------------------------------
  const flushMove = () => {
    const m = move.current;
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    if (!m.pending) return;
    sendBrowserInput({ kind: "mouse", action: "move", ...m.pending });
    m.pending = null;
    m.last = Date.now();
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const p = point(e.clientX, e.clientY);
    if (!p) return;
    const m = move.current;
    m.pending = p;
    const wait = MOVE_EVERY_MS - (Date.now() - m.last);
    if (wait <= 0) flushMove();
    else if (!m.timer) m.timer = setTimeout(flushMove, wait);
  };
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); // keep the text caret / selection of the app out of it
    focusInput();
    const p = point(e.clientX, e.clientY);
    if (!p) return;
    flushMove();
    dragging.current = true;
    sendBrowserInput({ kind: "mouse", action: "down", ...p, button: mouseButton(e.button), clickCount: clickCount(e.detail) });
  };
  // the button can be released outside the canvas: listen on the window and clamp to the image edge
  useEffect(() => {
    const up = (e: MouseEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      const p = point(e.clientX, e.clientY, true);
      if (!p) return;
      flushMove();
      sendBrowserInput({ kind: "mouse", action: "up", ...p, button: mouseButton(e.button), clickCount: clickCount(e.detail) });
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);
  useEffect(
    () => () => {
      const m = move.current;
      if (m.timer) clearTimeout(m.timer);
    },
    [],
  );

  // ---- wheel: native non-passive listener (React's is passive and could not stop the panel from scrolling) -----
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let acc: { x: number; y: number; dx: number; dy: number } | null = null;
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (!acc) return;
      sendBrowserInput({ kind: "wheel", x: acc.x, y: acc.y, deltaX: acc.dx, deltaY: acc.dy });
      acc = null;
    };
    const onWheel = (e: WheelEvent) => {
      const p = point(e.clientX, e.clientY);
      if (!p) return;
      e.preventDefault();
      const d = wheelPixels(e, el.clientHeight);
      acc = acc ? { x: p.x, y: p.y, dx: acc.dx + d.deltaX, dy: acc.dy + d.deltaY } : { x: p.x, y: p.y, dx: d.deltaX, dy: d.deltaY };
      if (!raf) raf = requestAnimationFrame(flush);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // ---- keyboard / text ------------------------------------------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent) => {
    const input = keyInput({ key: e.key, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing || composing.current, keyCode: e.keyCode });
    if (!input) return;
    e.preventDefault();
    sendBrowserInput(input);
  };
  const sendText = (text: string) => {
    for (const input of textInputs(text)) sendBrowserInput(input);
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text/plain");
    e.preventDefault();
    if (text) sendText(text);
  };
  const onCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    composing.current = false;
    if (e.data) sendText(e.data);
    e.currentTarget.value = "";
  };
  // soft keyboards report `Unidentified` keys and only fill the field
  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    if (composing.current || (e.nativeEvent as InputEvent).isComposing) return;
    const ta = e.currentTarget;
    if (ta.value) sendText(ta.value);
    ta.value = "";
  };

  return (
    <div
      ref={wrapRef}
      data-testid="browser-view"
      data-capturing={capturing}
      className={cn("absolute inset-0 select-none bg-sunken", capturing && "ring-2 ring-inset ring-accent")}
    >
      <canvas
        ref={canvasRef}
        data-testid="browser-canvas"
        className={cn("absolute inset-0 size-full object-contain", !hasFrame && "invisible")}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onContextMenu={(e) => e.preventDefault()}
      />
      {!hasFrame && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner />
        </div>
      )}
      <textarea
        ref={taRef}
        aria-label={t("browser.input")}
        data-testid="browser-input"
        className="absolute left-0 top-0 size-px resize-none overflow-hidden opacity-0"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        onFocus={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onInput={onInput}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={onCompositionEnd}
      />
    </div>
  );
}
