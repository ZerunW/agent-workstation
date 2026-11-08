import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { EmbedApp } from "./EmbedApp";
import { setApiBase, setApiUser } from "../lib/api";
import { applyTheme, readEmbedConfig } from "./bridge";
import { t } from "../i18n";

const config = readEmbedConfig();
const root = createRoot(document.getElementById("root")!);

if (!config) {
  root.render(
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-[color:var(--fg-muted)]">
      <div>
        <div className="mb-1 font-semibold text-[color:var(--fg)]">{t("embed.notConfigured")}</div>
      </div>
    </div>,
  );
} else {
  applyTheme(config.theme);
  // Child effects run before EmbedApp's own: the connection context must exist before the first request (diff mode fetches on mount).
  setApiBase(config.hubUrl);
  setApiUser(config.user);
  root.render(
    <StrictMode>
      <EmbedApp initial={config} />
    </StrictMode>,
  );
}
