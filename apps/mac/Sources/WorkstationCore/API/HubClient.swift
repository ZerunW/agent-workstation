import Foundation

public enum HubError: Error, LocalizedError, Equatable {
    case invalidURL(String)
    case http(status: Int, message: String, code: String?)
    case decoding(String)
    case transport(String)
    case blocked(String)

    public var errorDescription: String? {
        switch self {
        case .invalidURL(let s): return "Invalid hub URL: \(s)"
        case .http(let status, let message, _): return "Hub returned \(status): \(message)"
        case .decoding(let s): return "Unexpected response from the hub (\(s))"
        case .transport(let s): return s
        case .blocked(let s): return s
        }
    }

    public var status: Int? { if case .http(let s, _, _) = self { return s }; return nil }
    /// `ErrorBody.code` of an HTTP error (`api_unavailable`, `api_limit_reached`, …).
    public var code: String? { if case .http(_, _, let c) = self { return c }; return nil }
    /// The hub's own message for an HTTP error, without the status prefix.
    public var hubMessage: String? { if case .http(_, let m, _) = self { return m }; return nil }
}

/// Async REST client for workstation-hub. Every request carries `X-Workstation-User`.
/// List endpoints accept either a bare JSON array or an envelope object (`{sessions: [...]}`),
/// mirroring the web client's `asList` helper.
public final class HubClient: @unchecked Sendable {
    public let baseURL: URL
    public let user: String?
    public let session: URLSession

