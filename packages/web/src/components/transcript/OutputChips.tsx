import type { SessionOutput } from "@agent-workstation/protocol";
import { useEffect, useMemo, useState } from "react";
import { api, downloadFiles, fetchFileBlob } from "../../lib/api";
import { basename } from "../../lib/format";
import type { AssistantBlock } from "../../lib/transcript";
import { t } from "../../i18n";
import { useOutputs } from "../../store/outputs";
import { useSessions } from "../../store/sessions";
import { toast } from "../../store/toasts";
import { imageMimeForPath } from "../files/fileTree";
import { FileCard } from "../ui/FileCard";

const WRITE_TOOLS = /^(write|edit|multiedit|notebookedit)$/i;
const NO_OUTPUTS: SessionOutput[] = [];

/** The file paths the file-writing tool calls of a message name, as the tools were given them. */
export function writtenPaths(blocks: AssistantBlock[]): { paths: string[]; settled: string } {
  const paths: string[] = [];
  const settled: string[] = [];
  for (const b of blocks) {
    if (b.type !== "tool" || !WRITE_TOOLS.test(b.name.replace(/^.*__/, ""))) continue;
    const input = b.input as { file_path?: unknown; notebook_path?: unknown; path?: unknown } | null;
    const p = input?.file_path ?? input?.notebook_path ?? input?.path;
    if (typeof p !== "string" || !p) continue;
    paths.push(p);
    if (b.result && !b.result.isError) settled.push(b.toolUseId);
  }
  return { paths, settled: settled.join(",") };
}

/** Recorded outputs that one of the written paths names (absolute, workspace-relative or relative to the session folder). */
export function matchOutputs(outputs: SessionOutput[], written: string[], cwd: string): SessionOutput[] {
  const norm = written.map((p) => p.replace(/^(\.\/)+/, ""));
  const root = cwd.replace(/^\.?\/+|\/+$/g, "");
  const seen = new Set<string>();
  return outputs.filter((o) => {
    if (o.missing || seen.has(o.path)) return false;
    const rel = root && o.path.startsWith(`${root}/`) ? o.path.slice(root.length + 1) : null;
    const hit = norm.some((p) => p === o.path || p.endsWith(`/${o.path}`) || (rel !== null && (p === rel || p.endsWith(`/${rel}`))));
    if (hit) seen.add(o.path);
    return hit;
  });
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Sizes of files by path, from one folder listing per directory. */
function useSizes(paths: string[]): Record<string, number> {
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const key = paths.join("\n");
  useEffect(() => {
    let cancelled = false;
    const list = key ? key.split("\n") : [];
    for (const dir of new Set(list.map(dirname))) {
      api.filesTree(dir, 1).then(
        (entries) => {
          if (cancelled) return;
          const found: Record<string, number> = {};
          for (const e of entries) if (e.kind === "file" && list.includes(e.path)) found[e.path] = e.size;
          setSizes((s) => ({ ...s, ...found }));
        },
        () => {},
      );
    }
    return () => {
      cancelled = true;
    };
  }, [key]);
  return sizes;
}

export function save(path: string): void {
  downloadFiles(path).catch(() => toast.error(t("files.download.failed")));
}

function ImageChip({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    fetchFileBlob(path).then(
      ({ blob }) => {
        if (cancelled || typeof URL.createObjectURL !== "function") return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      },
      () => {},
    );
    return () => {
      cancelled = true;
      if (made && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(made);
    };
  }, [path]);
  const name = basename(path);
  return (
    <button type="button" onClick={() => save(path)} title={t("tx.userFile", { name })} className="block size-24 overflow-hidden rounded-xl border border-line bg-sunken transition-colors hover:border-strong" data-testid="output-chip" data-kind="image" data-path={path}>
      {url ? <img src={url} alt={name} className="size-full object-cover" /> : <span className="sr-only">{name}</span>}
    </button>
  );
}

/**
 * Compact chips under a Chat message that wrote files into the chat's own folder: icon, name and size, a click downloads
 * the file; images show a small thumbnail. The files come from the session's recorded outputs.
 */
export function OutputChips({ sessionId, blocks }: { sessionId: string; blocks: AssistantBlock[] }) {
  const cwd = useSessions((s) => (s.views[sessionId]?.session ?? s.sessions[sessionId])?.cwd ?? "");
  const recorded = useOutputs((s) => s.bySession[sessionId] ?? NO_OUTPUTS);
  const load = useOutputs((s) => s.load);
  const { paths, settled } = useMemo(() => writtenPaths(blocks), [blocks]);
  // a finished write adds a recorded output: fetch the list again
  useEffect(() => {
    if (settled) void load(sessionId);
  }, [sessionId, settled, load]);
  const files = useMemo(() => (paths.length ? matchOutputs(recorded, paths, cwd) : NO_OUTPUTS), [recorded, paths, cwd]);
  const sizes = useSizes(useMemo(() => files.filter((f) => !imageMimeForPath(f.path)).map((f) => f.path), [files]));
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="output-chips">
      {files.map((f) =>
        imageMimeForPath(f.path) ? (
          <ImageChip key={f.path} path={f.path} />
        ) : (
          <FileCard key={f.path} name={basename(f.path)} size={sizes[f.path]} onClick={() => save(f.path)} />
        ),
      )}
    </div>
  );
}
