/**
 * Swift <-> page contract (docs/EMBED-BRIDGE.md).
 *   page -> host : window.webkit.messageHandlers.workstation.postMessage(msg)   (console.debug fallback in a browser)
 *   host -> page : window.workstationEmbed.*  (installed by installEmbedApi)
 */
import { applyRootTheme } from "../lib/theme";

export type EmbedMode = "transcript" | "diff" | "terminal";

export interface EmbedConfig {
  hubUrl: string;
  user: string;
  mode: EmbedMode;
  sessionId?: string;
  projectId?: string;
  path?: string;
  terminalId?: string;
  theme?: "light" | "dark";
  platform?: string;
}

export type HostMessage =
  | { type: "ready"; mode: EmbedMode }
  | { type: "state"; sessionId: string; status: string; queuePosition: number | null }
  | { type: "settings"; sessionId: string; model: string; permissionMode: string; effort: string | null }
  | { type: "permission"; sessionId: string; requestId: string; toolName: string; summary: string; }
  | { type: "permission_resolved"; sessionId: string; requestId: string }
  | { type: "turn_done"; sessionId: string; costUsd: number | null; durationMs: number | null; subtype: string }
  | { type: "open_file"; path: string; projectId?: string }
  | { type: "open_external"; url: string }
  | { type: "notice"; level: string; code: string; message: string }
  | { type: "title"; sessionId: string; title: string };

export function post(message: HostMessage | Record<string, unknown>): void {
  const handler = typeof window !== "undefined" ? window.webkit?.messageHandlers?.workstation : undefined;
  if (handler) {
    try {
      handler.postMessage(message);
    } catch (e) {
      console.warn("[embed] postMessage failed", e);
    }
  } else {
    console.debug("[workstation embed ->host]", message);
  }
}

/** Functions the host may call on `window.workstationEmbed`. All are synchronous and no-ops when they do not apply. */
export interface EmbedApi {
  setTheme(theme: "light" | "dark"): void;
  navigate(target: { sessionId?: string; projectId?: string; path?: string; terminalId?: string }): void;
  setUser(user: string): void;
  focusComposer(): void;
  insertText(text: string): void;
  /** Attach a file that already exists in the workspace (e.g. just uploaded by the host) as a tile in the composer. */
  attachFile(file: { path: string; name?: string; size?: number }): void;
  stop(): void;
  applySettings(settings: { model?: string; permissionMode?: string; effort?: string | null }): void;
  acceptHunks(indices: number[]): void;
  acceptFile(): void;
  rejectHunks(indices: number[]): void;
  rejectFile(): void;
}

export function installEmbedApi(api: EmbedApi): () => void {
  (window as unknown as { workstationEmbed?: EmbedApi }).workstationEmbed = api;
  return () => {
    if ((window as unknown as { workstationEmbed?: EmbedApi }).workstationEmbed === api) delete (window as unknown as { workstationEmbed?: EmbedApi }).workstationEmbed;
  };
}

/** Config from window.workstationEmbedConfig (WKUserScript) or, for browser testing, from query parameters. */
export function readEmbedConfig(win: Pick<Window, "location"> & { workstationEmbedConfig?: unknown } = window as never): EmbedConfig | null {
  const raw = win.workstationEmbedConfig;
  const q = new URLSearchParams(win.location.search);
  const pick = (k: string): string | undefined => {
    const fromObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[k] : undefined;
    if (typeof fromObj === "string" && fromObj) return fromObj;
    return q.get(k) || undefined;
  };
  const user = pick("user");
  const mode = pick("mode") as EmbedMode | undefined;
  if (!user || (mode !== "transcript" && mode !== "diff" && mode !== "terminal")) return null;
  const theme = pick("theme");
  return {
    hubUrl: (pick("hubUrl") ?? "").replace(/\/+$/, ""),
    user,
    mode,
    sessionId: pick("sessionId"),
    projectId: pick("projectId"),
    path: pick("path"),
    terminalId: pick("terminalId"),
    theme: theme === "dark" ? "dark" : theme === "light" ? "light" : undefined,
    platform: pick("platform"),
  };
}

/** `theme` from the host config or `workstationEmbed.setTheme()`: applies to every surface at once (see applyRootTheme). */
export function applyTheme(theme: "light" | "dark" | undefined): void {
  applyRootTheme(theme);
}
