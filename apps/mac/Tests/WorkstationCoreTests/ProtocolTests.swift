import Foundation
import Testing
@testable import WorkstationCore

@Suite("WebSocket event decoding")
struct EventDecodingTests {
    let S = "3f6c1d2e-8a4b-4c5d-9e6f-0a1b2c3d4e5f"
    let P = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e"

    func ev(_ name: String) -> ServerEvent? { ServerEvent.decode(Fixtures.data(name)) }

    @Test func welcome() {
        guard case let .welcome(user, v, _) = ev("welcome") else { Issue.record("welcome"); return }
        #expect(user.name == "alice" && user.isAdmin && v == 1 && user.weeklyTokenLimit == nil)
    }

    @Test func sessionState() {
        #expect(ev("session_state") == .sessionState(sessionId: S, status: .requiresAction, queuePosition: nil))
    }

    @Test func sessionSettings() {
        guard case let .sessionSettings(sid, st) = ev("session_settings") else { Issue.record(); return }
        #expect(sid == S && st.model == "claude-sonnet-5-5" && st.permissionMode == .plan && st.effort == nil)
    }

    @Test func sessionUpdatedAndDeleted() {
        guard case let .sessionUpdated(s) = ev("session_updated") else { Issue.record(); return }
        #expect(s.id == S && s.kind == .code && s.permissionMode == .acceptEdits && s.effort == .high && s.status == .running && s.lastSeq == 12)
        #expect(ev("session_deleted") == .sessionDeleted(sessionId: S))
    }

    @Test func permissions() {
        guard case let .permissionRequest(r) = ev("permission_request") else { Issue.record(); return }
        #expect(r.requestId == "req-1" && r.toolName == "Bash" && r.summary == "npm test" && r.suggestions?.count == 1)
        #expect(ev("permission_resolved") == .permissionResolved(sessionId: S, requestId: "req-1", behavior: "allow"))
        #expect(ev("permission_cancelled") == .permissionCancelled(sessionId: S, requestId: "req-1"))
    }

    @Test func reviewAndConflict() {
        #expect(ev("review_changed") == .reviewChanged(projectId: P, localCommit: "deadbeef", pendingFiles: 3))
        #expect(ev("sync_conflict") == .syncConflict(projectId: P, path: "src/a.ts", reason: "merge conflict"))
    }

    @Test func usageLimits() {
        guard case let .usageLimits(l) = ev("usage_limits") else { Issue.record(); return }
        #expect(l.api?.spentUsd == 164.5 && l.api?.limitUsd == 200 && l.api?.percent == 82.25)
        #expect(l.api?.severity == .warning && l.needsAttention)
    }

    @Test func diskStatus() {
        guard case let .diskStatus(d) = ev("disk_status") else { Issue.record(); return }
        #expect(d.level == .warn && d.projects.first?.pendingFiles == 3 && d.breakdown.count == 1)
    }

    @Test func noticeAndError() {
        #expect(ev("notice") == .notice(level: "warning", code: "claude_logged_out", message: "Claude login lost", at: "2026-10-31T02:00:00.000Z"))
        #expect(ev("error") == .error(code: "bad_request", message: "nope", sessionId: S))
    }

    @Test func snapshotMessageReplayFileEventPong() {
        guard case let .snapshot(sid, session, pending) = ev("snapshot") else { Issue.record(); return }
        #expect(sid == S && session?.title == "Fix the sync engine" && pending?.requestId == "req-1")
        guard case let .message(_, m) = ev("message") else { Issue.record(); return }
        #expect(m.seq == 13 && m.payload["message"]?["content"]?[0]?["text"]?.stringValue == "Done.")
        guard case let .replay(_, ms) = ev("replay") else { Issue.record(); return }
        #expect(ms.count == 1)
        #expect(ev("file_event") == .fileEvent(path: "inbox/a.png", kind: "add", sessionId: nil))
        #expect(ev("pong") == .pong)
    }

