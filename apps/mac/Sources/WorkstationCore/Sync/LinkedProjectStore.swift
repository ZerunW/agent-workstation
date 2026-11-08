import Foundation

/// A local folder linked to a hub project. Persisted as JSON in Application Support.
public struct LinkedProject: Codable, Hashable, Identifiable, Sendable {
    public var id: String          // hub project id
    public var name: String
    public var localPath: String
    public var hubURL: String
    public var user: String
    public var linkedAt: Date
    public var extraIgnore: [String]
    public var paused: Bool
    /// Single-file link: the file's name inside `localPath` (its parent folder). nil = the whole folder.
    public var onlyPath: String?
    /// Read-only security-scoped bookmark of what the person picked (the folder or the file).
    public var bookmark: Data?

    public init(id: String, name: String, localPath: String, hubURL: String, user: String,
                linkedAt: Date = Date(), extraIgnore: [String] = [], paused: Bool = false,
                onlyPath: String? = nil, bookmark: Data? = nil) {
        self.id = id; self.name = name; self.localPath = localPath; self.hubURL = hubURL; self.user = user
        self.linkedAt = linkedAt; self.extraIgnore = extraIgnore; self.paused = paused
        self.onlyPath = onlyPath; self.bookmark = bookmark
    }

    public var localURL: URL { URL(fileURLWithPath: localPath, isDirectory: true) }
    public var isSingleFile: Bool { onlyPath != nil }
    /// The folder, or the single file.
    public var pickedURL: URL { onlyPath.map { localURL.appendingPathComponent($0, isDirectory: false) } ?? localURL }
}

/// A change waiting for the person's approval. Outgoing (Mac → server): a local edit, addition or
/// deletion the watcher saw. Incoming (server → Mac): a version from the server (pull back, a
/// change accepted on the server, a conflict's server side, a restore from history).
public struct PendingChange: Codable, Hashable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable { case added, modified, deleted }
    public enum Origin: String, Codable, Sendable {
        /// Edited on this Mac.
        case mac
        /// Accepted on the server (pull back, review page).
        case accepted
        /// The server's copy differs from what this Mac last synced (found by a reconcile).
        case server
        /// The server side of a sync conflict.
        case conflict
        /// An earlier version from History.
        case restore
    }

    public var path: String
    public var kind: Kind
    /// sha256 of the proposed version (nil for deletions).
    public var hash: String?
    public var size: Int64?
    public var mode: Int?
    /// Outgoing: the server's last-synced hash (`known`) when the change was seen.
    public var baseHash: String?
    public var origin: Origin
    public var detectedAt: Date
    public var id: String { path }

    public init(path: String, kind: Kind, hash: String?, size: Int64? = nil, mode: Int? = nil, baseHash: String? = nil,
                origin: Origin, detectedAt: Date = Date()) {
        self.path = path; self.kind = kind; self.hash = hash; self.size = size; self.mode = mode
        self.baseHash = baseHash; self.origin = origin; self.detectedAt = detectedAt
    }
}

/// Per-project sync bookkeeping.
public struct ProjectSyncState: Codable, Equatable, Sendable {
    /// path → sha256 the hub's `local` branch had for it after our last successful push/accept.
    public var known: [String: String] = [:]
    /// path → a commit of the server's `local` branch that holds the `known` version (for diffs and Restore).
    public var knownRefs: [String: String] = [:]
    public var localCommit: String?
    public var baselineDone = false
    public var baselineEncoding: String?
    public var lastReconcileAt: Date?
    public var lastPushAt: Date?
    /// Local changes waiting for "Sync to server" (persisted: never dropped, never pushed silently).
    public var outgoing: [String: PendingChange] = [:]
    /// Server versions waiting for "Apply to Mac" (content in `incoming/<projectId>/<hash>`).
    public var incoming: [String: PendingChange] = [:]

    public init() {}

    enum CodingKeys: String, CodingKey {
        case known, knownRefs, localCommit, baselineDone, baselineEncoding, lastReconcileAt, lastPushAt, outgoing, incoming
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        known = try c.decodeIfPresent([String: String].self, forKey: .known) ?? [:]
        knownRefs = try c.decodeIfPresent([String: String].self, forKey: .knownRefs) ?? [:]
        localCommit = try c.decodeIfPresent(String.self, forKey: .localCommit)
        baselineDone = try c.decodeIfPresent(Bool.self, forKey: .baselineDone) ?? false
        baselineEncoding = try c.decodeIfPresent(String.self, forKey: .baselineEncoding)
        lastReconcileAt = try c.decodeIfPresent(Date.self, forKey: .lastReconcileAt)
        lastPushAt = try c.decodeIfPresent(Date.self, forKey: .lastPushAt)
        outgoing = try c.decodeIfPresent([String: PendingChange].self, forKey: .outgoing) ?? [:]
        incoming = try c.decodeIfPresent([String: PendingChange].self, forKey: .incoming) ?? [:]
    }
}

