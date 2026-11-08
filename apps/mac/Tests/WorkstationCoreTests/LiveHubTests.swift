import Foundation
import Testing
@testable import WorkstationCore

/// Opt-in integration test against a real workstation-hub:
///
///     WORKSTATION_LIVE_HUB=https://workstation.example-tailnet.ts.net ./scripts/swiftpm.sh test --filter LiveHub
///
/// Uses a dedicated user (`macsmoke`), never sends a prompt to Claude (no API
/// usage), and deletes the session / project / upload it creates.
@Suite("Live hub (WORKSTATION_LIVE_HUB)", .enabled(if: ProcessInfo.processInfo.environment["WORKSTATION_LIVE_HUB"] != nil), .serialized)
struct LiveHubTests {
    let base = URL(string: ProcessInfo.processInfo.environment["WORKSTATION_LIVE_HUB"] ?? "http://localhost:9000")!
    let user = "macsmoke"

    func client() async throws -> HubClient {
        let anon = HubClient(baseURL: base, user: nil)
        #expect(await anon.health())
        let c = HubClient(baseURL: base, user: user)
        _ = try await c.createUser(user) // idempotent: 201 new, 200 existing
        return c
    }

    @Test func identitySessionsAndSettings() async throws {
        let c = try await client()
        let me = try await c.me()
        #expect(me.user.name == user)
        #expect(me.protocolVersion == WorkstationProtocol.protocolVersion)
        let models = try await c.models()
        #expect(!models.isEmpty)
        _ = try await c.sessions(kind: .chat)
        let s = try await c.createSession(CreateSessionBody(kind: .chat))
        #expect(s.kind == .chat)
        try await c.patchSettings(s.id, SessionSettingsPatch(effort: .some(.low)))
        let renamed = try await c.renameSession(s.id, title: "mac smoke")
        #expect(renamed == nil || renamed?.title == "mac smoke")
        let fetched = try await c.session(s.id)
        #expect(fetched.title == "mac smoke")
        #expect(fetched.effort == .low)
        #expect(try await c.messages(s.id).isEmpty)
        try await c.deleteSession(s.id)
        _ = try await c.usageLimits()
        _ = try await c.disk()
    }

    @Test func webSocketWelcome() async throws {
        _ = try await client()
        let socket = HubSocket(baseURL: base, user: user)
        let got = Locked<ServerEvent?>(nil)
        socket.onEvent = { ev in if case .welcome = ev { got.mutate { $0 = ev } } }
        socket.start()
        defer { socket.stop() }
        for _ in 0..<100 where got.value == nil { try await Task.sleep(nanoseconds: 100_000_000) }
        guard case let .welcome(u, v, _)? = got.value else { Issue.record("no welcome from \(base)"); return }
        #expect(u.name == user && v == WorkstationProtocol.protocolVersion)
    }

    @Test func uploadChunked() async throws {
        let c = try await client()
        let t = TempDir()
        let name = "macsmoke-\(UUID().uuidString.prefix(6)) 报告.txt"
        let f = t.write(name, "hello from the mac app\n")
        let stored = try await c.uploadFile(f, to: "inbox/\(name)")
        #expect(stored.hasPrefix("inbox/macsmoke-"))
        let entries = try await c.tree(path: "inbox", depth: 1)
        #expect(entries.contains { $0.path == stored })
        let content = try await c.fileContent(path: stored)
        #expect(content.text == "hello from the mac app\n")
        try await c.sendVoid(Endpoint(.DELETE, "/api/files", query: [("path", stored)]))
    }

    @Test func projectBaselineManifestPushReviewAndClear() async throws {
        let c = try await client()
        let name = "macsmoke-\(UUID().uuidString.prefix(6).lowercased())"
        let project: Project
        do {
            project = try await c.createProject(name: name, origin: "WorkstationCoreTests")
        } catch let e as HubError where e.status == 501 {
            print("live hub: projects not implemented on \(base) yet (501): skipping the sync part")
            return
        }
        let tree = makeFixtureTree()
        let store = TempDir()
        let linked = LinkedProject(id: project.id, name: project.name, localPath: tree.url.path, hubURL: base.absoluteString, user: user)
        let engine = SyncEngine(project: linked, transport: c, store: LinkedProjectStore(directory: store.url),
                                writer: InProcessWriter(deleteMode: .removeForTests), useWatcher: false)
        do {
            await engine.start()
            var st = await engine.currentStatus()
            #expect(st.phase == .watching, "\(st.phase) \(st.lastError ?? "")")
            #expect(await engine.syncState().baselineEncoding == (BaselineArchiver.findZstd() != nil ? "tar.zst" : "tar"))
            #expect(await engine.knownHashes().count == 7)

            // Manifest after the baseline: nothing needed.
            let manifest = try await c.manifest(projectId: project.id, entries: LocalScanner.scan(root: tree.url).manifest)
            #expect(manifest.need.isEmpty && manifest.delete.isEmpty)

            // Push an edit + a new file + a delete with baseHash bookkeeping.
            tree.write("README.md", "hello server\n")
            tree.write("src/new.txt", "new file\n")
            try FileManager.default.removeItem(at: tree.url.appendingPathComponent("src/a.js"))
            await engine.handleLocalChanges(["README.md", "src/new.txt", "src/a.js"])
            #expect(await engine.currentStatus().outgoing.count == 3, "recorded, not pushed")
            _ = try await engine.syncToServer(nil)   // the approval
            st = await engine.currentStatus()
            #expect(st.lastError == nil, "\(st.lastError ?? "")")
            #expect(st.conflicts.isEmpty)
            #expect(try await c.rawFile(projectId: project.id, path: "README.md") == Data("hello server\n".utf8))
            #expect(try await c.rawFile(projectId: project.id, path: "src/a.js") == nil)

            // Nothing for Claude touched it → no pending review.
            let review = try await c.review(projectId: project.id)
            #expect(review.files.isEmpty)
            _ = try await c.history(projectId: project.id)
            await engine.reconcile()
            #expect(await engine.currentStatus().phase == .watching)
        }
        await engine.stop()
        try await c.deleteProject(project.id, discardRemaining: true)
        #expect(!(try await c.projects()).contains { $0.id == project.id })
    }
}
