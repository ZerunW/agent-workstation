import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { parseNewSessionRoute } from "../lib/newSession";
import { isRightTab, useApp } from "../store/app";
import { useComposer } from "../store/composer";
import { useProjects } from "../store/projects";

/**
 * `/?new=code&cwd=…` opens a new Code draft in that folder; `?panel=<tab>` (on any workbench URL) opens that side-panel
 * tab. Both are then dropped from the URL.
 */
export function useNewSessionRoute(): void {
  const { search, pathname } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const q = new URLSearchParams(search);
    const panel = q.get("panel");
    if (isRightTab(panel)) useApp.getState().setRight(true, panel);
    const route = parseNewSessionRoute(search);
    if (!route) {
      if (q.has("panel")) {
        q.delete("panel");
        const rest = q.toString();
        navigate(rest ? `${pathname}?${rest}` : pathname, { replace: true });
      }
      return;
    }
    useApp.getState().setMode("code");
    const composer = useComposer.getState();
    composer.setNewCwd(route.cwd);
    // A folder the Mac app just linked is a new project: refresh the list (its Sync tab and the sidebar need it).
    if (route.cwd.startsWith("projects/")) void useProjects.getState().load();
    composer.requestFocus();
    navigate("/", { replace: true });
  }, [search, pathname, navigate]);
}
