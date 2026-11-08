import { memo, useMemo } from "react";
import { renderTex } from "../../lib/katex";
import { splitMath } from "../../lib/math";

/**
 * Plain message text with its LaTeX rendered (a user bubble): text stays text, `$…$` / `\(…\)` become inline formulas,
 * `$$…$$` / `\[…\]` display ones. No Markdown here: people's own text keeps its characters. Without math it is the text itself.
 */
export const MathText = memo(function MathText({ text }: { text: string }) {
  const segments = useMemo(() => splitMath(text), [text]);
  if (segments.length === 1 && segments[0]!.kind === "text") return <>{text}</>;
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <span key={i}>{seg.text}</span>
        ) : seg.kind === "display" ? (
          <span key={i} className="my-1 block max-w-full overflow-x-auto" dangerouslySetInnerHTML={{ __html: renderTex(seg.tex, true) }} />
        ) : (
          <span key={i} dangerouslySetInnerHTML={{ __html: renderTex(seg.tex, false) }} />
        ),
      )}
    </>
  );
});
