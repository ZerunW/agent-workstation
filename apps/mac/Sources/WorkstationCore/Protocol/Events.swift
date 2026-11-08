import Foundation

/// The subset of `ServerEvent` the native shell consumes. The transcript web view keeps
/// its own connection for streaming (`delta`), so deltas are intentionally ignored here.
/// Unknown or malformed events decode to `.unknown(type:)` and are dropped by callers.
public enum ServerEvent: Equatable, Sendable {
    case welcome(user: User, protocolVersion: Int, serverTime: String)
    case replay(sessionId: String, messages: [StoredMessage])
    case snapshot(sessionId: String, session: Session?, pendingPermission: PermissionRequest?)
    case message(sessionId: String, message: StoredMessage)
    case sessionState(sessionId: String, status: SessionStatus, queuePosition: Int?)
    case sessionSettings(sessionId: String, settings: SessionSettingsValue)
    case sessionUpdated(Session)
    case sessionDeleted(sessionId: String)
    case permissionRequest(PermissionRequest)
    case permissionResolved(sessionId: String, requestId: String, behavior: String)
    case permissionCancelled(sessionId: String, requestId: String)
    case fileEvent(path: String, kind: String, sessionId: String?)
    case reviewChanged(projectId: String, localCommit: String?, pendingFiles: Int)
    case syncConflict(projectId: String, path: String, reason: String)
    case usageLimits(UsageLimits)
    case diskStatus(DiskStatus)
    /// The user's memories changed (Claude saved/removed one, or another device edited them): refetch.
    case memoriesChanged
    /// The hub refreshed a session's context-window usage (at turn end).
    case contextUsage(sessionId: String, usage: ContextUsage)
    case notice(level: String, code: String, message: String, at: String)
    case error(code: String, message: String, sessionId: String?)
    case pong
    case unknown(type: String)

    public var typeName: String {
        switch self {
        case .welcome: return "welcome"
        case .replay: return "replay"
        case .snapshot: return "snapshot"
        case .message: return "message"
        case .sessionState: return "session_state"
        case .sessionSettings: return "session_settings"
        case .sessionUpdated: return "session_updated"
        case .sessionDeleted: return "session_deleted"
        case .permissionRequest: return "permission_request"
        case .permissionResolved: return "permission_resolved"
        case .permissionCancelled: return "permission_cancelled"
        case .fileEvent: return "file_event"
        case .reviewChanged: return "review_changed"
        case .syncConflict: return "sync_conflict"
        case .usageLimits: return "usage_limits"
        case .diskStatus: return "disk_status"
        case .memoriesChanged: return "memories_changed"
        case .contextUsage: return "context_usage"
        case .notice: return "notice"
        case .error: return "error"
        case .pong: return "pong"
        case .unknown(let t): return t
        }
    }

    // MARK: Decoding

    private struct TypeProbe: Decodable { let type: String }
    private struct Welcome: Decodable { let user: User; let protocolVersion: Int; let serverTime: String }
    private struct Replay: Decodable { let sessionId: String; let messages: [StoredMessage] }
    private struct SnapshotBody: Decodable { let session: Session?; let pendingPermission: PermissionRequest? }
    private struct SnapshotEvt: Decodable { let sessionId: String; let snapshot: SnapshotBody }
    private struct MessageEvt: Decodable { let sessionId: String; let message: StoredMessage }
    private struct State: Decodable { let sessionId: String; let status: SessionStatus; let queuePosition: Int? }
    private struct Settings: Decodable { let sessionId: String; let settings: SessionSettingsValue }
    private struct Updated: Decodable { let session: Session }
    private struct SessionRef: Decodable { let sessionId: String }
    private struct PermReq: Decodable { let request: PermissionRequest }
    private struct PermResolved: Decodable { let sessionId: String; let requestId: String; let behavior: String }
    private struct PermCancelled: Decodable { let sessionId: String; let requestId: String }
    private struct FileEvt: Decodable { let path: String; let kind: String; let sessionId: String? }
    private struct Review: Decodable { let projectId: String; let localCommit: String?; let pendingFiles: Int? }
    private struct Conflict: Decodable { let projectId: String; let path: String; let reason: String? }
    private struct Limits: Decodable { let limits: UsageLimits }
    private struct Disk: Decodable { let status: DiskStatus }
    private struct ContextEvt: Decodable { let sessionId: String; let usage: ContextUsage }
    private struct Notice: Decodable { let level: String; let code: String; let message: String; let at: String? }
    private struct Err: Decodable { let code: String; let message: String; let sessionId: String? }

