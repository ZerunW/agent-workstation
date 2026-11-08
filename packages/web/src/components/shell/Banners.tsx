import { useNavigate } from "react-router-dom";
import { t } from "../../i18n";
import { useApp } from "../../store/app";
import { Banner } from "../ui/primitives";

/** Non-modal banners stacked above the top bar: connection, login, remote switch, disk, notices. */
export function Banners() {
  const conn = useApp((s) => s.conn);
  const me = useApp((s) => s.me);
  const disk = useApp((s) => s.disk);
  const notices = useApp((s) => s.notices);
  const dismissNotice = useApp((s) => s.dismissNotice);
  const setRight = useApp((s) => s.setRight);
  const setMode = useApp((s) => s.setMode);
  const navigate = useNavigate();

  const openTab = (tab: "files") => {
    setMode("code");
    setRight(true, tab);
  };

  const rows: React.ReactNode[] = [];
  if (conn === "reconnecting") rows.push(<Banner key="conn" tone="warn">{t("app.offline")}</Banner>);

  if (me && me.settings.remoteClaudeEnabled === false) rows.push(<Banner key="remote" tone="warn">{t("banner.remoteDisabled")}</Banner>);

  if (disk && disk.level === "block")
    rows.push(
      <Banner
        key="disk"
        tone="danger"
        role="alert"
        action={
          <span className="flex shrink-0 gap-1">
            <button className="rounded-md px-2 text-xs font-medium text-accent hover:bg-hover" onClick={() => dismissDiskModalToggle()}>{t("banner.disk.review")}</button>
            <button className="rounded-md px-2 text-xs font-medium text-accent hover:bg-hover" onClick={() => openTab("files")}>{t("banner.disk.openFiles")}</button>
          </span>
        }
      >
        {t("banner.disk.block", { used: Math.round(disk.usedPercent) })}
      </Banner>,
    );
  else if (disk && disk.level === "warn")
    rows.push(
      <Banner
        key="disk"
        tone="warn"
        action={
          <span className="flex shrink-0 gap-1">
            <button className="rounded-md px-2 text-xs font-medium text-accent hover:bg-hover" onClick={() => dismissDiskModalToggle()}>{t("banner.disk.review")}</button>
            <button className="rounded-md px-2 text-xs font-medium text-accent hover:bg-hover" onClick={() => openTab("files")}>{t("banner.disk.openFiles")}</button>
          </span>
        }
      >
        {t("banner.disk.warn", { used: Math.round(disk.usedPercent) })}
      </Banner>,
    );

  function dismissDiskModalToggle() {
    useApp.setState({ diskModalDismissed: false });
  }

  for (const n of notices) {
    if (n.code === "remote_disabled" || n.code.startsWith("disk")) continue; // covered above
    if (n.code === "rate_limit") {
      rows.push(
        <Banner key={n.id} tone="warn" onDismiss={() => dismissNotice(n.id)}>
          {n.message || t("banner.rateLimit.noTime")}
        </Banner>,
      );
      continue;
    }
    const tone = n.level === "error" ? "danger" : n.level === "warning" ? "warn" : "info";
    const text = n.code === "weekly_limit" ? n.message || t("banner.weeklyLimit") : n.message;
    rows.push(
      <Banner
        key={n.id}
        tone={tone}
        onDismiss={() => dismissNotice(n.id)}
        action={n.code === "weekly_limit" ? <button className="shrink-0 rounded-md px-2 text-xs font-medium text-accent hover:bg-hover" onClick={() => navigate("/usage")}>{t("sidebar.usage")}</button> : undefined}
      >
        {text}
      </Banner>,
    );
  }
  if (rows.length === 0) return null;
  return <div className="shrink-0" data-testid="banners">{rows}</div>;
}
