# @agent-workstation/sync-core

Folder-sync and git-review engine for Agent Workstation projects.
It is a pure TypeScript library: no HTTP, no WebSocket, no database. `packages/hub`
mounts it as routes. It shells out to the system `git` (and `tar`/`du`) and never
uses a shell.

Requirements: Node ≥ 22, git ≥ 2.32 (Ubuntu 22.04 has 2.34; `GIT_CONFIG_GLOBAL` is the
newest feature used), and for tarball baselines a `tar` that understands `--zstd`
plus the `zstd` binary (GNU tar ≥ 1.31 on Linux, bsdtar on macOS).

```sh
npm run typecheck -w packages/sync-core
npm test          -w packages/sync-core   # real git in temp dirs, ~12 s
npm run build     -w packages/sync-core   # dist/ with .d.ts (the hub imports dist)
```

## Invariants

1. **The bare repo lives outside the work tree** (`users/<u>/.sync/<name>.git`, work
   tree `users/<u>/projects/<name>`). Every git call passes `--git-dir`/`--work-tree`,
   so Claude sees no `.git` in its cwd and cannot disturb the review branch.
2. **`local` is what the Mac has.** Only three things move it: Mac pushes (`applyOps`,
   one commit per batch, "sync: N files"), a baseline import, and accepts
   ("accept: <path>"). History on `local` is linear.
3. **The work tree is Claude's current state.** Nothing in this package edits it except
   applying Mac pushes (direct write or clean 3-way merge), reject, restore, and
   baseline import.
4. **Review is always recomputed from git.** `git status --porcelain=v2 -z
   --untracked-files=all` + `git diff --cached -M --numstat -z local` over a temp
   index that has the work tree staged. File-watcher events are only triggers.
5. **Accept is computed on the server:** new local = local ⊕ selected hunks (patch
   applied to the local blob with `git apply --cached`). The work tree is untouched,
   so unselected hunks stay pending. The new content is returned for the Mac to write.
6. **Snapshots at turn end, trash before destruction.** `snapshot()` writes
   `refs/snapshots/<session>/<turn>`; reject, restore, forced sync and re-baseline write
   `refs/trash/<timestamp>` first. Both are plain commits (object-level dedup), neither
   touches the work tree or any shared index.
7. **Three-way merge on push.** Each write op carries `baseHash` (sha256 of the local
   blob the Mac last saw). If the work tree moved since, `git merge-file` merges; only a
   real overlap is a conflict.
8. **Echo suppression.** A push whose hash (and executable bit) equals `local` is a
   `noop` and creates no commit. The Mac does the other half (it drops watcher events
   for files it just wrote).
9. **Manifest reconcile is read-only.** It tells the Mac what to push (`need`) and what
   it apparently deleted (`delete`); the hub never deletes on its own.
10. **Every git invocation** uses `-c core.quotepath=false`, `-z` output and
    `--literal-pathspecs`, ignores system/global config (`GIT_CONFIG_NOSYSTEM`,
    `GIT_CONFIG_GLOBAL=/dev/null`) and gets a private `GIT_INDEX_FILE`. Non-ASCII (for example CJK), space-,
    tab- and glob-character file names work everywhere.
11. **Blob bytes == file bytes.** `<gitDir>/info/attributes` sets
    `* -text -filter -ident -working-tree-encoding`, so an in-tree `.gitattributes` can
    never make the hub's sha256 differ from the Mac's.
12. **Nothing is ever deleted automatically.** Snapshot and trash refs are never pruned;
    `gc()` is `git gc --auto` (unreachable objects younger than two weeks are kept).
13. **Large files never go through git.** A file larger than `largeFileBytes`
    (MAX_SYNC_FILE_BYTES by default) is hashed by streaming, copied into the project's
    content-addressed store (if absent) and represented in every tree sync-core builds
    (review/status temp indices, snapshots, trash refs, baseline, Mac pushes) by a pointer
    blob: `workstation-large v1\nsha256 <hex>\nsize <n>\n` (LARGE_FILE_POINTER_HEADER). Pointer
    entries are marked assume-unchanged in the temp index, so neither `add -u` nor `status`
    reads the file. Wherever a ref's content goes back into the work tree (reject, restore,
    baseline, Mac pushes) pointers are resolved from the store (streamed, tmp + rename); a
    missing store object is a `large_missing` error raised before anything is written,
    never a pointer file in the work tree. No large file is ever read into memory.

