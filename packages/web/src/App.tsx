import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { bootstrap, connectHub, disconnectHub, getSocket, refreshProjects, refreshSessions } from "./store/hub";
import { useProjects } from "./store/projects";
import { useReview } from "./store/review";
import { applyRootTheme } from "./lib/theme";
import { useApp } from "./store/app";
import { autoSignIn, rejectAutoSignIn } from "./lib/whoami";
import { useChanged } from "./store/changed";
import { useComposer } from "./store/composer";
import { useSessions } from "./store/sessions";
import { SearchDialog } from "./components/shell/SearchDialog";
import { useFindHotkey } from "./hooks/useFindHotkey";
import { startShellNotifier } from "./lib/shellNotify";
import { Toaster } from "./components/ui/Toaster";
import { TooltipProvider } from "./components/ui/overlays";
import PickUserPage from "./pages/PickUserPage";
import Workbench from "./pages/Workbench";
import { Skeleton } from "./components/ui/primitives";

// Rarely used pages (and their chart libraries) load on demand.
const UsagePage = lazy(() => import("./pages/UsagePage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage"));
const ProjectReviewPage = lazy(() => import("./pages/ProjectReviewPage"));
const SkillsPage = lazy(() => import("./pages/SkillsPage"));
const SkillEditorPage = lazy(() => import("./pages/SkillEditorPage"));
const MemoryPage = lazy(() => import("./pages/MemoryPage"));
const InstructionsPage = lazy(() => import("./pages/InstructionsPage"));
const BrowserSitesPage = lazy(() => import("./pages/BrowserSitesPage"));
const DownloadPage = lazy(() => import("./pages/DownloadPage"));
const ReadmePage = lazy(() => import("./pages/ReadmePage"));

const PageFallback = () => (
  <div className="mx-auto max-w-3xl space-y-3 p-8" aria-busy>
    <Skeleton className="h-6 w-1/3" />
    <Skeleton className="h-24 w-full" />
    <Skeleton className="h-24 w-full" />
  </div>
);

const Lazy = ({ children }: { children: ReactNode }) => <Suspense fallback={<PageFallback />}>{children}</Suspense>;

function useTheme() {
  const theme = useApp((s) => s.theme);
  useEffect(() => applyRootTheme(theme), [theme]);
}

/** Owns the hub connection for the signed-in user: connect, bootstrap, refresh on focus. */
function RequireUser() {
  const user = useApp((s) => s.user);
  const location = useLocation();
  // No stored name: ask the hub who is calling before deciding between the app and the login page.
  const [checking, setChecking] = useState(!user);
  useFindHotkey();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // AgentWorkstation.app only: native notifications for long turns and waiting questions (a no-op in a browser).
  useEffect(() => (user ? startShellNotifier((to) => navigateRef.current(to)) : undefined), [user]);

  useEffect(() => {
    if (!checking) return;
    let cancelled = false;
    void autoSignIn().then(() => {
      if (!cancelled) setChecking(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount
  }, []);

  useEffect(() => {
    if (!user) return;
    connectHub(user);
    let cancelled = false;
    void bootstrap().then(async (r) => {
      if (r === "ok") return;
      rejectAutoSignIn(user);
      if (r === "unauthorized") {
        if (!cancelled) useApp.getState().setUser(null);
      } else {
        // user_bound: this name belongs to another account; sign in with the one the hub suggests
        setChecking(true);
        await autoSignIn(true);
        setChecking(false);
      }
    });
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const sock = getSocket();
      if (sock && sock.getStatus() !== "open") sock.reconnectNow();
      void refreshSessions();
      void refreshProjects();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    const poll = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshSessions();
      void refreshProjects();
    }, 30_000);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      clearInterval(poll);
      disconnectHub();
      useSessions.getState().reset();
      useChanged.getState().clear();
      useProjects.getState().reset();
      useReview.getState().clear();
      useComposer.setState({ drafts: {}, newSettings: {}, newCwd: "", newIncognito: false });
    };
  }, [user]);

  if (checking) return null;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return (
    <>
      <Outlet />
      {/* here, not in the workbench: ⌘F opens it on every page */}
      <SearchDialog />
    </>
  );
}

function AdminGuard() {
  const me = useApp((s) => s.me);
  if (!me) return null;
  if (!me.user.isAdmin) return <Navigate to="/" replace />;
  return (
    <Suspense fallback={<PageFallback />}>
      <AdminPage />
    </Suspense>
  );
}

export default function App() {
  useTheme();
  return (
    <BrowserRouter>
      <TooltipProvider>
        <Routes>
          <Route path="/login" element={<PickUserPage />} />
          <Route path="/download" element={<Lazy><DownloadPage /></Lazy>} />
          <Route path="/readme/*" element={<Lazy><ReadmePage /></Lazy>} />
          <Route element={<RequireUser />}>
            <Route path="/" element={<Workbench />} />
            <Route path="/s/:sessionId" element={<Workbench />} />
            <Route
              path="/usage"
              element={
                <Suspense fallback={<PageFallback />}>
                  <UsagePage />
                </Suspense>
              }
            />
            <Route path="/admin" element={<AdminGuard />} />
            <Route path="/projects" element={<Lazy><ProjectsPage /></Lazy>} />
            <Route path="/projects/:id" element={<Lazy><ProjectReviewPage /></Lazy>} />
            <Route path="/skills" element={<Lazy><SkillsPage /></Lazy>} />
            <Route path="/skills/:scope/:name" element={<Lazy><SkillEditorPage /></Lazy>} />
            <Route path="/memory" element={<Lazy><MemoryPage /></Lazy>} />
            <Route path="/instructions" element={<Lazy><InstructionsPage /></Lazy>} />
            <Route path="/browser-sites" element={<Lazy><BrowserSitesPage /></Lazy>} />
            <Route path="/customize" element={<Navigate to="/" replace />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Toaster />
      </TooltipProvider>
    </BrowserRouter>
  );
}
