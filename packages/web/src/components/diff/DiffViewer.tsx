import { MergeView, getChunks, getOriginalDoc, goToNextChunk, goToPreviousChunk, originalDocChangeEffect, unifiedMergeView } from "@codemirror/merge";
import { ChangeSet, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import type { Hunk } from "@agent-workstation/protocol";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useIsDark } from "../../hooks/useIsDark";
import { cn } from "../../lib/cn";
import { t } from "../../i18n";
import { chunkInfo, minimalChange, type DiffChunkInfo } from "./chunks";
import { cssVarHighlight, languageForPath } from "./lang";

export type { DiffChunkInfo } from "./chunks";

export interface DiffViewerProps {
  path?: string;
  /** Left side: the local copy (`local` branch). */
  oldText: string;
  /** Right side / document shown: the server's working tree. */
  newText: string;
  /** Hub hunks for the same pair of texts; used to translate viewer chunks into `Hunk.index` values. */
  hunks?: Hunk[];
  layout?: "unified" | "split";
  /** Hide per-chunk Accept/Reject buttons. */
  readOnly?: boolean;
  /** Collapse long unchanged stretches (3 lines of context). Default true. */
  collapseUnchanged?: boolean;
  /** Called instead of mutating the viewer: the host applies the change and re-renders with new props. */
  onAcceptChunk?: (chunk: DiffChunkInfo) => void;
  onRejectChunk?: (chunk: DiffChunkInfo) => void;
  className?: string;
}

export interface DiffViewerHandle {
  chunks(): DiffChunkInfo[];
  goToNext(): void;
  goToPrev(): void;
}

type Inner = { kind: "unified"; view: EditorView } | { kind: "split"; mv: MergeView };

const baseTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--fg)", fontSize: "12.5px" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55", overflow: "visible" },
  ".cm-content": { padding: "4px 0" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--fg-subtle)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "36px" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-collapsedLines": { color: "var(--fg-muted)", background: "var(--sunken)", cursor: "pointer", padding: "2px 12px", fontSize: "12px" },
  ".cm-collapsedLines:hover": { color: "var(--fg)" },
  ".cm-chunkButtons button": { height: "22px", fontSize: "11px", lineHeight: "20px", whiteSpace: "nowrap", boxShadow: "0 1px 2px rgb(0 0 0 / 0.12)" },
  ".cm-deletedChunk .cm-chunkButtons button": { background: "var(--surface)", color: "var(--fg)", border: "1px solid var(--line-strong)", borderRadius: "6px", padding: "0 8px" },
  ".cm-deletedChunk .cm-chunkButtons button[name=accept]": { color: "var(--ok)" },
  ".cm-deletedChunk .cm-chunkButtons button[name=reject]": { color: "var(--danger)" },
  ".cm-deletedChunk .cm-chunkButtons button:hover": { background: "var(--hover)" },

});

/** Builds the Accept/Reject button pair used by both layouts. */
function controlButton(type: "accept" | "reject", compact = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.name = type;
  b.dataset.action = type;
  const label = t(type === "accept" ? "diff.accept" : "diff.reject");
  b.textContent = compact ? (type === "accept" ? "✓" : "✕") : label;
  b.title = label;
  b.setAttribute("aria-label", label);
  if (compact) {
    // The split-view revert gutter lives outside .cm-editor, so editor-scoped theme rules do not reach it: style inline.
    Object.assign(b.style, {
      position: "static",
      width: "20px",
      height: "18px",
      margin: "0",
      padding: "0",
      lineHeight: "16px",
      fontSize: "11px",
      textAlign: "center",
      background: "var(--surface)",
      color: type === "accept" ? "var(--ok)" : "var(--danger)",
      border: "1px solid var(--line-strong)",
      borderRadius: "5px",
      cursor: "pointer",
    });
  }
  return b;
}

