import { describe, expect, it } from "vitest";
import { TargetTracker } from "../src/targets.js";
import { FakeCdp, flush } from "./fakes.js";

describe("TargetTracker", () => {
  it("seeds tabs on start, ignoring DevTools and the full browser's WebUI surfaces", async () => {
    const cdp = new FakeCdp([
      { targetId: "A", url: "https://a.test/" },
      { targetId: "W", url: "chrome://omnibox-popup.top-chrome/" },
      { targetId: "D", url: "devtools://devtools/x" },
      { targetId: "S", type: "service_worker", url: "https://a.test/sw.js" },
      { targetId: "B", url: "https://b.test/" },
    ]);
    const tr = new TargetTracker(cdp);
    await tr.start();
    expect(tr.list().map((t) => t.targetId)).toEqual(["A", "B"]);
    expect(tr.active).toBe("B");
    expect(cdp.calls[0]).toMatchObject({ method: "Target.setDiscoverTargets", params: { discover: true } });
  });

  it("follows new tabs, falls back to the most recently active tab when the active one closes", async () => {
    const cdp = new FakeCdp([{ targetId: "A" }]);
    const tr = new TargetTracker(cdp);
    const actives: (string | null)[] = [];
    tr.on("active", (id) => actives.push(id));
    await tr.start();
    cdp.addTarget({ targetId: "B" });
    cdp.addTarget({ targetId: "C" });
    expect(tr.active).toBe("C");
    tr.activate("A"); // agent selected tab A
    tr.activate("nope");
    expect(tr.active).toBe("A");
    cdp.destroyTarget("A");
    expect(tr.active).toBe("C");
    cdp.destroyTarget("C");
    cdp.destroyTarget("B");
    expect(tr.active).toBeNull();
    expect(actives).toEqual(["A", "B", "C", "A", "C", "B", null]);
  });

  it("reports url/title changes of the active tab only, and refresh() picks up titles", async () => {
    const cdp = new FakeCdp([{ targetId: "A" }, { targetId: "B" }]);
    const tr = new TargetTracker(cdp);
    const infos: string[] = [];
    tr.on("info", (t) => infos.push(`${t.targetId} ${t.url} ${t.title}`));
    await tr.start();
    cdp.updateTarget("A", { url: "https://a.test/" });
    cdp.updateTarget("B", { url: "https://b.test/" });
    cdp.updateTarget("B", { title: "set by JS" }, false); // Chromium sends no event for title changes
    expect(infos).toEqual(["B https://b.test/ "]);
    await tr.refresh();
    await flush();
    expect(tr.activeInfo()?.title).toBe("set by JS");
    expect(infos).toEqual(["B https://b.test/ ", "B https://b.test/ set by JS"]);
  });
});
