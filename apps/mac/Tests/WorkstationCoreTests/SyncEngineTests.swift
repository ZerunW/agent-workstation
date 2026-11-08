import Foundation
import Testing
@testable import WorkstationCore

@Suite("SyncEngine against a fake hub", .serialized)
struct SyncEngineTests {
    func makeEngine(_ tree: TempDir, _ hub: FakeTransport, store: TempDir, writer: LocalWriting = RecordingWriter(),
                    onlyPath: String? = nil) -> SyncEngine {
        let p = LinkedProject(id: "p1", name: "proj", localPath: tree.url.path, hubURL: "http://h", user: "u", onlyPath: onlyPath)
        return SyncEngine(project: p, transport: hub, store: LinkedProjectStore(directory: store.url), writer: writer, useWatcher: false)
    }

    @Test func linkUploadsOnceThenLocalEditsSyncOnTheirOwn() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let engine = makeEngine(tree, hub, store: store)
        await engine.start()

        // Without a window nothing is unchecked: the first upload carried every file but .git (no rules, no .gitignore).
        #expect(hub.baselineCalls.count == 1)
        #expect(hub.baselineCalls[0].1.sorted() == [".DS_Store", ".gitignore", "README.md", "build/out.o", "debug.log", "keep.log",
                                                     "node_modules/pkg/index.js", "secret/key.txt", "src/a.js", "src/dup1.txt", "src/dup2.txt", "src/nested/b.ts"])
        #expect(hub.pushes.isEmpty)
        var status = await engine.currentStatus()
        #expect(status.phase == .watching)
        #expect(status.outgoing.isEmpty && status.incoming.isEmpty)
        #expect(status.skipped.map(\.path) == ["link-to-readme"])
        #expect(await engine.currentSelection().records.isEmpty)
        let known0 = await engine.knownHashes()

        // Edit, add, delete inside the decided scope → synced on their own, with baseHash = the last-synced hash.
        tree.write("README.md", "hello world\n")
        tree.write("src/new.ts", "new\n")
        try FileManager.default.removeItem(at: tree.url.appendingPathComponent("src/a.js"))
        await engine.handleLocalChanges(["README.md", "src/new.ts", "src/a.js", "node_modules/x.js", ".git/index"])
        status = await engine.currentStatus()
        #expect(status.outgoing.isEmpty, "only conflicts stay pending")
        let ops = hub.pushes.flatMap { $0 }
        #expect(Set(ops.map(\.path)) == ["README.md", "src/new.ts", "src/a.js"])
        #expect(ops.first { $0.path == "README.md" }?.baseHash == known0["README.md"])
        #expect(hub.with { $0.local["src/a.js"] } == nil && hub.with { $0.local["src/new.ts"] } != nil)

        // The person unchecks build/ (Sync tab): the root now has something unchecked.
        await engine.applyDecisions([SyncDecisionInput(path: "build", kind: .folder, decision: .skip)])
        tree.write("build/more.o", "o")
        await engine.handleLocalChanges(["build/more.o"])
        #expect(hub.with { $0.local["build/more.o"] } == nil, "inside an unchecked folder: never")
        let pushes = hub.pushes.count

        // A new top-level folder and a new root file wait for the person; nothing about them syncs.
        tree.write("data/a.csv", "1,2\n")
        tree.write("data/b.csv", "3,4\n")
        tree.write("notes.txt", "n\n")
        await engine.handleLocalChanges(["data", "notes.txt"])
        status = await engine.currentStatus()
        #expect(hub.pushes.count == pushes)
        let waitingNow = await engine.currentSelection().pending.keys.sorted()
        #expect(status.pendingSelection == 2, "\(waitingNow)")
        let pending = await engine.currentSelection().pending
        #expect(pending["data"]?.kind == .folder && pending["data"]?.files == 2 && pending["notes.txt"]?.kind == .file)

        // Approving the folder syncs everything in it; skipping the file keeps it here.
        await engine.applyDecisions([SyncDecisionInput(path: "data", kind: .folder, decision: .sync),
                                     SyncDecisionInput(path: "notes.txt", kind: .file, decision: .skip)])
        #expect(hub.with { $0.local["data/a.csv"] } != nil && hub.with { $0.local["data/b.csv"] } != nil)
        #expect(hub.with { $0.local["notes.txt"] } == nil)
        #expect(await engine.currentSelection().pending.isEmpty)
        #expect(await engine.currentStatus().pendingSelection == 0)
        // data/ has nothing unchecked: later files in it sync on their own.
        tree.write("data/c.csv", "5\n")
        await engine.handleLocalChanges(["data/c.csv"])
        #expect(hub.with { $0.local["data/c.csv"] } != nil)
    }

    @Test func decisionsAndWaitingItemsPersistAcrossRestarts() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let e1 = makeEngine(tree, hub, store: store)
        await e1.start()
        await e1.applyDecisions([SyncDecisionInput(path: "build", kind: .folder, decision: .skip)])
        tree.write("data/a.csv", "1\n")
        await e1.handleLocalChanges(["data"])
        await e1.stop()
        let saved = try #require(LinkedProjectStore(directory: store.url).loadSelection("p1"))
        #expect(saved.pending.keys.sorted() == ["data"] && saved.records["build"]?.decision == .skip)
        let e2 = makeEngine(tree, hub, store: store)
        await e2.start()
        #expect(await e2.currentSelection().pending.keys.sorted() == ["data"], "still waiting, not synced")
        #expect(hub.with { $0.local["data/a.csv"] } == nil)
    }

    @Test func reviewedVersionMustStillBeOnDisk() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let engine = makeEngine(tree, hub, store: store)
        await engine.start()
        hub.with { $0.conflictPaths = ["README.md"] }
        tree.write("README.md", "v2\n")
        await engine.handleLocalChanges(["README.md"])
        #expect(await engine.currentStatus().outgoing.map(\.path) == ["README.md"], "a conflict stays pending")
        let pushes = hub.pushes.count
        tree.write("README.md", "v3 typed after the diff was shown\n")
        let r = try await engine.syncToServer(["README.md"], approvedHashes: ["README.md": FileHasher.sha256(Data("v2\n".utf8))])
        #expect(r.stale == ["README.md"] && r.pushed.isEmpty)
        #expect(hub.pushes.count == pushes)
    }

    @Test func missingBaselineEndpointUploadsFileByFileAsPartOfLinking() async {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        hub.baselineStatus = 404
        let engine = makeEngine(tree, hub, store: store)
        await engine.start()
        #expect(hub.pushes.flatMap { $0 }.count == 12, "the confirmed first upload, per file")
        #expect(await engine.syncState().baselineEncoding == "per-file")
        #expect(await engine.currentStatus().outgoing.isEmpty)
    }

    @Test func reconcileNeverPushesFilesThisMacDidNotChange() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let writer = RecordingWriter()
        let engine = makeEngine(tree, hub, store: store, writer: writer)
        await engine.start()
        let before = fingerprint(tree.url)
        // Accepted elsewhere: README changed, a new file, keep.log deleted: this Mac changed none of them.
        hub.acceptOnServer("README.md", Data("accepted on the phone\n".utf8))
        hub.acceptOnServer("src/claude.ts", Data("export const x = 1\n".utf8))
        hub.acceptOnServer("keep.log", nil)
        // This Mac changed src/a.js while the app was closed.
        tree.write("src/a.js", "mac edit\n")
        await engine.reconcile()
        #expect(hub.pushes.flatMap { $0 }.map(\.path) == ["src/a.js"], "only the Mac's own edit is sent; the untouched files never")
        let st = await engine.currentStatus()
        #expect(st.outgoing.isEmpty)
        #expect(st.incoming.map(\.path) == ["README.md", "keep.log", "src/claude.ts"])
        #expect(st.incoming.map(\.kind) == [.modified, .deleted, .added])
        #expect(st.incoming.allSatisfy { $0.origin == .server })
        #expect(writer.count == 0)
        var after = fingerprint(tree.url)
        after["src/a.js"] = before["src/a.js"]
        #expect(after == before, "reconcile writes nothing locally")
    }

    @Test func incomingChangesAreWrittenOnlyAfterApproval() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let writer = RecordingWriter()
        let engine = makeEngine(tree, hub, store: store, writer: writer)
        await engine.start()
        hub.acceptOnServer("README.md", Data("from the server\n".utf8))
        hub.acceptOnServer("src/nested/b.ts", nil)
        await engine.reconcile()
        #expect(tree.read("README.md") == "hello\n")
        #expect(writer.count == 0)

        let r = try await engine.applyIncoming(["README.md"])
        #expect(r.applied == ["README.md"])
        #expect(tree.read("README.md") == "from the server\n")
        #expect(writer.batches.last?.items.first?.expectedHash == FileHasher.sha256(Data("hello\n".utf8)), "expects the last-synced version")
        #expect(await engine.knownHashes()["README.md"] == FileHasher.sha256(Data("from the server\n".utf8)))
        // The FSEvents echo of our own write is not a local change.
        await engine.handleLocalChanges(["README.md"])
        #expect(await engine.currentStatus().outgoing.isEmpty)
        // Deletions too, only when approved.
        #expect(tree.exists("src/nested/b.ts"))
        _ = try await engine.applyIncoming(nil)
        #expect(!tree.exists("src/nested/b.ts"))
        #expect(await engine.currentStatus().incoming.isEmpty)
        // Recorded as one apply batch per approval (metadata only).
        let history = LinkedProjectStore(directory: store.url).history.batches(projectId: "p1")
        #expect(history.count == 2)
        #expect(history.first?.files.first?.op == .delete)
        #expect(history.last?.files.first?.oldRef != nil, "the server commit holding the old version")
    }

    @Test func unsyncedLocalEditsAreNeverOverwrittenSilently() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let writer = RecordingWriter()
        let engine = makeEngine(tree, hub, store: store, writer: writer)
        await engine.start()
        hub.with { $0.conflictPaths = ["README.md"] }   // the server changed it too: the edit stays unsynced
        tree.write("README.md", "my unsynced edit\n")
        await engine.handleLocalChanges(["README.md"])
        hub.acceptOnServer("README.md", Data("claude's\n".utf8))
        await engine.reconcile()
        var st = await engine.currentStatus()
        #expect(st.incomingWithLocalEdits == ["README.md"])
        #expect(st.backupsAvailable == true)

        // "Skip" leaves both.
        var r = try await engine.applyIncoming(["README.md"], choices: ["README.md": .skip])
        #expect(r.skipped == ["README.md"] && tree.read("README.md") == "my unsynced edit\n")

        // "Overwrite without backup" is refused without the second confirmation: and never backs up.
        r = try await engine.applyIncoming(["README.md"], choices: ["README.md": .overwriteWithoutBackup])
        #expect(r.refused.map(\.path) == ["README.md"])
        #expect(tree.read("README.md") == "my unsynced edit\n")
        #expect(hub.backupRequests.isEmpty)

        // The writer itself refuses a batch that expects the last-synced version over local edits.
        let rogue = WriteBatch(root: tree.url.path, items: [.write("README.md", data: Data("x".utf8), expected: FileHasher.sha256(Data("hello\n".utf8)))])
        let refused = WriteBatchExecutor.execute(rogue, deleteMode: .removeForTests)
        #expect(refused.applied.isEmpty && refused.refused.first?.reason.contains("not on the server") == true)

        // Default with backups: back up on the server, verify the blob, then overwrite.
        r = try await engine.applyIncoming(["README.md"])
        #expect(r.applied == ["README.md"])
        #expect(hub.backupRequests.count == 1)
        #expect(hub.backupRequests[0].reason == .overwrite)
        #expect(hub.backupRequests[0].files.first.flatMap { Data(base64Encoded: $0.dataBase64) } == Data("my unsynced edit\n".utf8))
        #expect(writer.batches.last?.items.first?.backedUpBlob == FileHasher.gitBlobOid(Data("my unsynced edit\n".utf8)))
        #expect(tree.read("README.md") == "claude's\n")
        st = await engine.currentStatus()
        #expect(st.outgoing.isEmpty && st.incoming.isEmpty)
        let h = LinkedProjectStore(directory: store.url).history.batches(projectId: "p1").first?.files.first
        #expect(h?.backedUp == true && h?.oldRef == "refs/backups/mac/b1")
    }

    @Test func backupMustBeConfirmedBeforeOverwriting() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let engine = makeEngine(tree, hub, store: store)
        await engine.start()
        hub.with { $0.conflictPaths = ["keep.log"] }
        tree.write("keep.log", "local\n")
        await engine.handleLocalChanges(["keep.log"])
        hub.acceptOnServer("keep.log", Data("server\n".utf8))
        await engine.reconcile()
        // A backup answer whose blob does not match what was uploaded → nothing overwritten.
        hub.backupBlobOverride = String(repeating: "0", count: 40)
        var r = try await engine.applyIncoming(nil, choices: ["keep.log": .backUpAndOverwrite])
        #expect(r.applied.isEmpty && r.refused.first?.reason.contains("did not confirm") == true)
        #expect(tree.read("keep.log") == "local\n")
        // The hub has no backups endpoint (404): unavailable, so the default skips; nothing overwritten.
        hub.backupBlobOverride = nil
        hub.backupStatus = 404
        await engine.reconcile()
        #expect(await engine.currentStatus().backupsAvailable == false)
        r = try await engine.applyIncoming(nil)
        #expect(r.skipped == ["keep.log"] && tree.read("keep.log") == "local\n")
        r = try await engine.applyIncoming(nil, choices: ["keep.log": .backUpAndOverwrite])
        #expect(r.skipped == ["keep.log"] && tree.read("keep.log") == "local\n")
        // "Overwrite without backup" works without the endpoint, once confirmed, and makes no backup request.
        let backupsBefore = hub.backupRequests.count
        r = try await engine.applyIncoming(nil, choices: ["keep.log": .overwriteWithoutBackup], confirmedLoss: ["keep.log"])
        #expect(r.applied == ["keep.log"] && tree.read("keep.log") == "server\n")
        #expect(hub.backupRequests.count == backupsBefore)
    }

    @Test func overwriteWithoutBackupChecksTheVersionSeen() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let engine = makeEngine(tree, hub, store: store)
        await engine.start()
        hub.with { $0.conflictPaths = ["keep.log"] }
        tree.write("keep.log", "seen in the diff\n")
        await engine.handleLocalChanges(["keep.log"])
        hub.acceptOnServer("keep.log", Data("server\n".utf8))
        await engine.reconcile()
        tree.write("keep.log", "typed after the diff\n")
        let r = try await engine.applyIncoming(nil, choices: ["keep.log": .overwriteWithoutBackup],
                                               seenLocalHashes: ["keep.log": FileHasher.sha256(Data("seen in the diff\n".utf8))],
                                               confirmedLoss: ["keep.log"])
        #expect(r.applied.isEmpty && tree.read("keep.log") == "typed after the diff\n")
    }

    @Test func syncMyVersionInsteadDropsTheIncomingChange() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let engine = makeEngine(tree, hub, store: store)
        await engine.start()
        hub.with { $0.conflictPaths = ["README.md"] }
        tree.write("README.md", "mine\n")
        await engine.handleLocalChanges(["README.md"])
        hub.acceptOnServer("README.md", Data("theirs\n".utf8))
        await engine.reconcile()
        let r = try await engine.applyIncoming(nil, choices: ["README.md": .syncMineInstead])
        #expect(r.syncedInstead == ["README.md"])
        #expect(tree.read("README.md") == "mine\n")
        #expect(hub.with { $0.local["README.md"] } == FileHasher.sha256(Data("mine\n".utf8)))
        let st = await engine.currentStatus()
        #expect(st.incoming.isEmpty && st.outgoing.isEmpty)
    }

    @Test func pullBackQueuesAndKeepsTheServerCopy() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let engine = makeEngine(tree, hub, store: store)
        await engine.start()
        hub.with { $0.worktree["src/claude.ts"] = Data("from claude\n".utf8) }
        let before = fingerprint(tree.url)
        let n = try await engine.pullBack()
        #expect(n == 1)
        #expect(fingerprint(tree.url) == before, "pull back writes nothing until applied")
        #expect(hub.with { $0.worktree["src/claude.ts"] } != nil, "the server copy stays")
        let st = await engine.currentStatus()
        #expect(st.incoming.map(\.path) == ["src/claude.ts"] && st.incoming.first?.origin == .accepted)
        _ = try await engine.applyIncoming(nil)
        #expect(tree.read("src/claude.ts") == "from claude\n")
    }

    @Test func conflictsKeepMineOrReviewTheServersVersion() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let engine = makeEngine(tree, hub, store: store)
        await engine.start()
        hub.with { $0.conflictPaths = ["src/a.js"] }
        tree.write("src/a.js", "mine\n")
        await engine.handleLocalChanges(["src/a.js"])
        #expect(await engine.currentStatus().conflicts.map(\.path) == ["src/a.js"])
        #expect(await engine.currentStatus().outgoing.map(\.path) == ["src/a.js"], "a conflict stays pending")

        // "Review Server's…" fetches the server's version into incoming: nothing written.
        hub.with {
            let d = Data("claude\n".utf8)
            $0.local["src/a.js"] = FileHasher.sha256(d); $0.blobs[FileHasher.sha256(d)] = d; $0.worktree["src/a.js"] = d
        }
        try await engine.useServerVersion("src/a.js")
        #expect(tree.read("src/a.js") == "mine\n")
        #expect(await engine.currentStatus().incomingWithLocalEdits == ["src/a.js"])

        // "Keep Mine" forces my version onto the server (the server keeps Claude's in its history).
        try await engine.keepMine("src/a.js")
        if case let .write(_, _, _, _, _, _, force) = hub.pushes.last!.first! { #expect(force == true) } else { Issue.record("expected write") }
        var st = await engine.currentStatus()
        #expect(st.conflicts.isEmpty && st.outgoing.isEmpty)
        // Now the local file is the synced version, so the server's version can be applied after review.
        #expect(st.incomingWithLocalEdits.isEmpty)
        _ = try await engine.applyIncoming(nil)
        #expect(tree.read("src/a.js") == "claude\n")
        st = await engine.currentStatus()
        #expect(st.incoming.isEmpty)
    }

    @Test func diskBlockRefusesSyncAndKeepsChangesPending() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let engine = makeEngine(tree, hub, store: store)
        await engine.start()
        await engine.setPushesBlocked("server storage ≥ 95%")
        tree.write("README.md", "while blocked\n")
        await engine.handleLocalChanges(["README.md"])
        await #expect(throws: HubError.self) { try await engine.syncToServer(nil) }
        #expect(hub.pushes.isEmpty)
        #expect(await engine.currentStatus().outgoing.count == 1)
        // 507 from the hub: same, nothing lost.
        await engine.setPushesBlocked(nil)
        hub.pushHTTPStatus = 507
        await #expect(throws: HubError.self) { try await engine.syncToServer(nil) }
        #expect(await engine.currentStatus().outgoing.count == 1)
        hub.pushHTTPStatus = nil
        hub.failNextPush = true
        await #expect(throws: HubError.self) { try await engine.syncToServer(nil) }
        #expect(await engine.currentStatus().outgoing.count == 1, "transport error: still pending")
        #expect(try await engine.syncToServer(nil).pushed == ["README.md"])
    }

    /// The iron rule: across linking, reconciles, local edits, conflicts, pull back, restore
    /// queueing, disk block, pause and stop, nothing reaches the writer and the folder is
    /// byte-for-byte unchanged (except for the person's own edits). Only `applyIncoming` writes.
    @Test func ironRuleNoLocalWriteWithoutApproval() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let writer = RecordingWriter()
        let engine = makeEngine(tree, hub, store: store, writer: writer)
        await engine.start()
        let snapshot = fingerprint(tree.url)
        hub.acceptOnServer("README.md", Data("server edit\n".utf8))
        hub.acceptOnServer("keep.log", nil)
        await engine.reconcile()
        hub.with { $0.conflictPaths = ["src/dup1.txt"]; $0.worktree["src/dup1.txt"] = Data("server dup\n".utf8) }
        try await engine.useServerVersion("src/dup1.txt")
        hub.with { $0.worktree["src/z.txt"] = Data("z\n".utf8) }
        _ = try await engine.pullBack()
        let batch = LinkedProjectStore(directory: store.url).history.batches(projectId: "p1")
        #expect(batch.isEmpty)
        _ = try await engine.restore([RestoreItem(path: "README.md", ref: "c1", sha256: FileHasher.sha256(Data("hello\n".utf8)))])
        await engine.setPushesBlocked("full")
        await engine.setPushesBlocked(nil)
        await engine.setUserPaused(true)
        await engine.setUserPaused(false)
        await engine.handleLocalChanges(["README.md", "keep.log", "src/a.js"], rescan: true)
        await engine.stop()
        #expect(writer.count == 0, "no batch reached the writer")
        #expect(fingerprint(tree.url) == snapshot, "the linked folder is unchanged")
        #expect(await engine.currentStatus().incoming.count >= 3)

        // The approval call is the one path that writes.
        _ = try await engine.applyIncoming(["src/z.txt"])
        #expect(writer.count == 1)
        #expect(tree.read("src/z.txt") == "z\n")
    }

    @Test func restoreFetchesTheOldVersionFromTheServerForReview() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let engine = makeEngine(tree, hub, store: store)
        await engine.start()
        hub.acceptOnServer("README.md", Data("v2 from the server\n".utf8))
        await engine.reconcile()
        _ = try await engine.applyIncoming(nil)
        #expect(tree.read("README.md") == "v2 from the server\n")
        let applied = try #require(LinkedProjectStore(directory: store.url).history.batches(projectId: "p1").first?.files.first)
        #expect(applied.oldHash == FileHasher.sha256(Data("hello\n".utf8)))

        // Restore: raw?ref= at the recorded commit, hash-checked, offered for review; nothing written yet.
        let n = try await engine.restore([RestoreItem.before(applied)])
        #expect(n == 1)
        #expect(hub.with { $0.rawRequests.last?.1 } == applied.oldRef)
        #expect(tree.read("README.md") == "v2 from the server\n")
        _ = try await engine.applyIncoming(nil)
        #expect(tree.read("README.md") == "hello\n", "round trip")
        // The server still has v2, so the restored file is now a local change to review.
        #expect(await engine.currentStatus().outgoing.map(\.path) == ["README.md"])
        // A wrong hash from the server is refused.
        await #expect(throws: HubError.self) {
            try await engine.restore([RestoreItem(path: "README.md", ref: applied.oldRef, sha256: String(repeating: "a", count: 64))])
        }
    }

    @Test func singleFileProjectsSeeOnlyThatFile() async throws {
        let tree = TempDir("workstation-single"), store = TempDir(), hub = FakeTransport()
        tree.write("notes.md", "# notes\n")
        tree.write("other.txt", "not linked\n")
        tree.write("big/stuff.bin", "x")
        let engine = makeEngine(tree, hub, store: store, onlyPath: "notes.md")
        await engine.start()
        #expect(hub.baselineCalls.first?.1 == ["notes.md"])
        #expect(await engine.currentStatus().trackedFiles == 1)
        tree.write("other.txt", "changed\n")
        await engine.handleLocalChanges(["other.txt", "big/stuff.bin"])
        #expect(await engine.currentStatus().outgoing.isEmpty, "siblings are ignored")
        #expect(hub.pushes.isEmpty)
        tree.write("notes.md", "# notes v2\n")
        await engine.handleLocalChanges([""])
        #expect(hub.pushes.flatMap { $0 }.map(\.path) == ["notes.md"], "an edit of the linked file syncs on its own")
        #expect(await engine.currentStatus().outgoing.isEmpty)
        // Pull back / incoming for other paths never touch siblings.
        hub.with { $0.worktree["other.txt"] = Data("server\n".utf8); $0.worktree["notes.md"] = Data("# server\n".utf8) }
        _ = try await engine.pullBack()
        #expect(await engine.currentStatus().incoming.map(\.path) == ["notes.md"])
        _ = try await engine.applyIncoming(nil, choices: ["notes.md": .overwriteWithoutBackup], confirmedLoss: ["notes.md"])
        #expect(tree.read("notes.md") == "# server\n")
        #expect(tree.read("other.txt") == "changed\n")
    }

    @Test func realFSEventsSyncEditsInsideTheDecidedScope() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let p = LinkedProject(id: "p1", name: "proj", localPath: tree.url.path, hubURL: "http://h", user: "u")
        let engine = SyncEngine(project: p, transport: hub, store: LinkedProjectStore(directory: store.url), writer: RecordingWriter(), useWatcher: true)
        await engine.start()
        try await Task.sleep(nanoseconds: 300_000_000)
        tree.write("src/watched.ts", "watched\n")
        var seen = false
        for _ in 0..<60 {
            try await Task.sleep(nanoseconds: 100_000_000)
            if hub.with({ $0.local["src/watched.ts"] }) != nil { seen = true; break }
        }
        await engine.stop()
        #expect(seen, "FSEvents reported the new file in the approved folder, and it synced")
    }

    /// Files > 100 MB: they wait for the person even in an approved folder; once approved they go
    /// up in ordered chunks; deletions sync; server versions come down in Range chunks to a file the
    /// writer copies (never the whole file in memory).
    @Test func largeFilesAskThenSyncInChunksBothWays() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let writer = RecordingWriter()
        let size: UInt64 = 110 * 1024 * 1024
        let big = tree.url.appendingPathComponent("src/weights.bin")
        FileManager.default.createFile(atPath: big.path, contents: nil)
        let h = try FileHandle(forWritingTo: big)
        try h.truncate(atOffset: size)   // sparse zeros
        try h.close()
        let engine = makeEngine(tree, hub, store: store, writer: writer)
        await engine.start()
        #expect(!hub.baselineCalls[0].1.contains("src/weights.bin"), "not part of the first upload")
        let item = try #require(await engine.currentSelection().pending["src/weights.bin"])
        #expect(item.large == true && item.reason == "115.3 MB large file: each synced version is kept on the server")
        #expect(hub.large.isEmpty)

        await engine.applyDecisions([SyncDecisionInput(path: "src/weights.bin", kind: .file, decision: .sync)])
        let sha = try FileHasher.sha256(fileAt: big)
        #expect(hub.large["src/weights.bin"] == sha)
        #expect(hub.chunkCalls.map(\.offset) == (0..<7).map { Int64($0) * LargeFileUploader.chunkBytes })
        #expect(await engine.knownHashes()["src/weights.bin"] == sha)
        #expect(!hub.pushes.flatMap { $0 }.contains { $0.path == "src/weights.bin" }, "never through the git path")

        // A new version while the server changed it too: the completing write conflicts and stays
        // pending; "Keep mine" re-sends it with force.
        let h2 = try FileHandle(forWritingTo: big)
        try h2.seek(toOffset: 0); try h2.write(contentsOf: Data("v2".utf8)); try h2.close()
        hub.with { $0.conflictPaths = ["src/weights.bin"] }
        await engine.handleLocalChanges(["src/weights.bin"])
        let sha2 = try FileHasher.sha256(fileAt: big)
        #expect(await engine.currentStatus().conflicts.map(\.path) == ["src/weights.bin"])
        #expect(await engine.currentStatus().outgoing.map(\.path) == ["src/weights.bin"])
        #expect(hub.largeWrites.last?.baseHash == sha && hub.largeWrites.last?.force == false, "baseHash = the version last seen")
        #expect(hub.large["src/weights.bin"] == sha)
        try await engine.keepMine("src/weights.bin")
        #expect(hub.largeWrites.last?.force == true && hub.large["src/weights.bin"] == sha2)
        let after = await engine.currentStatus()
        #expect(after.conflicts.isEmpty && after.outgoing.isEmpty)

        // Deleted here → a delete op like any synced file.
        try FileManager.default.removeItem(at: big)
        await engine.handleLocalChanges(["src/weights.bin"])
        #expect(hub.large["src/weights.bin"] == nil)

        // A large version accepted on the server comes down in Range chunks and is written from a file.
        let serverData = Data(count: Int(size))
        let serverSha = FileHasher.sha256(serverData)
        hub.with { $0.largeContent["src/model2.bin"] = serverData; $0.local["src/model2.bin"] = serverSha }
        await engine.reconcile()
        let incoming = try #require(await engine.currentStatus().incoming.first { $0.path == "src/model2.bin" })
        #expect(incoming.size == Int64(size) && incoming.hash == serverSha)
        #expect(hub.rangeRequests.filter { $0.path == "src/model2.bin" }.count == 7)
        _ = try await engine.applyIncoming(["src/model2.bin"])
        let written = try #require(writer.batches.last?.items.first)
        #expect(written.contentBase64 == nil && written.sourcePath != nil)
        #expect(try FileHasher.sha256(fileAt: tree.url.appendingPathComponent("src/model2.bin")) == serverSha)

        // Pull back: a large accepted file comes as a `large` entry, downloaded at the accepted commit.
        var claude = Data(count: Int(size)); claude[0] = 7
        hub.with { $0.largeWorktree["src/model3.bin"] = claude }
        _ = try await engine.pullBack()
        let pulled = try #require(await engine.currentStatus().incoming.first { $0.path == "src/model3.bin" })
        #expect(pulled.hash == FileHasher.sha256(claude) && pulled.origin == .accepted)
        #expect(hub.rangeRequests.contains { $0.path == "src/model3.bin" && $0.ref?.hasPrefix("c") == true })
    }

    /// Stopping (or unlinking) cancels a large upload in flight.
    @Test func stopCancelsALargeUpload() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let big = tree.url.appendingPathComponent("src/weights.bin")
        FileManager.default.createFile(atPath: big.path, contents: nil)
        let h = try FileHandle(forWritingTo: big)
        try h.truncate(atOffset: 120 * 1024 * 1024)
        try h.close()
        let engine = makeEngine(tree, hub, store: store)
        await engine.start()
        hub.chunkDelayNanos = 150_000_000
        let deciding = Task { await engine.applyDecisions([SyncDecisionInput(path: "src/weights.bin", kind: .file, decision: .sync)]) }
        for _ in 0..<100 where hub.with({ $0.chunkCalls.count }) == 0 { try await Task.sleep(nanoseconds: 20_000_000) }
        await engine.stop()
        await deciding.value
        let sent = hub.with { $0.chunkCalls.count }
        try await Task.sleep(nanoseconds: 400_000_000)
        #expect(hub.with { $0.chunkCalls.count } == sent, "no more chunks after stop")
        #expect(sent < 8 && hub.large["src/weights.bin"] == nil)
    }

    /// Files that were cloud-only while the first upload was built are not read and
    /// not uploaded, then go up on the next pass once local; files the server's import lost are sent
    /// again (not mistaken for deletions on the server).
    @Test func missingFilesCatchUpAfterTheFirstUpload() async throws {
        let tree = TempDir("catchup"), store = TempDir(), hub = FakeTransport()
        tree.write("lib/abs.hpp", "abs"); tree.write("lib/acos.hpp", "acos"); tree.write("lib/acosh.hpp", "acosh")
        tree.write("models/model.xml", "x"); tree.write("README.md", "r")
        let cloud = FakeCloud(root: tree.url, ["lib/acos.hpp", "models/model.xml"])
        let spy = ReaderSpy()
        hub.baselineDrops = ["README.md"]
        let p = LinkedProject(id: "p1", name: "proj", localPath: tree.url.path, hubURL: "http://h", user: "u")
        let engine = SyncEngine(project: p, transport: hub, store: LinkedProjectStore(directory: store.url), writer: RecordingWriter(),
                                useWatcher: false, cloud: cloud.probe, hasher: spy.hasher)
        await engine.start()
        #expect(!spy.names.contains("acos.hpp") && !spy.names.contains("model.xml"), "cloud-only files are never read")
        #expect(!hub.baselineCalls[0].1.contains("lib/acos.hpp"))
        #expect(await engine.currentStatus().cloudOnly == 2)
        // The server lost README.md from the first upload: the first reconcile sends it again.
        #expect(hub.with { $0.local["README.md"] } != nil)
        #expect(await engine.currentStatus().incoming.isEmpty, "not offered as a deletion from the server")
        // Downloaded later: the next pass uploads them.
        cloud.set([])
        await engine.reconcile()
        #expect(hub.with { $0.local["lib/acos.hpp"] } != nil && hub.with { $0.local["models/model.xml"] } != nil)
        #expect(await engine.currentStatus().cloudOnly == 0)

        // Evicted after syncing: not a change: no push, no delete, no read.
        let pushes = hub.pushes.count
        let reads = spy.names.count
        cloud.set(["lib/abs.hpp"])
        await engine.handleLocalChanges(["lib/abs.hpp"])
        await engine.reconcile()
        #expect(hub.pushes.count == pushes && hub.with { $0.local["lib/abs.hpp"] } != nil)
        #expect(!spy.names.dropFirst(reads).contains("abs.hpp"))
        #expect(await engine.localContent("lib/abs.hpp") == nil, "review diffs do not read it either")
    }

    /// The server's exclude list = the project's own `skip` decisions: sent before the first upload,
    /// whenever decisions change, once at every start; a failed send is retried; 404 is tolerated.
    @Test func excludeListFollowsTheOwnSkips() async throws {
        let tree = makeFixtureTree(), store = TempDir(), hub = FakeTransport()
        let sel = SyncSelection(records: [
            "node_modules": SyncRecord(kind: .folder, decision: .skip, source: .you),
            "debug.log": SyncRecord(kind: .file, decision: .skip, source: .you),
            "src": SyncRecord(kind: .folder, decision: .sync, source: .you),
        ])
        LinkedProjectStore(directory: store.url).saveSelection("p1", sel)
        let engine = makeEngine(tree, hub, store: store)
        await engine.start()
        #expect(hub.events.prefix(2) == ["excludes", "baseline"], "sent before anything is uploaded")
        #expect(hub.excludeCalls.first == [ExcludedPath(path: "debug.log", kind: .file), ExcludedPath(path: "node_modules", kind: .folder)],
                "own skips only (no sync rows, nothing inherited like node_modules/pkg)")
        #expect(!hub.baselineCalls[0].1.contains { $0.hasPrefix("node_modules/") || $0 == "debug.log" })
        let calls = hub.excludeCalls.count
        await engine.reconcile()
        #expect(hub.excludeCalls.count == calls, "unchanged: not sent again")

        // A decision changes the list.
        await engine.applyDecisions([SyncDecisionInput(path: "secret", kind: .folder, decision: .skip)])
        #expect(hub.excludeCalls.last?.map(\.path) == ["debug.log", "node_modules", "secret"])
        // Offline: retried with the next reconcile.
        hub.failExcludes = 2   // the send after the decision and the reconcile right after it
        await engine.applyDecisions([SyncDecisionInput(path: "debug.log", kind: .file, decision: nil)])
        #expect(hub.excludeCalls.last?.map(\.path) == ["debug.log", "node_modules", "secret"])
        await engine.reconcile()
        #expect(hub.excludeCalls.last?.map(\.path) == ["node_modules", "secret"])
        // Every start sends it once (links made before the server took the list get theirs).
        await engine.stop()
        let e2 = makeEngine(tree, hub, store: store)
        let before = hub.excludeCalls.count
        await e2.start()
        #expect(hub.excludeCalls.count == before + 1)

        // An older hub (404): nothing breaks, sync goes on.
        let hub2 = FakeTransport(), store2 = TempDir(), tree2 = makeFixtureTree()
        hub2.excludesStatus = 404
        let e3 = makeEngine(tree2, hub2, store: store2)
        await e3.start()
        let phase3 = await e3.currentStatus().phase
        #expect(hub2.baselineCalls.count == 1 && phase3 == .watching)
    }

    @Test func projectStorePersistsLinksAndDecodesOlderFiles() throws {
        let dir = TempDir()
        let store = LinkedProjectStore(directory: dir.url)
        store.upsert(LinkedProject(id: "a", name: "A", localPath: "/tmp/a", hubURL: "http://h", user: "u"))
        store.upsert(LinkedProject(id: "b", name: "notes.md", localPath: "/tmp", hubURL: "http://h", user: "u", onlyPath: "notes.md"))
        #expect(store.load().map(\.id) == ["a", "b"])
        #expect(store.load()[1].isSingleFile && store.load()[1].pickedURL.path == "/tmp/notes.md")
        store.remove(id: "a")
        #expect(store.load().map(\.id) == ["b"])
        // Files written by the previous version (no onlyPath / bookmark / pending maps) still load.
        let oldList = #"[{"extraIgnore":[],"hubURL":"http://h","id":"x","linkedAt":"2026-10-30T00:00:00Z","localPath":"/tmp/x","name":"x","paused":false,"user":"u"}]"#
        try Data(oldList.utf8).write(to: dir.url.appendingPathComponent("linked-projects.json"))
        #expect(store.load().first?.onlyPath == nil)
        try Data(#"{"known":{"a.txt":"h"},"baselineDone":true}"#.utf8).write(to: dir.url.appendingPathComponent("sync/x.json"))
        let st = store.loadState("x")
        #expect(st.known == ["a.txt": "h"] && st.baselineDone && st.outgoing.isEmpty && st.incoming.isEmpty)
    }
}
