/** `/?new=code&cwd=<workspace-relative path>`: a new Code session draft rooted in that folder. */
export const MAX_CWD_LENGTH = 300;

/** A workspace-relative folder path: no leading `/`, no `..` segment, at most 300 characters. Returns it without trailing slashes, or null. */
export function validCwd(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_CWD_LENGTH || raw.startsWith("/") || raw.includes("\0")) return null;
  const path = raw.replace(/\/+$/, "");
  if (!path) return null;
  if (path.split(/[\\/]/).some((seg) => seg === "..")) return null;
  return path;
}

export interface NewSessionRoute {
  /** The new Code session draft's working directory; "" = the workspace root (also for an invalid `cwd`). */
  cwd: string;
}

/** Reads the route's query; null when it is not a `new=code` request. */
export function parseNewSessionRoute(search: string): NewSessionRoute | null {
  const q = new URLSearchParams(search);
  if (q.get("new") !== "code") return null;
  return { cwd: validCwd(q.get("cwd")) ?? "" };
}

/** The route that opens a new Code session draft in `cwd`. */
export function newCodeSessionUrl(cwd: string): string {
  return `/?${new URLSearchParams({ new: "code", cwd })}`;
}
