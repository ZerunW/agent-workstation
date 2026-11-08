import Foundation

// Swift mirrors of packages/protocol/src/index.ts. JSON key names are identical to
// the protocol (camelCase), so synthesized Codable is used wherever possible.
// Enums decode tolerantly: an unknown raw value maps to a fallback instead of
// failing the whole payload (the hub may grow new values before the app does).

// MARK: - Constants

public enum WorkstationProtocol {
    public static let userHeader = "X-Workstation-User"
    public static let uploadChunkBytes = 4 * 1024 * 1024
    public static let maxSyncFileBytes: Int64 = 100 * 1024 * 1024
    public static let protocolVersion = 1
    /// `BASELINE_ENCODING_HEADER`: `tar.zst` (default) or `tar`.
    public static let baselineEncodingHeader = "X-Baseline-Encoding"
    /// `USER_QUERY_PARAM`: fallback identity for requests that cannot carry headers.
    public static let userQueryParam = "user"
}

/// `UPLOAD_HEADERS` from the protocol.
public enum UploadHeaders {
    public static let uploadId = "X-Upload-Id"
    public static let path = "X-Upload-Path"
    public static let chunkIndex = "X-Chunk-Index"
    public static let chunkTotal = "X-Chunk-Total"
    public static let totalBytes = "X-Total-Bytes"
}

/// `ERROR_CODES` the app reacts to specifically (the list in the protocol is non-exhaustive).
public enum HubErrorCode {
    /// No API key is configured on the server, or the monthly budget is 0 (503).
    public static let apiUnavailable = "api_unavailable"
    /// This month's API budget is used up down to the service reserve (429).
    public static let apiLimitReached = "api_limit_reached"
}

// MARK: - Tolerant enums

public protocol TolerantStringEnum: RawRepresentable, Codable, CaseIterable, Hashable, Sendable where RawValue == String {
    static var fallback: Self { get }
}

extension TolerantStringEnum {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? Self.fallback
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

public enum SessionKind: String, TolerantStringEnum {
    case chat, code
    public static let fallback: SessionKind = .chat
}

public enum PermissionMode: String, TolerantStringEnum {
    case `default`, acceptEdits, plan, auto, dontAsk, bypassPermissions
    public static let fallback: PermissionMode = .default

    public var label: String {
        switch self {
        case .default: return "Ask before edits"
        case .acceptEdits: return "Accept edits"
        case .plan: return "Plan mode"
        case .auto: return "Auto"
        case .dontAsk: return "Don't ask"
        case .bypassPermissions: return "Bypass permissions"
        }
    }

    /// Modes offered in the toolbar picker (dontAsk is chat-internal).
    public static let pickable: [PermissionMode] = [.default, .acceptEdits, .plan, .auto, .bypassPermissions]
}

public enum EffortLevel: String, TolerantStringEnum {
    case low, medium, high, xhigh, max
    public static let fallback: EffortLevel = .high

    public var label: String {
        switch self {
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        case .xhigh: return "Extra high"
        case .max: return "Max"
        }
    }
}

public enum SessionStatus: String, TolerantStringEnum {
    case idle, queued, running
    case requiresAction = "requires_action"
    case dead
    public static let fallback: SessionStatus = .idle

    /// A turn is in flight (Stop is meaningful).
    public var isBusy: Bool { self == .running || self == .queued || self == .requiresAction }
}

public enum LimitSeverity: String, TolerantStringEnum {
    case normal, warning, critical, unknown
    public static let fallback: LimitSeverity = .unknown
    public var needsAttention: Bool { self == .warning || self == .critical }
}

public enum DiskLevel: String, TolerantStringEnum {
    case ok, warn, block
    public static let fallback: DiskLevel = .ok
}

public enum UsageRange: String, TolerantStringEnum {
    case today
    case sevenDays = "7d"
    case thirtyDays = "30d"
    public static let fallback: UsageRange = .sevenDays
}

// MARK: - Entities

public struct User: Codable, Hashable, Identifiable, Sendable {
    public var name: String
    public var createdAt: String
    public var isAdmin: Bool
    public var enabled: Bool
    public var terminalEnabled: Bool
    public var weeklyTokenLimit: Int?
    public var modelAllowlist: [String]?
    /// The user's own default for new sessions; nil = follow the server default (`AdminSettings.defaultModel`).
    public var defaultModel: String?
    /// The user's own default effort; nil = follow `AdminSettings.defaultEffort`.
    public var defaultEffort: EffortLevel?
    /// Whether Claude keeps and uses memories for this user; nil (older hubs) = on.
    public var memoryEnabled: Bool?
    public var id: String { name }

