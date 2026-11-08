import Foundation

public enum HTTPMethod: String, Sendable { case GET, POST, PUT, PATCH, DELETE }

/// One concrete REST call: method + path + query. Paths mirror `ROUTES` in the protocol.
public struct Endpoint: Equatable, Sendable, CustomStringConvertible {
    public var method: HTTPMethod
    public var path: String
    public var query: [(String, String)]

    public init(_ method: HTTPMethod, _ path: String, query: [(String, String)] = []) {
        self.method = method; self.path = path; self.query = query
    }

    public static func == (a: Endpoint, b: Endpoint) -> Bool {
        a.method == b.method && a.path == b.path && a.query.map { "\($0.0)=\($0.1)" } == b.query.map { "\($0.0)=\($0.1)" }
    }

    public var description: String { "\(method.rawValue) \(path)\(queryString.isEmpty ? "" : "?" + queryString)" }

    /// Query values are strictly percent-encoded (`+` → `%2B`, space → `%20`), because
    /// Node's querystring parser treats a literal `+` as a space.
    public var queryString: String {
        query.map { "\(Self.encode($0.0))=\(Self.encode($0.1))" }.joined(separator: "&")
    }

    static let queryAllowed: CharacterSet = {
        var s = CharacterSet.alphanumerics
        s.insert(charactersIn: "-._~/")
        return s
    }()

    static func encode(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: queryAllowed) ?? s
    }

    public func url(base: URL) -> URL {
        var root = base.absoluteString
        while root.hasSuffix("/") { root.removeLast() }
        let q = queryString
        return URL(string: root + path + (q.isEmpty ? "" : "?" + q))!
    }
}

/// Path-segment encoding for ids/usernames that end up inside a path.
func seg(_ s: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
}

/// Builders for every route the native shell uses (names follow `ROUTES` keys).
public enum Routes {
    public static func health() -> Endpoint { Endpoint(.GET, "/api/health") }
    /// `appLatest` / `appDownload`: the newest app build the server offers for a channel
    /// (`mac` / `mac-intel`; no user header needed).
    public static func appLatest(_ platform: String = "mac") -> Endpoint { Endpoint(.GET, "/api/app/\(seg(platform))/latest") }
    public static func appDownload(_ platform: String = "mac") -> Endpoint { Endpoint(.GET, "/api/app/\(seg(platform))/download") }
    public static func me() -> Endpoint { Endpoint(.GET, "/api/me") }
    public static func mePreferences() -> Endpoint { Endpoint(.PATCH, "/api/me/preferences") }
    /// `memories`: GET (list, newest first) / POST (add).
    public static func memories() -> Endpoint { Endpoint(.GET, "/api/me/memories") }
    public static func createMemory() -> Endpoint { Endpoint(.POST, "/api/me/memories") }
    /// `memory`: PATCH (edit text) / DELETE (204).
    public static func updateMemory(_ id: String) -> Endpoint { Endpoint(.PATCH, "/api/me/memories/\(seg(id))") }
    public static func deleteMemory(_ id: String) -> Endpoint { Endpoint(.DELETE, "/api/me/memories/\(seg(id))") }
    public static func models() -> Endpoint { Endpoint(.GET, "/api/models") }
    public static func users() -> Endpoint { Endpoint(.GET, "/api/users") }
    public static func createUser() -> Endpoint { Endpoint(.POST, "/api/users") }

    public static func sessions(kind: SessionKind?) -> Endpoint {
        Endpoint(.GET, "/api/sessions", query: kind.map { [("kind", $0.rawValue)] } ?? [])
    }
    public static func createSession() -> Endpoint { Endpoint(.POST, "/api/sessions") }
    public static func session(_ id: String) -> Endpoint { Endpoint(.GET, "/api/sessions/\(seg(id))") }
    public static func renameSession(_ id: String) -> Endpoint { Endpoint(.PATCH, "/api/sessions/\(seg(id))") }
    public static func deleteSession(_ id: String) -> Endpoint { Endpoint(.DELETE, "/api/sessions/\(seg(id))") }
    public static func sessionMessages(_ id: String, after: Int = 0, limit: Int = 500) -> Endpoint {
        Endpoint(.GET, "/api/sessions/\(seg(id))/messages", query: [("after", String(after)), ("limit", String(limit))])
    }
    public static func sendMessage(_ id: String) -> Endpoint { Endpoint(.POST, "/api/sessions/\(seg(id))/messages") }
    public static func sessionSettings(_ id: String) -> Endpoint { Endpoint(.PATCH, "/api/sessions/\(seg(id))/settings") }
    public static func sessionStop(_ id: String) -> Endpoint { Endpoint(.POST, "/api/sessions/\(seg(id))/stop") }
    public static func sessionClose(_ id: String) -> Endpoint { Endpoint(.POST, "/api/sessions/\(seg(id))/close") }

