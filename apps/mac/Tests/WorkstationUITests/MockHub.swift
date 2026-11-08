import Foundation
@testable import WorkstationCore

/// A small in-process Agent Workstation served through a `URLProtocol` (no sockets, no desktop). It is
/// stateful enough to drive the shell's native services end to end: health (switchable for the
/// offline state), identity, the session list (notification titles), disk, and projects with a
/// baseline that is really unpacked with tar, manifest, file pushes with conflict injection, raw
/// files, accept and delete.
final class MockHub: @unchecked Sendable {
    static let host = "mockhub.test"
    static var baseURL: URL { URL(string: "http://\(host):9000")! }

    private let lock = NSLock()
    weak var events: FakeEventSource?

    var healthy = true
    var users: [User] = []
    var sessions: [Session] = []
    var projects: [Project] = []
    var local: [String: [String: String]] = [:]            // projectId → path → hash (branch `local`)
    var worktree: [String: [String: Data]] = [:]           // projectId → Claude's working-tree bytes
    var review: [String: [ReviewFile]] = [:]
    var blobs: [String: Data] = [:]                         // sha256 → bytes the hub has seen
    var commits: [String: [String: [String: String]]] = [:] // projectId → commit → local map
    var backupsEnabled = true                               // false = the endpoint answers 404 (hub not updated yet)
    var backups: [String: [ProjectBackup]] = [:]
    var conflictPaths: Set<String> = []
    var disk = DiskStatus(level: .ok, usedPercent: 41, totalBytes: 128_000_000_000, freeBytes: 75_000_000_000)
    /// `GET /api/app/<platform>/latest` (missing = 404) and the bytes `GET /api/app/<platform>/download` serves.
    var appReleases: [String: AppRelease] = [:]
    /// PUT /api/projects/:id/excludes bodies, by project.
    var excludes: [String: JSONValue] = [:]
    var appDmgs: [String: Data] = [:]
    /// The `mac` (Apple Silicon) channel.
    var appRelease: AppRelease? { get { appReleases["mac"] } set { appReleases["mac"] = newValue } }
    var appDmg: Data { get { appDmgs["mac"] ?? Data() } set { appDmgs["mac"] = newValue } }

    // Recorded traffic
    var requests: [String] = []
    var baselineEncodings: [String] = []
    var pushedOps: [SyncOp] = []
    var userHeaders: Set<String> = []
    var deletedProjects: [String] = []
    var backupBodies: [ProjectBackupBody] = []
    private var commitSeq = 0

    static let shared = MockHub()

    func reset() {
        lock.withLock {
            healthy = true
            users = [User(name: "alice", createdAt: "2026-10-30T00:00:00.000Z"), User(name: "bob", createdAt: "2026-10-30T00:00:00.000Z", isAdmin: true),
                     User(name: "carol", createdAt: "2026-10-30T00:00:00.000Z")]
            sessions = []; projects = []; local = [:]; worktree = [:]; review = [:]
            conflictPaths = []; requests = []; baselineEncodings = []; pushedOps = []; userHeaders = []; deletedProjects = []
            blobs = [:]; commits = [:]; backupsEnabled = true; backups = [:]; backupBodies = []; commitSeq = 0
            appReleases = [:]; appDmgs = [:]
            disk = DiskStatus(level: .ok, usedPercent: 41, totalBytes: 128_000_000_000, freeBytes: 75_000_000_000)
        }
    }

    func with<T>(_ f: (MockHub) -> T) -> T { lock.withLock { f(self) } }

    /// Call with the lock held: records the current `local` as a new commit.
    private func commit(_ pid: String) -> String {
        commitSeq += 1
        let c = "commit\(commitSeq)"
        commits[pid, default: [:]][c] = local[pid] ?? [:]
        return c
    }

    private func latestCommit(_ pid: String) -> String? {
        commits[pid]?.keys.max { (Int($0.dropFirst(6)) ?? 0) < (Int($1.dropFirst(6)) ?? 0) }
    }