## On-disk layout

```
<gitDir>/                 bare repo, HEAD -> refs/heads/local
  info/exclude            defaults + caller patterns (rewritten on every open)
  info/attributes         content conversions off
  refs/heads/local        what the Mac has
  refs/snapshots/<session>/<turn>
  refs/trash/<YYYYMMDDTHHMMSSmmmZ>-<rand>
  workstation/index.cache         stat cache (copied into each temp index)
  workstation/blob-sha256         git blob id -> sha256 (append-only, immutable mapping)
  workstation/large-sha256.json   stat -> sha256 of large work-tree files (so an unchanged one is hashed once)
  workstation/state.json          {downloaded: {path: blob id}} for canDelete()
  workstation/tmp/                per-operation temp indexes, merge inputs (wiped on open)
```

```
<largeStoreDir>/          default: `<name>.large` next to `<name>.git` (outside the work tree)
  objects/<sha[0:2]>/<sha256>   one read-only copy per distinct large-file version
  tmp/                    copies in progress (wiped on open)
```

The store only grows (nothing is removed automatically); `largeStoreSize()` reports it and
the caller removes it together with the project.

Every commit message ends with trailers (`Workstation-Kind`, `Workstation-At` with millisecond
precision, and for snapshots `Workstation-Session`, `Workstation-Turn`, `Workstation-Changed`), which is what
`history()` reads.

## Exclusion rules

A path is excluded exactly when `git status` would ignore it. By default (`openProject` options `defaultExcludes: true`,
`honorGitignore: true`) that is `info/exclude` (`defaultExcludes` = `.git node_modules/ build/ dist/ .DS_Store __pycache__/
.venv/ target/`, directory patterns only match directories, then the caller's `excludes`) **plus in-tree `.gitignore`
files**; in-tree rules outrank `info/exclude`, so a caller cannot re-include them with `!pattern`. **The hub opens every
project with `defaultExcludes: false` and `honorGitignore: false`**: its rule set is `.git`, the operator's patterns and the
paths the person unchecked in the Mac app's selection window (`PUT /api/projects/:id/excludes`, applied with
`setExcludes`), so files the agent creates in an unchecked folder stay out of review. Excluded paths are invisible to sync:
not imported by a baseline, filtered out of `manifest`, `skipped` by `applyOps`, absent from review/snapshots.

## API

```ts
import { openProject, withLock, acquireLock } from "@agent-workstation/sync-core";

const repo = await openProject({
  gitDir: "/srv/agent-workstation/users/alice/.sync/demo.git",
  workTree: "/srv/agent-workstation/users/alice/projects/demo",
  lockKey: project.id,          // use the same key for the hub's own locks
  excludes: ["*.log"],          // appended to defaultExcludes
  // statCache: true, honorGitignore: true
});
```

All methods take the project lock themselves (re-entrant, see "Locking").

