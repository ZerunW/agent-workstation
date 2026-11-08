import { describe, expect, it } from "vitest";
import { exportSvg, isVisualTool, parseVisual, resolveSvgVars, rewriteVisualCdn, sanitizeSvg, VISUAL_BOOTSTRAP, visualFilename, visualSrcdoc } from "./visual";
import { mermaidErrorLine } from "./mermaid";

describe("isVisualTool / parseVisual", () => {
  it("matches show_visual under any MCP prefix", () => {
    expect(isVisualTool("mcp__workstation-visual__show_visual")).toBe(true);
    expect(isVisualTool("show_visual")).toBe(true);
    expect(isVisualTool("mcp__x__show_visual")).toBe(true);
    for (const n of ["Bash", "show_visuals", "mcp__a__show_visual_extra", "visual"]) expect(isVisualTool(n), n).toBe(false);
  });
  it("is tolerant of partial / odd input", () => {
    expect(parseVisual(undefined)).toEqual({ title: "", svg: undefined, html: undefined });
    expect(parseVisual({ title: " T ", svg: "<svg/>", html: "  " })).toEqual({ title: "T", svg: "<svg/>", html: undefined });
    expect(parseVisual({ title: 3, svg: 4 })).toEqual({ title: "", svg: undefined, html: undefined });
  });
});

describe("sanitizeSvg", () => {
  const wrap = (inner: string, attrs = 'viewBox="0 0 10 10"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;

  it("keeps ordinary shapes, text, gradients and viewBox", () => {
    const out = sanitizeSvg(wrap('<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="5" height="5" fill="url(#g)"/><text x="1" y="2" fill="var(--fg)">Hi</text>'));
    expect(out).toContain("<rect");
    expect(out).toContain("<text");
    expect(out).toContain("linearGradient");
    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out).toContain("var(--fg)");
  });

  it("strips <script>, on* handlers, foreignObject (HTML inside), <style>, animate/set and iframes", () => {
    const out = sanitizeSvg(
      wrap(
        '<script>alert(1)</script><rect width="1" height="1" onload="alert(2)" onclick="alert(3)"/><foreignObject width="5" height="5"><div xmlns="http://www.w3.org/1999/xhtml" onmouseover="alert(4)">x<iframe src="https://evil.example"></iframe></div></foreignObject><style>@import url(https://evil.example/x.css);svg{display:none}</style><a href="#a"><animate attributeName="href" values="javascript:alert(5)"/></a><set attributeName="onmouseover" to="alert(6)"/><circle r="1" onerror="alert(7)"/>',
      ),
    );
    expect(out).toContain("<rect");
    expect(out).toContain("<circle");
    for (const bad of ["script", "alert", "onload", "onclick", "onerror", "onmouseover", "foreignObject", "iframe", "<style", "@import", "<animate", "<set"]) expect(out, bad).not.toContain(bad);
  });

  it("drops javascript: and external hrefs, keeps inline raster images", () => {
    const out = sanitizeSvg(
      wrap(
        '<a href="javascript:alert(1)"><text>a</text></a><a xlink:href="javascript:alert(2)" xmlns:xlink="http://www.w3.org/1999/xlink"><text>b</text></a><a href="https://evil.example/x"><text>c</text></a><image href="https://evil.example/p.png" width="1" height="1"/><use href="#sym"/><use href="https://evil.example/s.svg#x"/><image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>',
      ),
    );
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("<use"); // DOMPurify's SVG profile has no <use> at all
    expect(out).toContain("data:image/png;base64,iVBORw0KGgo=");
  });

  it("neutralises url() loads and position in style attributes", () => {
    const out = sanitizeSvg(wrap('<rect width="1" height="1" style="fill:red;position:fixed;z-index:9;filter:url(https://evil.example/f.svg#x)"/><rect width="1" height="1" style="fill:url(#g)"/>'));
    expect(out).not.toContain("evil.example");
    expect(out).not.toMatch(/position|z-index/);
    expect(out).toContain("fill:red");
    expect(out).toContain("url(#g)");
  });

  it("adds a viewBox from numeric width/height; returns '' for non-SVG or empty results", () => {
    expect(sanitizeSvg(wrap("<rect/>", 'width="200" height="100"'))).toContain('viewBox="0 0 200 100"');
    expect(sanitizeSvg("<div>no</div>")).toBe("");
    expect(sanitizeSvg("<script>alert(1)</script>")).toBe("");
    expect(sanitizeSvg("")).toBe("");
  });
});