/// `~/Library/Application Support/Agent Workstation/linked-projects.json` + `sync/<projectId>.json`.
public final class LinkedProjectStore: @unchecked Sendable {
    public let directory: URL
    private let lock = NSLock()

    public static var defaultDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Agent Workstation", isDirectory: true)
    }

    public init(directory: URL = LinkedProjectStore.defaultDirectory) {
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory.appendingPathComponent("sync"), withIntermediateDirectories: true)
    }

    private var listURL: URL { directory.appendingPathComponent("linked-projects.json") }
    private func stateURL(_ id: String) -> URL { directory.appendingPathComponent("sync/\(id).json") }
    private func incomingURL(_ id: String) -> URL { directory.appendingPathComponent("incoming/\(id)", isDirectory: true) }
    private func selectionURL(_ id: String) -> URL { directory.appendingPathComponent("sync/\(id).selection.json") }
    /// Apply-batch records (metadata only).
    public var history: HistoryStore { HistoryStore(directory: directory.appendingPathComponent("history", isDirectory: true)) }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    public func load() -> [LinkedProject] {
        lock.lock(); defer { lock.unlock() }
        guard let data = try? Data(contentsOf: listURL) else { return [] }
        return (try? Self.decoder.decode([LinkedProject].self, from: data)) ?? []
    }

    public func save(_ projects: [LinkedProject]) {
        lock.lock(); defer { lock.unlock() }
        if let data = try? Self.encoder.encode(projects) { try? data.write(to: listURL, options: .atomic) }
    }

    public func upsert(_ p: LinkedProject) {
        var all = load()
        if let i = all.firstIndex(where: { $0.id == p.id }) { all[i] = p } else { all.append(p) }
        save(all)
    }

    /// Forgets a link: the app's own bookkeeping for it (never anything in the linked folder).
    public func remove(id: String) {
        save(load().filter { $0.id != id })
        lock.lock(); defer { lock.unlock() }
        try? FileManager.default.removeItem(at: stateURL(id))
        try? FileManager.default.removeItem(at: incomingURL(id))
        try? FileManager.default.removeItem(at: selectionURL(id))
    }

    // MARK: Sync selection (decisions and waiting items, per linked project)

    /// nil = none stored yet (a link from before sync selection, or a new one without the window).
    public func loadSelection(_ id: String) -> SyncSelection? {
        lock.lock(); defer { lock.unlock() }
        guard let data = try? Data(contentsOf: selectionURL(id)) else { return nil }
        return try? Self.decoder.decode(SyncSelection.self, from: data)
    }

    public func saveSelection(_ id: String, _ selection: SyncSelection) {
        lock.lock(); defer { lock.unlock() }
        if let data = try? Self.encoder.encode(selection) { try? data.write(to: selectionURL(id), options: .atomic) }
    }

    // MARK: Incoming content (server versions waiting for approval; app storage, not the linked folder)

    public func saveIncoming(_ id: String, _ data: Data) throws -> String {
        let hash = FileHasher.sha256(data)
        let dir = incomingURL(id)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try data.write(to: dir.appendingPathComponent(hash), options: .atomic)
        return hash
    }

    /// A downloaded server version (a file, already hash-checked) moved into the incoming store.
    public func saveIncomingFile(_ id: String, _ file: URL, hash: String) throws {
        let dir = incomingURL(id)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent(hash)
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: file, to: dest)
    }

    /// Where a stored server version lives (for the writer's file-backed writes).
    public func incomingFile(_ id: String, hash: String) -> URL? {
        let u = incomingURL(id).appendingPathComponent(hash)
        return LocalEntry.stat(u) == .absent ? nil : u
    }

    /// A temporary file for a download in progress (inside the app's storage).
    public func downloadURL(_ id: String) -> URL {
        let dir = directory.appendingPathComponent("downloads", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(id)-\(UUID().uuidString)")
    }

    public func incoming(_ id: String, hash: String) -> Data? {
        guard let d = try? Data(contentsOf: incomingURL(id).appendingPathComponent(hash)), FileHasher.sha256(d) == hash else { return nil }
        return d
    }

    /// Drops stored server versions no pending entry refers to any more.
    public func pruneIncoming(_ id: String, keep: Set<String>) {
        let dir = incomingURL(id)
        for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where !keep.contains(name) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
        }
    }

    public func loadState(_ id: String) -> ProjectSyncState {
        lock.lock(); defer { lock.unlock() }
        guard let data = try? Data(contentsOf: stateURL(id)) else { return ProjectSyncState() }
        return (try? Self.decoder.decode(ProjectSyncState.self, from: data)) ?? ProjectSyncState()
    }

    public func saveState(_ id: String, _ state: ProjectSyncState) {
        lock.lock(); defer { lock.unlock() }
        if let data = try? Self.encoder.encode(state) { try? data.write(to: stateURL(id), options: .atomic) }
    }
}
