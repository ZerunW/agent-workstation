import { useMemo, useState } from "react";
import { basename } from "../../lib/format";
import { t } from "../../i18n";
import { useApp } from "../../store/app";
import type { ChangedFile } from "../../store/changed";
import { useLoadOutputs, useMergedChanged } from "../../store/outputs";
import { useSessions } from "../../store/sessions";
import { FileIcon } from "../files/FileRow";
import { isUnder } from "../files/fileTree";
import { Card } from "./Card";

const LIMIT = 5;

/** Files this session created or changed (not folders), under `root`, newest first; deleted ones are flagged `missing`. */
export function sessionOutputs(changed: Record<string, ChangedFile>, root: string): Array<{ path: string; at: string; missing: boolean }> {
  return Object.entries(changed)
    .filter(([path, c]) => (c.kind === "add" || c.kind === "change" || c.kind === "unlink") && isUnder(path, root))
    .map(([path, c]) => ({ path, at: c.at, missing: c.kind === "unlink" }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.path.localeCompare(b.path));
}

/** The data behind Files → "Changed this session" (the hub's recorded writes plus live file events), as a short list; a row opens the file in the Files tab preview. Hidden when empty. */
export function OutputsCard({ sessionId }: { sessionId: string | null }) {
  const changed = useMergedChanged(sessionId);
  const cwd = useSessions((s) => {
    const sess = sessionId ? (s.views[sessionId]?.session ?? s.sessions[sessionId]) : undefined;
    return sess?.kind === "code" ? sess.cwd : null;
  });
  const openFile = useApp((s) => s.openFile);
  const [all, setAll] = useState(false);
  const root = (cwd ?? "").replace(/^\.?\/+|\/+$/g, "");
  useLoadOutputs(sessionId, cwd !== null);
  const outputs = useMemo(() => sessionOutputs(changed, root), [changed, root]);

  // Chat sessions have no Files tab to open a file in.
  if (cwd === null || outputs.length === 0) return null;
  const shown = all ? outputs : outputs.slice(0, LIMIT);
  return (
    <Card id="outputs" title={t("overview.outputs")}>
      <ul className="space-y-0.5">
        {shown.map(({ path, missing }) => (
          <li key={path}>
            {missing ? (
              <div
                title={path}
                data-testid="overview-output"
                data-path={path}
                data-missing="true"
                aria-disabled="true"
                className="flex h-7 w-full items-center gap-2 rounded-md px-1 text-left text-muted line-through"
              >
                <FileIcon entry={{ kind: "file", name: basename(path) }} open={false} />
                <span className="min-w-0 flex-1 truncate">{basename(path)}</span>
              </div>
            ) : (
            <button
              type="button"
              onClick={() => openFile(path)}
              title={path}
              data-testid="overview-output"
              data-path={path}
              className="flex h-7 w-full items-center gap-2 rounded-md px-1 text-left hover:bg-hover"
            >
              <FileIcon entry={{ kind: "file", name: basename(path) }} open={false} />
              <span className="min-w-0 flex-1 truncate">{basename(path)}</span>
            </button>
            )}
          </li>
        ))}
      </ul>
      {!all && outputs.length > LIMIT && (
        <button type="button" onClick={() => setAll(true)} data-testid="overview-outputs-more" className="mt-1 px-1 text-xs font-medium text-accent hover:underline">
          {t("overview.showMore")}
        </button>
      )}
    </Card>
  );
}
