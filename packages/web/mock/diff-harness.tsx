// Dev-only visual harness for the DiffViewer: `npx vite` then open /mock/diff-harness.html
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/index.css";
import { DiffHeader } from "../src/components/diff/DiffHeader";
import { DiffViewer, type DiffViewerHandle } from "../src/components/diff/DiffViewer";

const OLD = Array.from({ length: 40 }, (_, i) => `export function step${i + 1}(input: number): number {\n  return input + ${i + 1};\n}`).join("\n\n") + "\n";
const blocks = OLD.trimEnd().split("\n\n");
blocks[2] = "export function step3(input: number): number {\n  // clamp first\n  return Math.max(0, input) + 3;\n}";
blocks[20] = "export function step21(input: number): number {\n  return input * 21;\n}";
blocks.splice(35, 0, "export const extra = 'added';");
const NEW = blocks.join("\n\n") + "\n";

function Harness() {
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [log, setLog] = useState<string[]>([]);
  const ref = useRef<DiffViewerHandle>(null);
  const push = (s: string) => setLog((l) => [s, ...l].slice(0, 5));
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <DiffHeader path="src/app.ts" additions={7} deletions={2} changes={3} onOpenFile={(p) => push(`open ${p}`)} onAcceptAll={() => push("accept all")} onRejectAll={() => push("reject all")} onNext={() => ref.current?.goToNext()} onPrev={() => ref.current?.goToPrev()}>
        <button data-testid="toggle-layout" onClick={() => setLayout(layout === "unified" ? "split" : "unified")}>
          {layout}
        </button>
      </DiffHeader>
      <div style={{ padding: 4, fontSize: 12 }} data-testid="log">
        {log.join(" | ")}
      </div>
      <DiffViewer ref={ref} className="min-h-0 flex-1" path="src/app.ts" oldText={OLD} newText={NEW} layout={layout} onAcceptChunk={(c) => push(`accept ${JSON.stringify(c)}`)} onRejectChunk={(c) => push(`reject ${c.index}`)} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
