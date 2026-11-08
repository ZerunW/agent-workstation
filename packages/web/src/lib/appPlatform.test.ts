import { describe, expect, it } from "vitest";
import { detectDevice } from "./appPlatform";

const nav = (o: { platform?: string; ua?: Record<string, unknown>; touch?: number }) =>
  ({ platform: o.platform ?? "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: o.touch ?? 0, userAgentData: o.ua }) as unknown as Navigator;

const uaData = (architecture: string | Error) => ({
  platform: "macOS",
  getHighEntropyValues: async () => {
    if (architecture instanceof Error) throw architecture;
    return { architecture };
  },
});

/** A document whose canvas has WebGL with the given unmasked renderer (undefined: no WebGL, null ext: no debug info). */
const docWith = (renderer: string | undefined, ext = true) =>
  ({
    createElement: () => ({
      getContext: () =>
        renderer === undefined
          ? null
          : {
              getExtension: () => (ext ? { UNMASKED_RENDERER_WEBGL: 37446 } : null),
              getParameter: () => renderer,
            },
    }),
  }) as unknown as Document;

describe("detectDevice", () => {
  it("Chromium: architecture arm → Apple Silicon, x86 → Intel", async () => {
    expect(await detectDevice(nav({ ua: uaData("arm") }), docWith(undefined))).toEqual({ mac: true, platform: "mac" });
    expect(await detectDevice(nav({ ua: uaData("x86") }), docWith(undefined))).toEqual({ mac: true, platform: "mac-intel" });
  });

  it("userAgentData wins over WebGL", async () => {
    expect(await detectDevice(nav({ ua: uaData("x86") }), docWith("Apple M2"))).toEqual({ mac: true, platform: "mac-intel" });
  });

  it("Safari/Firefox: WebGL renderer decides", async () => {
    for (const r of ["Apple M2", "Apple GPU"]) expect(await detectDevice(nav({}), docWith(r))).toEqual({ mac: true, platform: "mac" });
    for (const r of ["Intel(R) Iris(TM) Plus Graphics", "AMD Radeon Pro 5500M", "Intel Inc."]) {
      expect(await detectDevice(nav({}), docWith(r))).toEqual({ mac: true, platform: "mac-intel" });
    }
  });

  it("falls back to WebGL when userAgentData refuses or is unclear", async () => {
    expect(await detectDevice(nav({ ua: uaData(new Error("blocked")) }), docWith("Intel Iris"))).toEqual({ mac: true, platform: "mac-intel" });
    expect(await detectDevice(nav({ ua: uaData("") }), docWith("Intel Iris"))).toEqual({ mac: true, platform: "mac-intel" });
  });

  it("unknown → Apple Silicon", async () => {
    expect(await detectDevice(nav({}), docWith(undefined))).toEqual({ mac: true, platform: "mac" });
    expect(await detectDevice(nav({}), docWith("Apple M2", false))).toEqual({ mac: true, platform: "mac" });
    expect(await detectDevice(nav({}), docWith("SwiftShader"))).toEqual({ mac: true, platform: "mac" });
  });

  it("non-Mac devices are not guessed", async () => {
    expect(await detectDevice(nav({ platform: "Win32" }), docWith("Intel"))).toEqual({ mac: false });
    expect(await detectDevice(nav({ platform: "Linux x86_64" }), docWith("Intel"))).toEqual({ mac: false });
    expect(await detectDevice(nav({ ua: { platform: "Windows", getHighEntropyValues: async () => ({ architecture: "x86" }) } }), docWith(undefined))).toEqual({ mac: false });
    // iPad Safari says MacIntel but has a touch screen
    expect(await detectDevice(nav({ touch: 5 }), docWith("Apple GPU"))).toEqual({ mac: false });
  });
});