    /// What an accept in the web review page (or on another device) does to one file, plus the
    /// `review_changed` broadcast the hub sends.
    func acceptOnServer(_ pid: String, _ path: String, _ data: Data?) {
        let ev: FakeEventSource? = lock.withLock {
            if let data {
                let h = FileHasher.sha256(data)
                local[pid, default: [:]][path] = h; blobs[h] = data; worktree[pid, default: [:]][path] = data
            } else {
                local[pid]?.removeValue(forKey: path); worktree[pid]?.removeValue(forKey: path)
            }
            _ = commit(pid)
            return events
        }
        ev?.emit(.reviewChanged(projectId: pid, localCommit: nil, pendingFiles: 0))
    }

    @discardableResult
    func addSession(user: String, title: String, kind: SessionKind = .code, status: SessionStatus = .idle) -> Session {
        lock.withLock {
            let now = Formatters.iso(Date())
            let s = Session(id: UUID().uuidString.lowercased(), user: user, kind: kind, title: title, model: "claude-opus-5-5",
                            status: status, createdAt: now, lastActiveAt: now)
            sessions.append(s)
            return s
        }
    }

    static func session() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [MockHubProtocol.self]
        return URLSession(configuration: cfg)
    }

    // MARK: Routing

    private static let enc: JSONEncoder = { let e = JSONEncoder(); e.outputFormatting = [.sortedKeys]; return e }()
    private func json<T: Encodable>(_ v: T, _ status: Int = 200) -> (Int, Data) { (status, (try? Self.enc.encode(v)) ?? Data()) }
    private func err(_ status: Int, _ msg: String, code: String? = nil) -> (Int, Data) {
        (status, Data((code.map { #"{"code":"\#($0)","error":"\#(msg)"}"# } ?? #"{"error":"\#(msg)"}"#).utf8))
    }

    func handle(_ req: URLRequest, body: Data) -> (Int, Data) {
        lock.lock()
        defer { lock.unlock() }
        let url = req.url!
        let method = req.httpMethod ?? "GET"
        let path = url.path
        let query = Dictionary(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.map { ($0.name, $0.value ?? "") } ?? [], uniquingKeysWith: { a, _ in a })
        let user = req.value(forHTTPHeaderField: "X-Workstation-User") ?? ""
        if !user.isEmpty { userHeaders.insert(user) }
        requests.append("\(method) \(path)")
        let parts = path.split(separator: "/").map(String.init)   // ["api", "sessions", id, ...]
        let dec = JSONDecoder()
        func route(_ m: String, _ pattern: String) -> [String]? {
            guard m == method else { return nil }
            let pp = pattern.split(separator: "/").map(String.init)
            guard pp.count == parts.count else { return nil }
            var caps: [String] = []
            for (a, b) in zip(pp, parts) {
                if a.hasPrefix(":") { caps.append(b) } else if a != b { return nil }
            }
            return caps
        }

        if parts.isEmpty { return err(404, "empty path")
        } else if path == "/healthz" || path == "/api/health" {
            return healthy ? (200, Data(#"{"ok":true}"#.utf8)) : (503, Data("down".utf8))
        } else if !healthy {
            return err(503, "hub down")
        } else if let c = route("GET", "api/app/:platform/latest") {
            return appReleases[c[0]].map { json($0) } ?? err(404, "no release")
        } else if let c = route("GET", "api/app/:platform/download") {
            return appReleases[c[0]] == nil ? err(404, "no release") : (200, appDmgs[c[0]] ?? Data())
        } else if let c = route("GET", "api/me") { _ = c;
            guard let u = users.first(where: { $0.name == user }) else { return err(404, "unknown user") }
            return json(Me(user: u, settings: AdminSettings(defaultModel: "opus", defaultEffort: .high), disk: disk.level))
        } else if let c = route("GET", "api/sessions") { _ = c;
            return json(sessions.filter { $0.user == user })
        } else if let c = route("GET", "api/sessions/:id") { _ = c; let id = c[0];
            guard let s = sessions.first(where: { $0.id == id && $0.user == user }) else { return err(404, "no session") }
            return json(s)
        } else if let c = route("GET", "api/projects") { _ = c; return json(projects.filter { $0.user == user })
        } else if let c = route("POST", "api/projects") { _ = c;
            guard let b = try? dec.decode(CreateProjectBody.self, from: body) else { return err(400, "bad body") }
            if projects.contains(where: { $0.name == b.name && $0.user == user }) { return err(409, "exists") }
            let p = Project(id: UUID().uuidString.lowercased(), user: user, name: b.name, createdAt: Formatters.iso(Date()), origin: b.origin)
            projects.append(p)
            local[p.id] = [:]
            worktree[p.id] = [:]
            return json(p, 201)
        } else if let c = route("DELETE", "api/projects/:id") { _ = c; let id = c[0];
            let force = (try? dec.decode(DeleteProjectBody.self, from: body))?.discardRemaining ?? (query["discardRemaining"] == "true")
            if !(review[id] ?? []).isEmpty && !force { return err(409, "project has pending changes", code: "project_not_empty") }
            projects.removeAll { $0.id == id }
            deletedProjects.append(id)
            return (204, Data())
        } else if let c = route("POST", "api/projects/:id/baseline") { _ = c; let id = c[0];
            let encoding = req.value(forHTTPHeaderField: "X-Baseline-Encoding") ?? "?"
            baselineEncodings.append(encoding)
            // Really unpack the archive and hash the members → `local`.
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("mockhub-\(UUID().uuidString.prefix(6))")
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: dir) }
            let archive = dir.appendingPathComponent("baseline.bin")
            try? body.write(to: archive)
            let out = dir.appendingPathComponent("x")
            try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
            var env = ["PATH": "/usr/bin:/bin"]
            if let z = BaselineArchiver.findZstd() { env["PATH"] = (z as NSString).deletingLastPathComponent + ":/usr/bin:/bin" }
            guard let r = try? ProcessRunner.run("/usr/bin/tar", ["-x", "-f", archive.path, "-C", out.path], environment: env), r.status == 0 else {
                return err(400, "bad archive")
            }
            // Every member (the server keeps what the Mac sends).
            let paths = SyncTreeScanner.scan(root: out).descendants().filter { $0.kind == .file }.map(\.path)
            worktree[id] = Dictionary(uniqueKeysWithValues: paths.map { ($0, (try? Data(contentsOf: out.appendingPathComponent($0))) ?? Data()) })
            local[id] = (worktree[id] ?? [:]).mapValues(FileHasher.sha256)
            for (_, d) in worktree[id] ?? [:] { blobs[FileHasher.sha256(d)] = d }
            _ = commit(id)
            return (200, Data("{}".utf8))
        } else if let c = route("PUT", "api/projects/:id/excludes") {
            excludes[c[0]] = (try? dec.decode(JSONValue.self, from: body))?["paths"] ?? .null
            return (204, Data())
        } else if let c = route("POST", "api/projects/:id/manifest") { _ = c; let id = c[0];
            guard let b = try? dec.decode(ManifestBody.self, from: body) else { return err(400, "bad body") }
            let l = local[id] ?? [:]
            let mine = Set(b.entries.map(\.path))
            return json(ManifestResponse(need: b.entries.filter { l[$0.path] != $0.hash }.map(\.path),
                                         delete: l.keys.filter { !mine.contains($0) }.sorted(), localCommit: latestCommit(id) ?? commit(id)))
        } else if let c = route("PUT", "api/projects/:id/files") { _ = c; let id = c[0];
            guard let b = try? dec.decode(SyncBody.self, from: body) else { return err(400, "bad body") }
            var results: [SyncResultItem] = []
            for op in b.ops {
                pushedOps.append(op)
                switch op {
                case let .write(path, hash, _, _, _, content, force):
                    if conflictPaths.contains(path) && force != true {
                        results.append(.init(path: path, status: .conflict, reason: "both sides changed"))
                    } else {
                        local[id, default: [:]][path] = hash
                        if let content, let d = Data(base64Encoded: content) { worktree[id, default: [:]][path] = d; blobs[hash] = d }
                        conflictPaths.remove(path)
                        results.append(.init(path: path, status: .applied))
                    }
                case let .delete(path, _, force):
                    if conflictPaths.contains(path) && force != true {
                        results.append(.init(path: path, status: .conflict, reason: "both sides changed"))
                    } else {
                        local[id]?.removeValue(forKey: path)
                        results.append(.init(path: path, status: .applied))
                    }
                }
            }
            let hasConflict = results.contains { $0.status == .conflict }
            return json(SyncResult(localCommit: commit(id), results: results), hasConflict ? 409 : 200)
        } else if let c = route("GET", "api/projects/:id/raw") { _ = c; let id = c[0];
            let p = query["path"] ?? ""
            switch query["ref"] {
            case nil:
                guard let d = worktree[id]?[p] else { return (404, Data()) }
                return (200, d)
            case "local":
                guard let h = local[id]?[p], let d = blobs[h] else { return (404, Data()) }
                return (200, d)
            case let ref?:
                if let b = backups[id]?.first(where: { $0.ref == ref }), let f = b.files.first(where: { $0.path == p }),
                   let d = blobs.values.first(where: { FileHasher.gitBlobOid($0) == f.blob }) { return (200, d) }
                guard let h = commits[id]?[ref]?[p], let d = blobs[h] else { return (404, Data()) }
                return (200, d)
            }
        } else if let c = route("POST", "api/projects/:id/backups") { _ = c; let id = c[0];
            guard backupsEnabled else { return err(404, "mock: no route for POST \(path)") }
            guard let b = try? dec.decode(ProjectBackupBody.self, from: body) else { return err(400, "bad body") }
            backupBodies.append(b)
            let bid = "bk\(backupBodies.count)"
            var files: [ProjectBackup.File] = []
            for f in b.files {
                let d = Data(base64Encoded: f.dataBase64) ?? Data()
                blobs[FileHasher.sha256(d)] = d
                files.append(.init(path: f.path, blob: FileHasher.gitBlobOid(d), size: Int64(d.count)))
            }
            let backup = ProjectBackup(id: bid, ref: "refs/backups/\(b.client)/\(bid)", commit: "bc\(bid)", client: b.client, reason: b.reason,
                                       at: Formatters.iso(Date()), files: files)
            backups[id, default: []].append(backup)
            return json(backup, 201)
        } else if let c = route("GET", "api/projects/:id/backups") { _ = c; let id = c[0];
            guard backupsEnabled else { return err(404, "mock: no route for GET \(path)") }
            return json(["backups": backups[id] ?? []])
        } else if let c = route("GET", "api/projects/:id/review") { _ = c; let id = c[0];
            guard let p = projects.first(where: { $0.id == id }) else { return err(404, "no project") }
            return json(ReviewResponse(project: p, files: review[id] ?? []))
        } else if let c = route("POST", "api/projects/:id/review/accept") { _ = c; let id = c[0];
            guard let v = try? dec.decode(JSONValue.self, from: body) else { return err(400, "bad body") }
            if v["hunks"] != nil && v["diffId"] == nil { return err(400, "diffId is required when hunks are given") }
            let paths: [String] = v["all"]?.boolValue == true ? (review[id] ?? []).map(\.path) : [v["path"]?.stringValue ?? ""]
            var files: [AcceptedFile] = []
            for p in paths {
                if let d = worktree[id]?[p] {
                    local[id, default: [:]][p] = FileHasher.sha256(d)
                    blobs[FileHasher.sha256(d)] = d
                    files.append(AcceptedFile(path: p, contentBase64: d.base64EncodedString(), deleted: false))
                } else {
                    local[id]?.removeValue(forKey: p)
                    files.append(AcceptedFile(path: p, contentBase64: nil, deleted: true))
                }
                review[id]?.removeAll { $0.path == p }
            }
            return json(AcceptResponse(localCommit: commit(id), files: files))
        } else if let c = route("GET", "api/disk") { _ = c; return json(disk)
        } else {
            return err(404, "mock: no route for \(method) \(path)")
        }
    }
}

final class MockHubProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == MockHub.host }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let s = request.httpBodyStream {
            s.open()
            var buf = [UInt8](repeating: 0, count: 65536)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; body.append(buf, count: n) }
            s.close()
        }
        let (status, data) = MockHub.shared.handle(request, body: body)
        let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
