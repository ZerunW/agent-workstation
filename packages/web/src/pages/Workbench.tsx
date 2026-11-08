import { CodeXml, Ghost, MessageSquare, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { ingestFiles } from "../lib/attachments";
import { cn } from "../lib/cn";
import { handleFolderDrop } from "../lib/folderDrop";
import { useNewSessionRoute } from "../hooks/useNewSessionRoute";
import { useHotkeys } from "../hooks/useHotkeys";
import { useIncognitoSession } from "../hooks/useIncognitoSession";
import { useNarrow } from "../hooks/useMediaQuery";
import { t } from "../i18n";
import { rememberSession, useApp } from "../store/app";
import { useComposer } from "../store/composer";
import { subscribeSession } from "../store/hub";
import { useSessions } from "../store/sessions";
import { stopSession } from "../store/actions";
import { Banners } from "../components/shell/Banners";
import { CommandPalette } from "../components/shell/CommandPalette";
import { DiskModal } from "../components/shell/DiskModal";
import { RightPanel } from "../components/shell/RightPanel";
import { Sidebar } from "../components/shell/Sidebar";
import { TopBar } from "../components/shell/TopBar";
import { Composer } from "../components/composer/Composer";
import { Transcript } from "../components/transcript/Transcript";
import { EmptyState, Skeleton } from "../components/ui/primitives";

function SessionPane({ sessionId }: { sessionId: string }) {
  const view = useSessions((s) => s.views[sessionId]);
  const known = useSessions((s) => s.sessions[sessionId]);
  const [missing, setMissing] = useState(false);

  useEffect(() => subscribeSession(sessionId), [sessionId]);

  useEffect(() => {
    setMissing(false);
    if (useSessions.getState().sessions[sessionId]) return;
    let cancelled = false;
    api
      .session(sessionId)
      .then((s) => !cancelled && useSessions.getState().upsertSession(s))
      .catch((e) => {
        if (!cancelled && e instanceof ApiError && (e.status === 404 || e.status === 403)) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (missing && !known)
    return <EmptyState title={t("workbench.notFound")} />;
  if (!view || (!view.session && !known))
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-8" aria-busy>
        <Skeleton className="ml-auto h-10 w-2/5" />
        <Skeleton className="h-24 w-4/5" />
        <Skeleton className="h-16 w-3/5" />
      </div>
    );
  return (
    <>
      <Transcript view={view} />
      <Composer sessionId={sessionId} />
    </>
  );
}

function NewSessionPane() {
  const mode = useApp((s) => s.mode);
  const incognito = useComposer((s) => s.newIncognito) && mode === "chat";
  const Icon = incognito ? Ghost : mode === "chat" ? MessageSquare : CodeXml;
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <Icon className="size-6" />
        </div>
        {incognito ? (
          <>
            <h2 className="text-xl font-semibold tracking-tight" data-testid="incognito-title">{t("incognito.title")}</h2>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold tracking-tight">{t(mode === "chat" ? "workbench.empty.title.chat" : "workbench.empty.title.code")}</h2>
          </>
        )}
      </div>
      <Composer sessionId={null} />
    </>
  );
}

/** Whole-window drop target: images attach inline, other files upload to inbox/, a folder becomes a Code session's directory. */
function useGlobalDrop(draftKey: string, mode: "chat" | "code", navigate: (to: string) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (handleFolderDrop(e.dataTransfer, navigate)) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void ingestFiles(files, draftKey, mode);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [draftKey, mode, navigate]);
  return dragging;
}

export default function Workbench() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const mode = useApp((s) => s.mode);
  const setMode = useApp((s) => s.setMode);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const rightOpen = useApp((s) => s.rightOpen);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const session = useSessions((s) => (sessionId ? s.sessions[sessionId] : undefined));
  const newIncognito = useComposer((s) => s.newIncognito);
  // Leaving an incognito chat (new chat, another session or page) deletes it; closing the tab does too (see store/incognito).
  const openIncognito = useIncognitoSession(sessionId);
  const incognito = openIncognito || (!sessionId && mode === "chat" && newIncognito);

  // The session's kind decides the mode (deep links, palette, sidebar). Incognito chats are never "the last session".
  useEffect(() => {
    if (session && session.kind !== mode) setMode(session.kind);
    if (session && !session.incognito) rememberSession(session.kind, session.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.kind]);


  // Collapse the sidebar when the viewport becomes narrow.
  useEffect(() => {
    if (narrow) {
      toggleSidebar(false);
      useApp.getState().setRight(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow]);

  useHotkeys([
    { key: "k", handler: () => setSearchOpen(!useApp.getState().searchOpen) },
    { key: "p", shift: true, handler: () => setPaletteOpen(!useApp.getState().paletteOpen) },
    {
      key: "n",
      handler: () => {
        navigate("/");
        useComposer.getState().requestFocus();
      },
    },
    { key: "/", handler: () => toggleSidebar() },
    { key: "code:Period", shift: true, handler: () => sessionId && void stopSession(sessionId) },
  ]);

  const draftKey = sessionId ?? `new:${mode}`;
  const dragging = useGlobalDrop(draftKey, mode, navigate);
  useNewSessionRoute();
  const showSidebar = sidebarOpen;
  const showRight = rightOpen;

  return (
    <div className="relative flex h-full overflow-hidden bg-bg">
      {showSidebar && narrow && <div className="anim-fade absolute inset-0 z-30 bg-black/40" onClick={() => toggleSidebar(false)} aria-hidden />}
      {showSidebar && (
        <div className={cn(narrow && "absolute inset-y-0 left-0 z-40 shadow-[var(--shadow-pop)]")}>
          <Sidebar onNavigate={() => narrow && toggleSidebar(false)} />
        </div>
      )}
      <div className="relative flex min-w-0 flex-1 flex-col" data-incognito={incognito ? "true" : undefined}>
        <Banners />
        <TopBar session={session ?? null} narrow={narrow} />
        <div className="relative flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col" aria-label="Conversation">
            {sessionId ? <SessionPane key={sessionId} sessionId={sessionId} /> : <NewSessionPane />}
          </main>
          {showRight && <RightPanel sessionId={sessionId ?? null} overlay={narrow} />}
        </div>
      </div>
      {dragging && (
        <div className="anim-fade pointer-events-none absolute inset-0 z-[60] flex items-center justify-center bg-bg/80 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-surface px-10 py-8 text-center">
            <Upload className="size-6 text-accent" />
            <div className="text-[15px] font-medium">{t(mode === "code" ? "workbench.dropToUpload" : "workbench.dropImages")}</div>
          </div>
        </div>
      )}
      <CommandPalette />
      <DiskModal />
    </div>
  );
}
