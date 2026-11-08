import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appCsp, inlineScriptHashes } from "../src/securityHeaders.js";
import { hubFixture, type HubFixture } from "./helpers.js";

const THEME = `
      try {
        var t = localStorage.getItem("workstation.theme");
        if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
      } catch (e) {}
    `;
const INDEX = `<!doctype html><html><head><script>${THEME}</script><script type="module" crossorigin src="/assets/index-x.js"></script></head><body><div id="root"></div></body></html>`;
const EMBED = `<!doctype html><html><head><script>var c = window.workstationEmbedConfig;</script><script type="module" src="/assets/embed-x.js"></script></head><body class="embed"></body></html>`;
const sha = (s: string) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

let h: HubFixture;
afterEach(async () => {
  await h?.close();
});

async function webHub(): Promise<HubFixture> {
  h = await hubFixture({}, (dir) => {
    const web = join(dir, "web");
    mkdirSync(join(web, "assets"), { recursive: true });
    writeFileSync(join(web, "index.html"), INDEX);
    writeFileSync(join(web, "embed.html"), EMBED);
    writeFileSync(join(web, "assets", "index-x.js"), "console.log(1)");
    return { paths: { web_dist: web } };
  });
  return h;
}

describe("security headers", () => {
  it("hashes only inline scripts", () => {
    expect(inlineScriptHashes(INDEX)).toEqual([sha(THEME)]);
    expect(inlineScriptHashes(`<script src="/a.js"></script><script>  </script>`)).toEqual([]);
    expect(appCsp("")).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
    );
  });

  it("serves index.html, embed.html and the SPA fallback with the strict CSP; every response gets nosniff + Referrer-Policy", async () => {
    await webHub();
    for (const url of ["/", "/index.html", "/usage", "/sessions/abc"]) {
      const r = await h.app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(200);
      const csp = String(r.headers["content-security-policy"]);
      expect(csp, url).toContain(`script-src 'self' ${sha(THEME)}`);
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'self'");
      expect(csp).toContain("connect-src 'self' ws: wss:");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["referrer-policy"]).toBe("same-origin");
    }
    const embed = await h.app.inject({ method: "GET", url: "/embed.html" });
    expect(String(embed.headers["content-security-policy"])).toContain(`script-src 'self' ${sha("var c = window.workstationEmbedConfig;")}`);

    const asset = await h.app.inject({ method: "GET", url: "/assets/index-x.js" });
    expect(asset.headers["content-security-policy"]).toBeUndefined();
    expect(asset.headers["x-content-type-options"]).toBe("nosniff");

    const api = await h.app.inject({ method: "GET", url: "/api/health" });
    expect(api.headers["content-security-policy"]).toBeUndefined();
    expect(api.headers["x-content-type-options"]).toBe("nosniff");
    expect(api.headers["referrer-policy"]).toBe("same-origin");
  });

  it("keeps the sandbox CSP on inline file previews", async () => {
    await webHub();
    mkdirSync(join(h.root, "alice", "inbox"), { recursive: true });
    await h.app.inject({ method: "GET", url: "/api/me", headers: h.as("alice") });
    writeFileSync(join(h.root, "alice", "inbox", "page.html"), "<script>alert(1)</script>");
    const r = await h.app.inject({ method: "GET", url: "/api/files/download?path=inbox/page.html&inline=1", headers: h.as("alice") });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-security-policy"]).toBe("sandbox");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("same-origin");
  });
});
