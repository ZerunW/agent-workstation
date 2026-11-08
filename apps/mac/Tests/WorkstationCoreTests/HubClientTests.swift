import Foundation
import Testing
@testable import WorkstationCore

/// URLProtocol stub: each test installs a handler keyed by a unique host so suites can run in parallel.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = (URLRequest, Data) -> (Int, [String: String], Data)
    nonisolated(unsafe) static var handlers: [String: Handler] = [:]
    static let lock = NSLock()

    static func register(_ host: String, _ h: @escaping Handler) { lock.lock(); handlers[host] = h; lock.unlock() }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let h = Self.handlers[request.url?.host ?? ""]
        Self.lock.unlock()
        var body = request.httpBody ?? Data()
        if body.isEmpty, let s = request.httpBodyStream {
            s.open()
            var buf = [UInt8](repeating: 0, count: 65536)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; body.append(buf, count: n) }
            s.close()
        }
        let (status, headers, data) = h?(request, body) ?? (500, [:], Data())
        let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func session() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: cfg)
    }
}

@Suite("HubClient over a stubbed URLSession")
struct HubClientTests {
    func client(_ host: String, user: String? = "alice", _ h: @escaping StubProtocol.Handler) -> HubClient {
        StubProtocol.register(host, h)
        return HubClient(baseURL: URL(string: "http://\(host):9000")!, user: user, session: StubProtocol.session())
    }

