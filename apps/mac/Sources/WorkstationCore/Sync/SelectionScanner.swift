import Foundation

/// What a linked folder holds under its sync selection.
public struct SelectionScan: Sendable {
    /// Synced (or syncing on their own), ≤ MAX_SYNC_FILE_BYTES.
    public var files: [ScannedFile] = []
    /// Synced large files (> MAX_SYNC_FILE_BYTES, chunked uploads).
    public var large: [LargeFile] = []
    /// Topmost paths waiting for the person (new items in a folder with something unchecked, large files).
    public var undecided: [SyncPendingItem] = []
    public var skipped: [SkippedFile] = []
    /// Would sync, but only in the cloud and never synced: not uploaded until it is local.
    public var cloudOnly: [String] = []
    /// Synced already, then evicted by the provider: kept as the known version (not a change).
    public var evicted: [String] = []

    public var manifest: [ManifestEntry] { files.map(\.manifestEntry) + large.map(\.manifestEntry) }
    public var hashes: [String: String] { Dictionary(files.map { ($0.path, $0.hash) }, uniquingKeysWith: { a, _ in a }) }
    public var largeHashes: [String: String] { Dictionary(large.map { ($0.path, $0.sha256) }, uniquingKeysWith: { a, _ in a }) }
    public var totalBytes: Int64 { files.reduce(0) { $0 + $1.size } + large.reduce(0) { $0 + $1.size } }
}

/// Walks a linked folder with its selection: hashes what syncs, lists what waits. `.git` is never
/// entered; symlinks are never followed; cloud-only files are never read.
public enum SelectionScanner {
    /// - Parameters:
    ///   - knownHashes: the synced version of each path (synced files keep syncing; a cloud-only
    ///     one keeps its known version, unread).
    ///   - start: a subfolder or file to scan ("" = everything).
    public static func scan(root: URL, selection: SyncSelection, knownHashes: [String: String] = [:], cache: HashCache? = nil,
                            start: String = "", probe: CloudProbe? = nil) -> SelectionScan {
        let probe = probe ?? cache?.probe ?? .system
        var out = SelectionScan()
        let established = establishedFolders(knownHashes.keys)
        var waitingFiles: [(path: String, size: Int64, large: Bool)] = []

        func underPending(_ path: String) -> Bool {
            if selection.pending[path] != nil { return true }
            var cur = path
            while let i = cur.lastIndex(of: "/") {
                cur = String(cur[..<i])
                if selection.pending[cur] != nil { return true }
            }
            return false
        }

        func visit(_ path: String, url: URL) {
            let name = url.lastPathComponent
            let entry = LocalEntry.stat(url)
            var size: Int64 = 0, mode = 0o644, mtime: TimeInterval = 0
            switch entry {
            case let .file(s, m, t): size = s; mode = m; mtime = t
            case .directory: if name == ".git" { return }
            case .symlink:
                if selection.effective(path, kind: .file, established: established).decision != .skip {
                    out.skipped.append(SkippedFile(path: path, reason: .symlink))
                }
                return
            default: return
            }
            let isDir = entry == .directory
            var eff = selection.effective(path, kind: isDir ? .folder : .file, size: isDir ? nil : size, established: established)
            if eff.decision == .skip { return }
            if !isDir && eff.decision == nil && !eff.large && knownHashes[path] != nil {
                // Synced already: edits keep syncing.
                eff = EffectiveDecision(decision: .sync, source: nil, reason: nil, inherited: true, large: false)
            }
            if selection.records[path] == nil && underPending(path) {
                eff = .waiting   // a pending item holds everything inside it
            }
            if isDir {
                walk(path, url: url)
                return
            }
            guard eff.decision == .sync else {
                waitingFiles.append((path, size, eff.large))
                return
            }
            // Cloud-only: never read. Synced before → its known version stands; new → waits until local.
            if probe.isDataless(url) {
                if let k = knownHashes[path] {
                    out.evicted.append(path)
                    if size > SyncSelection.largeFileBytes { out.large.append(LargeFile(path: path, sha256: k, size: size, mode: mode)) }
                    else { out.files.append(ScannedFile(path: path, size: size, mode: mode, hash: k)) }
                } else {
                    out.cloudOnly.append(path)
                }
                return
            }
            do {
                let hash = try cache?.hash(path: path, url: url, size: size, mtime: mtime) ?? FileHasher.sha256(fileAt: url)
                if size > SyncSelection.largeFileBytes {
                    out.large.append(LargeFile(path: path, sha256: hash, size: size, mode: mode))
                } else {
                    out.files.append(ScannedFile(path: path, size: size, mode: mode, hash: hash))
                }
            } catch {
                out.skipped.append(SkippedFile(path: path, reason: .unreadable(error.localizedDescription)))
            }
        }

        func walk(_ dirPath: String, url: URL) {
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: url.path) else { return }
            for name in names.sorted() {
                visit(dirPath.isEmpty ? name : dirPath + "/" + name, url: url.appendingPathComponent(name))
            }
        }