    public init(name: String, createdAt: String = "", isAdmin: Bool = false, enabled: Bool = true,
                terminalEnabled: Bool = true, weeklyTokenLimit: Int? = nil, modelAllowlist: [String]? = nil,
                defaultModel: String? = nil, defaultEffort: EffortLevel? = nil, memoryEnabled: Bool? = nil) {
        self.name = name; self.createdAt = createdAt; self.isAdmin = isAdmin; self.enabled = enabled
        self.terminalEnabled = terminalEnabled; self.weeklyTokenLimit = weeklyTokenLimit; self.modelAllowlist = modelAllowlist
        self.defaultModel = defaultModel; self.defaultEffort = defaultEffort; self.memoryEnabled = memoryEnabled
    }
}

/// `PATCH /api/me/preferences` (omitted key = leave it).
/// - `init(defaultModel:defaultEffort:memoryEnabled:)` always sends both defaults: nil encodes as `null`, which means
///   "follow the server default" (the Settings pickers). `memoryEnabled` is sent only when set.
/// - `init(memoryEnabled:)` is sparse: it sends only `{"memoryEnabled": …}`, so it can never touch the defaults.
public struct UserPreferencesBody: Encodable, Hashable, Sendable {
    public var defaultModel: String?
    public var defaultEffort: EffortLevel?
    public var memoryEnabled: Bool?
    /// false → the two defaults are not sent at all.
    public private(set) var includesDefaults: Bool

    public init(defaultModel: String?, defaultEffort: EffortLevel?, memoryEnabled: Bool? = nil) {
        self.defaultModel = defaultModel; self.defaultEffort = defaultEffort; self.memoryEnabled = memoryEnabled
        self.includesDefaults = true
    }

    /// Only the memory switch.
    public init(memoryEnabled: Bool) {
        self.defaultModel = nil; self.defaultEffort = nil; self.memoryEnabled = memoryEnabled
        self.includesDefaults = false
    }

    enum CodingKeys: String, CodingKey { case defaultModel, defaultEffort, memoryEnabled }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if includesDefaults {
            try c.encode(defaultModel, forKey: .defaultModel)
            try c.encode(defaultEffort, forKey: .defaultEffort)
        }
        try c.encodeIfPresent(memoryEnabled, forKey: .memoryEnabled)
    }
}

public struct ModelInfo: Codable, Hashable, Identifiable, Sendable {
    public var value: String
    public var displayName: String
    public var description: String?
    public var supportsEffort: Bool?
    public var supportedEffortLevels: [EffortLevel]?
    public var supportsAutoMode: Bool?
    /// Family for grouping ("opus", "fable", "sonnet", "haiku"); nil → the hub did not say.
    public var family: String?
    /// true for older versions of a family (shown under "More models"); nil → the hub did not say.
    public var legacy: Bool?
    public var id: String { value }

    public init(value: String, displayName: String, description: String? = nil, supportsEffort: Bool? = nil,
                supportedEffortLevels: [EffortLevel]? = nil, supportsAutoMode: Bool? = nil,
                family: String? = nil, legacy: Bool? = nil) {
        self.value = value; self.displayName = displayName; self.description = description
        self.supportsEffort = supportsEffort; self.supportedEffortLevels = supportedEffortLevels; self.supportsAutoMode = supportsAutoMode
        self.family = family; self.legacy = legacy
    }

    /// Effort levels offered for this model ([] = no effort control).
    public var effortLevels: [EffortLevel] {
        if supportsEffort == false { return [] }
        return supportedEffortLevels ?? []
    }
}

/// One category of a session's context window (`ContextUsage.breakdown[]`).
public struct ContextUsageEntry: Codable, Hashable, Identifiable, Sendable {
    /// system_prompt | system_tools | mcp_tools | skills | memory | messages | autocompact_buffer | …
    public var key: String
    public var label: String
    public var tokens: Int
    public var id: String { key }

    public init(key: String, label: String, tokens: Int) { self.key = key; self.label = label; self.tokens = tokens }
}

/// Context-window usage of a session after its last turn (like Claude Code's `/context`).
/// `breakdown` is nil when the hub only knows the totals.
public struct ContextUsage: Codable, Hashable, Sendable {
    public var usedTokens: Int
    public var windowTokens: Int
    public var model: String?
    public var breakdown: [ContextUsageEntry]?
    public var updatedAt: String

    public init(usedTokens: Int, windowTokens: Int, model: String? = nil, breakdown: [ContextUsageEntry]? = nil, updatedAt: String) {
        self.usedTokens = usedTokens; self.windowTokens = windowTokens; self.model = model; self.breakdown = breakdown; self.updatedAt = updatedAt
    }