| Method | Returns | Notes |
| --- | --- | --- |
| `importBaseline(src, opts?)` | `{ localCommit, files, trashRef, warnings }` | `src` = tar.zst (default) or tar (`opts.format`) `Readable`/`Uint8Array` or a directory path. An archive is extracted into a scratch folder with `zstd -d` and `tar -x` under `opts.limits` (`DEFAULT_BASELINE_LIMITS`: 4 GiB upload, 8 GiB extracted, 200 000 entries, 30 min); a limit kills the children, removes the scratch folder and throws `baseline_too_large` / `baseline_timeout`. The header scanner reads tar the way GNU tar does: only entry types `0`, NUL, `1`-`7`, `x`, `g`, `L`, `K` (and `X`, like `x`) pass; sparse, multi-volume, dump-directory, volume and unknown types and any wrong header checksum throw `baseline_unsupported_entry`; the scratch folder's allocated size is also measured every second and the children killed past the extracted-size limit. Commits everything (minus excluded and symlinks; large files as pointers) to `local` and writes it into the work tree. Re-import: the old work tree goes to a trash ref if it differed from `local`; files absent from the new source and untouched on the server are removed. |
| `manifest(entries)` | `ManifestResponse` | `need` = paths whose sha256 or exec bit differs, or missing from `local` (large files: by the real sha256 and size in the pointer, or when the store lacks the version); `delete` = paths in `local` the Mac did not list. Excluded entries ignored on both sides. |
| `applyOps(ops)` | `SyncResult & { localCommit, trashRef }` | See decision table. One commit for the whole batch. A write over the large-file threshold is `skipped: too_large` (use `applyLargeWrite`). |
| `applyLargeWrite({path, sha256, size, mode, baseHash, force?, file?})` | `{ localCommit, result, trashRef }` | A Mac push of a large file: `file` (a finished upload on the store's file system) is checked against `sha256` (mismatch → `invalid_argument`, `details.hashMismatch`) and moved into the store; without `file` the store must already hold it (else `need_content`). Then a normal write of the pointer (same table; `baseHash` = the real sha256 the Mac last saw); a large file changed on both sides is a `conflict`. |
| `review()` | `{ files: ReviewFile[], localCommit }` | `lastTouchedBy` is null: the hub fills it from `file_touches`. A path whose old or new side is a pointer is `large: true`, `binary: true`, no line counts, `sizeBytes` (work tree) and `oldSizeBytes` (`local`). |
| `pendingCount()` | `number` | `review().files.length`. |
| `diffFile(path)` | `FileDiff & { status, oldPath?, tooLarge }` | Hunk indices are stable for a given (local, work tree). `oldText`/`newText` are null for binary or > 2 MB (then `hunks` is empty too). Unchanged path → `status: "unchanged"`; unknown → `not_found`. A rename can be looked up by either path. |
| `accept(body)` | `AcceptResponse & { skipped }` | `{path}` whole file (content, or deletion; a rename returns the old path as deleted; a large file comes back as `{contentBase64: null, large: true, sha256, size}` - download it by Range at `localCommit`), `{path, hunks}` partial (modified text files only; selecting every hunk = whole file), `{all: true}` one commit "accept: all (N files)", skipping symlinks and unreadable files (listed in `skipped`). Optional `localCommit` → `stale` if `local` moved. |
| `reject(body)` | `{ localCommit, trashRef, paths }` | Trash ref first. Whole file: `git restore --source=local --no-overlay` (a new file is removed, a deleted one restored, a rename undone). Hunks: `git apply -R` of the selected hunks. |
| `snapshot({sessionId, turn, message})` | `Snapshot & { changed, commit }` | Parent = highest earlier turn of that session, else `local`. `changed: false` when the tree equals the parent's. |
| `trash(reason)` | `Snapshot` | Explicit backup of the work tree. |
| `history({limit?, includeUnchanged?})` | `Snapshot[]` | `local` commits (kind `sync`/`accept`; baseline counts as `sync`, the initial empty commit is omitted), snapshot and trash refs, newest first. `ref` is the commit id for `local` commits. |
| `restore({ref, path?})` | `{ localCommit, trashRef, commit }` | Trash ref first, then `git restore --source=<ref> --worktree --no-overlay -- <path or .>`. `ref` must be a commit id, `local`, or a `refs/snapshots/…`/`refs/trash/…` ref. `local` is never changed. |
| `rawFile(path)` | `Buffer \| null` | Work-tree bytes of a regular file; null for missing/dir/symlink; `too_large` for a large file (stream it instead). Records the path as downloaded. |
| `resolveFile(path)` / `markDownloaded(paths)` | | For streaming downloads (zip, large files): resolve safely, stream, then mark. |
| `canDelete()` | `{ ok, pendingFiles, undownloadedFiles }` | `ok` = no tracked file differs from `local` and every new file was downloaded or accepted. `pendingFiles` = all review entries (informational). Ignored files are not considered. |
| `size()` / `gitDirSize()` / `largeStoreSize()` | bytes | `du -sk` (falls back to summing sizes). |
| `projectStats()` | `{ localCommit, pendingFiles, sizeBytes }` | The repository-derived fields of `Project` (`sizeBytes` = work tree + large-file store). |
| `largePointer(oid)` / `localLargeFile(path)` / `largeStore` | | Resolve a blob to its pointer (null when not one), the pointer at `local`, and the store (`has`, `require` → `large_missing`, `open(ptr, what, range)` for Range downloads). |
| `gc()` | | `git gc --auto`, synchronous. |
| `setExcludes(patterns)` / `localCommit()` | | |

Pure helpers (own tests): `parseUnifiedDiff(text)`, `filterPatch(patch, indices,
{reverse?})` (keeps the selected hunks and rewrites line hints so `git apply` /
`git apply -R` places each hunk exactly even with repeated context; decode git output
as `latin1` to filter losslessly), `parsePorcelainV2(buf)`, `porcelainToChanges()`,
`pairRenames(records)` (exact delete+add pairs by blob id), `parseNumstatZ()`,
`parseLsTreeZ()`, `defaultExcludes`, `hashBytes(bytes)` (sha256 hex, identical to the
Mac), `gitBlobOid(bytes)`, `withLock`, `acquireLock`.

### applyOps decision table

Ops are deduplicated per path (last wins), deletes run before writes (so a directory can
become a file within one batch), and all `applied`/`merged` ops end up in one commit.

| Situation (write op) | Result |
| --- | --- |
| path excluded / op mode is a symlink / work-tree path or a parent is a symlink / size over the large-file threshold (not via `applyLargeWrite`) | `skipped` (`excluded`, `symlink`, `too_large`) |
| hash and exec bit equal `local` | `noop` (no commit) |
| no `contentBase64` and the sha256 is unknown to the repo | `need_content` (resend with content). Known hashes (renames, reverts, mode-only changes) need no content. Content not matching its hash → `need_content`, reason `hash_mismatch` |
| work tree == base | write the Mac's content → `applied` |
| work tree already == the Mac's content | `applied` (work tree untouched) |
| both changed | `git merge-file` (ours = work tree, base, theirs = Mac): clean → work tree = merged, `merged`; overlap / binary / deleted on the server → `conflict`; any side a large file → `conflict` ("large file changed on both sides", no content merge) |
| conflict with `force: true` | trash ref (once per batch), overwrite → `applied`, reason `forced` |
| directory in the way | `conflict` (`path_blocked`), even with force |

*base* is the current `local` blob, except when the op's `baseHash` names a different
known blob (the Mac edited an older version, e.g. before writing an accept): then the
merge uses what the Mac actually started from, so the accepted hunk is kept as pending
instead of being reverted. `local` always ends up with the Mac's content and mode; the
work-tree exec bit follows the Mac only if the Mac changed it.

Delete ops: not in `local` → `noop`; work tree missing or equal to `local`/base → remove
from both (`applied`, emptied parent dirs pruned); modified on the server → `conflict`
unless `force` (trash, then delete).

### Error codes

Methods throw `SyncCoreError` (`code`), suggested HTTP mapping:
`invalid_path`, `invalid_argument` → 400 · `not_found` → 404 · `stale` → 409 ·
`binary`, `unsupported`, `symlink` → 422 · `baseline_unsupported_entry` → 400 · `too_large`, `baseline_too_large` → 413 · `baseline_timeout` → 408 · `unreadable`, `git`,
`tool`, `large_missing` (a pointer whose content the store lacks; details `{sha256, size}`) → 500.

## Wiring it into the hub

**One instance per project.** Open it once (on hub start or first use) and cache it in a
`Map<projectId, ProjectRepo>`; `openProject` is idempotent. Paths:
`gitDir = users/<u>/.sync/<name>.git`, `workTree = users/<u>/projects/<name>`,
`lockKey = project.id`.

| Route | Call |
| --- | --- |
| `POST /projects` | `openProject(...)` |
| `POST /projects/:id/baseline` | `repo.importBaseline(request.raw)` (tar.zst body stream) |
| `POST /projects/:id/manifest` | `repo.manifest(body.entries)` |
| `PUT /projects/:id/excludes` | `repo.setExcludes(patterns)` (the unchecked paths) |
| `PUT /projects/:id/files` | `repo.applyOps(body.ops)`; respond 409 with the `SyncResult` body if any result is `conflict` (the rest of the batch is already applied), else 200. Emit one `sync_conflict{projectId, path, reason}` per conflict. |
| `GET /projects/:id/review` | `repo.review()`, then fill `lastTouchedBy` from `file_touches`; `Project.localCommit/pendingFiles/sizeBytes` from `projectStats()` (or `review()` + `size()`). |
| `GET /projects/:id/review/diff?path=` | `repo.diffFile(path)` |
| `POST /projects/:id/review/accept` | `repo.accept(body)` |
| `POST /projects/:id/review/reject` | `repo.reject(body)` |
| `GET /projects/:id/history` | `repo.history()` |
| `POST /projects/:id/restore` | `repo.restore(body)` |
| `GET /projects/:id/raw?path=&ref=` | `resolveFile` + stream (Range) + `markDownloaded`; with `ref`: the blob, or `largePointer` → `largeStore.open` |
| `PUT /projects/:id/large` | chunked upload into the store's file system, then `repo.applyLargeWrite({..., file})` |
| `DELETE /projects/:id` | `repo.canDelete()`; refuse with 409 unless `ok` or `discardRemaining`; then the hub removes both directories (user-initiated only). |

**Locking.** Every method takes the project mutex itself, re-entrantly (AsyncLocalStorage),
so the hub never needs to wrap single calls. For the anti-tearing hold:

```ts
// PreToolUse (in-process hook) for Write/Edit/MultiEdit/NotebookEdit inside a project:
const hold = await acquireLock(project.id, { autoReleaseMs: 10 * 60_000 });
holds.set(toolUseId, hold);
// PostToolUse (and on tool error / session death / interrupt):
holds.get(toolUseId)?.release(); holds.delete(toolUseId);
```

While held, Mac pushes, review reads and accepts for that project wait. Code that runs
*inside* the holder's flow and needs the repo must use `hold.run(() => repo.review())`,
otherwise it waits for itself. Do not hold across long Bash commands (a Mac push would
hang for the whole `npm install`); for Bash, rely on the 100 ms re-check the plan
describes, or hold with a short `autoReleaseMs`. Different projects never block each
other.

**When to call what.**
- Turn end (`result` message) of a session whose cwd is inside a project:
  `repo.snapshot({ sessionId, turn, message: <first line of the user prompt> })`, then
  emit `review_changed`.
- `trash()` is called internally before reject, restore, forced sync and re-baseline.
  Call it yourself before any other hub-initiated destructive action on the work tree.
- Emit `review_changed{projectId, localCommit, pendingFiles}` (debounced) after
  `applyOps`, `accept`, `reject`, `restore`, `importBaseline`, `snapshot`, and on
  chokidar events in the project (events are only triggers; the panel recomputes via
  `review()`).
- Batch the Mac's pushes per quiet window (2 s) into one `applyOps` call if you want one
  commit per window; each call is one commit.
- The accept response is what the Mac writes locally; its next push of that file is then
  a `noop` (echo suppression on both ends).
- Weekly: `repo.gc()`. Disk page: `size()`, `gitDirSize()`, `canDelete()`.
- Hub-side file writes into a project should use tmp+rename (the exported
  `writeFileAtomic(abs, bytes, mode)`) so reviews never read half-written files.
- Never enable the SDK's `enableFileCheckpointing` for project sessions (it would also
  roll back sync writes); snapshots replace it.

