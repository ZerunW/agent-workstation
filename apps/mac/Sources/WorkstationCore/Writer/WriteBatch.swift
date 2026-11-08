import Foundation

/// One approved change to a linked folder on this Mac. Built only from an explicit approval
/// ("Apply selected to Mac" / "Apply all") and executed only by the writer.
public struct WriteItem: Codable, Equatable, Sendable {
    public enum Op: String, Codable, Sendable { case write, delete }

    /// Path relative to the batch root (`src/a.c`).
    public var path: String
    public var op: Op
    /// sha256 the local file must have right now: the last-synced version, whose content is in
    /// the server's git history (nil = the file must not exist). The writer refuses the item
    /// otherwise, so un-synced local edits are never overwritten or deleted.
    public var expectedHash: String?
    /// write: sha256 of `contentBase64`.
    public var hash: String?
    public var contentBase64: String?
    /// write: POSIX permission bits (nil = keep the existing file's, 0644 for new files).
    public var mode: Int?
    /// Set when the local version was backed up on the server first: the git blob id the server
    /// confirmed. The writer checks that the file it replaces is exactly those bytes.
    public var backedUpBlob: String?
    /// write, large files (> MAX_SYNC_FILE_BYTES): an absolute path to the verified content in the
    /// app's own store, used instead of `contentBase64` (never loaded into memory). Its sha256 must be `hash`.
    public var sourcePath: String?

    public init(path: String, op: Op, expectedHash: String?, hash: String? = nil, contentBase64: String? = nil, mode: Int? = nil) {
        self.path = path; self.op = op; self.expectedHash = expectedHash; self.hash = hash; self.contentBase64 = contentBase64; self.mode = mode
    }

    public static func write(_ path: String, data: Data, expected: String?, mode: Int? = nil) -> WriteItem {
        WriteItem(path: path, op: .write, expectedHash: expected, hash: FileHasher.sha256(data), contentBase64: data.base64EncodedString(), mode: mode)
    }

    /// A write whose content is a file (a large server version, streamed to disk and hash-checked).
    public static func write(_ path: String, file: URL, hash: String, expected: String?, mode: Int? = nil) -> WriteItem {
        var item = WriteItem(path: path, op: .write, expectedHash: expected, hash: hash, mode: mode)
        item.sourcePath = file.path
        return item
    }

    public static func delete(_ path: String, expected: String?) -> WriteItem {
        WriteItem(path: path, op: .delete, expectedHash: expected)
    }
}

/// An approved batch for one linked folder.
public struct WriteBatch: Codable, Equatable, Sendable {
    public var id: String
    /// Absolute path of the linked folder (for a single-file link: its parent folder).
    public var root: String
    public var items: [WriteItem]

    public init(id: String = UUID().uuidString.lowercased(), root: String, items: [WriteItem]) {
        self.id = id; self.root = root; self.items = items
    }
}

public struct WriteRefusal: Codable, Equatable, Sendable {
    public var path: String
    public var reason: String
    public init(path: String, reason: String) { self.path = path; self.reason = reason }
}

public struct WriteBatchResult: Codable, Equatable, Sendable {
    public var applied: [String]
    public var refused: [WriteRefusal]
    public init(applied: [String] = [], refused: [WriteRefusal] = []) {
        self.applied = applied; self.refused = refused
    }
}

/// Executes approved batches. This is the only code that creates, modifies or deletes files in
/// linked folders; in the app bundle it runs in the WorkstationWriter XPC service.
///
/// Per item: the path must be relative, inside the root, without `..`, `.git` or symlinked
/// components; the file on disk must still be what the person reviewed (`expectedHash`); the
/// content must match its hash. No local copies are kept: an item is only accepted when the
/// file on disk equals the last-synced version (`expectedHash`), whose content the server's git
/// history already holds. Writes are atomic (temp file + rename in the same directory);
/// deletions go to the Trash and are refused if the Trash is unavailable: never a hard delete.
public enum WriteBatchExecutor {
    public enum DeleteMode: Sendable {
        /// `FileManager.trashItem` (in-process writer).
        case trash
        /// Move into this Trash folder by `rename` (the sandboxed writer: the Trash is the only
        /// place outside the linked folder its profile lets it write).
        case trashDirectory(URL)
        /// No Trash available: deletions are refused.
        case refuse
        case removeForTests
    }

    public static func execute(_ batch: WriteBatch, deleteMode: DeleteMode = .trash) -> WriteBatchResult {
        var result = WriteBatchResult()
        let checked = validateRoot(batch.root)
        guard let root = checked.url else {
            result.refused = batch.items.map { WriteRefusal(path: $0.path, reason: checked.problem ?? "invalid folder") }
            return result
        }
        var seen = Set<String>()
        for item in batch.items {
            guard seen.insert(item.path).inserted else {
                result.refused.append(WriteRefusal(path: item.path, reason: "listed twice in one batch"))
                continue
            }
            if let reason = validate(item, root: root) {
                result.refused.append(WriteRefusal(path: item.path, reason: reason))
                continue
            }
            do {
                try perform(item, root: root, deleteMode: deleteMode)
                result.applied.append(item.path)
            } catch {
                result.refused.append(WriteRefusal(path: item.path, reason: error.localizedDescription))
            }
        }
        return result
    }

