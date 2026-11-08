import type { AppPlatform } from "@agent-workstation/protocol";

export const PLATFORM_LABEL: Record<AppPlatform, string> = { mac: "Apple Silicon", "mac-intel": "Intel" };

/** What the browser says about the device: a Mac (with the build to recommend) or something else. */
export type DeviceGuess = { mac: false } | { mac: true; platform: AppPlatform };

interface UaData {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
}

const uaDataOf = (nav: Navigator) => (nav as Navigator & { userAgentData?: UaData }).userAgentData;

function isMacDevice(nav: Navigator): boolean {
  const uaData = uaDataOf(nav);
  if (uaData?.platform) return uaData.platform === "macOS";
  // iPadOS Safari claims to be a Mac: it has a touch screen, a Mac does not
  return /Mac/i.test(nav.platform || nav.userAgent || "") && !(nav.maxTouchPoints > 1);
}

/** Chromium only: "arm" → Apple Silicon, "x86" → Intel, anything else (or a refusal) → undefined. */
async function fromUserAgentData(nav: Navigator): Promise<AppPlatform | undefined> {
  const uaData = uaDataOf(nav);
  if (!uaData?.getHighEntropyValues) return undefined;
  try {
    const { architecture } = await uaData.getHighEntropyValues(["architecture"]);
    if (architecture === "arm") return "mac";
    if (architecture === "x86") return "mac-intel";
  } catch {
    // blocked by a permissions policy: fall through to WebGL
  }
  return undefined;
}

/** Safari/Firefox always say "Intel" in the UA; the GPU name does not lie ("Apple M2", "Apple GPU", "Intel Iris", "AMD Radeon"). */
function fromWebGL(doc: Document): AppPlatform | undefined {
  try {
    const canvas = doc.createElement("canvas");
    const gl = (canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (!gl || !ext) return undefined;
    const renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "");
    if (/apple/i.test(renderer)) return "mac";
    if (/intel|amd|radeon/i.test(renderer)) return "mac-intel";
  } catch {
    // no WebGL
  }
  return undefined;
}

/** Which build to recommend. Unknown architecture on a Mac → Apple Silicon (every Mac sold since 2020). */
export async function detectDevice(nav: Navigator = navigator, doc: Document = document): Promise<DeviceGuess> {
  if (!isMacDevice(nav)) return { mac: false };
  const platform = (await fromUserAgentData(nav)) ?? fromWebGL(doc) ?? "mac";
  return { mac: true, platform };
}