    /// Share of the window, 0…1, for any token count.
    public func fraction(_ tokens: Int) -> Double { windowTokens > 0 ? min(1, max(0, Double(tokens) / Double(windowTokens))) : 0 }
    public var usedFraction: Double { fraction(usedTokens) }
    /// What is left: the window minus every breakdown category (the autocompact buffer included), or minus `usedTokens`.
    public var freeTokens: Int {
        let taken = breakdown.map { $0.reduce(0) { $0 + $1.tokens } } ?? usedTokens
        return max(0, windowTokens - taken)
    }
}

public struct Session: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var user: String
    public var kind: SessionKind
    public var title: String
    public var cwd: String
    public var model: String
    public var permissionMode: PermissionMode
    public var effort: EffortLevel?
    public var status: SessionStatus
    public var queuePosition: Int?
    public var claudeSessionId: String?
    public var createdAt: String
    public var lastActiveAt: String
    public var lastSeq: Int
    public var costUsd: Double
    /// Context-window usage after the last turn; nil before the first turn (and from hubs that do not send it).
    public var contextUsage: ContextUsage?

    public init(id: String, user: String, kind: SessionKind, title: String, cwd: String = "", model: String = "",
                permissionMode: PermissionMode = .default, effort: EffortLevel? = nil, status: SessionStatus = .idle,
                queuePosition: Int? = nil, claudeSessionId: String? = nil, createdAt: String = "", lastActiveAt: String = "",
                lastSeq: Int = 0, costUsd: Double = 0, contextUsage: ContextUsage? = nil) {
        self.id = id; self.user = user; self.kind = kind; self.title = title; self.cwd = cwd; self.model = model
        self.permissionMode = permissionMode; self.effort = effort; self.status = status; self.queuePosition = queuePosition
        self.claudeSessionId = claudeSessionId; self.createdAt = createdAt; self.lastActiveAt = lastActiveAt
        self.lastSeq = lastSeq; self.costUsd = costUsd; self.contextUsage = contextUsage
    }

    enum CodingKeys: String, CodingKey {
        case id, user, kind, title, cwd, model, permissionMode, effort, status, queuePosition, claudeSessionId
        case createdAt, lastActiveAt, lastSeq, costUsd, contextUsage
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        user = try c.decode(String.self, forKey: .user)
        kind = try c.decode(SessionKind.self, forKey: .kind)
        title = try c.decode(String.self, forKey: .title)
        cwd = try c.decode(String.self, forKey: .cwd)
        model = try c.decode(String.self, forKey: .model)
        permissionMode = try c.decode(PermissionMode.self, forKey: .permissionMode)
        effort = try c.decodeIfPresent(EffortLevel.self, forKey: .effort)
        status = try c.decode(SessionStatus.self, forKey: .status)
        queuePosition = try c.decodeIfPresent(Int.self, forKey: .queuePosition)
        claudeSessionId = try c.decodeIfPresent(String.self, forKey: .claudeSessionId)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        lastActiveAt = try c.decode(String.self, forKey: .lastActiveAt)
        lastSeq = try c.decode(Int.self, forKey: .lastSeq)
        costUsd = try c.decode(Double.self, forKey: .costUsd)
        // Absent, null or malformed → nil: a bad usage block must never hide the session itself.
        contextUsage = (try? c.decodeIfPresent(ContextUsage.self, forKey: .contextUsage)) ?? nil
    }
}

public struct StoredMessage: Codable, Hashable, Identifiable, Sendable {
    public var seq: Int
    public var sessionId: String
    public var uuid: String
    /// user | assistant | result | system | reset (kept as a string for tolerance).
    public var kind: String
    public var payload: JSONValue
    public var at: String
    public var id: Int { seq }

    public init(seq: Int, sessionId: String, uuid: String, kind: String, payload: JSONValue, at: String) {
        self.seq = seq; self.sessionId = sessionId; self.uuid = uuid; self.kind = kind; self.payload = payload; self.at = at
    }
}

/// Something Claude remembers about the user across sessions (per user, stored on the hub).
public struct Memory: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var text: String
    /// claude (saved by Claude in a conversation) | user (typed by the person)
    public var source: String
    /// The session Claude saved it from, when `source` is claude.
    public var sessionId: String?
    public var createdAt: String
    public var updatedAt: String

    public init(id: String, text: String, source: String = "user", sessionId: String? = nil, createdAt: String = "", updatedAt: String = "") {
        self.id = id; self.text = text; self.source = source; self.sessionId = sessionId; self.createdAt = createdAt; self.updatedAt = updatedAt
    }

    public var isFromClaude: Bool { source == "claude" }
}

/// `POST /api/me/memories`, `PATCH /api/me/memories/:id`.
public struct MemoryBody: Codable, Hashable, Sendable {
    public var text: String
    public init(text: String) { self.text = text }
}

