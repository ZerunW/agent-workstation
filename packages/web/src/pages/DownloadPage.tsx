import type { AppPlatform, AppRelease } from "@agent-workstation/protocol";
import { Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { detectDevice, PLATFORM_LABEL, type DeviceGuess } from "../lib/appPlatform";
import { formatBytes, formatShortDate } from "../lib/format";
import { t } from "../i18n";

const PLATFORMS: AppPlatform[] = ["mac", "mac-intel"];

/** Newest first (build is the CFBundleVersion timestamp, digits only). */
const newestFirst = (a: AppRelease, b: AppRelease) => {
  const x = BigInt(a.build);
  const y = BigInt(b.build);
  return x === y ? 0 : x > y ? -1 : 1;
};

const href = (platform: AppPlatform, version: string) => `/download/${platform}/${encodeURIComponent(version)}`;

/**
 * Public download page for the Mac app: no username, no hub session. Recommends the build for this Mac (Apple Silicon
 * or Intel); on any other device both builds are offered equally. A platform without a release shows nothing.
 */
export default function DownloadPage() {
  const [releases, setReleases] = useState<AppRelease[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [device, setDevice] = useState<DeviceGuess | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .appReleases()
      .then((r) => !cancelled && setReleases(r))
      .catch(() => !cancelled && (setFailed(true), setReleases([])));
    detectDevice().then((d) => !cancelled && setDevice(d));
    return () => {
      cancelled = true;
    };
  }, []);

  const byPlatform = useMemo(() => {
    const m: Record<AppPlatform, AppRelease[]> = { mac: [], "mac-intel": [] };
    for (const r of releases ?? []) m[r.platform]?.push(r);
    for (const p of PLATFORMS) m[p].sort(newestFirst);
    return m;
  }, [releases]);

  const ready = releases !== null && device !== null;
  const available = PLATFORMS.filter((p) => byPlatform[p].length > 0);

  // Buttons: the recommended build alone on a Mac (the other one when the recommended has no release), both elsewhere.
  const recommended: AppPlatform = device?.mac ? device.platform : "mac";
  const primary: AppPlatform[] = !device?.mac
    ? available
    : available.includes(recommended)
      ? [recommended]
      : available.slice(0, 1);
  const shown = new Set(primary.map((p) => byPlatform[p][0]));

  // Rows: the other architecture's latest first, then older versions per platform (recommended platform first).
  const ordered = [...available].sort((a, b) => (a === recommended ? -1 : b === recommended ? 1 : 0));
  const rows = [
    ...ordered.filter((p) => !primary.includes(p)).map((p) => byPlatform[p][0]),
    ...ordered.flatMap((p) => byPlatform[p].slice(1)),
  ].filter((r) => !shown.has(r));

  const headline = primary.length ? byPlatform[primary[0]][0] : undefined;

  return (
    <div className="flex h-full overflow-y-auto bg-bg px-4 py-10" data-testid="download-page">
      <div className="m-auto flex w-full max-w-sm flex-col items-center text-center">
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-16 shrink-0" data-testid="download-icon" />
        <h1 className="mt-4 text-xl font-semibold tracking-tight">{t("download.title")}</h1>
        {ready && headline && (
          <p className="mt-0.5 text-[13px] text-muted" data-testid="download-version">
            {t("download.version", { version: headline.version })}
          </p>
        )}

        {ready && !headline && (
          <p className="mt-6 text-sm text-muted" data-testid="download-empty">
            {failed ? t("download.failed") : t("download.none")}
          </p>
        )}

        {ready && headline && (
          <>
            <div className="mt-6 flex w-full flex-col gap-2">
              {primary.map((p) => (
                <a
                  key={p}
                  href={href(p, "latest")}
                  data-testid="download-primary"
                  data-platform={p}
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-accent text-[15px] font-medium text-accent-fg transition-colors hover:bg-accent-hover"
                >
                  <Download className="size-4" />
                  {t("download.for", { platform: PLATFORM_LABEL[p] })}
                </a>
              ))}
            </div>
            <p className="mt-3 text-xs text-subtle">{t("download.requires")}</p>

            {rows.length > 0 && (
              <div className="mt-8 w-full">
                <button
                  type="button"
                  onClick={() => setOpen((o) => !o)}
                  aria-expanded={open}
                  data-testid="download-others-toggle"
                  className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
                >
                  {t("download.others")}
                </button>
                {open && (
                  <ul className="mt-3 divide-y divide-line rounded-lg border border-line text-left text-[13px]" data-testid="download-others">
                    {rows.map((r) => (
                      <li key={`${r.platform}/${r.version}`}>
                        <a
                          href={href(r.platform, r.version)}
                          data-testid="download-other"
                          className="flex items-baseline gap-2 px-3 py-2 transition-colors hover:bg-hover"
                        >
                          <span className="flex-1 truncate">
                            {PLATFORM_LABEL[r.platform]} · {r.version}
                          </span>
                          <span className="shrink-0 text-xs text-subtle">
                            {formatShortDate(r.publishedAt)} · {formatBytes(r.sizeBytes)}
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}

        <p className="mt-10 text-xs">
          <a href="/readme" data-testid="download-docs" className="text-subtle underline-offset-2 hover:text-fg hover:underline">
            {t("readme.link")}
          </a>
        </p>
      </div>
    </div>
  );
}
