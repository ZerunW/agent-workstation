import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Loader2, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getApiUser } from "../../lib/api";
import { t } from "../../i18n";
import { Button } from "../ui/primitives";
import { TerminalSocket, terminalWsUrl, type TerminalConn } from "./terminalSocket";
import { buildXtermTheme } from "./xtermTheme";

export interface TerminalViewProps {
  terminalId: string;
  /** false while the host hides this view (display:none); it refits as soon as it becomes true. Default true. */
  active?: boolean;
  /** Called once when the shell process exits. */
  onExit?: (code: number | null) => void;
  /** When given, the exit overlay offers a "Start new terminal" button. */
  onRestart?: () => void;
}

const isClearShortcut = (e: KeyboardEvent) => e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;

/**
 * One xterm bound to one hub terminal (`/ws/terminal/:id`): fit + resize frames, auto re-attach with
 * backoff, theme from CSS tokens, ⌘K clear. Self-contained (no router/shell imports) so the macOS
 * embed can mount it directly.
 */
export function TerminalView({ terminalId, active = true, onExit, onRestart }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sockRef = useRef<TerminalSocket | null>(null);
  const activeRef = useRef(active);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const [conn, setConn] = useState<TerminalConn>("connecting");
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);

  /** Fit to the container, but never while hidden or zero-sized (that would collapse the pty to 1 col). */
  const fit = useCallback(() => {
    const el = hostRef.current;
    const addon = fitRef.current;
    if (!el || !addon || !activeRef.current || el.clientWidth === 0 || el.clientHeight === 0) return;
    try {
      addon.fit();
    } catch {
      /* xterm not ready yet */
    }
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setConn("connecting");
    setExitCode(undefined);

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "ui-monospace, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10_000,
      allowProposedApi: true,
      theme: buildXtermTheme(),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);
    termRef.current = term;
    fitRef.current = fitAddon;

    const sock = new TerminalSocket({
      url: () => terminalWsUrl(terminalId, getApiUser()),
      onOutput: (data) => term.write(data),
      // The hub replays the tmux screen on every attach: start from an empty buffer so it is not shown twice.
      onAttach: () => term.reset(),
      onStatus: setConn,
      onExit: (code) => {
        setExitCode(code);
        onExitRef.current?.(code);
      },
    });
    sockRef.current = sock;

    const dataSub = term.onData((d) => sock.sendInput(d));
    const resizeSub = term.onResize(({ cols, rows }) => sock.sendResize(cols, rows));

    // ⌘K / Ctrl+K clears the screen and must not reach the app's command palette.
    const onKeyCapture = (e: KeyboardEvent) => {
      if (!isClearShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "keydown") term.clear();
    };
    host.addEventListener("keydown", onKeyCapture, true);
    host.addEventListener("keyup", onKeyCapture, true);
    term.attachCustomKeyEventHandler((e) => !isClearShortcut(e));

    // Size: initial fit + whenever the container changes.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit);
    });
    ro.observe(host);
    fit();
    if (term.cols > 0 && term.rows > 0) sock.sendResize(term.cols, term.rows);

    // Theme follows the OS scheme and the <html data-theme> override.
    const applyTheme = () => {
      term.options.theme = buildXtermTheme();
    };
    const mo = new MutationObserver(applyTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", applyTheme);

    sock.start();

    return () => {
      sock.stop();
      sockRef.current = null;
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      mq?.removeEventListener?.("change", applyTheme);
      host.removeEventListener("keydown", onKeyCapture, true);
      host.removeEventListener("keyup", onKeyCapture, true);
      dataSub.dispose();
      resizeSub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId, fit]);

  // Becoming visible: refit (the container was display:none) and grab focus.
  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    const id = requestAnimationFrame(() => {
      fit();
      const term = termRef.current;
      if (term) {
        sockRef.current?.sendResize(term.cols, term.rows);
        term.focus();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [active, fit]);

  const exited = conn === "exited";
  return (
    <div className="relative h-full w-full bg-code" data-testid="terminal-view" data-conn={conn}>
      <div ref={hostRef} className="xterm-host h-full w-full overflow-hidden" />
      {(conn === "reconnecting" || conn === "connecting") && !exited && (
        <div className="pointer-events-none absolute right-3 top-2 flex items-center gap-1.5 rounded-full border border-line bg-surface/95 px-2.5 py-1 text-xs text-muted shadow-sm" role="status">
          <Loader2 className="size-3 animate-spin" />
          {conn === "connecting" ? t("terminal.loading") : t("terminal.reconnecting")}
        </div>
      )}
      {conn === "closed" && (
        <div className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] shadow-[var(--shadow-pop)]" role="alert">
          <span className="min-w-0 flex-1">{t("terminal.disconnected")}</span>
          <Button size="xs" icon={<RotateCw className="size-3" />} onClick={() => sockRef.current?.retryNow()}>
            {t("app.retry")}
          </Button>
          {onRestart && (
            <Button size="xs" variant="primary" onClick={onRestart}>
              {t("terminal.startNew")}
            </Button>
          )}
        </div>
      )}
      {exited && (
        <div className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] shadow-[var(--shadow-pop)]" role="status">
          <span className="min-w-0 flex-1">{exitCode == null ? t("terminal.exitedNoCode") : t("terminal.exited", { code: exitCode })}</span>
          {onRestart && (
            <Button size="xs" variant="primary" onClick={onRestart}>
              {t("terminal.startNew")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