/// `GET /api/me/memories`: newest first.
public struct MemoriesResponse: Codable, Hashable, Sendable {
    public var memories: [Memory]
    public init(memories: [Memory]) { self.memories = memories }
}

public struct FileEntry: Codable, Hashable, Identifiable, Sendable {
    public var path: String
    public var name: String
    /// file | dir | symlink
    public var kind: String
    public var size: Int64
    public var mtime: String
    public var reviewStatus: String?
    public var id: String { path }
    public var isDirectory: Bool { kind == "dir" }

    public init(path: String, name: String, kind: String, size: Int64 = 0, mtime: String = "", reviewStatus: String? = nil) {
        self.path = path; self.name = name; self.kind = kind; self.size = size; self.mtime = mtime; self.reviewStatus = reviewStatus
    }
}

public struct Project: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var user: String
    public var name: String
    public var path: String
    public var createdAt: String
    public var localCommit: String?
    public var pendingFiles: Int
    public var sizeBytes: Int64
    public var origin: String?

    public init(id: String, user: String, name: String, path: String? = nil, createdAt: String = "", localCommit: String? = nil,
                pendingFiles: Int = 0, sizeBytes: Int64 = 0, origin: String? = nil) {
        self.id = id; self.user = user; self.name = name; self.path = path ?? "projects/\(name)"; self.createdAt = createdAt
        self.localCommit = localCommit; self.pendingFiles = pendingFiles; self.sizeBytes = sizeBytes; self.origin = origin
    }
}

public struct TouchInfo: Codable, Hashable, Sendable {
    public var sessionId: String
    public var turn: Int
    public var tool: String
    public var at: String
}

public struct ReviewFile: Codable, Hashable, Identifiable, Sendable {
    public var path: String
    /// added | modified | deleted | renamed | typechange
    public var status: String
    public var oldPath: String?
    public var binary: Bool
    public var additions: Int
    public var deletions: Int
    public var sizeBytes: Int64
    public var lastTouchedBy: TouchInfo?
    public var id: String { path }

    public init(path: String, status: String, oldPath: String? = nil, binary: Bool = false, additions: Int = 0,
                deletions: Int = 0, sizeBytes: Int64 = 0, lastTouchedBy: TouchInfo? = nil) {
        self.path = path; self.status = status; self.oldPath = oldPath; self.binary = binary; self.additions = additions
        self.deletions = deletions; self.sizeBytes = sizeBytes; self.lastTouchedBy = lastTouchedBy
    }
}

public struct Hunk: Codable, Hashable, Identifiable, Sendable {
    public var index: Int
    public var oldStart: Int
    public var oldLines: Int
    public var newStart: Int
    public var newLines: Int
    public var header: String
    public var lines: [String]
    public var id: Int { index }
}

public struct FileDiff: Codable, Hashable, Sendable {
    public var path: String
    public var localCommit: String?
    /// sha256 of the unified diff; required when accepting/rejecting individual hunks.
    public var diffId: String?
    public var binary: Bool
    public var oldText: String?
    public var newText: String?
    public var hunks: [Hunk]
}

public struct Snapshot: Codable, Hashable, Identifiable, Sendable {
    public var ref: String
    public var sessionId: String?
    public var turn: Int?
    public var at: String
    public var message: String
    /// snapshot | sync | trash | accept
    public var kind: String
    public var id: String { ref }

    public init(ref: String, sessionId: String? = nil, turn: Int? = nil, at: String, message: String, kind: String) {
        self.ref = ref; self.sessionId = sessionId; self.turn = turn; self.at = at; self.message = message; self.kind = kind
    }
}

/// API-credit spend this budget month (`ApiCredits`); `percent` is nil when the limit is 0.
public struct ApiCredits: Codable, Hashable, Sendable {
    public var spentUsd: Double
    public var limitUsd: Double
    public var percent: Double?
    public var periodStart: String
    public var resetsAt: String
    public var severity: LimitSeverity

    public init(spentUsd: Double, limitUsd: Double, percent: Double?, periodStart: String, resetsAt: String, severity: LimitSeverity) {
        self.spentUsd = spentUsd; self.limitUsd = limitUsd; self.percent = percent
        self.periodStart = periodStart; self.resetsAt = resetsAt; self.severity = severity
    }
}

public struct UsageLimits: Codable, Hashable, Sendable {
    /// nil when no API key is configured on the server.
    public var api: ApiCredits?

    public init(api: ApiCredits? = nil) { self.api = api }

    /// Drives the red dot on the sidebar "Usage" entry.
    public var needsAttention: Bool { api?.severity.needsAttention ?? false }
}

