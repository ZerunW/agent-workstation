## What and why

<!-- What does this change do, and why? Link the issue if there is one. -->

## How it was tested

<!-- Commands you ran, manual steps, screenshots for UI changes. -->

## Checklist

- [ ] `npm run typecheck`, `npm test` and `npm run build` pass locally (and `swift test` in `apps/mac` if the app changed)
- [ ] Tests added or updated for the new behavior
- [ ] Protocol changes: `packages/protocol` edited first, `npx tsx scripts/gen-protocol-docs.mts` re-run and `docs/PROTOCOL.md` committed, and both the hub and the clients updated
- [ ] Docs updated (`docs/`, config example, `deploy/` if relevant)
- [ ] No secrets, personal addresses, tokens, SQLite files or logs committed
- [ ] Nothing deletes user data automatically; every deletion is user-initiated and confirmed
- [ ] `docs/CHANGELOG.md` has a line for user-visible changes
