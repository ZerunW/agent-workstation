/**
 * GET /api/projects/:id/review/patch: every pending change (`local` → work tree) as one `git diff`.
 *
 * The file list comes from the repo's own review() (so excludes, size limits and rename pairing match the review
 * screen); the diff is then rendered from a private temp index = `local` + those paths staged from the work tree.
 * Renames are detected (`-M`), binaries print git's "Binary files … differ" marker, and empty new files get a
 * header-only entry (`new file mode …`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewFile } from "@agent-workstation/protocol";
import { withLock, type ProjectRepo } from "@agent-workstation/sync-core";
import { git } from "./backups.js";

const LOCAL_REF = "refs/heads/local";

/**
 * Large files (pointer in git, content in the store) have no text diff and must never be staged from the work tree
 * by plain git: they are left out of the patch on both sides (accept/reject them whole in review).
 */
const isLarge = (f: ReviewFile): boolean => f.large === true;

export async function reviewPatch(repo: ProjectRepo): Promise<Buffer> {
  return withLock(repo.lockKey, async () => {
    const { files } = await repo.review();
    if (files.length === 0) return Buffer.alloc(0);
    const dir = await mkdtemp(join(tmpdir(), "workstation-patch-"));
    try {
      const env = { GIT_INDEX_FILE: join(dir, "index") };
      const run = (args: readonly string[], input?: string) => git(repo.gitDir, args, { workTree: repo.workTree, env, ...(input !== undefined ? { input } : {}) });
      await run(["read-tree", LOCAL_REF]);
      const paths = new Set<string>();
      for (const f of files) {
        if (isLarge(f)) continue;
        if (f.oldPath) paths.add(f.oldPath);
        paths.add(f.path);
      }
      if (paths.size === 0) return Buffer.alloc(0);
      await run(["update-index", "--add", "--remove", "-z", "--stdin"], [...paths].join("\0") + "\0");
      const r = await run(["diff", "--cached", "-M", "--no-color", "--no-ext-diff", "--no-textconv", LOCAL_REF, "--"]);
      return r.stdout;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