public struct TokenUsageBucket: Codable, Hashable, Sendable {
    public var bucket: String
    public var model: String
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheReadTokens: Int
    public var cacheCreateTokens: Int
    public var costUsd: Double
    public var turns: Int

    public init(bucket: String, model: String, inputTokens: Int, outputTokens: Int, cacheReadTokens: Int = 0,
                cacheCreateTokens: Int = 0, costUsd: Double = 0, turns: Int = 0) {
        self.bucket = bucket; self.model = model; self.inputTokens = inputTokens; self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens; self.cacheCreateTokens = cacheCreateTokens; self.costUsd = costUsd; self.turns = turns
    }
}

public struct DiskBreakdownItem: Codable, Hashable, Sendable {
    public var label: String
    public var user: String?
    public var path: String
    public var bytes: Int64
}

public struct DiskProjectItem: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var pendingFiles: Int
    public var undownloadedFiles: Int
    public var bytes: Int64

    public init(id: String, name: String, pendingFiles: Int, undownloadedFiles: Int, bytes: Int64) {
        self.id = id; self.name = name; self.pendingFiles = pendingFiles; self.undownloadedFiles = undownloadedFiles; self.bytes = bytes
    }
}

public struct DiskStatus: Codable, Hashable, Sendable {
    public var level: DiskLevel
    public var usedPercent: Double
    public var totalBytes: Int64
    public var freeBytes: Int64
    public var warnPercent: Double
    public var blockPercent: Double
    public var breakdown: [DiskBreakdownItem]
    public var projects: [DiskProjectItem]

    public init(level: DiskLevel, usedPercent: Double, totalBytes: Int64, freeBytes: Int64, warnPercent: Double = 80,
                blockPercent: Double = 95, breakdown: [DiskBreakdownItem] = [], projects: [DiskProjectItem] = []) {
        self.level = level; self.usedPercent = usedPercent; self.totalBytes = totalBytes; self.freeBytes = freeBytes
        self.warnPercent = warnPercent; self.blockPercent = blockPercent; self.breakdown = breakdown; self.projects = projects
    }
}

public struct AdminSettings: Codable, Hashable, Sendable {
    public var remoteClaudeEnabled: Bool
    public var diskWarnPercent: Double
    public var diskBlockPercent: Double
    public var defaultWeeklyTokenLimit: Int
    /// Server-wide default model / effort for new sessions (a user's own defaults win). Optional so older hubs still decode.
    public var defaultModel: String?
    public var defaultEffort: EffortLevel?
    /// Monthly API budget in USD, the day of month it resets and the part kept for the hub's own services. Optional so older hubs still decode.
    public var apiMonthlyLimitUsd: Double?
    public var apiResetDay: Int?
    public var serviceReserveUsd: Double?

    public init(remoteClaudeEnabled: Bool = true, diskWarnPercent: Double = 80, diskBlockPercent: Double = 95, defaultWeeklyTokenLimit: Int = 0,
                defaultModel: String? = nil, defaultEffort: EffortLevel? = nil,
                apiMonthlyLimitUsd: Double? = nil, apiResetDay: Int? = nil, serviceReserveUsd: Double? = nil) {
        self.remoteClaudeEnabled = remoteClaudeEnabled; self.diskWarnPercent = diskWarnPercent
        self.diskBlockPercent = diskBlockPercent; self.defaultWeeklyTokenLimit = defaultWeeklyTokenLimit
        self.defaultModel = defaultModel; self.defaultEffort = defaultEffort
        self.apiMonthlyLimitUsd = apiMonthlyLimitUsd; self.apiResetDay = apiResetDay; self.serviceReserveUsd = serviceReserveUsd
    }
}

public struct PermissionRequest: Codable, Hashable, Identifiable, Sendable {
    public var requestId: String
    public var sessionId: String
    public var toolName: String
    public var input: JSONValue?
    public var toolUseId: String?
    public var suggestions: [JSONValue]?
    public var at: String
    public var id: String { requestId }

    public init(requestId: String, sessionId: String, toolName: String, input: JSONValue? = nil, toolUseId: String? = nil,
                suggestions: [JSONValue]? = nil, at: String = "") {
        self.requestId = requestId; self.sessionId = sessionId; self.toolName = toolName; self.input = input
        self.toolUseId = toolUseId; self.suggestions = suggestions; self.at = at
    }

    /// One-line human summary for notifications ("npm test", "src/a.ts", …).
    public var summary: String {
        let keys = ["command", "file_path", "path", "url", "pattern", "description"]
        for k in keys { if let s = input?[k]?.stringValue, !s.isEmpty { return String(s.prefix(140)) } }
        return toolName
    }
}