    /// The root must be an absolute path to an existing directory that is not itself a symlink.
    public static func validateRoot(_ path: String) -> (url: URL?, problem: String?) {
        guard path.hasPrefix("/") else { return (nil, "the linked folder path is not absolute") }
        let url = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
        switch LocalEntry.stat(url) {
        case .directory: break
        case .symlink: return (nil, "the linked folder is a symbolic link")
        case .absent: return (nil, "the linked folder no longer exists")
        default: return (nil, "the linked folder is not a folder")
        }
        return (URL(fileURLWithPath: realPath(url.path), isDirectory: true), nil)
    }

    /// nil = OK, else why the item is refused.
    public static func validate(_ item: WriteItem, root: URL) -> String? {
        let p = item.path
        guard !p.isEmpty, !p.hasPrefix("/"), !p.contains("\0") else { return "not a relative path" }
        let comps = p.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !comps.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return "path leaves the linked folder" }
        guard !IgnoreMatcher.isAlwaysExcluded(p) else { return "inside .git" }
        // Every existing component below the root must be a real directory (no symlink escapes).
        var dir = root
        for c in comps.dropLast() {
            dir = dir.appendingPathComponent(c, isDirectory: true)
            switch LocalEntry.stat(dir) {
            case .directory: continue
            case .absent: break
            case .symlink: return "a folder in the path is a symbolic link"
            default: return "a file is in the way of the path"
            }
            if case .absent = LocalEntry.stat(dir) { break }
        }
        let target = root.appendingPathComponent(p)
        let current: String?
        switch LocalEntry.stat(target) {
        case .file where CloudProbe.system.isDataless(target):
            // Never read a cloud-only placeholder (reading fetches it first).
            return "only in the cloud: keep it downloaded first"
        case .file:
            guard let h = try? FileHasher.sha256(fileAt: target) else { return "the file can't be read" }
            current = h
        case .absent: current = nil
        case .symlink: return "the file is a symbolic link"
        case .directory: return "a folder exists at this path"
        case .other: return "not a regular file"
        }
        // Belt and braces: the deepest existing ancestor resolves inside the root.
        var probe = target.deletingLastPathComponent()
        while case .absent = LocalEntry.stat(probe), probe.path.count > root.path.count { probe.deleteLastPathComponent() }
        let real = realPath(probe.path)
        guard real == root.path || real.hasPrefix(root.path + "/") else { return "path leaves the linked folder" }

