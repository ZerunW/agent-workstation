import Foundation

/// Sync selection: which paths of a linked folder go to the server. The person decides once, in the
/// selection window (everything checked; unchecked items are `skip`), and later only for new items:
///
/// * an unchecked folder or file never syncs, and nothing inside an unchecked folder ever asks;
/// * a new item in a folder that contains anything unchecked waits for the person (the Sync tab and a
///   notification); in a folder with nothing unchecked it syncs on its own: the root follows the
///   same rule; a new folder that waits holds everything inside it;
/// * files that synced already keep syncing (edits, deletions);
/// * `.git` never syncs; a file over 100 MB always waits for the person's own decision.
public enum SyncDecision: String, Codable, Sendable { case sync, skip }
public enum SyncSource: String, Codable, Sendable { case rule, ai, you }
public enum SyncKind: String, Codable, Sendable { case folder, file }

/// One own decision.
public struct SyncRecord: Codable, Equatable, Sendable {
    public var kind: SyncKind
    public var decision: SyncDecision
    public var source: SyncSource
    /// Rules: a fixed sentence; AI: its own; the person: nil.
    public var reason: String?
    /// Folders decided `sync` whose contents were decided one by one: on the server, not approved.
    public var mixed: Bool

    public init(kind: SyncKind, decision: SyncDecision, source: SyncSource, reason: String? = nil, mixed: Bool = false) {
        self.kind = kind; self.decision = decision; self.source = source; self.reason = reason; self.mixed = mixed
    }

    enum CodingKeys: String, CodingKey { case kind, decision, source, reason, mixed }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(SyncKind.self, forKey: .kind)
        decision = try c.decode(SyncDecision.self, forKey: .decision)
        source = try c.decode(SyncSource.self, forKey: .source)
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        mixed = try c.decodeIfPresent(Bool.self, forKey: .mixed) ?? false
    }
}

/// protocol `SyncPendingItem`: a new item waiting for the person.
public struct SyncPendingItem: Codable, Equatable, Sendable {
    public var path: String
    public var kind: SyncKind
    public var bytes: Int64
    public var files: Int?
    public var suggestion: SyncDecision?
    public var source: SyncSource?
    public var reason: String?
    public var large: Bool?
    public var detectedAt: String

    public init(path: String, kind: SyncKind, bytes: Int64, files: Int? = nil, suggestion: SyncDecision? = nil, source: SyncSource? = nil,
                reason: String? = nil, large: Bool? = nil, detectedAt: String = Formatters.iso(Date())) {
        self.path = path; self.kind = kind; self.bytes = bytes; self.files = files; self.suggestion = suggestion
        self.source = source; self.reason = reason; self.large = large; self.detectedAt = detectedAt
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = ["path": .string(path), "kind": .string(kind.rawValue), "bytes": .number(Double(bytes)),
                                      "suggestion": suggestion.map { .string($0.rawValue) } ?? .null,
                                      "source": source.map { .string($0.rawValue) } ?? .null,
                                      "reason": reason.map(JSONValue.string) ?? .null, "detectedAt": .string(detectedAt)]
        if let files { o["files"] = .number(Double(files)) }
        if large == true { o["large"] = .bool(true) }
        return .object(o)
    }
}

/// protocol `SyncEntry`: one row of the Sync panel tree.
public struct SyncEntry: Equatable, Sendable {
    public var path: String
    public var kind: SyncKind
    public var decision: SyncDecision?
    public var effective: SyncDecision?
    public var mixed: Bool?
    public var source: SyncSource?
    public var reason: String?
    public var bytes: Int64
    public var files: Int?

    public var json: JSONValue {
        var o: [String: JSONValue] = ["path": .string(path), "kind": .string(kind.rawValue),
                                      "decision": decision.map { .string($0.rawValue) } ?? .null,
                                      "effective": effective.map { .string($0.rawValue) } ?? .null,
                                      "source": source.map { .string($0.rawValue) } ?? .null,
                                      "reason": reason.map(JSONValue.string) ?? .null, "bytes": .number(Double(bytes))]
        if let mixed { o["mixed"] = .bool(mixed) }
        if let files { o["files"] = .number(Double(files)) }
        return .object(o)
    }
}

