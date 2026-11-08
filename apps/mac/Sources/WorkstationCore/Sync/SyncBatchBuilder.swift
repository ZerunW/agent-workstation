import Foundation

/// Observed local state of one path, after ignore filtering and echo suppression.
public enum LocalChange: Equatable, Sendable {
    case present(path: String, hash: String, size: Int64, mode: Int)
    case absent(path: String)

    public var path: String {
        switch self { case .present(let p, _, _, _), .absent(let p): return p }
    }
}

public struct SyncConflictInfo: Hashable, Sendable, Identifiable {
    public var path: String
    public var reason: String
    public var id: String { path }
    public init(path: String, reason: String) { self.path = path; self.reason = reason }
}

public struct SyncOutcome: Equatable, Sendable {
    public var applied: [String] = []
    public var conflicts: [SyncConflictInfo] = []
    public var needContent: [String] = []
    public var skipped: [SyncConflictInfo] = []
}

/// Pure planning of `PUT /api/projects/:id/files` batches.
///
/// * `baseHash` = the hash recorded for that path after the last successful push/accept
///   (`known[path]`), `nil` for a file the hub has never seen from us.
/// * Unchanged files (`hash == known[path]`) produce no op; absent files we never pushed
///   produce no delete.
/// * Within one batch, content is sent once per distinct hash (later ops with the same hash
///   omit `contentBase64`); the hub answers `need_content` if it cannot resolve one.
/// * Batches are split at `maxBatchContentBytes` of raw content / `maxOpsPerBatch` ops.
public struct SyncBatchBuilder: Sendable {
    public var maxBatchContentBytes: Int64 = 8 * 1024 * 1024
    public var maxOpsPerBatch = 500
    public var maxFileBytes: Int64 = WorkstationProtocol.maxSyncFileBytes

    public init(maxBatchContentBytes: Int64 = 8 * 1024 * 1024, maxOpsPerBatch: Int = 500) {
        self.maxBatchContentBytes = maxBatchContentBytes
        self.maxOpsPerBatch = maxOpsPerBatch
    }

    public struct Plan: Equatable, Sendable {
        public var batches: [[SyncOp]]
        public var skipped: [SyncConflictInfo]
        public var opCount: Int { batches.reduce(0) { $0 + $1.count } }
    }

    /// - Parameters:
    ///   - force: paths sent with `force: true` ("keep mine" after a conflict).
    ///   - mustSend: paths sent even if unchanged / never pushed (the hub asked for them
    ///     in a manifest `need[]` / `delete[]`).
    public func plan(changes: [LocalChange], known: [String: String], force: Set<String> = [],
                     mustSend: Set<String> = [], alwaysIncludeContent: Bool = false,
                     content: (String) throws -> Data) -> Plan {
        var batches: [[SyncOp]] = []
        var current: [SyncOp] = []
        var currentBytes: Int64 = 0
        var sentHashes = Set<String>()
        var skipped: [SyncConflictInfo] = []

        func flush() {
            if !current.isEmpty { batches.append(current) }
            current = []; currentBytes = 0; sentHashes = []
        }

        // De-duplicate by path (last observation wins), then order deterministically.
        var byPath: [String: LocalChange] = [:]
        for c in changes { byPath[c.path] = c }
        for path in byPath.keys.sorted() {
            let change = byPath[path]!
            let base = known[path]
            let isForced = force.contains(path)
            let required = isForced || mustSend.contains(path)
            switch change {
            case .absent:
                guard base != nil || required else { continue }
                if current.count >= maxOpsPerBatch { flush() }
                current.append(.delete(path: path, baseHash: base, force: isForced ? true : nil))
            case let .present(_, hash, size, mode):
                if hash == base && !required { continue }
                if size > maxFileBytes {
                    skipped.append(SyncConflictInfo(path: path, reason: "larger than \(Formatters.bytes(maxFileBytes))"))
                    continue
                }
                let needsContent = alwaysIncludeContent || !sentHashes.contains(hash)
                if current.count >= maxOpsPerBatch || (needsContent && currentBytes > 0 && currentBytes + size > maxBatchContentBytes) {
                    flush()
                }
                var b64: String?
                if alwaysIncludeContent || !sentHashes.contains(hash) {
                    do {
                        b64 = try content(path).base64EncodedString()
                    } catch {
                        skipped.append(SyncConflictInfo(path: path, reason: "unreadable: \(error.localizedDescription)"))
                        continue
                    }
                    sentHashes.insert(hash)
                    currentBytes += size
                }
                current.append(.write(path: path, hash: hash, size: size, mode: mode, baseHash: base,
                                      contentBase64: b64, force: isForced ? true : nil))
            }
        }
        flush()
        return Plan(batches: batches, skipped: skipped)
    }

    /// Applies hub results to the `known` map (baseHash bookkeeping).
    /// applied / noop / merged → the hub's `local` now equals what we sent.
    public static func apply(_ result: SyncResult, ops: [SyncOp], known: inout [String: String]) -> SyncOutcome {
        var outcome = SyncOutcome()
        let opsByPath = Dictionary(ops.map { ($0.path, $0) }, uniquingKeysWith: { _, b in b })
        for item in result.results {
            guard let op = opsByPath[item.path] else { continue }
            switch item.status {
            case .applied, .noop, .merged:
                switch op {
                case .write(_, let hash, _, _, _, _, _): known[item.path] = hash
                case .delete: known.removeValue(forKey: item.path)
                }
                outcome.applied.append(item.path)
            case .conflict:
                outcome.conflicts.append(SyncConflictInfo(path: item.path, reason: item.reason ?? "conflict"))
            case .needContent:
                outcome.needContent.append(item.path)
            case .skipped:
                outcome.skipped.append(SyncConflictInfo(path: item.path, reason: item.reason ?? "skipped by hub"))
            }
        }
        return outcome
    }
}