        if start.isEmpty { walk("", url: root) } else { visit(start, url: root.appendingPathComponent(start)) }
        out.undecided = topmost(waitingFiles, selection: selection, established: established)
        out.files.sort { $0.path.utf8.lexicographicallyPrecedes($1.path.utf8) }
        out.large.sort { $0.path < $1.path }
        return out
    }

    /// Folders holding synced files: they existed and are part of the server copy.
    static func establishedFolders<S: Sequence>(_ known: S) -> Set<String> where S.Element == String {
        var out: Set<String> = []
        for p in known {
            var cur = p
            while let i = cur.lastIndex(of: "/") { cur = String(cur[..<i]); if !out.insert(cur).inserted { break } }
        }
        return out
    }

    /// Groups waiting files into the topmost waiting items: a new folder that waits stands for
    /// everything inside it; a large file is an item of its own; the root never is one.
    static func topmost(_ files: [(path: String, size: Int64, large: Bool)], selection: SyncSelection,
                        established: Set<String>) -> [SyncPendingItem] {
        var openFolder: [String: Bool] = [:]
        func isOpen(_ folder: String) -> Bool {
            if let v = openFolder[folder] { return v }
            let v = selection.pending[folder] != nil
                || (selection.records[folder] == nil && !established.contains(folder)
                    && selection.effective(folder, kind: .folder, established: established).decision == nil)
            openFolder[folder] = v
            return v
        }
        var items: [String: SyncPendingItem] = [:]
        for f in files {
            var item = f.path
            var kind = SyncKind.file
            if !f.large || selection.pending[f.path] == nil {
                var cur = f.path
                while let i = cur.lastIndex(of: "/") {
                    cur = String(cur[..<i])
                    guard isOpen(cur) else { if f.large { break } else { continue } }
                    item = cur
                    kind = .folder
                }
                if f.large && kind == .folder && selection.pending[item] == nil && !isOpen(item) { item = f.path; kind = .file }
            }
            if var existing = items[item] {
                existing.bytes += f.size
                existing.files = (existing.files ?? 0) + 1
                items[item] = existing
            } else {
                items[item] = SyncPendingItem(path: item, kind: kind, bytes: f.size, files: kind == .folder ? 1 : nil,
                                              reason: f.large && kind == .file ? SyncSelection.largeReason(f.size) : nil,
                                              large: f.large && kind == .file ? true : nil)
            }
        }
        return items.values.sorted { $0.path < $1.path }
    }
}

/// Selections built without the selection window.
public enum SelectionDefaults {
    public static let excludedBeforeReason = "Excluded before"

    /// - known non-empty (a link from before sync selection, migrated once): what the old ignore
    ///   list left out (defaults + .gitignore + `extraIgnore`) stays out (`skip`); every top-level
    ///   folder holding synced files and each synced root file are decided `sync`.
    /// - known empty (an engine started without a window, e.g. tests): nothing unchecked.
    public static func selection(root: URL, extraIgnore: [String], known: [String: String]) -> SyncSelection {
        var sel = SyncSelection()
        guard !known.isEmpty else { return sel }
        let top = SyncTreeScanner.scan(root: root)
        let old = LocalScanner.scan(root: root, extraPatterns: extraIgnore, hashContents: false, stop: { false }).matcher
        func visit(_ n: SyncTreeNode) {
            for c in n.children where c.kind != .symlink && !c.isGit {
                if old.matchSelf(c.path, isDirectory: c.isFolder) == true {
                    if !known.keys.contains(where: { $0 == c.path || $0.hasPrefix(c.path + "/") }) {
                        sel.records[c.path] = SyncRecord(kind: c.isFolder ? .folder : .file, decision: .skip, source: .rule, reason: excludedBeforeReason)
                    }
                } else if c.isFolder && c.descended {
                    visit(c)
                }
            }
        }
        visit(top)
        for p in known.keys {
            if let slash = p.firstIndex(of: "/") {
                sel.records[String(p[..<slash])] = SyncRecord(kind: .folder, decision: .sync, source: .you)
            } else {
                sel.records[p] = SyncRecord(kind: .file, decision: .sync, source: .you)
            }
        }
        return sel
    }
}