## Known gaps

- Tested on macOS with git 2.54 and bsdtar. Only git features available in 2.32+ are used; run the suite on Linux
  (git 2.34, GNU tar) before relying on it there.
- The stat cache covers tracked files only: new (untracked) files are re-hashed on every
  review. Fine for normal amounts of generated files, slow for many thousands.
- Ignored files (node_modules, …) are never captured by snapshots/trash.
- Large files: every new version Claude writes is copied into the store at the next
  review/snapshot (the store only grows). Hashing a large file the stat cache has not seen
  reads it once (streamed). A pointer path is skipped by the hub's `review/patch`. A blob
  whose bytes are exactly a pointer is treated as one.
- Hunk indices carry no fingerprint in `accept` itself: the hub closes this with the `diffId` of the diff the indices
  came from (`409 stale_diff`); the optional `localCommit` guard only catches `local` moving.
- Symlinks are never synced. Claude-created symlinks show up in the review but cannot be
  accepted (they are listed as `skipped` by accept-all).
- Nested git repositories inside the work tree (gitlinks) are invisible to review and
  snapshots.
- A directory/file clash in a push is a conflict even with `force`.
- Re-baseline overwrites Claude's edits in the work tree (they are kept in the trash ref)
  instead of merging them.
- Non-UTF-8 file names are decoded lossily. Case-only renames on case-insensitive file
  systems are not special-cased.
- LFS/filters are switched off, so LFS pointer files sync as ordinary text.
- `accept({all: true})` returns every accepted file's content in one response, as the
  protocol defines; very large accept-alls are memory-heavy.