public struct PermissionResponse: Codable, Hashable, Sendable {
    /// allow | deny
    public var requestId: String
    public var behavior: String
    public var updatedInput: JSONValue?
    public var message: String?
    /// session | user
    public var remember: String?

    public init(requestId: String, behavior: String, updatedInput: JSONValue? = nil, message: String? = nil, remember: String? = nil) {
        self.requestId = requestId; self.behavior = behavior; self.updatedInput = updatedInput; self.message = message; self.remember = remember
    }
}

// MARK: - REST bodies

public struct ErrorBody: Codable, Hashable, Sendable {
    public var error: String
    public var code: String?
}

public struct Me: Codable, Hashable, Sendable {
    public var user: User
    public var settings: AdminSettings
    public var disk: DiskLevel
    /// An API key is configured and the monthly budget is above 0; false = sessions cannot start.
    public var apiAvailable: Bool
    public var protocolVersion: Int

    public init(user: User, settings: AdminSettings = AdminSettings(), disk: DiskLevel = .ok, apiAvailable: Bool = true,
                protocolVersion: Int = 1) {
        self.user = user; self.settings = settings; self.disk = disk; self.apiAvailable = apiAvailable
        self.protocolVersion = protocolVersion
    }
}

public struct CreateUserBody: Codable, Sendable { public var name: String }

public struct CreateSessionBody: Codable, Hashable, Sendable {
    public var kind: SessionKind
    public var title: String?
    public var cwd: String?
    public var model: String?
    public var permissionMode: PermissionMode?
    public var effort: EffortLevel?

    public init(kind: SessionKind, title: String? = nil, cwd: String? = nil, model: String? = nil,
                permissionMode: PermissionMode? = nil, effort: EffortLevel? = nil) {
        self.kind = kind; self.title = title; self.cwd = cwd; self.model = model; self.permissionMode = permissionMode; self.effort = effort
    }
}

public struct PatchSessionBody: Codable, Sendable { public var title: String }

/// `PATCH /api/sessions/:id/settings`. `effort` distinguishes "leave alone" (not set)
/// from "clear" (`.some(nil)` → JSON null), as the protocol's `.nullable().optional()` does.
public struct SessionSettingsPatch: Encodable, Hashable, Sendable {
    public var model: String?
    public var permissionMode: PermissionMode?
    public var effort: EffortLevel??

    public init(model: String? = nil, permissionMode: PermissionMode? = nil, effort: EffortLevel?? = .none) {
        self.model = model; self.permissionMode = permissionMode; self.effort = effort
    }

    enum CodingKeys: String, CodingKey { case model, permissionMode, effort }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(model, forKey: .model)
        try c.encodeIfPresent(permissionMode, forKey: .permissionMode)
        if let effort { try c.encode(effort, forKey: .effort) } // inner nil → null
    }

    public var isEmpty: Bool { model == nil && permissionMode == nil && effort == nil }

    /// Same patch as a JSON value (for `window.workstationEmbed.applySettings`).
    public var jsonValue: JSONValue {
        var o: [String: JSONValue] = [:]
        if let model { o["model"] = .string(model) }
        if let permissionMode { o["permissionMode"] = .string(permissionMode.rawValue) }
        if let effort { o["effort"] = effort.map { .string($0.rawValue) } ?? .null }
        return .object(o)
    }
}

/// Settings as broadcast in `session_settings`.
public struct SessionSettingsValue: Codable, Hashable, Sendable {
    public var model: String
    public var permissionMode: PermissionMode
    public var effort: EffortLevel?
}

/// An attachment on a sent message: an inline image, or a reference to a file already in the workspace
/// (uploaded to inbox/ first). Mirrors the protocol's `Attachment` discriminated union.
public enum Attachment: Codable, Hashable, Sendable {
    case image(mediaType: String, dataBase64: String, name: String?)
    case fileRef(path: String)

    private enum CodingKeys: String, CodingKey { case type, mediaType, dataBase64, name, path }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "image":
            self = .image(mediaType: try c.decode(String.self, forKey: .mediaType),
                          dataBase64: try c.decode(String.self, forKey: .dataBase64),
                          name: try c.decodeIfPresent(String.self, forKey: .name))
        case "file_ref":
            self = .fileRef(path: try c.decode(String.self, forKey: .path))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown attachment type \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .image(let mediaType, let dataBase64, let name):
            try c.encode("image", forKey: .type)
            try c.encode(mediaType, forKey: .mediaType)
            try c.encode(dataBase64, forKey: .dataBase64)
            try c.encodeIfPresent(name, forKey: .name)
        case .fileRef(let path):
            try c.encode("file_ref", forKey: .type)
            try c.encode(path, forKey: .path)
        }
    }
}

