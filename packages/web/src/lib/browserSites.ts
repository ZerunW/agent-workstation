/** `https://github.com:8443` -> `github.com:8443`; anything that is not a URL is shown as it came. */
export function siteHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}