        if let blob = item.backedUpBlob {
            guard (try? FileHasher.gitBlobOid(fileAt: target)) == blob else {
                return "the file is not the version that was backed up on the server"
            }
        }
        guard current == item.expectedHash else {
            return current == nil ? "the file was removed on this Mac and that is not on the server yet"
                                  : "the file has changes on this Mac that are not on the server yet"
        }
        switch item.op {
        case .write:
            if let src = item.sourcePath, item.contentBase64 == nil {
                guard src.hasPrefix("/"), case .file = LocalEntry.stat(URL(fileURLWithPath: src)) else { return "no content" }
                guard let h = item.hash, (try? FileHasher.sha256(fileAt: URL(fileURLWithPath: src))) == h else { return "content does not match its hash" }
            } else {
                guard let b64 = item.contentBase64, let data = Data(base64Encoded: b64) else { return "no content" }
                guard let h = item.hash, FileHasher.sha256(data) == h else { return "content does not match its hash" }
            }
        case .delete:
            break
        }
        return nil
    }

    static func perform(_ item: WriteItem, root: URL, deleteMode: DeleteMode) throws {
        let fm = FileManager.default
        let target = root.appendingPathComponent(item.path)
        switch item.op {
        case .write:
            var mode = item.mode
            if mode == nil, case .file(_, let m, _) = LocalEntry.stat(target) { mode = m }
            let dir = target.deletingLastPathComponent()
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let tmp = dir.appendingPathComponent(".workstation-write-\(UUID().uuidString.prefix(8))")
            if let src = item.sourcePath, item.contentBase64 == nil {
                // Large file: copied from the verified store copy, never read into memory.
                do {
                    try fm.copyItem(at: URL(fileURLWithPath: src), to: tmp)
                    try fm.setAttributes([.posixPermissions: NSNumber(value: mode ?? 0o644)], ofItemAtPath: tmp.path)
                } catch {
                    try? fm.removeItem(at: tmp)
                    throw HubError.blocked("couldn't write \(item.path)")
                }
                guard (try? FileHasher.sha256(fileAt: tmp)) == item.hash else {
                    try? fm.removeItem(at: tmp)
                    throw HubError.blocked("\(item.path) changed while it was being copied")
                }
            } else {
                let data = Data(base64Encoded: item.contentBase64 ?? "") ?? Data()
                guard fm.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: NSNumber(value: mode ?? 0o644)]) else {
                    throw HubError.blocked("couldn't write \(item.path)")
                }
            }
            guard rename(tmp.path, target.path) == 0 else {
                let err = String(cString: strerror(errno))
                try? fm.removeItem(at: tmp)
                throw HubError.blocked("couldn't replace \(item.path): \(err)")
            }
        case .delete:
            guard case .file = LocalEntry.stat(target) else { return }   // already gone: nothing to do
            switch deleteMode {
            case .trash: try fm.trashItem(at: target, resultingItemURL: nil)
            case .trashDirectory(let trash): try moveToTrash(target, trash)
            case .refuse: throw HubError.blocked("there is no Trash for this folder's volume, so \(item.path) was not deleted")
            case .removeForTests: try fm.removeItem(at: target)
            }
        }
    }

    /// `rename` into the Trash folder under a free name ("a.txt", "a 2.txt", …), like Finder.
    static func moveToTrash(_ file: URL, _ trash: URL) throws {
        let name = file.lastPathComponent
        let ext = (name as NSString).pathExtension
        let stem = ext.isEmpty ? name : String(name.dropLast(ext.count + 1))
        var dest = trash.appendingPathComponent(name)
        var n = 2
        while LocalEntry.stat(dest) != .absent {
            dest = trash.appendingPathComponent(ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)")
            n += 1
        }
        guard rename(file.path, dest.path) == 0 else {
            throw HubError.blocked("couldn't move \(name) to the Trash: \(String(cString: strerror(errno)))")
        }
    }

    public static func realPath(_ p: String) -> String {
        guard let r = realpath(p, nil) else { return p }
        defer { free(r) }
        return String(cString: r)
    }
}

/// Where approved batches are executed. The app uses `XPCWriter` (the WorkstationWriter service)
/// when the service is bundled; tests and unbundled runs use `InProcessWriter`.
public protocol LocalWriting: Sendable {
    func apply(_ batch: WriteBatch) async throws -> WriteBatchResult
}

public struct InProcessWriter: LocalWriting {
    public var deleteMode: WriteBatchExecutor.DeleteMode
    public init(deleteMode: WriteBatchExecutor.DeleteMode = .trash) { self.deleteMode = deleteMode }
    public func apply(_ batch: WriteBatch) async throws -> WriteBatchResult {
        let mode = deleteMode
        return try await offloadBlocking { WriteBatchExecutor.execute(batch, deleteMode: mode) }
    }
}

/// XPC interface of the WorkstationWriter service (Contents/XPCServices/WorkstationWriter.xpc).
@objc public protocol WorkstationWriterXPC {
    /// `batch` = JSON `WriteBatch`; replies with JSON `WriteBatchResult`.
    func apply(_ batch: Data, withReply reply: @escaping (Data) -> Void)
}

/// Sends approved batches to the WorkstationWriter XPC service.
public final class XPCWriter: LocalWriting, @unchecked Sendable {
    public static let serviceName = "io.github.agentworkstation.writer"

    /// true inside a AgentWorkstation.app that embeds the service.
    public static var isBundled: Bool {
        FileManager.default.fileExists(atPath: Bundle.main.bundleURL.appendingPathComponent("Contents/XPCServices/WorkstationWriter.xpc").path)
    }

    public init() {}

    public func apply(_ batch: WriteBatch) async throws -> WriteBatchResult {
        let payload = try JSONEncoder().encode(batch)
        let conn = NSXPCConnection(serviceName: Self.serviceName)
        conn.remoteObjectInterface = NSXPCInterface(with: WorkstationWriterXPC.self)
        conn.resume()
        defer { conn.invalidate() }
        let once = Once()
        return try await withCheckedThrowingContinuation { cont in
            let proxy = conn.remoteObjectProxyWithErrorHandler { error in
                if once.claim() { cont.resume(throwing: error) }
            } as? WorkstationWriterXPC
            guard let proxy else {
                if once.claim() { cont.resume(throwing: HubError.blocked("the writer service is unavailable")) }
                return
            }
            proxy.apply(payload) { reply in
                guard once.claim() else { return }
                if let r = try? JSONDecoder().decode(WriteBatchResult.self, from: reply) { cont.resume(returning: r) }
                else { cont.resume(throwing: HubError.decoding("writer reply")) }
            }
        }
    }

    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false
        func claim() -> Bool { lock.withLock { if done { return false }; done = true; return true } }
    }
}
