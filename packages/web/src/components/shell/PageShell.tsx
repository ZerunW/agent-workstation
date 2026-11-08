import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { t } from "../../i18n";
import { IconButton } from "../ui/primitives";

/**
 * Chrome for standalone pages (/usage, /admin). `?embed=1` hides the back button so the macOS app can
 * load the page in its own window without double chrome.
 */
export function PageShell({ title, actions, children, maxWidth = "max-w-5xl" }: { title: string; actions?: ReactNode; children: ReactNode; maxWidth?: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const embed = params.get("embed") === "1";
  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        {!embed && (
          <IconButton label={t("app.back")} onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))}>
            <ArrowLeft className="size-4" />
          </IconButton>
        )}
        <h1 className="text-[15px] font-semibold text-fg">{title}</h1>
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto w-full ${maxWidth} px-4 py-6 sm:px-6`}>{children}</div>
      </div>
    </div>
  );
}