/// protocol `SyncDecisionInput`: the person's answer for one path (`nil` clears the own decision).
public struct SyncDecisionInput: Equatable, Sendable {
    public var path: String
    public var kind: SyncKind
    public var decision: SyncDecision?
    public init(path: String, kind: SyncKind, decision: SyncDecision?) { self.path = path; self.kind = kind; self.decision = decision }
}

/// The decision that applies to a path.
public struct EffectiveDecision: Equatable, Sendable {
    /// nil = waiting for the person.
    public var decision: SyncDecision?
    public var source: SyncSource?
    public var reason: String?
    /// From an ancestor folder (not the path's own).
    public var inherited: Bool
    /// A file over the review limit (waits unless the person decided it).
    public var large: Bool

    public static let waiting = EffectiveDecision(decision: nil, source: nil, reason: nil, inherited: false, large: false)
}

/// Per linked project: every own decision and the items waiting for the person. Persisted beside the sync state.
public struct SyncSelection: Codable, Equatable, Sendable {
    /// protocol `SYNC_LARGE_FILE_PROMPT_BYTES` (= `MAX_SYNC_FILE_BYTES`).
    public static let largeFileBytes: Int64 = WorkstationProtocol.maxSyncFileBytes

    /// Own decisions by relative path ("" = the root, which never has one).
    public var records: [String: SyncRecord] = [:]
    /// New items waiting for the person, by path.
    public var pending: [String: SyncPendingItem] = [:]

    public init(records: [String: SyncRecord] = [:], pending: [String: SyncPendingItem] = [:]) {
        self.records = records; self.pending = pending
    }

    /// "2.3 GB large file: each synced version is kept on the server".
    public static func largeReason(_ bytes: Int64) -> String {
        "\(Formatters.bytes(bytes)) large file: each synced version is kept on the server"
    }

    // MARK: Resolution

    /// - Parameter established: folders that existed when the folder was linked or hold synced files
    ///   (they are transparent); a folder not in it is new.
    public func effective(_ path: String, kind: SyncKind, size: Int64? = nil, established: Set<String> = []) -> EffectiveDecision {
        let large = kind == .file && (size ?? 0) > Self.largeFileBytes
        let largeWait = EffectiveDecision(decision: nil, source: nil, reason: Self.largeReason(size ?? 0), inherited: false, large: true)
        if path == ".git" || path.hasPrefix(".git/") {
            return EffectiveDecision(decision: .skip, source: .rule, reason: SyncRules.gitReason, inherited: path != ".git", large: large)
        }
        if let r = records[path] {
            if large && r.decision == .sync && r.source != .you { return largeWait }
            return EffectiveDecision(decision: r.decision, source: r.source, reason: r.reason, inherited: false, large: large)
        }
        // Inside an unchecked folder: never. Inside a new folder that waits: waits with it.
        var cur = path
        while let slash = cur.lastIndex(of: "/") {
            cur = String(cur[..<slash])
            if let r = records[cur], r.kind == .folder {
                if r.decision == .skip { return EffectiveDecision(decision: .skip, source: r.source, reason: r.reason, inherited: true, large: large) }
                break   // decided `sync`: the folders above do not matter
            }
            if !established.contains(cur) && containsSkip(Self.parent(of: cur)) {
                return EffectiveDecision(decision: nil, source: nil, reason: large ? Self.largeReason(size ?? 0) : nil, inherited: false, large: large)
            }
        }
        if large { return largeWait }
        if containsSkip(Self.parent(of: path)) { return .waiting }
        return EffectiveDecision(decision: .sync, source: nil, reason: nil, inherited: true, large: false)
    }

    static func parent(of path: String) -> String { path.lastIndex(of: "/").map { String(path[..<$0]) } ?? "" }

    /// Something unchecked inside `folder` ("" = the root).
    public func containsSkip(_ folder: String) -> Bool {
        let prefix = folder.isEmpty ? "" : folder + "/"
        return records.contains { k, r in r.decision == .skip && k != folder && k.hasPrefix(prefix) }
    }