    @Test func excludesPayloadAnd404() async throws {
        let seen = Locked<(String, String, Data)?>(nil)
        let c = client("excludes.test") { req, body in
            seen.mutate { $0 = (req.httpMethod ?? "", req.url!.path, body) }
            return (204, [:], Data())
        }
        try await c.putExcludes(projectId: "p1", paths: [ExcludedPath(path: "build", kind: .folder), ExcludedPath(path: "a.log", kind: .file)])
        #expect(seen.value?.0 == "PUT" && seen.value?.1 == "/api/projects/p1/excludes")
        let body = try JSONDecoder().decode(JSONValue.self, from: seen.value?.2 ?? Data())
        #expect(body == ["paths": [["path": "build", "kind": "folder"], ["path": "a.log", "kind": "file"]]])
        let old = client("excludes404.test") { _, _ in (404, [:], Data(#"{"error":"not found"}"#.utf8)) }
        try await old.putExcludes(projectId: "p1", paths: [])
        let down = client("excludes500.test") { _, _ in (500, [:], Data()) }
        await #expect(throws: HubError.self) { try await down.putExcludes(projectId: "p1", paths: []) }
    }

    @Test func sendsUserHeaderAndDecodesEnvelopes() async throws {
        let seen = Locked<[String]>([])
        let c = client("h1.test") { req, _ in
            seen.mutate { $0.append(req.value(forHTTPHeaderField: "X-Workstation-User") ?? "-") }
            switch req.url!.path {
            case "/api/users": return (200, [:], Data(#"{"users":[{"name":"alice","createdAt":"","isAdmin":false,"enabled":true,"terminalEnabled":true,"weeklyTokenLimit":null,"modelAllowlist":null}]}"#.utf8))
            case "/api/models": return (200, [:], Data(#"[{"value":"claude-opus-5-5","displayName":"Opus 5.5","supportedEffortLevels":["low","medium","high","xhigh","max"]}]"#.utf8))
            default: return (404, [:], Data(#"{"error":"not found","code":"not_found"}"#.utf8))
            }
        }
        #expect(try await c.users().map(\.name) == ["alice"])
        #expect(try await c.models().first?.supportedEffortLevels?.count == 5)
        await #expect(throws: HubError.http(status: 404, message: "not found", code: "not_found")) { try await c.me() }
        #expect(seen.value == ["alice", "alice", "alice"])
    }

    @Test func pushFilesTreats409BodyAsResult() async throws {
        let c = client("h2.test") { req, body in
            #expect(req.httpMethod == "PUT")
            let sent = try! JSONDecoder().decode(SyncBody.self, from: body)
            #expect(sent.ops.first?.baseHash == "B")
            return (409, [:], Data(#"{"localCommit":null,"results":[{"path":"a","status":"conflict","reason":"merge"}]}"#.utf8))
        }
        let r = try await c.pushFiles(projectId: "p", ops: [.write(path: "a", hash: "H", size: 1, mode: 420, baseHash: "B", contentBase64: "eA==", force: nil)])
        #expect(r.results == [SyncResultItem(path: "a", status: .conflict, reason: "merge")])
    }

    @Test func chunkedUploadSendsProtocolHeaders() async throws {
        let calls = Locked<[[String: String]]>([])
        let sizes = Locked<[Int]>([])
        let c = client("h3.test") { req, body in
            var h: [String: String] = [:]
            for k in ["X-Upload-Id", "X-Upload-Path", "X-Chunk-Index", "X-Chunk-Total", "X-Total-Bytes"] { h[k] = req.value(forHTTPHeaderField: k) }
            calls.mutate { $0.append(h) }
            sizes.mutate { $0.append(body.count) }
            let last = h["X-Chunk-Index"] == String(Int(h["X-Chunk-Total"]!)! - 1)
            return (200, [:], Data(#"{"uploadId":"\#(h["X-Upload-Id"]!)","received":[0],"complete":\#(last),"path":"inbox/stored.bin"}"#.utf8))
        }
        let t = TempDir()
        let f = t.url.appendingPathComponent("big.bin")
        try Data(repeating: 7, count: WorkstationProtocol.uploadChunkBytes + 10).write(to: f)
        let path = try await c.uploadFile(f, to: "inbox/big.bin")
        #expect(path == "inbox/stored.bin")
        #expect(calls.value.count == 2)
        #expect(calls.value.map { $0["X-Chunk-Index"]! } == ["0", "1"])
        #expect(Set(calls.value.map { $0["X-Upload-Id"]! }).count == 1)
        #expect(calls.value.allSatisfy { $0["X-Upload-Path"] == "inbox%2Fbig.bin" && $0["X-Chunk-Total"] == "2" && $0["X-Total-Bytes"] == String(WorkstationProtocol.uploadChunkBytes + 10) })
        #expect(sizes.value == [WorkstationProtocol.uploadChunkBytes, 10])
    }

    @Test func baselineUploadStreamsArchiveWithEncodingHeader() async throws {
        let got = Locked<(String?, String?, Int)>((nil, nil, 0))
        let c = client("h4.test") { req, body in
            got.mutate { $0 = (req.value(forHTTPHeaderField: "X-Baseline-Encoding"), req.value(forHTTPHeaderField: "Content-Type"), body.count) }
            return (200, [:], Data("{}".utf8))
        }
        let t = TempDir()
        let f = t.write("a.tar", String(repeating: "x", count: 5000))
        try await c.uploadBaseline(projectId: "p", archive: f, encoding: .tar)
        #expect(got.value.0 == "tar")
        #expect(got.value.1 == "application/x-tar")
        #expect(got.value.2 == 5000)
    }

    @Test func rawFile404IsNil() async throws {
        let c = client("h5.test") { req, _ in
            req.url!.query!.contains("missing") ? (404, [:], Data()) : (200, [:], Data("bytes".utf8))
        }
        #expect(try await c.rawFile(projectId: "p", path: "missing.txt") == nil)
        #expect(try await c.rawFile(projectId: "p", path: "a.txt") == Data("bytes".utf8))
    }

    @Test func memoryEndpoints() async throws {
        let seen = Locked<[String]>([])
        let c = client("h6.test") { req, body in
            let line = "\(req.httpMethod ?? "?") \(req.url!.path) \(String(decoding: body, as: UTF8.self))"
            seen.mutate { $0.append(line) }
            let m = #"{"id":"m1","text":"Likes tea.","source":"user","sessionId":null,"createdAt":"2026-10-31T01:00:00.000Z","updatedAt":"2026-10-31T01:00:00.000Z"}"#
            switch (req.httpMethod ?? "", req.url!.path) {
            case ("GET", "/api/me/memories"): return (200, [:], Data(#"{"memories":[\#(m)]}"#.utf8))
            case ("POST", "/api/me/memories"): return (201, [:], Data(m.utf8))
            case ("PATCH", "/api/me/memories/m1"): return (200, [:], Data(m.replacingOccurrences(of: "Likes tea.", with: "Likes green tea.").utf8))
            case ("DELETE", "/api/me/memories/m1"): return (204, [:], Data())
            default: return (404, [:], Data(#"{"error":"no such memory","code":"memory_not_found"}"#.utf8))
            }
        }
        #expect(try await c.memories().map(\.text) == ["Likes tea."])
        #expect(try await c.createMemory("Likes tea.").id == "m1")
        #expect(try await c.updateMemory("m1", text: "Likes green tea.").text == "Likes green tea.")
        try await c.deleteMemory("m1")
        await #expect(throws: HubError.http(status: 404, message: "no such memory", code: "memory_not_found")) { try await c.deleteMemory("m2") }
        #expect(seen.value.prefix(4) == ["GET /api/me/memories ", #"POST /api/me/memories {"text":"Likes tea."}"#,
                                          #"PATCH /api/me/memories/m1 {"text":"Likes green tea."}"#, "DELETE /api/me/memories/m1 "])
    }

    @Test func transportErrorsAreFriendly() async {
        let c = HubClient(baseURL: URL(string: "http://127.0.0.1:1")!, user: "x")
        await #expect(throws: HubError.self) { try await c.me() }
        #expect(await c.health() == false)
    }
}