describe("export helpers", () => {
  it("resolveSvgVars swaps var(--token) and currentColor for concrete colours", () => {
    document.documentElement.style.setProperty("--accent", "#0f766e");
    expect(resolveSvgVars('<rect fill="var(--accent)"/><text fill="var(--nope, #123456)"/><path stroke="currentColor"/><g fill="var(--nope2)"/>', "#111")).toBe('<rect fill="#0f766e"/><text fill="#123456"/><path stroke="#111"/><g fill="#111"/>');
    document.documentElement.style.removeProperty("--accent");
  });

  it("exportSvg builds standalone markup with xmlns, size and a text fill", () => {
    document.body.innerHTML = '<svg viewBox="0 0 40 20" width="100%" class="x"><text>Hi</text><text fill="red">Yo</text></svg>';
    const exp = exportSvg(document.querySelector("svg"))!;
    expect(exp.width).toBe(40);
    expect(exp.height).toBe(20);
    expect(exp.markup).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(exp.markup).toContain('width="40"');
    expect(exp.markup).toMatch(/<text fill="#[0-9a-f]{6}">Hi<\/text>/i);
    expect(exp.markup).toContain('<text fill="red">Yo</text>');
    expect(exportSvg(document.body)).toBeNull();
  });

  it("loads CDN libraries only through the hub: URLs rewritten, the policy allows no CDN host", () => {
    const html = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script><script src="//cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script><script src="https://evil.example/x.js"></script>';
    expect(rewriteVisualCdn(html, "https://workstation.example.com")).toBe(
      '<script src="https://workstation.example.com/api/visual-cdn/cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script><script src="https://workstation.example.com/api/visual-cdn/cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script><script src="https://evil.example/x.js"></script>',
    );
    const doc = visualSrcdoc(html, false, "https://workstation.example.com");
    const csp = /content="([^"]+)"/.exec(doc)![1]!;
    expect(csp).toContain("script-src 'unsafe-inline' https://workstation.example.com/api/visual-cdn/;");
    expect(csp).not.toMatch(/cdnjs|jsdelivr|evil/);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("img-src data: blob:;");
  });

  it("visualSrcdoc injects the theme variables and the colour scheme", () => {
    document.documentElement.style.setProperty("--fg", "#abcdef");
    const doc = visualSrcdoc("<p>hello</p>", true);
    expect(doc).toContain("--fg:#abcdef");
    expect(doc).toContain("color-scheme:dark");
    expect(doc).toContain("<p>hello</p>");
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain("sendPrompt");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<script>"));
    expect(doc.indexOf("<script>")).toBeLessThan(doc.indexOf("<p>hello</p>"));
    document.documentElement.style.removeProperty("--fg");
  });

  it("visualFilename is filesystem safe", () => {
    expect(visualFilename("Request Flow / v2!", "svg")).toBe("request-flow-v2.svg");
    expect(visualFilename("  ", "png")).toBe("visual.png");
  });
});

