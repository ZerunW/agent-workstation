import Foundation

/// One file of an apply batch: the version before (`oldHash`, nil = absent) and after
/// (`newHash`, nil = deleted). Both versions live in the server's git history; nothing is
/// copied on the Mac.
public struct HistoryFile: Codable, Equatable, Hashable, Sendable, Identifiable {
    public var path: String
    public var op: WriteItem.Op
    public var oldHash: String?
    public var newHash: String?
    /// Where the server keeps the old version (a commit of `local`, or a backup ref): for Restore.
    public var oldRef: String?
    /// The old version had un-synced local edits and was backed up on the server first.
    public var backedUp: Bool
    public var id: String { path }
    public init(path: String, op: WriteItem.Op, oldHash: String?, newHash: String?, oldRef: String? = nil, backedUp: Bool = false) {
        self.path = path; self.op = op; self.oldHash = oldHash; self.newHash = newHash; self.oldRef = oldRef; self.backedUp = backedUp
    }
}

/// One approved batch the writer applied to a linked folder (metadata only).
public struct HistoryBatch: Codable, Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var at: Date
    public var projectId: String
    public var projectName: String
    public var files: [HistoryFile]
    public init(id: String, at: Date, projectId: String, projectName: String, files: [HistoryFile]) {
        self.id = id; self.at = at; self.projectId = projectId; self.projectName = projectName; self.files = files
    }
}

/// Apply-batch records in the app's own storage (`<directory>/<projectId>/<epoch ms>-<id>.json`).
/// Metadata only: the file contents are restored from the server. Nothing is pruned automatically.
public struct HistoryStore: Sendable {
    public let directory: URL

    public init(directory: URL) { self.directory = directory }

    func projectURL(_ projectId: String) -> URL { directory.appendingPathComponent(projectId, isDirectory: true) }

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

    public func record(_ batch: HistoryBatch) throws {
        let dir = projectURL(batch.projectId)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let ms = Int64(batch.at.timeIntervalSince1970 * 1000)
        try Self.encoder.encode(batch).write(to: dir.appendingPathComponent("\(ms)-\(batch.id).json"), options: .atomic)
    }

    /// Newest first.
    public func batches(projectId: String) -> [HistoryBatch] {
        let dir = projectURL(projectId)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        // File names start with the epoch milliseconds: newest first, stable within a second.
        return names.filter { $0.hasSuffix(".json") }
            .sorted { (Int64($0.split(separator: "-").first ?? "") ?? 0) > (Int64($1.split(separator: "-").first ?? "") ?? 0) }
            .compactMap { try? Self.decoder.decode(HistoryBatch.self, from: Data(contentsOf: dir.appendingPathComponent($0))) }
    }
}
