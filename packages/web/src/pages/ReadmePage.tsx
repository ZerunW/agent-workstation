import type { ReadmeDocName, ReadmeDocResponse } from "@agent-workstation/protocol";
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, NavLink, useLocation } from "react-router-dom";
import { ReadmeAssistant } from "../components/readme/ReadmeAssistant";
import { Markdown } from "../components/transcript/Markdown";
import { Skeleton } from "../components/ui/primitives";
import { t } from "../i18n";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { parseReadme, README_TABS, tableOfContents, type ReadmeBlock } from "../lib/readme";

function Blocks({ blocks }: { blocks: ReadmeBlock[] }) {
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === "md" ? (
          <Markdown key={i} text={b.text} headingIds />
        ) : (
          <details key={i} open={b.open || undefined} className="readme-details">
            <summary>{b.summary}</summary>
            <div className="readme-details-body">
              <Blocks blocks={b.body} />
            </div>
          </details>
        ),
      )}
    </>
  );
}

function View({ doc }: { doc: ReadmeDocName }) {
  const [docs, setDocs] = useState<Partial<Record<ReadmeDocName, ReadmeDocResponse>>>({});
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  // the assistant is shown while the latest page answer says it is available; a 403 from it ends that for this view
  const [assistant, setAssistant] = useState(false);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    setFailed(false);
    const ctrl = new AbortController();
    api
      .readmeDoc(doc, ctrl.signal)
      .then((r) => {
        if (ctrl.signal.aborted) return;
        setDocs((d) => ({ ...d, [doc]: r }));
        setAssistant(r.assistant);
      })
      .catch(() => !ctrl.signal.aborted && setFailed(true));
    return () => ctrl.abort();
  }, [doc, retry]);

  const current = docs[doc];
  const blocks = useMemo(() => (current ? parseReadme(current.markdown) : []), [current]);
  const toc = useMemo(() => tableOfContents(blocks), [blocks]);

  return (
    <div className="h-full overflow-y-auto bg-bg text-fg" data-testid="readme-page">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-[1060px] items-center gap-5 px-4">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-5 shrink-0" />
            {t("readme.title")}
          </span>
          <nav role="tablist" aria-label={t("readme.tabs")} className="flex h-full items-stretch gap-4">
            {README_TABS.map((tab) => (
              <NavLink
                key={tab.doc}
                to={tab.path}
                end
                role="tab"
                aria-selected={tab.doc === doc}
                data-testid={`readme-tab-${tab.doc}`}
                className={({ isActive }) =>
                  cn(
                    "flex items-center border-b-2 text-[13px] transition-colors",
                    isActive ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg",
                  )
                }
              >
                {t(tab.label)}
              </NavLink>
            ))}
          </nav>
          <Link to="/" className="ml-auto text-xs text-muted underline-offset-2 hover:text-fg hover:underline">
            {t("readme.openApp")}
          </Link>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1060px] gap-12 px-4 py-8">
        <main role="tabpanel" className="min-w-0 max-w-[760px] flex-1" data-testid="readme-content">
          {current ? (
            <Blocks blocks={blocks} />
          ) : failed ? (
            <p className="text-sm text-muted" data-testid="readme-failed">
              {t("readme.failed")}{" "}
              <button type="button" onClick={() => setRetry((n) => n + 1)} className="underline underline-offset-2 hover:text-fg">
                {t("app.retry")}
              </button>
            </p>
          ) : (
            <div className="space-y-3" aria-busy>
              <Skeleton className="h-7 w-1/2" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}
        </main>
        {toc.length > 1 && (
          <aside className="hidden w-48 shrink-0 xl:block" data-testid="readme-toc">
            <nav aria-label={t("readme.toc")} className="sticky top-20 text-[13px]">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">{t("readme.toc")}</p>
              <ul className="space-y-1.5 border-l border-line">
                {toc.map((e, i) => (
                  <li key={`${e.id}-${i}`}>
                    <a
                      href={`#${e.id}`}
                      onClick={(ev) => {
                        ev.preventDefault();
                        document.getElementById(e.id)?.scrollIntoView({ block: "start" });
                      }}
                      className="-ml-px block border-l border-transparent pl-3 text-muted transition-colors hover:border-strong hover:text-fg"
                    >
                      {e.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>
        )}
      </div>

      {assistant && !denied && <ReadmeAssistant onDenied={() => setDenied(true)} />}
    </div>
  );
}

/** /readme (Features) and /readme/get-started: public docs pages with an optional docs assistant. */
export default function ReadmePage() {
  const { pathname } = useLocation();
  const tab = README_TABS.find((x) => x.path === (pathname.replace(/\/+$/, "") || "/"));
  if (!tab) return <Navigate to="/readme" replace />;
  return <View doc={tab.doc} />;
}
