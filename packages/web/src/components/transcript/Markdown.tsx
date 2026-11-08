import { Image as ImageIcon } from "lucide-react";
import { Children, isValidElement, memo, useMemo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { cn } from "../../lib/cn";
import { KATEX_OPTIONS } from "../../lib/katex";
import { prepareMarkdownMath } from "../../lib/math";
import { headingId, plainText } from "../../lib/readme";
import { CodeBlock } from "./CodeBlock";
import { useTranscriptHost } from "./host";
import { MermaidBlock } from "./Visuals";

/**
 * Images the page may load: embedded (`data:image/…`, `blob:`) or served by the hub itself (a same-origin path). Any
 * other image URL is never fetched by the person's device — it could carry data out — and shows as a link instead.
 */
export function isLocalImageSrc(src: string | undefined): boolean {
  if (!src) return false;
  if (/^data:image\//i.test(src) || /^blob:/i.test(src)) return true;
  return src.startsWith("/") && !src.startsWith("//");
}

const PATH_LIKE = /^(?:\.{0,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z0-9]{1,8}(?::\d+)?$/;

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

function useComponents(headingIds: boolean): Components {
  const host = useTranscriptHost();
  return {
    // readme pages: anchors for the table of contents
    ...(headingIds ? { h2: ({ children }: { children?: ReactNode }) => <h2 id={headingId(plainText(textOf(children)))}>{children}</h2> } : {}),
    pre({ children }) {
      const child = Children.toArray(children)[0];
      if (isValidElement(child)) {
        const props = (child as ReactElement<{ className?: string; children?: ReactNode }>).props;
        const lang = /language-([\w+-]+)/.exec(props.className ?? "")?.[1];
        const code = textOf(props.children).replace(/\n$/, "");
        if (lang === "mermaid") return <MermaidBlock code={code} />;
        return <CodeBlock code={code} lang={lang} />;
      }
      return <pre>{children}</pre>;
    },
    code({ className, children }) {
      const text = textOf(children);
      if (host.openFile && !className && PATH_LIKE.test(text)) {
        return (
          <code>
            <button type="button" onClick={() => host.openFile?.(text.replace(/:\d+$/, ""))} className="text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid">
              {text}
            </button>
          </code>
        );
      }
      return <code className={className}>{children}</code>;
    },
    img({ src, alt }) {
      const url = typeof src === "string" ? src : undefined;
      if (isLocalImageSrc(url)) return <img src={url} alt={alt ?? ""} />;
      if (!url) return <span>{alt}</span>;
      return (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="external-image"
          className="inline-flex items-center gap-1"
          onClick={(e) => {
            if (/^https?:\/\//i.test(url) && host.openExternal) {
              e.preventDefault();
              host.openExternal(url);
            }
          }}
        >
          <ImageIcon className="size-3.5 shrink-0" aria-hidden />
          {alt || url}
        </a>
      );
    },
    a({ href, children }) {
      const external = !!href && /^https?:\/\//i.test(href);
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => {
            if (external && host.openExternal) {
              e.preventDefault();
              host.openExternal(href!);
            }
          }}
        >
          {children}
        </a>
      );
    },
  };
}

interface MdNode {
  type: string;
  lang?: string | null;
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>;
  position?: { start: { offset?: number } };
  children?: MdNode[];
}

/**
 * After remark-math: `$$x$$` written inline is display math (remark-math calls every text math "inline"), and a fenced
 * ```` ```math ```` block stays a code block (rehype-katex would render it as a formula).
 */
function remarkMathExtras() {
  return (tree: MdNode, file: { value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : "";
    const walk = (node: MdNode) => {
      if (node.type === "code" && node.lang === "math") node.lang = "tex";
      if (node.type === "inlineMath" && node.position?.start.offset !== undefined && source.startsWith("$$", node.position.start.offset)) {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, className: ["language-math", "math-display"] } };
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

const REMARK = [remarkGfm, remarkMath, remarkMathExtras];
const REHYPE: [typeof rehypeKatex, typeof KATEX_OPTIONS][] = [[rehypeKatex, KATEX_OPTIONS]];

/** Assistant Markdown with GFM and LaTeX math (KaTeX, bundled): `$…$`, `\(…\)`, `$$…$$`, `\[…\]`; code is never math. */
export const Markdown = memo(function Markdown({ text, className, headingIds = false }: { text: string; className?: string; headingIds?: boolean }) {
  const components = useComponents(headingIds);
  const source = useMemo(() => prepareMarkdownMath(text), [text]);
  return (
    <div className={cn("prose-workstation", className)}>
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
});