    /// Any own decision strictly beneath `folder`.
    public func hasDecisionsBeneath(_ folder: String) -> Bool {
        let prefix = folder.isEmpty ? "" : folder + "/"
        return records.keys.contains { $0 != folder && $0.hasPrefix(prefix) }
    }

    /// Something inside is unchecked (drawn as "mixed").
    public func isMixed(_ folder: String) -> Bool { records[folder]?.mixed == true || containsSkip(folder) }

    // MARK: Changes

    /// The person's answers. Deciding a folder decides everything inside it (every own decision
    /// beneath goes). Resolved pending items go.
    public mutating func apply(_ inputs: [SyncDecisionInput]) {
        for i in inputs where !i.path.isEmpty {
            pending.removeValue(forKey: i.path)
            guard let d = i.decision else {
                records.removeValue(forKey: i.path)
                continue
            }
            if i.kind == .folder {
                let prefix = i.path + "/"
                for k in records.keys where k.hasPrefix(prefix) { records.removeValue(forKey: k) }
                for k in pending.keys where k.hasPrefix(prefix) { pending.removeValue(forKey: k) }
            }
            records[i.path] = SyncRecord(kind: i.kind, decision: d, source: .you)
        }
        prunePending()
    }

    /// Drops pending items that were decided (their own decision, or an unchecked folder above them).
    public mutating func prunePending() {
        for k in Array(pending.keys) {
            if records[k] != nil { pending.removeValue(forKey: k); continue }
            var cur = k
            while let slash = cur.lastIndex(of: "/") {
                cur = String(cur[..<slash])
                if records[cur]?.decision == .skip { pending.removeValue(forKey: k); break }
            }
        }
    }
}

/// Rows of the Sync tab (protocol `SyncEntry`): the children of one folder with their decisions.
public enum SyncEntries {
    /// Folder sizes are measured up to this many entries (huge skipped folders stay cheap).
    public static let measureLimit = 100_000

    public static func list(root: URL, dir: String, selection: SyncSelection, known: Set<String> = []) -> [SyncEntry] {
        let established = SelectionScanner.establishedFolders(known)
        let url = dir.isEmpty ? root : root.appendingPathComponent(dir, isDirectory: true)
        guard LocalEntry.stat(url) == .directory, let names = try? FileManager.default.contentsOfDirectory(atPath: url.path) else { return [] }
        var folders: [SyncEntry] = [], files: [SyncEntry] = []
        for name in names.sorted(by: { $0.localizedStandardCompare($1) == .orderedAscending }) {
            let path = dir.isEmpty ? name : dir + "/" + name
            let child = url.appendingPathComponent(name)
            switch LocalEntry.stat(child) {
            case .directory:
                let (n, bytes) = measure(child)
                if name == ".git" {
                    folders.append(SyncEntry(path: path, kind: .folder, decision: nil, effective: .skip, mixed: false, source: .rule,
                                             reason: SyncRules.gitReason, bytes: bytes, files: n))
                    continue
                }
                let own = selection.records[path]
                let eff = selection.effective(path, kind: .folder, established: established)
                folders.append(SyncEntry(path: path, kind: .folder, decision: own?.decision, effective: eff.decision,
                                         mixed: selection.isMixed(path), source: own?.source, reason: own?.reason, bytes: bytes, files: n))
            case .file(let size, _, _):
                let own = selection.records[path]
                var eff = selection.effective(path, kind: .file, size: size, established: established)
                if eff.decision == nil && !eff.large && known.contains(path) { eff.decision = .sync }
                files.append(SyncEntry(path: path, kind: .file, decision: own?.decision, effective: eff.decision, mixed: nil,
                                       source: own?.source, reason: own?.reason ?? (eff.large && eff.decision == nil ? eff.reason : nil),
                                       bytes: size, files: nil))
            default:
                continue
            }
        }
        return folders + files
    }

    static func measure(_ url: URL) -> (Int, Int64) {
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey], options: []) else { return (0, 0) }
        var n = 0, bytes: Int64 = 0, seen = 0
        for case let u as URL in e {
            seen += 1
            if seen > measureLimit { break }
            guard let v = try? u.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]), v.isRegularFile == true else { continue }
            n += 1
            bytes += Int64(v.fileSize ?? 0)
        }
        return (n, bytes)
    }
}
