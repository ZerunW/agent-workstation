import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { useIsDark } from "../../hooks/useIsDark";
import { cssVarHighlight } from "../diff/lang";

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--fg)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", overflow: "auto" },
  ".cm-content": { padding: "10px 0", caretColor: "var(--fg)" },
  ".cm-line": { padding: "0 14px" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--fg-subtle)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 12px", minWidth: "32px" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-soft)" },
});

export interface MarkdownEditorProps {
  /** Document at mount. Remount (change `key`) to load a different document. */
  initialValue: string;
  onChange: (text: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  ariaLabel?: string;
  className?: string;
}

/**
 * CodeMirror 6 markdown editor. `@codemirror/commands` is not a dependency of this package, so undo/redo is a small
 * snapshot history (coalesced ~0.4 s of typing per step) bound to ⌘Z / ⌘⇧Z / Ctrl+Y, and ⌘S calls `onSave`.
 */
export function MarkdownEditor({ initialValue, onChange, onSave, readOnly = false, ariaLabel, className }: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };
  const dark = useIsDark();
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const view = useRef<EditorView | null>(null);
  const darkSlot = useRef(new Compartment());

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const stack: string[] = [initialValue];
    let idx = 0;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let applying = false;
    // eslint-disable-next-line prefer-const -- referenced by the keymap closures before the view exists
    let editor: EditorView;

    const commit = () => {
      if (pending) clearTimeout(pending);
      pending = null;
      const text = editor.state.doc.toString();
      if (text === stack[idx]) return;
      stack.length = idx + 1;
      stack.push(text);
      idx++;
    };
    const jump = (to: number): boolean => {
      commit();
      if (to < 0 || to >= stack.length || to === idx) return true;
      idx = to;
      applying = true;
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: stack[idx]! } });
      applying = false;
      cb.current.onChange(stack[idx]!);
      return true;
    };

    editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          theme,
          darkSlot.current.of(EditorView.darkTheme.of(darkRef.current)),
          lineNumbers(),
          markdown(),
          cssVarHighlight,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": ariaLabel ?? "Markdown editor", "data-testid": "skill-editor-content" }),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave?.(), true) },
            { key: "Mod-z", preventDefault: true, run: () => jump(idx - 1) },
            { key: "Mod-Shift-z", preventDefault: true, run: () => jump(idx + 1) },
            { key: "Mod-y", preventDefault: true, run: () => jump(idx + 1) },
          ]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || applying) return;
            cb.current.onChange(u.state.doc.toString());
            if (pending) clearTimeout(pending);
            pending = setTimeout(commit, 400);
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      if (pending) clearTimeout(pending);
      view.current = null;
      editor.destroy();
    };
    // the document is fixed at mount; a different document remounts the component
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // light/dark follows the app theme without rebuilding the editor (that would lose the undo history and caret)
  useEffect(() => {
    view.current?.dispatch({ effects: darkSlot.current.reconfigure(EditorView.darkTheme.of(dark)) });
  }, [dark]);

  return <div ref={host} className={className} data-testid="skill-editor" />;
}