public struct SendMessageBody: Codable, Sendable {
    public var uuid: String
    public var text: String
    public var attachments: [Attachment]?

    public init(uuid: String, text: String, attachments: [Attachment]? = nil) {
        self.uuid = uuid
        self.text = text
        self.attachments = attachments
    }
}

public struct SendMessageResponse: Codable, Hashable, Sendable {
    /// accepted | queued
    public var state: String
    public var position: Int?
    public var seq: Int
}

public struct FileContentResponse: Codable, Hashable, Sendable {
    public var path: String
    public var size: Int64
    public var truncated: Bool
    public var text: String?
    public var mediaType: String
}

public struct UploadChunkResponse: Codable, Hashable, Sendable {
    public var uploadId: String
    public var received: [Int]
    public var complete: Bool
    public var path: String?
}

public struct CreateProjectBody: Codable, Sendable {
    public var name: String
    public var origin: String?
}

public struct ManifestEntry: Codable, Hashable, Sendable {
    public var path: String
    public var hash: String
    public var size: Int64
    public var mode: Int

    public init(path: String, hash: String, size: Int64, mode: Int) {
        self.path = path; self.hash = hash; self.size = size; self.mode = mode
    }
}

public struct ManifestBody: Codable, Sendable { public var entries: [ManifestEntry] }

public struct ManifestResponse: Codable, Hashable, Sendable {
    public var need: [String]
    public var delete: [String]
    public var localCommit: String?

    public init(need: [String], delete: [String], localCommit: String?) {
        self.need = need; self.delete = delete; self.localCommit = localCommit
    }
}

/// `SyncOp`: discriminated by `op`. `baseHash` is *required but nullable* in the
/// protocol, so it is always encoded (as `null` for new files).
public enum SyncOp: Codable, Hashable, Sendable {
    case write(path: String, hash: String, size: Int64, mode: Int, baseHash: String?, contentBase64: String?, force: Bool?)
    case delete(path: String, baseHash: String?, force: Bool?)

    public var path: String {
        switch self { case .write(let p, _, _, _, _, _, _), .delete(let p, _, _): return p }
    }

    public var hash: String? {
        if case .write(_, let h, _, _, _, _, _) = self { return h }
        return nil
    }

    public var baseHash: String? {
        switch self { case .write(_, _, _, _, let b, _, _), .delete(_, let b, _): return b }
    }

    public var carriesContent: Bool {
        if case .write(_, _, _, _, _, let c, _) = self { return c != nil }
        return false
    }

    public var isDelete: Bool { if case .delete = self { return true }; return false }

    enum CodingKeys: String, CodingKey { case op, path, hash, size, mode, baseHash, contentBase64, force }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let op = try c.decode(String.self, forKey: .op)
        let path = try c.decode(String.self, forKey: .path)
        let base = try c.decodeIfPresent(String.self, forKey: .baseHash)
        let force = try c.decodeIfPresent(Bool.self, forKey: .force)
        if op == "delete" {
            self = .delete(path: path, baseHash: base, force: force)
        } else {
            self = .write(path: path, hash: try c.decode(String.self, forKey: .hash), size: try c.decode(Int64.self, forKey: .size),
                          mode: try c.decode(Int.self, forKey: .mode), baseHash: base,
                          contentBase64: try c.decodeIfPresent(String.self, forKey: .contentBase64), force: force)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .write(path, hash, size, mode, baseHash, content, force):
            try c.encode("write", forKey: .op)
            try c.encode(path, forKey: .path)
            try c.encode(hash, forKey: .hash)
            try c.encode(size, forKey: .size)
            try c.encode(mode, forKey: .mode)
            try c.encode(baseHash, forKey: .baseHash)
            try c.encodeIfPresent(content, forKey: .contentBase64)
            try c.encodeIfPresent(force, forKey: .force)
        case let .delete(path, baseHash, force):
            try c.encode("delete", forKey: .op)
            try c.encode(path, forKey: .path)
            try c.encode(baseHash, forKey: .baseHash)
            try c.encodeIfPresent(force, forKey: .force)
        }
    }
}

public struct SyncBody: Codable, Sendable { public var ops: [SyncOp] }

public enum SyncResultStatus: String, TolerantStringEnum {
    case applied, noop, merged, conflict
    case needContent = "need_content"
    case skipped
    public static let fallback: SyncResultStatus = .skipped
}

public struct SyncResultItem: Codable, Hashable, Sendable {
    public var path: String
    public var status: SyncResultStatus
    public var reason: String?

    public init(path: String, status: SyncResultStatus, reason: String? = nil) {
        self.path = path; self.status = status; self.reason = reason
    }
}