    @Test func memoriesChangedAndContextUsage() {
        #expect(ev("memories_changed") == .memoriesChanged)
        #expect(ev("memories_changed")?.typeName == "memories_changed")
        guard case let .contextUsage(sid, u) = ev("context_usage") else { Issue.record("context_usage"); return }
        #expect(sid == S && u.usedTokens == 262_700 && u.windowTokens == 1_000_000 && u.model == "claude-opus-5-5")
        #expect(u.breakdown?.map(\.key) == ["system_prompt", "system_tools", "mcp_tools", "skills", "memory", "messages", "autocompact_buffer"])
        #expect(u.freeTokens == 1_000_000 - 307_700, "free = window − every category, buffer included")
        #expect(abs(u.usedFraction - 0.2627) < 0.0001)
        let totals = ServerEvent.decode(#"{"type":"context_usage","sessionId":"s","usage":{"usedTokens":50000,"windowTokens":200000,"model":null,"breakdown":null,"updatedAt":"x"}}"#)
        guard case let .contextUsage(_, t) = totals else { Issue.record("totals"); return }
        #expect(t.breakdown == nil && t.model == nil && t.freeTokens == 150_000)
        #expect(ServerEvent.decode(#"{"type":"context_usage","sessionId":"s"}"#) == .unknown(type: "context_usage"), "malformed stays unknown")
    }

    @Test func unknownAndIgnoredEventsAreTolerated() {
        #expect(ev("future_event") == .unknown(type: "brand_new_thing"))
        #expect(ev("delta") == .unknown(type: "delta"), "deltas are left to the web view")
        #expect(ServerEvent.decode("not json") == nil)
        #expect(ServerEvent.decode(#"{"type":"session_state","sessionId":1}"#) == .unknown(type: "session_state"), "malformed known type")
        #expect(ServerEvent.decode(#"{"type":"session_state","sessionId":"x","status":"hibernating","queuePosition":null}"#)
                == .sessionState(sessionId: "x", status: .idle, queuePosition: nil), "unknown enum value falls back")
    }

    @Test func clientEventsEncodeExactly() {
        #expect(ClientEvent.hello(user: "alice", protocolVersion: 1).text == #"{"protocolVersion":1,"type":"hello","user":"alice"}"#)
        #expect(ClientEvent.subscribe(sessionId: S, lastSeq: 7).text == #"{"lastSeq":7,"sessionId":"\#(S)","type":"subscribe"}"#)
        #expect(ClientEvent.unsubscribe(sessionId: S).text == #"{"sessionId":"\#(S)","type":"unsubscribe"}"#)
        #expect(ClientEvent.ping.text == #"{"type":"ping"}"#)
        let pr = ClientEvent.permissionResponse(sessionId: S, response: PermissionResponse(requestId: "r", behavior: "deny", message: "no"))
        #expect(pr.text == #"{"response":{"behavior":"deny","message":"no","requestId":"r"},"sessionId":"\#(S)","type":"permission_response"}"#)
    }
}

