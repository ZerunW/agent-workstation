import katex from "katex";
// The stylesheet and its fonts ship in the bundle (Vite copies them next to the assets): no CDN, also in the embed.
import "katex/dist/katex.min.css";

/** KaTeX's own options for everything we render: no throwing on bad TeX (the error shows as red source), no `\href`/`\url` trust. */
export const KATEX_OPTIONS = { throwOnError: false, errorColor: "var(--danger)", strict: "ignore", trust: false, output: "htmlAndMathml" } as const;

/** Trusted HTML from KaTeX for one formula (inline or display). The TeX source rides along in an `<annotation>` for copying. */
export function renderTex(tex: string, display: boolean): string {
  return katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display });
}