    /// Returns nil only when the frame is not a JSON object with a string `type`.
    public static func decode(_ data: Data) -> ServerEvent? {
        let d = JSONDecoder()
        guard let probe = try? d.decode(TypeProbe.self, from: data) else { return nil }
        func get<T: Decodable>(_ t: T.Type) -> T? { try? d.decode(T.self, from: data) }
        switch probe.type {
        case "welcome":
            if let e = get(Welcome.self) { return .welcome(user: e.user, protocolVersion: e.protocolVersion, serverTime: e.serverTime) }
        case "replay":
            if let e = get(Replay.self) { return .replay(sessionId: e.sessionId, messages: e.messages) }
        case "snapshot":
            if let e = get(SnapshotEvt.self) {
                return .snapshot(sessionId: e.sessionId, session: e.snapshot.session, pendingPermission: e.snapshot.pendingPermission)
            }
        case "message":
            if let e = get(MessageEvt.self) { return .message(sessionId: e.sessionId, message: e.message) }
        case "session_state":
            if let e = get(State.self) { return .sessionState(sessionId: e.sessionId, status: e.status, queuePosition: e.queuePosition) }
        case "session_settings":
            if let e = get(Settings.self) { return .sessionSettings(sessionId: e.sessionId, settings: e.settings) }
        case "session_updated":
            if let e = get(Updated.self) { return .sessionUpdated(e.session) }
        case "session_deleted":
            if let e = get(SessionRef.self) { return .sessionDeleted(sessionId: e.sessionId) }
        case "permission_request":
            if let e = get(PermReq.self) { return .permissionRequest(e.request) }
        case "permission_resolved":
            if let e = get(PermResolved.self) { return .permissionResolved(sessionId: e.sessionId, requestId: e.requestId, behavior: e.behavior) }
        case "permission_cancelled":
            if let e = get(PermCancelled.self) { return .permissionCancelled(sessionId: e.sessionId, requestId: e.requestId) }
        case "file_event":
            if let e = get(FileEvt.self) { return .fileEvent(path: e.path, kind: e.kind, sessionId: e.sessionId) }
        case "review_changed":
            if let e = get(Review.self) { return .reviewChanged(projectId: e.projectId, localCommit: e.localCommit, pendingFiles: e.pendingFiles ?? 0) }
        case "sync_conflict":
            if let e = get(Conflict.self) { return .syncConflict(projectId: e.projectId, path: e.path, reason: e.reason ?? "conflict") }
        case "usage_limits":
            if let e = get(Limits.self) { return .usageLimits(e.limits) }
        case "disk_status":
            if let e = get(Disk.self) { return .diskStatus(e.status) }
        case "memories_changed":
            return .memoriesChanged
        case "context_usage":
            if let e = get(ContextEvt.self) { return .contextUsage(sessionId: e.sessionId, usage: e.usage) }
        case "notice":
            if let e = get(Notice.self) { return .notice(level: e.level, code: e.code, message: e.message, at: e.at ?? "") }
        case "error":
            if let e = get(Err.self) { return .error(code: e.code, message: e.message, sessionId: e.sessionId) }
        case "pong":
            return .pong
        default:
            break
        }
        return .unknown(type: probe.type)
    }

    public static func decode(_ text: String) -> ServerEvent? { decode(Data(text.utf8)) }
}

/// Client → hub frames.
public enum ClientEvent: Equatable, Sendable {
    case hello(user: String, protocolVersion: Int)
    case subscribe(sessionId: String, lastSeq: Int)
    case unsubscribe(sessionId: String)
    case permissionResponse(sessionId: String, response: PermissionResponse)
    case ping

    private struct Frame: Encodable {
        let type: String
        var user: String? = nil
        var protocolVersion: Int? = nil
        var sessionId: String? = nil
        var lastSeq: Int? = nil
        var response: PermissionResponse? = nil
    }

    public func encoded() -> Data {
        let frame: Frame
        switch self {
        case .hello(let user, let v): frame = Frame(type: "hello", user: user, protocolVersion: v)
        case .subscribe(let id, let seq): frame = Frame(type: "subscribe", sessionId: id, lastSeq: max(0, seq))
        case .unsubscribe(let id): frame = Frame(type: "unsubscribe", sessionId: id)
        case .permissionResponse(let id, let r): frame = Frame(type: "permission_response", sessionId: id, response: r)
        case .ping: frame = Frame(type: "ping")
        }
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        return (try? enc.encode(frame)) ?? Data("{}".utf8)
    }

    public var text: String { String(decoding: encoded(), as: UTF8.self) }
}