public struct SyncResult: Codable, Hashable, Sendable {
    public var localCommit: String?
    public var results: [SyncResultItem]

    public init(localCommit: String?, results: [SyncResultItem]) { self.localCommit = localCommit; self.results = results }
}

public struct ReviewResponse: Codable, Hashable, Sendable {
    public var project: Project
    public var files: [ReviewFile]
}

/// `{path, hunks?, diffId?}` or `{all: true}`. `diffId` (from `FileDiff`) is required by the
/// hub whenever `hunks` is given; a mismatch answers 409 `stale_diff`.
public enum AcceptBody: Encodable, Hashable, Sendable {
    case file(path: String, hunks: [Int]?, diffId: String?)
    case all

    public static func file(path: String) -> AcceptBody { .file(path: path, hunks: nil, diffId: nil) }

    enum CodingKeys: String, CodingKey { case path, hunks, diffId, all }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .file(let path, let hunks, let diffId):
            try c.encode(path, forKey: .path)
            try c.encodeIfPresent(hunks, forKey: .hunks)
            try c.encodeIfPresent(diffId, forKey: .diffId)
        case .all:
            try c.encode(true, forKey: .all)
        }
    }
}

public typealias RejectBody = AcceptBody

public struct AcceptedFile: Codable, Hashable, Sendable {
    public var path: String
    public var contentBase64: String?
    public var deleted: Bool
    /// Large files: no content here; download with raw at `ref = localCommit` (Range) and check `sha256`.
    public var large: Bool?
    public var sha256: String?
    public var size: Int64?

    public init(path: String, contentBase64: String?, deleted: Bool, large: Bool? = nil, sha256: String? = nil, size: Int64? = nil) {
        self.path = path; self.contentBase64 = contentBase64; self.deleted = deleted
        self.large = large; self.sha256 = sha256; self.size = size
    }

    public var data: Data? { contentBase64.flatMap { Data(base64Encoded: $0) } }
}

public struct AcceptResponse: Codable, Hashable, Sendable {
    public var localCommit: String
    public var files: [AcceptedFile]

    public init(localCommit: String, files: [AcceptedFile]) { self.localCommit = localCommit; self.files = files }
}

/// `POST /api/projects/:id/backups`: a Mac-side version kept on the server (`refs/backups/<client>/<id>`)
/// before a locally edited file is overwritten or deleted. ≤ 50 MB decoded and ≤ 500 files per request.
public struct ProjectBackupBody: Codable, Equatable, Sendable {
    public enum Reason: String, Codable, Sendable { case overwrite, delete, manual }
    public struct File: Codable, Equatable, Sendable {
        public var path: String
        public var dataBase64: String
        public var mode: Int?
        public init(path: String, dataBase64: String, mode: Int? = nil) { self.path = path; self.dataBase64 = dataBase64; self.mode = mode }
    }
    public var client: String
    public var reason: Reason
    public var files: [File]
    public init(client: String, reason: Reason, files: [File]) { self.client = client; self.reason = reason; self.files = files }
}

public struct ProjectBackup: Codable, Equatable, Hashable, Sendable, Identifiable {
    public struct File: Codable, Equatable, Hashable, Sendable {
        public var path: String
        /// Git blob id of the stored bytes.
        public var blob: String
        public var size: Int64
        public init(path: String, blob: String, size: Int64) { self.path = path; self.blob = blob; self.size = size }
    }
    public var id: String
    public var ref: String
    public var commit: String
    public var client: String
    public var reason: ProjectBackupBody.Reason
    public var at: String
    public var files: [File]
    public init(id: String, ref: String, commit: String, client: String, reason: ProjectBackupBody.Reason, at: String, files: [File]) {
        self.id = id; self.ref = ref; self.commit = commit; self.client = client; self.reason = reason; self.at = at; self.files = files
    }
}

public struct RestoreBody: Codable, Sendable {
    public var ref: String
    public var path: String?
}

public struct DeleteProjectBody: Codable, Sendable { public var discardRemaining: Bool }

public struct MyUsageResponse: Codable, Hashable, Sendable {
    public var range: UsageRange
    public var buckets: [TokenUsageBucket]
    public var weeklyTokens: Int
    public var weeklyLimit: Int?

    public init(range: UsageRange, buckets: [TokenUsageBucket], weeklyTokens: Int, weeklyLimit: Int?) {
        self.range = range; self.buckets = buckets; self.weeklyTokens = weeklyTokens; self.weeklyLimit = weeklyLimit
    }
}

public struct CreateTerminalBody: Codable, Sendable { public var cwd: String? }

public struct TerminalInfo: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var cwd: String
    public var createdAt: String
    public var tmuxSession: String
}
