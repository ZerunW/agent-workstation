import Foundation
import WorkstationCore

/// The window shown before a folder is linked, on every way of linking it: the folder's first
/// level, and under each first-level folder at most three of its items (the rest as "+N more").
/// Everything starts checked; the person unchecks what should stay on this Mac.
@MainActor
public final class LinkSelectionModel: ObservableObject {
    public enum CheckState: Equatable { case checked, mixed, unchecked }

    /// Items shown under each first-level folder.
    public static let childrenShown = 3

    public let root: SyncTreeNode
    public let folderName: String
    /// The folder on disk (for re-checking cloud-only files and Show in Finder).
    public var folderURL: URL?
    /// Where the folder's cloud-only files live (the hint names its Finder command).
    public var provider: CloudProvider = .generic
    /// Unchecked rows (first level and the shown second level).
    @Published public private(set) var unchecked: Set<String> = []
    private var cloudWatch: Task<Void, Never>?

    public init(root: SyncTreeNode, folderName: String) {
        self.root = root
        self.folderName = folderName
    }

    /// One visible row.
    public struct Row: Identifiable, Equatable {
        public enum Kind { case item(SyncTreeNode), more(Int) }
        public let id: String
        public let depth: Int
        public let kind: Kind
        public var node: SyncTreeNode? { if case .item(let n) = kind { return n }; return nil }
        public static func == (a: Row, b: Row) -> Bool { a.id == b.id && a.depth == b.depth }
    }

    static func visible(_ n: SyncTreeNode) -> [SyncTreeNode] {
        (n.folders + n.files + n.symlinks).filter { !$0.isGit && $0.kind != .symlink }
    }

    /// The window's rows: every first-level item; under each first-level folder its first three
    /// items and a "+N more" line for the rest.
    public var rows: [Row] {
        var out: [Row] = []
        for top in Self.visible(root) {
            out.append(Row(id: top.path, depth: 0, kind: .item(top)))
            guard top.isFolder else { continue }
            let kids = Self.visible(top)
            for k in kids.prefix(Self.childrenShown) { out.append(Row(id: k.path, depth: 1, kind: .item(k))) }
            if kids.count > Self.childrenShown { out.append(Row(id: top.path + "/+more", depth: 1, kind: .more(kids.count - Self.childrenShown))) }
        }
        return out
    }

    /// The rows the person can decide.
    var shown: [SyncTreeNode] { rows.compactMap(\.node) }

    public func state(_ path: String) -> CheckState {
        if unchecked.contains(path) { return .unchecked }
        if let p = parent(path), unchecked.contains(p) { return .unchecked }
        guard let n = root.node(at: path), n.isFolder else { return .checked }
        return Self.visible(n).prefix(Self.childrenShown).contains { unchecked.contains($0.path) } ? .mixed : .checked
    }

    func parent(_ path: String) -> String? { path.lastIndex(of: "/").map { String(path[..<$0]) } }

    /// A click: a first-level folder and its shown items follow it; checking an item inside an
    /// unchecked folder checks the folder again (its other items stay as they were).
    public func toggle(_ path: String) {
        let on = state(path) != .checked
        if on {
            unchecked.remove(path)
            if let p = parent(path), unchecked.contains(p) {
                // The folder comes back; its other shown items stay unchecked, as they looked.
                unchecked.remove(p)
                if let pn = root.node(at: p) {
                    for k in Self.visible(pn).prefix(Self.childrenShown) where k.path != path { unchecked.insert(k.path) }
                }
            }
            if let n = root.node(at: path), n.isFolder, path.firstIndex(of: "/") == nil {
                for k in Self.visible(n).prefix(Self.childrenShown) { unchecked.remove(k.path) }
            }
        } else {
            unchecked.insert(path)
        }
    }

    // MARK: Totals and cloud-only files

    /// A file goes up with "Link and Upload": nothing above it unchecked, not `.git`, and a large
    /// file only when it is one of the rows (its own check).
    func uploads(_ n: SyncTreeNode) -> Bool {
        guard n.kind == .file else { return false }
        var cur: String? = n.path
        while let c = cur {
            if unchecked.contains(c) { return false }
            cur = parent(c)
        }
        if n.size > SyncSelection.largeFileBytes { return shown.contains { $0 === n } }
        return true
    }

    public struct Totals: Equatable { public var files = 0; public var bytes: Int64 = 0 }

    public var totals: Totals {
        var t = Totals()
        for n in root.descendants() where uploads(n) { t.files += 1; t.bytes += n.size }
        return t
    }

    /// Files that would upload but are only in the cloud: the upload waits while any remain.
    public var cloudOnlyUploading: [String] {
        root.descendants().filter { $0.cloudOnly && uploads($0) }.map(\.path).sorted()
    }

    /// Re-reads the flags of the files that were cloud-only (metadata only). True = something changed.
    @discardableResult
    public func recheckCloud(_ probe: CloudProbe) -> Bool {
        guard let folderURL else { return false }
        var changed = false
        for n in root.descendants() where n.kind == .file && n.cloudOnly {
            if !probe.isDataless(folderURL.appendingPathComponent(n.path)) { n.cloudOnly = false; changed = true }
        }
        if changed { objectWillChange.send() }
        return changed
    }

    /// While files that would upload are only in the cloud, re-checks their flags every `interval`
    /// seconds (metadata only) until none remain.
    public func watchCloud(_ probe: CloudProbe, interval: TimeInterval) {
        cloudWatch?.cancel()
        guard !cloudOnlyUploading.isEmpty else { return }
        cloudWatch = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                guard let self, !Task.isCancelled, !self.cloudOnlyUploading.isEmpty else { return }
                self.recheckCloud(probe)
            }
        }
    }

    public func stopCloudWatch() { cloudWatch?.cancel(); cloudWatch = nil }

    // MARK: Decisions

    /// Every row the person saw gets its own decision: checked → `sync`, unchecked → `skip` (an
    /// unchecked first-level folder: only the folder). Items not shown follow the rule for new
    /// items (they sync when nothing in their folder is unchecked, else they wait).
    public func records() -> [String: SyncRecord] {
        var out: [String: SyncRecord] = [:]
        for n in shown {
            let kind: SyncKind = n.isFolder ? .folder : .file
            if let p = parent(n.path), unchecked.contains(p) { continue }
            out[n.path] = SyncRecord(kind: kind, decision: unchecked.contains(n.path) ? .skip : .sync, source: .you)
        }
        return out
    }
}