describe("visual bootstrap (fake DOM)", () => {
  interface Dims {
    docRect: number;
    docScroll: number;
    bodyScroll: number;
    bodyBottom: number;
    marginBottom: string;
    innerHeight: number;
  }
  function boot(init: Partial<Dims> = {}) {
    const dims: Dims = { docRect: 0, docScroll: 0, bodyScroll: 0, bodyBottom: 0, marginBottom: "0px", innerHeight: 320, ...init };
    const posted: Array<{ type: string; height?: number }> = [];
    const winListeners: Record<string, Array<() => void>> = {};
    const docListeners: Record<string, Array<() => void>> = {};
    const timers: Array<() => void> = [];
    let fontsReady!: () => void;
    const observers: { resize: Array<() => void>; mutation: Array<() => void> } = { resize: [], mutation: [] };
    const parent = { postMessage: (m: { type: string; height?: number }) => posted.push(m) };
    const body = { get scrollHeight() { return dims.bodyScroll; }, getBoundingClientRect: () => ({ bottom: dims.bodyBottom, height: dims.bodyBottom }) };
    const root = { get scrollHeight() { return dims.docScroll; }, getBoundingClientRect: () => ({ height: dims.docRect }) };
    const win = {
      parent,
      get innerHeight() { return dims.innerHeight; },
      pageYOffset: 0,
      addEventListener: (n: string, f: () => void) => (winListeners[n] ??= []).push(f),
    } as Record<string, unknown>;
    const doc = {
      documentElement: root,
      body,
      getElementById: () => null,
      addEventListener: (n: string, f: () => void) => (docListeners[n] ??= []).push(f),
      fonts: { ready: { then: (f: () => void) => (fontsReady = f) } },
    };
    class RO {
      constructor(cb: () => void) {
        observers.resize.push(cb);
      }
      observe() {}
    }
    class MO {
      constructor(cb: () => void) {
        observers.mutation.push(cb);
      }
      observe() {}
    }
    new Function("window", "document", "ResizeObserver", "MutationObserver", "getComputedStyle", "setTimeout", VISUAL_BOOTSTRAP)(win, doc, RO, MO, () => ({ marginBottom: dims.marginBottom }), (f: () => void) => timers.push(f));
    const heights = () => posted.filter((m) => m.type === "height").map((m) => m.height);
    return { dims, heights, winListeners, docListeners, observers, timers, fontsReady: () => fontsReady() };
  }

  it("reports the largest of the scroll heights and the body box with its bottom margin", () => {
    const e = boot({ docRect: 200, bodyScroll: 250, bodyBottom: 240, marginBottom: "30px" });
    e.winListeners.load![0]!();
    expect(e.heights()).toEqual([270]); // body bottom + margin beats both
    e.dims.docScroll = 900; // content taller than the 320 px viewport
    e.observers.resize[0]!();
    expect(e.heights()).toEqual([270, 900]);
  });

  it("does not hold the frame at its own height: a document scroll height within the viewport is ignored", () => {
    const e = boot({ docRect: 100, docScroll: 320, bodyScroll: 90, bodyBottom: 96 });
    e.winListeners.load![0]!();
    expect(e.heights()).toEqual([100]);
  });

  it("re-measures after load, once fonts are ready, on resize and on throttled mutations; repeats are not re-posted", () => {
    const e = boot({ bodyScroll: 100, bodyBottom: 100 });
    e.docListeners.DOMContentLoaded![0]!();
    e.winListeners.load![0]!();
    expect(e.heights()).toEqual([100]);
    e.dims.bodyScroll = 140;
    e.dims.bodyBottom = 140;
    e.fontsReady();
    expect(e.heights()).toEqual([100, 140]);
    e.dims.bodyScroll = 400;
    e.dims.bodyBottom = 400;
    e.observers.resize.forEach((f) => f());
    expect(e.heights()).toEqual([100, 140, 400]);
    // mutations: one timer for a burst, measured when it fires
    e.dims.bodyScroll = 520;
    e.dims.bodyBottom = 520;
    e.observers.mutation[0]!();
    e.observers.mutation[0]!();
    e.observers.mutation[0]!();
    expect(e.timers).toHaveLength(1);
    expect(e.heights()).toEqual([100, 140, 400]);
    e.timers.shift()!();
    expect(e.heights()).toEqual([100, 140, 400, 520]);
    e.observers.mutation[0]!();
    expect(e.timers).toHaveLength(1); // a new burst schedules again
  });
});

describe("mermaidErrorLine", () => {
  it("collapses a multi-line parse error to one line", () => {
    expect(mermaidErrorLine(new Error("Parse error on line 3:\nA --> \n----^\nExpecting 'X', got 'EOF'"))).toBe("Parse error on line 3: Expecting 'X', got 'EOF'");
    expect(mermaidErrorLine(new Error("No diagram type detected"))).toBe("No diagram type detected");
    expect(mermaidErrorLine("x".repeat(300))).toHaveLength(140);
  });
});
