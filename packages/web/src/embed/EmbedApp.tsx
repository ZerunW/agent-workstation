import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { Composer } from "../components/composer/Composer";
import { TerminalView } from "../components/terminal/TerminalView";
import { Transcript } from "../components/transcript/Transcript";
import { EmptyState, Skeleton } from "../components/ui/primitives";
import { TooltipProvider } from "../components/ui/overlays";
import { Toaster } from "../components/ui/Toaster";
import { api, setApiBase, setApiUser } from "../lib/api";
import { t } from "../i18n";
import { useApp } from "../store/app";
import { useComposer } from "../store/composer";
import { addServerEventTap, bootstrapEmbed, connectHub, disconnectHub, subscribeSession } from "../store/hub";
import { patchSettings, stopSession } from "../store/actions";
import { useSessions } from "../store/sessions";
import { DiffEmbed, type DiffEmbedHandle } from "./DiffEmbed";
import { applyTheme, installEmbedApi, post, type EmbedConfig } from "./bridge";
import { useHostNotifier } from "./useHostNotifier";

function TranscriptEmbed({ sessionId }: { sessionId: string }) {
  const view = useSessions((s) => s.views[sessionId]);
  const conn = useApp((s) => s.conn);
  const [missing, setMissing] = useState(false);
  useHostNotifier(sessionId);
  useEffect(() => subscribeSession(sessionId), [sessionId]);
  useEffect(() => {
    setMissing(false);
    api
      .session(sessionId)
      .then((s) => useSessions.getState().upsertSession(s))
      .catch(() => setMissing(true));
  }, [sessionId]);
  const host = useMemo(() => ({ openExternal: (url: string) => post({ type: "open_external", url }), openFile: (path: string) => post({ type: "open_file", path }) }), []);

  if (missing && !view?.session) return <EmptyState title={t("workbench.notFound")} />;
  if (!view || !view.session)
    return (
      <div className="space-y-4 p-6" aria-busy>
        <Skeleton className="ml-auto h-10 w-2/5" />
        <Skeleton className="h-20 w-4/5" />
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {conn === "reconnecting" && <div className="bg-warn-soft px-4 py-1.5 text-center text-xs">{t("app.offline")}</div>}
      <Transcript view={view} host={host} />
      <Composer sessionId={sessionId} hidePickers hideStop />
    </div>
  );
}

export function EmbedApp({ initial }: { initial: EmbedConfig }) {
  const [config, setConfig] = useState<EmbedConfig>(initial);
  const diffRef = useRef<DiffEmbedHandle>(null);
  const configRef = useRef(config);
  configRef.current = config;

  // identity + connection ------------------------------------------------------------------
  useEffect(() => {
    setApiBase(config.hubUrl);
    useApp.getState().setUser(config.user);
    setApiUser(config.user);
    if (config.mode === "terminal") return;
    connectHub(config.user);
    void bootstrapEmbed();
    return () => {
      disconnectHub();
      useSessions.getState().reset();
    };
  }, [config.hubUrl, config.user, config.mode]);

  // diff mode refreshes on review_changed
  useEffect(() => {
    if (config.mode !== "diff") return;
    return addServerEventTap((ev) => {
      if (ev.type === "review_changed" && ev.projectId === configRef.current.projectId) diffRef.current?.reload();
    });
  }, [config.mode]);

  // window.workstationEmbed ----------------------------------------------------------------------------
  useEffect(() => {
    const draftKey = () => configRef.current.sessionId ?? "";
    const withSession = (fn: (sessionId: string) => void) => {
      const id = configRef.current.sessionId;
      if (id && configRef.current.mode === "transcript") fn(id);
    };
    const withDiff = (fn: (h: DiffEmbedHandle) => void) => {
      if (configRef.current.mode === "diff" && diffRef.current) fn(diffRef.current);
    };
    const uninstall = installEmbedApi({
      setTheme: (theme) => applyTheme(theme),
      navigate: (target) =>
        setConfig((c) => {
          if (target.sessionId) return { ...c, mode: "transcript", sessionId: target.sessionId };
          if (target.projectId && target.path) return { ...c, mode: "diff", projectId: target.projectId, path: target.path };
          if (target.terminalId) return { ...c, mode: "terminal", terminalId: target.terminalId };
          return c;
        }),
      setUser: (user) => setConfig((c) => (c.user === user ? c : { ...c, user })),
      focusComposer: () => withSession(() => useComposer.getState().requestFocus()),
      insertText: (text) =>
        withSession(() => {
          useComposer.getState().appendText(draftKey(), text);
          useComposer.getState().requestFocus();
        }),
      attachFile: (file) =>
        withSession(() => {
          const name = file.name ?? file.path.split("/").pop() ?? file.path;
          useComposer.getState().addAttachments(draftKey(), [{ type: "file_ref", path: file.path, name, size: file.size }]);
          useComposer.getState().requestFocus();
        }),
      stop: () => withSession((id) => void stopSession(id)),
      applySettings: (settings) =>
        withSession((id) => {
          const patch: Parameters<typeof patchSettings>[1] = {};
          if (settings.model) patch.model = settings.model;
          if (settings.permissionMode) patch.permissionMode = settings.permissionMode as never;
          if (settings.effort !== undefined) patch.effort = settings.effort as never;
          void patchSettings(id, patch);
        }),
      acceptHunks: (indices) => withDiff((h) => h.acceptHunks(indices)),
      acceptFile: () => withDiff((h) => h.acceptFile()),
      rejectHunks: (indices) => withDiff((h) => h.rejectHunks(indices)),
      rejectFile: () => withDiff((h) => h.rejectFile()),
    });
    return uninstall;
  }, []);

  const readyKey = `${config.mode}|${config.sessionId ?? ""}|${config.projectId ?? ""}|${config.path ?? ""}|${config.terminalId ?? ""}`;
  useEffect(() => {
    post({ type: "ready", mode: config.mode });
  }, [readyKey, config.mode]);

  const onOpenFile = useCallback((msg: Record<string, unknown>) => post(msg), []);

  let body;
  if (config.mode === "transcript") {
    body = config.sessionId ? <TranscriptEmbed key={config.sessionId} sessionId={config.sessionId} /> : <EmptyState title={t("embed.notConfigured")} />;
  } else if (config.mode === "diff") {
    body = config.projectId && config.path ? <DiffEmbed ref={diffRef} key={`${config.projectId}:${config.path}`} projectId={config.projectId} path={config.path} post={onOpenFile} className="h-full" /> : <EmptyState title={t("embed.notConfigured")} />;
  } else {
    body = config.terminalId ? (
      <div className="xterm-host h-full bg-code">
        <TerminalView key={config.terminalId} terminalId={config.terminalId} active />
      </div>
    ) : (
      <EmptyState title={t("embed.notConfigured")} />
    );
  }

  return (
    <MemoryRouter>
      <TooltipProvider>
        <div className="h-full bg-bg text-fg" data-testid="embed-root" data-mode={config.mode}>
          {body}
        </div>
        <Toaster />
      </TooltipProvider>
    </MemoryRouter>
  );
}
