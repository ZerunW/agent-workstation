/**
 * The readme pages: two Markdown files kept in the repo (`docs/readme/features.md`, `docs/readme/getting-started.md`),
 * deployed with the rest of docs/ and read from `[paths] docs_dir` on every request, so a changed page needs no restart.
 * Served by routes/readme.ts (the web and Mac readme, the docs assistant) and read by agents through `read_workstation_docs`
 * (sessions/docs.ts).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReadmeDocName } from "@agent-workstation/protocol";

export const README_DOCS: readonly ReadmeDocName[] = ["features", "getting-started"];

export function isReadmeDoc(v: unknown): v is ReadmeDocName {
  return typeof v === "string" && (README_DOCS as readonly string[]).includes(v);
}

/** The Markdown of one page (null when the file is missing or unreadable). */
export async function readReadmeDoc(docsDir: string, doc: ReadmeDocName): Promise<string | null> {
  try {
    return await readFile(join(docsDir, "readme", `${doc}.md`), "utf8");
  } catch {
    return null;
  }
}