export const DiffViewer = forwardRef<DiffViewerHandle, DiffViewerProps>(function DiffViewer(props, ref) {
  const { path, layout = "unified", readOnly = false, collapseUnchanged = true, className, oldText, newText } = props;
  const host = useRef<HTMLDivElement>(null);
  const inner = useRef<Inner | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const controls = !readOnly && !!(props.onAcceptChunk || props.onRejectChunk);
  // CodeMirror picks its built-in light/dark defaults (selection, search, tooltips) from this facet; the diff colors come from CSS tokens.
  const dark = useIsDark();
  const lang = useMemo(() => languageForPath(path), [path]);

  const collect = useCallback((): DiffChunkInfo[] => {
    const cur = inner.current;
    if (!cur) return [];
    const hunks = latest.current.hunks;
    if (cur.kind === "unified") {
      const chunks = getChunks(cur.view.state)?.chunks ?? [];
      const docA = getOriginalDoc(cur.view.state);
      return chunks.map((c, i) => chunkInfo(c, i, docA, cur.view.state.doc, hunks));
    }
    return cur.mv.chunks.map((c, i) => chunkInfo(c, i, cur.mv.a.state.doc, cur.mv.b.state.doc, hunks));
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      chunks: collect,
      goToNext: () => {
        const cur = inner.current;
        const v = cur ? (cur.kind === "unified" ? cur.view : cur.mv.b) : null;
        if (v) goToNextChunk(v);
      },
      goToPrev: () => {
        const cur = inner.current;
        const v = cur ? (cur.kind === "unified" ? cur.view : cur.mv.b) : null;
        if (v) goToPreviousChunk(v);
      },
    }),
    [collect],
  );

  // (Re)create the editor when structure-level options change.
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const { oldText, newText } = latest.current;
    const common: Extension[] = [baseTheme, EditorView.darkTheme.of(dark), lineNumbers(), cssVarHighlight, ...lang, EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping];
    const collapse = collapseUnchanged ? { margin: 3, minSize: 4 } : undefined;

    // The host applies accept/reject; nothing here edits the displayed documents.
    const fire = (type: "accept" | "reject", index: number) => {
      const info = collect()[index];
      if (!info) return;
      (type === "accept" ? latest.current.onAcceptChunk : latest.current.onRejectChunk)?.(info);
    };

    if (layout === "split") {
      const mv = new MergeView({
        a: { doc: oldText, extensions: common },
        b: { doc: newText, extensions: common },
        parent,
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: collapse,
        ...(controls
          ? {
              revertControls: "b-to-a" as const,
              renderRevertControl: () => {
                const wrap = document.createElement("div");
                wrap.className = "cm-chunkButtons";
                Object.assign(wrap.style, { position: "absolute", left: "0", right: "0", display: "flex", flexDirection: "column", alignItems: "center", gap: "2px", paddingTop: "1px" });
                wrap.append(controlButton("accept", true), controlButton("reject", true));
                return wrap;
              },
            }
          : {}),
      });
      // MergeView's own revert handler would copy text between editors; intercept in the capture phase instead.
      const onDown = (e: MouseEvent) => {
        const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-action]");
        const holder = btn?.closest<HTMLElement>("[data-chunk]");
        if (!btn || !holder) return;
        e.preventDefault();
        e.stopPropagation();
        fire(btn.dataset.action as "accept" | "reject", Number(holder.dataset.chunk));
      };
      mv.dom.addEventListener("mousedown", onDown, true);
      inner.current = { kind: "split", mv };
      return () => {
        mv.dom.removeEventListener("mousedown", onDown, true);
        mv.destroy();
        inner.current = null;
      };
    }

    // eslint-disable-next-line prefer-const -- `view` is read by the button handlers that are created before the view exists
    let view: EditorView;
    const onUnifiedClick = (type: "accept" | "reject") => (e: MouseEvent) => {
      e.preventDefault();
      const target = e.target as HTMLElement | null;
      const pos = target ? view.posAtDOM(target) : 0;
      const chunks = getChunks(view.state)?.chunks ?? [];
      const index = chunks.findIndex((c) => c.fromB <= pos && c.endB >= pos);
      if (index >= 0) fire(type, index);
    };
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: newText,
        extensions: [
          ...common,
          unifiedMergeView({
            original: oldText,
            gutter: true,
            highlightChanges: true,
            collapseUnchanged: collapse,
            mergeControls: controls
              ? (type, _action) => {
                  const b = controlButton(type);
                  b.addEventListener("mousedown", onUnifiedClick(type));
                  return b;
                }
              : false,
          }),
        ],
      }),
    });
    inner.current = { kind: "unified", view };
    return () => {
      view.destroy();
      inner.current = null;
    };
    // `latest` carries texts/callbacks; only structural options rebuild the editor.
  }, [layout, controls, collapseUnchanged, lang, collect, dark]);

  // Keep documents in sync with props without rebuilding (minimal edits preserve scroll).
  useEffect(() => {
    const cur = inner.current;
    if (!cur) return;
    if (cur.kind === "unified") {
      const view = cur.view;
      const origDoc = getOriginalDoc(view.state);
      const aChange = minimalChange(origDoc.toString(), oldText);
      const bChange = minimalChange(view.state.doc.toString(), newText);
      if (!aChange && !bChange) return;
      view.dispatch({
        ...(bChange ? { changes: bChange } : {}),
        ...(aChange ? { effects: originalDocChangeEffect(view.state, ChangeSet.of(aChange, origDoc.length)) } : {}),
      });
    } else {
      const aChange = minimalChange(cur.mv.a.state.doc.toString(), oldText);
      const bChange = minimalChange(cur.mv.b.state.doc.toString(), newText);
      if (aChange) cur.mv.a.dispatch({ changes: aChange });
      if (bChange) cur.mv.b.dispatch({ changes: bChange });
    }
  }, [oldText, newText, layout, controls, collapseUnchanged, lang]);

  return <div ref={host} className={cn("min-w-0 overflow-auto", className)} data-testid="diff-viewer" data-layout={layout} />;
});