    public init(baseURL: URL, user: String?, session: URLSession? = nil) {
        self.baseURL = baseURL
        self.user = user
        if let session {
            self.session = session
        } else {
            let cfg = URLSessionConfiguration.default
            cfg.timeoutIntervalForRequest = 30
            cfg.waitsForConnectivity = false
            cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: cfg)
        }
    }

    public func withUser(_ user: String?) -> HubClient { HubClient(baseURL: baseURL, user: user, session: session) }

    // MARK: Plumbing

    public func makeRequest(_ ep: Endpoint, body: Data? = nil, contentType: String? = "application/json",
                            headers: [String: String] = [:], timeout: TimeInterval? = nil) -> URLRequest {
        var r = URLRequest(url: ep.url(base: baseURL))
        r.httpMethod = ep.method.rawValue
        if let user { r.setValue(user, forHTTPHeaderField: WorkstationProtocol.userHeader) }
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            r.httpBody = body
            if let contentType { r.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        }
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        if let timeout { r.timeoutInterval = timeout }
        return r
    }

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }()

    func encode<B: Encodable>(_ body: B) throws -> Data {
        do { return try Self.encoder.encode(body) } catch { throw HubError.decoding("encode: \(error)") }
    }

    /// Performs a request; non-2xx statuses become `HubError.http` unless listed in `accept`.
    @discardableResult
    public func perform(_ request: URLRequest, accept: Set<Int> = []) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let e as URLError {
            throw HubError.transport(Self.describe(e))
        } catch {
            throw HubError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw HubError.transport("no HTTP response") }
        if (200..<300).contains(http.statusCode) || accept.contains(http.statusCode) { return (data, http) }
        let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
        let text = body?.error ?? String(data: data.prefix(300), encoding: .utf8) ?? ""
        throw HubError.http(status: http.statusCode, message: text.isEmpty ? HTTPURLResponse.localizedString(forStatusCode: http.statusCode) : text, code: body?.code)
    }

    static func describe(_ e: URLError) -> String {
        switch e.code {
        case .cannotConnectToHost, .cannotFindHost: return "Can't reach the hub (\(e.failingURL?.host ?? "host")): is it running and on this network?"
        case .timedOut: return "The hub did not answer in time."
        case .notConnectedToInternet, .networkConnectionLost: return "The network connection was lost."
        default: return e.localizedDescription
        }
    }

    public func get<T: Decodable>(_ ep: Endpoint, as: T.Type = T.self, key: String? = nil) async throws -> T {
        let (data, _) = try await perform(makeRequest(ep))
        return try Self.decodeFlexible(T.self, from: data, key: key)
    }

    public func send<T: Decodable, B: Encodable>(_ ep: Endpoint, body: B, as: T.Type = T.self, key: String? = nil,
                                                 accept: Set<Int> = []) async throws -> T {
        let (data, _) = try await perform(makeRequest(ep, body: try encode(body)), accept: accept)
        return try Self.decodeFlexible(T.self, from: data, key: key)
    }

    public func sendVoid<B: Encodable>(_ ep: Endpoint, body: B) async throws {
        try await perform(makeRequest(ep, body: try encode(body)))
    }

    public func sendVoid(_ ep: Endpoint) async throws {
        try await perform(makeRequest(ep))
    }

    public func list<T: Decodable>(_ ep: Endpoint, key: String) async throws -> [T] {
        let (data, _) = try await perform(makeRequest(ep))
        return try Self.decodeList(T.self, from: data, key: key)
    }

    /// Decodes `T` directly, or from `{key: T}` / the only object property that decodes as `T`.
    public static func decodeFlexible<T: Decodable>(_ type: T.Type, from data: Data, key: String?) throws -> T {
        let d = JSONDecoder()
        if let v = try? d.decode(T.self, from: data) { return v }
        if let obj = try? d.decode([String: JSONValue].self, from: data) {
            if let key, let inner = obj[key], let v = try? d.decode(T.self, from: JSONEncoder().encode(inner)) { return v }
            for (_, inner) in obj {
                if case .object = inner, let v = try? d.decode(T.self, from: JSONEncoder().encode(inner)) { return v }
            }
        }
        do { return try d.decode(T.self, from: data) } catch { throw HubError.decoding("\(T.self): \(error)") }
    }

    public static func decodeList<T: Decodable>(_ type: T.Type, from data: Data, key: String) throws -> [T] {
        let d = JSONDecoder()
        if let v = try? d.decode([T].self, from: data) { return v }
        if let obj = try? d.decode([String: JSONValue].self, from: data) {
            let preferred = [key, "items", "data", "results"]
            for k in preferred { if let inner = obj[k], let v = try? d.decode([T].self, from: JSONEncoder().encode(inner)) { return v } }
            for (_, inner) in obj.sorted(by: { $0.key < $1.key }) {
                if case .array = inner, let v = try? d.decode([T].self, from: JSONEncoder().encode(inner)) { return v }
            }
        }
        do { return try d.decode([T].self, from: data) } catch { throw HubError.decoding("[\(T.self)]: \(error)") }
    }

    // MARK: Identity & meta

    /// `GET /api/health`, falling back to `/healthz`.
    public func health() async -> Bool {
        for ep in [Routes.health(), Endpoint(.GET, "/healthz")] {
            var r = makeRequest(ep)
            r.timeoutInterval = 5
            if (try? await perform(r)) != nil { return true }
        }
        return false
    }

    /// The newest app build on the server for `platform`; nil when it has none (404).
    public func latestAppRelease(platform: String = AppPlatform.appleSilicon) async throws -> AppRelease? {
        let (data, http) = try await perform(makeRequest(Routes.appLatest(platform)), accept: [404])
        if http.statusCode == 404 { return nil }
        do { return try JSONDecoder().decode(AppRelease.self, from: data) } catch { throw HubError.decoding("AppRelease") }
    }

    /// Streams `GET /api/app/<platform>/download` into `file`; stops with `tooLarge` past `maxBytes`.
    /// `progress` gets the bytes written so far. Returns the byte count.
    @discardableResult
    public func downloadApp(platform: String = AppPlatform.appleSilicon, to file: URL, maxBytes: Int64,
                            progress: @escaping @Sendable (Int64) -> Void = { _ in }) async throws -> Int64 {
        var req = makeRequest(Routes.appDownload(platform))
        req.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 120
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do { (bytes, response) = try await session.bytes(for: req) } catch let e as URLError { throw HubError.transport(Self.describe(e)) }
        guard let http = response as? HTTPURLResponse else { throw HubError.transport("no HTTP response") }
        guard (200..<300).contains(http.statusCode) else {
            throw HubError.http(status: http.statusCode, message: HTTPURLResponse.localizedString(forStatusCode: http.statusCode), code: nil)
        }
        guard FileManager.default.createFile(atPath: file.path, contents: nil) else { throw HubError.transport("can't write \(file.lastPathComponent)") }
        let out = try FileHandle(forWritingTo: file)
        defer { try? out.close() }
        var buffer = Data(capacity: 1 << 16)
        var total: Int64 = 0
        do {
            for try await byte in bytes {
                buffer.append(byte)
                if buffer.count >= 1 << 16 {
                    total += Int64(buffer.count)
                    if total > maxBytes { throw UpdateDownloadError.tooLarge }
                    try out.write(contentsOf: buffer)
                    buffer.removeAll(keepingCapacity: true)
                    progress(total)
                }
            }
        } catch let e as URLError { throw HubError.transport(Self.describe(e)) }
        if !buffer.isEmpty {
            total += Int64(buffer.count)
            if total > maxBytes { throw UpdateDownloadError.tooLarge }
            try out.write(contentsOf: buffer)
        }
        progress(total)
        return total
    }

    public func me() async throws -> Me { try await get(Routes.me()) }
    /// The caller's own defaults for new sessions; returns the updated user.
    public func patchPreferences(_ body: UserPreferencesBody) async throws -> User {
        try await send(Routes.mePreferences(), body: body, key: "user")
    }
    public func users() async throws -> [User] { try await list(Routes.users(), key: "users") }

    // MARK: Memory

    /// The user's memories, newest first.
    public func memories() async throws -> [Memory] { try await list(Routes.memories(), key: "memories") }
    /// 201 with the new memory (or the existing one when the same text is already saved).
    public func createMemory(_ text: String) async throws -> Memory {
        try await send(Routes.createMemory(), body: MemoryBody(text: text), key: "memory")
    }
    public func updateMemory(_ id: String, text: String) async throws -> Memory {
        try await send(Routes.updateMemory(id), body: MemoryBody(text: text), key: "memory")
    }
    /// 204. Only ever called for a memory the person chose to delete.
    public func deleteMemory(_ id: String) async throws { try await sendVoid(Routes.deleteMemory(id)) }

    public func createUser(_ name: String) async throws -> User {
        try await send(Routes.createUser(), body: CreateUserBody(name: name), key: "user")
    }
    public func models() async throws -> [ModelInfo] { try await list(Routes.models(), key: "models") }

    // MARK: Sessions

    public func sessions(kind: SessionKind?) async throws -> [Session] { try await list(Routes.sessions(kind: kind), key: "sessions") }
    public func createSession(_ body: CreateSessionBody) async throws -> Session { try await send(Routes.createSession(), body: body, key: "session") }
    public func session(_ id: String) async throws -> Session { try await get(Routes.session(id), key: "session") }

    @discardableResult
    public func renameSession(_ id: String, title: String) async throws -> Session? {
        let (data, _) = try await perform(makeRequest(Routes.renameSession(id), body: try encode(PatchSessionBody(title: title))))
        return try? Self.decodeFlexible(Session.self, from: data, key: "session")
    }

    public func deleteSession(_ id: String) async throws { try await sendVoid(Routes.deleteSession(id)) }

    public func messages(_ id: String, after: Int = 0, limit: Int = 500) async throws -> [StoredMessage] {
        try await list(Routes.sessionMessages(id, after: after, limit: limit), key: "messages")
    }

    public func sendMessage(_ id: String, text: String, attachments: [Attachment] = [], uuid: String = UUID().uuidString.lowercased()) async throws -> SendMessageResponse {
        try await send(Routes.sendMessage(id), body: SendMessageBody(uuid: uuid, text: text, attachments: attachments.isEmpty ? nil : attachments), accept: [202])
    }

    public func patchSettings(_ id: String, _ patch: SessionSettingsPatch) async throws {
        try await sendVoid(Routes.sessionSettings(id), body: patch)
    }

    public func stop(_ id: String) async throws { try await sendVoid(Routes.sessionStop(id)) }

    // MARK: Files

    public func tree(path: String = "", depth: Int = 1) async throws -> [FileEntry] {
        try await list(Routes.filesTree(path: path, depth: depth), key: "entries")
    }

    public func fileContent(path: String) async throws -> FileContentResponse { try await get(Routes.filesContent(path: path)) }

    /// Downloads to a temporary file and returns its URL (named after the last path component, or `.zip` for several).
    public func download(paths: [String], into directory: URL? = nil) async throws -> URL {
        let req = makeRequest(Routes.filesDownload(paths: paths), timeout: 600)
        let (tmp, response): (URL, URLResponse)
        do { (tmp, response) = try await session.download(for: req) } catch { throw HubError.transport(error.localizedDescription) }
        guard let http = response as? HTTPURLResponse else { throw HubError.transport("no HTTP response") }
        guard (200..<300).contains(http.statusCode) else {
            throw HubError.http(status: http.statusCode, message: HTTPURLResponse.localizedString(forStatusCode: http.statusCode), code: nil)
        }
        let name = paths.count == 1 ? (paths[0] as NSString).lastPathComponent : "workstation-files.zip"
        let dir = directory ?? FileManager.default.temporaryDirectory.appendingPathComponent("Agent Workstation-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = Self.uniqueURL(in: dir, name: name)
        try FileManager.default.moveItem(at: tmp, to: dest)
        return dest
    }

    static func uniqueURL(in dir: URL, name: String) -> URL {
        var candidate = dir.appendingPathComponent(name)
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var i = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(i)" : "\(base) \(i).\(ext)")
            i += 1
        }
        return candidate
    }

    // MARK: Projects / sync / review

    public func projects() async throws -> [Project] { try await list(Routes.projects(), key: "projects") }
    public func createProject(name: String, origin: String?) async throws -> Project {
        try await send(Routes.createProject(), body: CreateProjectBody(name: name, origin: origin), key: "project")
    }
    public func project(_ id: String) async throws -> Project { try await get(Routes.project(id), key: "project") }
    /// Sends `discardRemaining` both as body and query (`DeleteProjectQuery`). 409
    /// `project_not_empty` means something would be lost: ask again before discarding.
    public func deleteProject(_ id: String, discardRemaining: Bool) async throws {
        var ep = Routes.deleteProject(id)
        if discardRemaining { ep.query = [("discardRemaining", "true")] }
        try await sendVoid(ep, body: DeleteProjectBody(discardRemaining: discardRemaining))
    }

    public func uploadBaseline(projectId: String, archive: URL, encoding: BaselineEncoding) async throws {
        var req = makeRequest(Routes.projectBaseline(projectId), timeout: 1800)
        req.setValue(encoding.contentType, forHTTPHeaderField: "Content-Type")
        req.setValue(encoding.rawValue, forHTTPHeaderField: WorkstationProtocol.baselineEncodingHeader)
        let size = (try? FileManager.default.attributesOfItem(atPath: archive.path)[.size] as? NSNumber)?.int64Value ?? 0
        req.setValue(String(size), forHTTPHeaderField: "Content-Length")
        req.httpBodyStream = InputStream(url: archive)
        try await perform(req)
    }

    public func manifest(projectId: String, entries: [ManifestEntry]) async throws -> ManifestResponse {
        try await send(Routes.projectManifest(projectId), body: ManifestBody(entries: entries), timeout: 300)
    }

    /// `PUT /files`. A 409 whose body is a `SyncResult` is treated as a normal result
    /// (the hub may answer conflicts that way); other statuses throw.
    public func pushFiles(projectId: String, ops: [SyncOp]) async throws -> SyncResult {
        let req = makeRequest(Routes.projectFiles(projectId), body: try encode(SyncBody(ops: ops)), timeout: 300)
        let (data, http) = try await perform(req, accept: [409])
        if let r = try? JSONDecoder().decode(SyncResult.self, from: data) { return r }
        if http.statusCode == 409 {
            // Bare conflict without a body: mark every op as conflicting.
            return SyncResult(localCommit: nil, results: ops.map { SyncResultItem(path: $0.path, status: .conflict, reason: "conflict") })
        }
        throw HubError.decoding("SyncResult")
    }

    public func rawFile(projectId: String, path: String, ref: String? = nil) async throws -> Data? {
        let (data, http) = try await perform(makeRequest(Routes.projectFileRaw(projectId, path: path, ref: ref), timeout: 300), accept: [404])
        return http.statusCode == 404 ? nil : data
    }

    public func createBackup(projectId: String, _ body: ProjectBackupBody) async throws -> ProjectBackup {
        try await send(Routes.createProjectBackup(projectId), body: body, timeout: 600)
    }

    public func backups(projectId: String) async throws -> [ProjectBackup] {
        try await list(Routes.projectBackups(projectId), key: "backups")
    }

    public func review(projectId: String) async throws -> ReviewResponse { try await get(Routes.projectReview(projectId)) }
    public func reviewDiff(projectId: String, path: String) async throws -> FileDiff { try await get(Routes.projectReviewDiff(projectId, path: path)) }
    public func accept(projectId: String, _ body: AcceptBody) async throws -> AcceptResponse {
        try await send(Routes.projectAccept(projectId), body: body)
    }
    public func reject(projectId: String, _ body: RejectBody) async throws {
        try await sendVoid(Routes.projectReject(projectId), body: body)
    }
    public func history(projectId: String) async throws -> [Snapshot] { try await list(Routes.projectHistory(projectId), key: "snapshots") }
    public func restore(projectId: String, ref: String, path: String? = nil) async throws {
        try await sendVoid(Routes.projectRestore(projectId), body: RestoreBody(ref: ref, path: path))
    }

    // MARK: Usage / disk / admin / terminals

    public func usageLimits() async throws -> UsageLimits { try await get(Routes.usageLimits(), key: "limits") }
    public func usageMe(range: UsageRange = .sevenDays) async throws -> MyUsageResponse { try await get(Routes.usageMe(range: range)) }
    public func disk() async throws -> DiskStatus { try await get(Routes.disk(), key: "status") }
    public func adminSettings() async throws -> AdminSettings { try await get(Routes.adminSettings(), key: "settings") }
    public func patchAdminSettings(_ s: AdminSettings) async throws { try await sendVoid(Routes.patchAdminSettings(), body: s) }
    public func createTerminal(cwd: String?) async throws -> TerminalInfo {
        try await send(Routes.createTerminal(), body: CreateTerminalBody(cwd: cwd), key: "terminal")
    }

    // MARK: helpers

    func send<T: Decodable, B: Encodable>(_ ep: Endpoint, body: B, timeout: TimeInterval) async throws -> T {
        let (data, _) = try await perform(makeRequest(ep, body: try encode(body), timeout: timeout))
        return try Self.decodeFlexible(T.self, from: data, key: nil)
    }
}