    public static func filesTree(path: String = "", depth: Int = 1) -> Endpoint {
        Endpoint(.GET, "/api/files/tree", query: [("path", path), ("depth", String(depth))])
    }
    public static func filesContent(path: String) -> Endpoint { Endpoint(.GET, "/api/files/content", query: [("path", path)]) }
    public static func filesDownload(paths: [String]) -> Endpoint {
        Endpoint(.GET, "/api/files/download", query: paths.map { ("path", $0) })
    }
    public static func filesUpload() -> Endpoint { Endpoint(.PUT, "/api/files/upload") }

    public static func projects() -> Endpoint { Endpoint(.GET, "/api/projects") }
    public static func createProject() -> Endpoint { Endpoint(.POST, "/api/projects") }
    public static func project(_ id: String) -> Endpoint { Endpoint(.GET, "/api/projects/\(seg(id))") }
    public static func deleteProject(_ id: String) -> Endpoint { Endpoint(.DELETE, "/api/projects/\(seg(id))") }
    public static func projectBaseline(_ id: String) -> Endpoint { Endpoint(.POST, "/api/projects/\(seg(id))/baseline") }
    public static func projectManifest(_ id: String) -> Endpoint { Endpoint(.POST, "/api/projects/\(seg(id))/manifest") }
    public static func projectFiles(_ id: String) -> Endpoint { Endpoint(.PUT, "/api/projects/\(seg(id))/files") }
    /// `projectLargeFile`: PUT one chunk / GET progress of a file > MAX_SYNC_FILE_BYTES.
    public static func projectLargeFile(_ id: String, method: HTTPMethod, query: [(String, String)]) -> Endpoint {
        Endpoint(method, "/api/projects/\(seg(id))/large", query: query)
    }
    /// `projectExcludes`: the paths unchecked on the Mac (the server excludes only these and `.git`).
    public static func projectExcludes(_ id: String) -> Endpoint { Endpoint(.PUT, "/api/projects/\(seg(id))/excludes") }
    public static func projectReview(_ id: String) -> Endpoint { Endpoint(.GET, "/api/projects/\(seg(id))/review") }
    public static func projectReviewDiff(_ id: String, path: String) -> Endpoint {
        Endpoint(.GET, "/api/projects/\(seg(id))/review/diff", query: [("path", path)])
    }
    public static func projectAccept(_ id: String) -> Endpoint { Endpoint(.POST, "/api/projects/\(seg(id))/review/accept") }
    public static func projectReject(_ id: String) -> Endpoint { Endpoint(.POST, "/api/projects/\(seg(id))/review/reject") }
    public static func projectHistory(_ id: String) -> Endpoint { Endpoint(.GET, "/api/projects/\(seg(id))/history") }
    public static func projectRestore(_ id: String) -> Endpoint { Endpoint(.POST, "/api/projects/\(seg(id))/restore") }
    public static func projectFileRaw(_ id: String, path: String, ref: String? = nil) -> Endpoint {
        Endpoint(.GET, "/api/projects/\(seg(id))/raw", query: [("path", path)] + (ref.map { [("ref", $0)] } ?? []))
    }
    /// `projectBackups`: GET (list) / POST (create).
    public static func projectBackups(_ id: String) -> Endpoint { Endpoint(.GET, "/api/projects/\(seg(id))/backups") }
    public static func createProjectBackup(_ id: String) -> Endpoint { Endpoint(.POST, "/api/projects/\(seg(id))/backups") }

    public static func usageLimits() -> Endpoint { Endpoint(.GET, "/api/usage/limits") }
    public static func usageMe(range: UsageRange) -> Endpoint { Endpoint(.GET, "/api/usage/me", query: [("range", range.rawValue)]) }
    public static func disk() -> Endpoint { Endpoint(.GET, "/api/disk") }
    public static func adminSettings() -> Endpoint { Endpoint(.GET, "/api/admin/settings") }
    public static func patchAdminSettings() -> Endpoint { Endpoint(.PATCH, "/api/admin/settings") }
    public static func terminals() -> Endpoint { Endpoint(.GET, "/api/terminals") }
    public static func createTerminal() -> Endpoint { Endpoint(.POST, "/api/terminals") }

    /// `WS /ws`: http→ws, https→wss. `?user=` (USER_QUERY_PARAM) is added as a fallback;
    /// the app also sends the `X-Workstation-User` header, which wins.
    public static func webSocketURL(base: URL, user: String? = nil) -> URL {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        c.scheme = (c.scheme == "https") ? "wss" : "ws"
        var p = c.path
        while p.hasSuffix("/") { p.removeLast() }
        c.path = p + "/ws"
        c.query = nil
        if let user { c.queryItems = [URLQueryItem(name: WorkstationProtocol.userQueryParam, value: user)] }
        return c.url!
    }
}