@Suite("Models: exact JSON shapes")
struct ModelCodingTests {
    func json<T: Encodable>(_ v: T) -> String {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try! e.encode(v), as: UTF8.self)
    }

    @Test func syncOpAlwaysEncodesBaseHash() {
        #expect(json(SyncOp.write(path: "a", hash: "h", size: 1, mode: 420, baseHash: nil, contentBase64: "eA==", force: nil))
                == #"{"baseHash":null,"contentBase64":"eA==","hash":"h","mode":420,"op":"write","path":"a","size":1}"#)
        #expect(json(SyncOp.delete(path: "a", baseHash: "b", force: true)) == #"{"baseHash":"b","force":true,"op":"delete","path":"a"}"#)
        let back = try! JSONDecoder().decode(SyncOp.self, from: Data(json(SyncOp.delete(path: "a", baseHash: nil, force: nil)).utf8))
        #expect(back == .delete(path: "a", baseHash: nil, force: nil))
    }

    @Test func projectBackupContract() throws {
        let body = ProjectBackupBody(client: "mac:Air", reason: .overwrite, files: [.init(path: "a.txt", dataBase64: "aGk=", mode: 420)])
        let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys]
        #expect(String(decoding: try enc.encode(body), as: UTF8.self)
                == #"{"client":"mac:Air","files":[{"dataBase64":"aGk=","mode":420,"path":"a.txt"}],"reason":"overwrite"}"#)
        let json = #"{"backups":[{"id":"b1","ref":"refs/backups/mac/b1","commit":"abc","client":"mac:Air","reason":"delete","at":"2026-10-31T10:00:00.000Z","files":[{"path":"a.txt","blob":"ce01","size":6}]}]}"#
        let list = try HubClient.decodeList(ProjectBackup.self, from: Data(json.utf8), key: "backups")
        #expect(list.first?.reason == .delete && list.first?.files.first?.blob == "ce01" && list.first?.ref == "refs/backups/mac/b1")
    }

    @Test func acceptBody() {
        #expect(json(AcceptBody.file(path: "src/a.ts", hunks: [0, 2], diffId: "d1")) == #"{"diffId":"d1","hunks":[0,2],"path":"src/a.ts"}"#)
        #expect(json(AcceptBody.file(path: "a")) == #"{"path":"a"}"#)
        #expect(json(AcceptBody.all) == #"{"all":true}"#)
    }

    @Test func settingsPatchDistinguishesNullFromAbsent() {
        #expect(json(SessionSettingsPatch(model: "m")) == #"{"model":"m"}"#)
        #expect(json(SessionSettingsPatch(effort: .some(nil))) == #"{"effort":null}"#)
        #expect(json(SessionSettingsPatch(permissionMode: .plan, effort: .some(.max))) == #"{"effort":"max","permissionMode":"plan"}"#)
        #expect(SessionSettingsPatch(effort: .some(nil)).jsonValue == ["effort": nil])
        #expect(SessionSettingsPatch().isEmpty)
    }

    @Test func preferencesBodySendsMemoryEnabledOnlyWhenSet() {
        #expect(json(UserPreferencesBody(defaultModel: nil, defaultEffort: nil)) == #"{"defaultEffort":null,"defaultModel":null}"#)
        #expect(json(UserPreferencesBody(defaultModel: "haiku", defaultEffort: .low, memoryEnabled: false))
                == #"{"defaultEffort":"low","defaultModel":"haiku","memoryEnabled":false}"#)
        #expect(json(UserPreferencesBody(memoryEnabled: true)) == #"{"memoryEnabled":true}"#, "sparse: never touches the defaults")
    }

    @Test func memoryAndUserMemoryFlagDecode() throws {
        let m = try JSONDecoder().decode(Memory.self, from: Data(#"{"id":"m1","text":"Prefers metric units.","source":"claude","sessionId":"s1","createdAt":"2026-10-31T01:00:00.000Z","updatedAt":"2026-10-31T01:00:00.000Z"}"#.utf8))
        #expect(m.isFromClaude && m.sessionId == "s1")
        let list = try HubClient.decodeList(Memory.self, from: Data(#"{"memories":[{"id":"m2","text":"t","source":"user","sessionId":null,"createdAt":"","updatedAt":""}]}"#.utf8), key: "memories")
        #expect(list.map(\.id) == ["m2"] && list[0].sessionId == nil && !list[0].isFromClaude)
        #expect(json(MemoryBody(text: "x")) == #"{"text":"x"}"#)
        let u = Data(#"{"name":"a","createdAt":"","isAdmin":false,"enabled":true,"terminalEnabled":true,"weeklyTokenLimit":null,"modelAllowlist":null,"memoryEnabled":false}"#.utf8)
        #expect(try JSONDecoder().decode(User.self, from: u).memoryEnabled == false)
        let old = Data(#"{"name":"a","createdAt":"","isAdmin":false,"enabled":true,"terminalEnabled":true,"weeklyTokenLimit":null,"modelAllowlist":null}"#.utf8)
        #expect(try JSONDecoder().decode(User.self, from: old).memoryEnabled == nil)
    }

    @Test func sessionContextUsageIsOptional() throws {
        let base = #""id":"x","user":"u","kind":"code","title":"t","cwd":"","model":"m","permissionMode":"default","effort":null,"status":"idle","queuePosition":null,"claudeSessionId":null,"createdAt":"","lastActiveAt":"","lastSeq":3,"costUsd":0"#
        let d = JSONDecoder()
        #expect(try d.decode(Session.self, from: Data("{\(base)}".utf8)).contextUsage == nil)
        #expect(try d.decode(Session.self, from: Data("{\(base),\"contextUsage\":null}".utf8)).contextUsage == nil)
        let bad = try d.decode(Session.self, from: Data("{\(base),\"contextUsage\":{\"usedTokens\":\"lots\"}}".utf8))
        #expect(bad.contextUsage == nil && bad.lastSeq == 3, "a malformed usage block never hides the session")
        let full = try d.decode(Session.self, from: Data("{\(base),\"contextUsage\":{\"usedTokens\":10,\"windowTokens\":100,\"model\":null,\"breakdown\":[{\"key\":\"messages\",\"label\":\"Messages\",\"tokens\":10}],\"updatedAt\":\"u\"}}".utf8))
        #expect(full.contextUsage?.breakdown?.first?.tokens == 10)
        // Round trip (MockHub encodes sessions with synthesized encoding).
        let again = try d.decode(Session.self, from: JSONEncoder().encode(full))
        #expect(again == full)
    }

    @Test func createSessionBodyOmitsUnset() {
        #expect(json(CreateSessionBody(kind: .chat)) == #"{"kind":"chat"}"#)
        #expect(json(CreateSessionBody(kind: .code, cwd: "projects/x")) == #"{"cwd":"projects/x","kind":"code"}"#)
        #expect(json(CreateSessionBody(kind: .chat, model: "opus")) == #"{"kind":"chat","model":"opus"}"#)
    }

    @Test func modelInfoFamilyLegacy() throws {
        let d = JSONDecoder()
        let full = try d.decode(ModelInfo.self, from: Data(#"{"value":"opus","displayName":"Opus","supportsEffort":true,"supportedEffortLevels":["low","medium","high"],"family":"opus","legacy":false}"#.utf8))
        #expect(full.family == "opus" && full.legacy == false)
        #expect(full.effortLevels == [.low, .medium, .high])
        let old = try d.decode(ModelInfo.self, from: Data(#"{"value":"claude-opus-4-1","displayName":"Opus 4.1","legacy":true,"family":"opus"}"#.utf8))
        #expect(old.legacy == true)
        let bare = try d.decode(ModelInfo.self, from: Data(#"{"value":"opus","displayName":"Opus"}"#.utf8))
        #expect(bare.family == nil && bare.legacy == nil)
        #expect(json(bare) == #"{"displayName":"Opus","value":"opus"}"#, "absent fields stay absent")
    }

    @Test func usageLimitsApiBlock() throws {
        let d = JSONDecoder()
        let none = try d.decode(UsageLimits.self, from: Data(#"{"api":null}"#.utf8))
        #expect(none.api == nil && !none.needsAttention, "null = no API key on the server")
        #expect(try d.decode(UsageLimits.self, from: Data("{}".utf8)).api == nil)
        let api = #"{"spentUsd":199,"limitUsd":200,"percent":99.5,"periodStart":"2026-10-01T00:00:00.000Z","resetsAt":"2026-11-01T00:00:00.000Z","severity":"critical"}"#
        let present = try d.decode(UsageLimits.self, from: Data(#"{"api":\#(api)}"#.utf8))
        #expect(present.api?.severity == .critical && present.needsAttention)
        let zero = try d.decode(UsageLimits.self, from: Data(#"{"api":{"spentUsd":0,"limitUsd":0,"percent":null,"periodStart":"a","resetsAt":"b","severity":"unknown"}}"#.utf8))
        #expect(zero.api?.percent == nil && !zero.needsAttention)
        #expect(try d.decode(UsageLimits.self, from: JSONEncoder().encode(present)) == present)
    }

    @Test func meApiAvailableAndBudgetSettings() throws {
        let d = JSONDecoder()
        let me = #"{"user":{"name":"a","createdAt":"","isAdmin":false,"enabled":true,"terminalEnabled":true,"weeklyTokenLimit":null,"modelAllowlist":null},"settings":{"remoteClaudeEnabled":true,"diskWarnPercent":80,"diskBlockPercent":95,"defaultWeeklyTokenLimit":0,"apiMonthlyLimitUsd":200,"apiResetDay":1,"serviceReserveUsd":2},"disk":"ok","apiAvailable":false,"protocolVersion":1}"#
        let m = try d.decode(Me.self, from: Data(me.utf8))
        #expect(m.apiAvailable == false && m.settings.apiMonthlyLimitUsd == 200 && m.settings.apiResetDay == 1 && m.settings.serviceReserveUsd == 2)
    }

    @Test func hubErrorExposesCode() {
        let e = HubError.http(status: 503, message: "no API key", code: HubErrorCode.apiUnavailable)
        #expect(e.code == "api_unavailable" && e.hubMessage == "no API key" && e.status == 503)
        #expect(HubError.transport("x").code == nil && HubErrorCode.apiLimitReached == "api_limit_reached")
    }

    @Test func listEnvelopes() throws {
        let bare = Data(#"[{"name":"a","createdAt":"","isAdmin":false,"enabled":true,"terminalEnabled":true,"weeklyTokenLimit":null,"modelAllowlist":null}]"#.utf8)
        let wrapped = Data(#"{"users":[{"name":"b","createdAt":"","isAdmin":true,"enabled":true,"terminalEnabled":false,"weeklyTokenLimit":5,"modelAllowlist":["m"]}]}"#.utf8)
        #expect(try HubClient.decodeList(User.self, from: bare, key: "users").map(\.name) == ["a"])
        #expect(try HubClient.decodeList(User.self, from: wrapped, key: "users").map(\.name) == ["b"])
        let other = Data(#"{"total":1,"things":[{"value":"m","displayName":"M","supportedEffortLevels":["low","max"]}]}"#.utf8)
        #expect(try HubClient.decodeList(ModelInfo.self, from: other, key: "models").first?.supportedEffortLevels == [.low, .max])
        let s = Data(#"{"session":{"id":"x","user":"u","kind":"chat","title":"t","cwd":".chat","model":"m","permissionMode":"dontAsk","effort":null,"status":"idle","queuePosition":null,"claudeSessionId":null,"createdAt":"","lastActiveAt":"","lastSeq":0,"costUsd":0}}"#.utf8)
        #expect(try HubClient.decodeFlexible(Session.self, from: s, key: "session").permissionMode == .dontAsk)
    }

    @Test func jsonValueRoundTrip() {
        let v: JSONValue = ["a": 1, "b": [true, nil, "x"], "c": 1.5]
        #expect(v.jsonString() == #"{"a":1,"b":[true,null,"x"],"c":1.5}"#)
        #expect(JSONValue.from(any: ["n": NSNumber(value: true), "i": 3, "s": "t"] as [String: Any]) == ["n": true, "i": 3, "s": "t"])
    }
}

@Suite("Routes and URLs")
struct RoutesTests {
    let base = URL(string: "http://192.168.1.50:9000/")!

    func u(_ e: Endpoint) -> String { "\(e.method.rawValue) \(e.url(base: base).absoluteString)" }

    @Test func everyRouteUsed() {
        let id = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e"
        let h = "http://192.168.1.50:9000"
        let cases: [(Endpoint, String)] = [
            (Routes.health(), "GET \(h)/api/health"),
            (Routes.me(), "GET \(h)/api/me"),
            (Routes.mePreferences(), "PATCH \(h)/api/me/preferences"),
            (Routes.memories(), "GET \(h)/api/me/memories"),
            (Routes.createMemory(), "POST \(h)/api/me/memories"),
            (Routes.updateMemory("m 1"), "PATCH \(h)/api/me/memories/m%201"),
            (Routes.deleteMemory(id), "DELETE \(h)/api/me/memories/\(id)"),
            (Routes.models(), "GET \(h)/api/models"),
            (Routes.users(), "GET \(h)/api/users"),
            (Routes.createUser(), "POST \(h)/api/users"),
            (Routes.sessions(kind: .code), "GET \(h)/api/sessions?kind=code"),
            (Routes.sessions(kind: nil), "GET \(h)/api/sessions"),
            (Routes.createSession(), "POST \(h)/api/sessions"),
            (Routes.session(id), "GET \(h)/api/sessions/\(id)"),
            (Routes.renameSession(id), "PATCH \(h)/api/sessions/\(id)"),
            (Routes.deleteSession(id), "DELETE \(h)/api/sessions/\(id)"),
            (Routes.sessionMessages(id, after: 5, limit: 100), "GET \(h)/api/sessions/\(id)/messages?after=5&limit=100"),
            (Routes.sendMessage(id), "POST \(h)/api/sessions/\(id)/messages"),
            (Routes.sessionSettings(id), "PATCH \(h)/api/sessions/\(id)/settings"),
            (Routes.sessionStop(id), "POST \(h)/api/sessions/\(id)/stop"),
            (Routes.sessionClose(id), "POST \(h)/api/sessions/\(id)/close"),
            (Routes.filesTree(path: "projects/my app", depth: 2), "GET \(h)/api/files/tree?path=projects/my%20app&depth=2"),
            (Routes.filesContent(path: "a+b.txt"), "GET \(h)/api/files/content?path=a%2Bb.txt"),
            (Routes.filesDownload(paths: ["a.txt", "dir/b c.txt"]), "GET \(h)/api/files/download?path=a.txt&path=dir/b%20c.txt"),
            (Routes.filesUpload(), "PUT \(h)/api/files/upload"),
            (Routes.projects(), "GET \(h)/api/projects"),
            (Routes.createProject(), "POST \(h)/api/projects"),
            (Routes.project(id), "GET \(h)/api/projects/\(id)"),
            (Routes.deleteProject(id), "DELETE \(h)/api/projects/\(id)"),
            (Routes.projectBaseline(id), "POST \(h)/api/projects/\(id)/baseline"),
            (Routes.projectManifest(id), "POST \(h)/api/projects/\(id)/manifest"),
            (Routes.projectFiles(id), "PUT \(h)/api/projects/\(id)/files"),
            (Routes.projectReview(id), "GET \(h)/api/projects/\(id)/review"),
            (Routes.projectReviewDiff(id, path: "src/中文.ts"), "GET \(h)/api/projects/\(id)/review/diff?path=src/%E4%B8%AD%E6%96%87.ts"),
            (Routes.projectAccept(id), "POST \(h)/api/projects/\(id)/review/accept"),
            (Routes.projectReject(id), "POST \(h)/api/projects/\(id)/review/reject"),
            (Routes.projectHistory(id), "GET \(h)/api/projects/\(id)/history"),
            (Routes.projectRestore(id), "POST \(h)/api/projects/\(id)/restore"),
            (Routes.projectFileRaw(id, path: "a&b=c.txt"), "GET \(h)/api/projects/\(id)/raw?path=a%26b%3Dc.txt"),
            (Routes.projectFileRaw(id, path: "a.txt", ref: "refs/backups/mac/b1"), "GET \(h)/api/projects/\(id)/raw?path=a.txt&ref=refs/backups/mac/b1"),
            (Routes.projectFileRaw(id, path: "a.txt", ref: "local"), "GET \(h)/api/projects/\(id)/raw?path=a.txt&ref=local"),
            (Routes.projectBackups(id), "GET \(h)/api/projects/\(id)/backups"),
            (Routes.createProjectBackup(id), "POST \(h)/api/projects/\(id)/backups"),
            (Routes.usageLimits(), "GET \(h)/api/usage/limits"),
            (Routes.usageMe(range: .today), "GET \(h)/api/usage/me?range=today"),
            (Routes.disk(), "GET \(h)/api/disk"),
            (Routes.adminSettings(), "GET \(h)/api/admin/settings"),
            (Routes.patchAdminSettings(), "PATCH \(h)/api/admin/settings"),
            (Routes.terminals(), "GET \(h)/api/terminals"),
            (Routes.createTerminal(), "POST \(h)/api/terminals"),
        ]
        for (e, expected) in cases { #expect(u(e) == expected) }
    }

    @Test func webSocketURLs() {
        #expect(Routes.webSocketURL(base: base).absoluteString == "ws://192.168.1.50:9000/ws")
        #expect(Routes.webSocketURL(base: base, user: "alice").absoluteString == "ws://192.168.1.50:9000/ws?user=alice")
        #expect(Routes.webSocketURL(base: URL(string: "https://workstation.example.run")!).absoluteString == "wss://workstation.example.run/ws")
    }
}

@Suite("Chunked upload planning")
struct ChunkTests {
    @Test func chunkRanges() {
        let c = WorkstationProtocol.uploadChunkBytes
        #expect(c == 4 * 1024 * 1024)
        #expect(ChunkPlan.ranges(totalBytes: 0) == [0..<0])
        #expect(ChunkPlan.ranges(totalBytes: 10) == [0..<10])
        #expect(ChunkPlan.ranges(totalBytes: Int64(c)) == [0..<Int64(c)])
        let r = ChunkPlan.ranges(totalBytes: Int64(c) * 2 + 1)
        #expect(r.count == 3)
        #expect(r[2] == Int64(c) * 2..<Int64(c) * 2 + 1)
        #expect(r.reduce(0) { $0 + $1.count } == Int64(c) * 2 + 1)
        #expect(ChunkPlan.ranges(totalBytes: 10, chunkSize: 3) == [0..<3, 3..<6, 6..<9, 9..<10])
    }

    @Test func chunkHeaders() {
        let h = ChunkPlan.headers(uploadId: "u", path: "inbox/a b.pdf", index: 1, total: 3, totalBytes: 99)
        #expect(h == ["X-Upload-Id": "u", "X-Upload-Path": "inbox%2Fa%20b.pdf", "X-Chunk-Index": "1", "X-Chunk-Total": "3", "X-Total-Bytes": "99"])
        #expect(encodeURIComponent("inbox/报告 (1).pdf") == "inbox%2F%E6%8A%A5%E5%91%8A%20(1).pdf")
    }
}

@Suite("Settings, Tailscale, backoff")
struct MiscTests {
    @Test func usernameValidation() {
        for ok in ["alice", "a", "user_1", "x-y", String(repeating: "a", count: 32)] { #expect(AppSettings.isValidUsername(ok)) }
        for bad in ["", "Alice", "a b", "é", String(repeating: "a", count: 33), "a.b", "../x"] { #expect(!AppSettings.isValidUsername(bad)) }
    }

    @Test func hubURLNormalisation() {
        #expect(AppSettings.normalizeHubURL("192.168.1.50:9000")?.absoluteString == "http://192.168.1.50:9000")
        #expect(AppSettings.normalizeHubURL(" https://workstation.example.run/ ")?.absoluteString == "https://workstation.example.run")
        #expect(AppSettings.normalizeHubURL("ftp://x") == nil)
        func n(_ raw: String) -> String? { AppSettings.normalizeHubURL(raw)?.absoluteString }
        // Bare host names → https (the hub is served over HTTPS; http only redirects).
        #expect(n("workstation.example.com") == "https://workstation.example.com")
        #expect(n("workstation.example.com/") == "https://workstation.example.com")
        #expect(n("workstation.tailnet-name.ts.net") == "https://workstation.tailnet-name.ts.net")
        #expect(n("Workstation.Example.Com//") == "https://Workstation.Example.Com")
        // An explicit port → http.
        #expect(n("workstation.tailnet-name.ts.net:9000") == "http://workstation.tailnet-name.ts.net:9000")
        #expect(n("192.168.1.50:9000/") == "http://192.168.1.50:9000")
        // IP literals and localhost → http.
        #expect(n("192.168.1.50") == "http://192.168.1.50")
        #expect(n("100.101.102.103") == "http://100.101.102.103")
        #expect(n("[::1]") == "http://[::1]")
        #expect(n("[fd7a:115c:a1e0::1]:9000") == "http://[fd7a:115c:a1e0::1]:9000")
        #expect(n("::1") == "http://[::1]")
        #expect(n("fe80::2") == "http://[fe80::2]")
        #expect(n("localhost") == "http://localhost")
        #expect(n("localhost:5173") == "http://localhost:5173")
        #expect(n("hub.localhost") == "http://hub.localhost")
        // Not IPv4 → a host name → https.
        #expect(n("192.168.1") == "https://192.168.1")
        #expect(n("999.1.1.1") == "https://999.1.1.1")
        #expect(n("1.2.3.4.example") == "https://1.2.3.4.example")
        // A typed scheme is kept as is; paths stay, trailing slashes go.
        #expect(n("http://workstation.example.com/") == "http://workstation.example.com")
        #expect(n("https://192.168.1.50:9000") == "https://192.168.1.50:9000")
        #expect(n("HTTPS://workstation.example.com") == "HTTPS://workstation.example.com")
        #expect(n("workstation.example.com/hub/") == "https://workstation.example.com/hub")
        #expect(n("http://") == nil && n("https:///x") == nil)
        #expect(AppSettings.normalizeHubURL("") == nil)
    }

    @Test func settingsEnvironmentOverrides() {
        let d = TestDefaults.make("workstation-test")
        let s = AppSettings(defaults: d, environment: ["WORKSTATION_HUB_URL": "http://localhost:9000", "WORKSTATION_HUB_USER": "tester"])
        #expect(s.hubURLString == "http://localhost:9000")
        #expect(s.username == "tester")
        let plain = AppSettings(defaults: d, environment: [:])
        #expect(plain.hubURLString == AppSettings.defaultHubURL)
        #expect(plain.username == nil)
        #expect(!plain.hasHubURL, "the first-run sheet asks until an address is confirmed")
        #expect(s.hasHubURL, "WORKSTATION_HUB_URL counts as configured")
        plain.username = "alice"
        #expect(plain.username == "alice")
        plain.username = nil
        #expect(plain.username == nil && d.string(forKey: "username") == nil, "logging out of the web clears the cache")
    }

    @Test func tailscaleParsing() {
        let running = Data(#"{"BackendState":"Running","Peer":{"k1":{"HostName":"laptop","DNSName":"laptop.ts.net.","Online":true},"k2":{"HostName":"workstation","DNSName":"workstation.tail.ts.net.","Online":false,"TailscaleIPs":["100.64.0.7"]}}}"#.utf8)
        #expect(TailscaleProbe.parse(running, hint: "workstation") == .running(peer: TailscalePeer(hostName: "workstation", dnsName: "workstation.tail.ts.net.", online: false, ip: "100.64.0.7")))
        #expect(TailscaleProbe.parse(Data(#"{"BackendState":"Stopped"}"#.utf8), hint: "workstation") == .stopped("Stopped"))
        #expect(TailscaleProbe.parse(Data(#"{"BackendState":"Running","Peer":{}}"#.utf8), hint: "workstation") == .running(peer: nil))
        #expect(TailscaleStatus.notInstalled.summary == "Tailscale not installed: LAN mode")
    }

    @Test func backoff() {
        let b = Backoff(base: 1, factor: 2, maximum: 30)
        #expect(b.delay(attempt: 0) == 1)
        #expect(b.delay(attempt: 3) == 8)
        #expect(b.delay(attempt: 10) == 30)
        #expect(b.delay(attempt: 3, jitter: 1) == 4)
    }

    @Test func compactTokensAndAgo() {
        #expect(Formatters.compactTokens(262_700) == "262.7k")
        #expect(Formatters.compactTokens(1_000_000) == "1M")
        #expect(Formatters.compactTokens(1_500_000) == "1.5M")
        #expect(Formatters.compactTokens(200_000) == "200k")
        #expect(Formatters.compactTokens(812) == "812")
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(Formatters.ago(now.addingTimeInterval(-20), now: now) == "just now")
        #expect(Formatters.ago(now.addingTimeInterval(-5 * 60), now: now) == "5 min ago")
        #expect(Formatters.ago(now.addingTimeInterval(-3 * 3600), now: now) == "3 h ago")
        #expect(Formatters.ago(now.addingTimeInterval(-2 * 86_400), now: now) == "2 d ago")
    }

    @Test func countdownFormatting() {
        let now = Date(timeIntervalSince1970: 0)
        #expect(Formatters.countdown(to: now.addingTimeInterval(2 * 3600 + 14 * 60), now: now) == "in 2 h 14 min")
        #expect(Formatters.countdown(to: now.addingTimeInterval(3 * 86_400 + 4 * 3600), now: now) == "in 3 d 4 h")
        #expect(Formatters.countdown(to: now.addingTimeInterval(-5), now: now) == "now")
        #expect(Formatters.shortCountdown(to: now.addingTimeInterval(37 * 60 + 5), now: now) == "in 37m")
        #expect(Formatters.shortCountdown(to: now.addingTimeInterval(2 * 3600 + 14 * 60), now: now) == "in 2h 14m")
        #expect(Formatters.shortCountdown(to: now.addingTimeInterval(3 * 86_400 + 4 * 3600), now: now) == "in 3d 4h")
        let utc = TimeZone(identifier: "UTC")!
        let reset = Formatters.parseISO("2026-10-31T15:20:00.000Z")!
        #expect(Formatters.resetLine(reset, now: reset.addingTimeInterval(-37 * 60), timeZone: utc) == "Resets in 37m · Oct 31, 03:20 PM")
        #expect(Formatters.resetLine(reset, now: reset.addingTimeInterval(60), timeZone: utc) == "Resets now · Oct 31, 03:20 PM")
        #expect(Formatters.resetLine(nil) == "Reset time unknown")
        #expect(Formatters.parseISO("2026-10-31T02:00:00.000Z") != nil)
        #expect(Formatters.parseISO("2026-10-31T02:00:00Z") != nil)
        #expect(Formatters.parseISO("2026-10-31") != nil)
    }
}
