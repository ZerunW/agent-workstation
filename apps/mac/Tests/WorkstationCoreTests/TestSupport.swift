import Foundation
@testable import WorkstationCore

/// Temporary directory removed when the value is deinitialised.
final class TempDir {
    let url: URL

    init(_ name: String = "workstation-test") {
        url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: url) }

    @discardableResult
    func write(_ rel: String, _ text: String) -> URL {
        let u = url.appendingPathComponent(rel)
        try! FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! Data(text.utf8).write(to: u)
        return u
    }

    func read(_ rel: String) -> String? {
        (try? Data(contentsOf: url.appendingPathComponent(rel))).map { String(decoding: $0, as: UTF8.self) }
    }

    func exists(_ rel: String) -> Bool { FileManager.default.fileExists(atPath: url.appendingPathComponent(rel).path) }
}

/// The fixture project used by scanner / manifest / engine tests.
///
///     README.md, src/a.js, src/nested/b.ts, src/dup1.txt, src/dup2.txt (same bytes),
///     keep.log (re-included by `!keep.log`), plus ignored: .git/, node_modules/, build/,
///     debug.log (*.log), secret/ (dir-only rule), .DS_Store, and a symlink.
func makeFixtureTree() -> TempDir {
    let t = TempDir("workstation-tree")
    t.write("README.md", "hello\n")
    t.write("src/a.js", "console.log(1)\n")
    t.write("src/nested/b.ts", "export {}\n")
    t.write("src/dup1.txt", "SAME")
    t.write("src/dup2.txt", "SAME")
    t.write(".gitignore", "*.log\n!keep.log\nsecret/\n")
    t.write("debug.log", "l")
    t.write("keep.log", "k")
    t.write("secret/key.txt", "s")
    t.write(".git/HEAD", "ref: refs/heads/main\n")
    t.write("node_modules/pkg/index.js", "x")
    t.write("build/out.o", "bin")
    t.write(".DS_Store", "junk")
    try! FileManager.default.createSymbolicLink(atPath: t.url.appendingPathComponent("link-to-readme").path, withDestinationPath: "README.md")
    return t
}

/// Records calls; answers like a minimal hub: `local` branch (path → hash) with per-commit
/// versions for `raw?ref=`, Claude's working tree, conflict injection, accept-all, backups.
final class FakeTransport: SyncTransport, @unchecked Sendable {
    private let lock = NSLock()
    var local: [String: String] = [:]          // hub `local` branch: path → hash
    var blobs: [String: Data] = [:]            // sha256 → bytes the hub has seen
    var commits: [String: [String: String]] = [:]   // commit → local map at that commit
    var worktree: [String: Data] = [:]         // Claude's working tree (for raw / accept)
    var conflictPaths: Set<String> = []         // paths that conflict unless forced
    var baselineCalls: [(BaselineEncoding, [String])] = []
    var manifestCalls = 0
    var pushes: [[SyncOp]] = []
    var failNextPush = false
    var pushHTTPStatus: Int? = nil              // e.g. 507 disk_block
    var baselineStatus: Int? = nil              // e.g. 404 to simulate missing endpoint
    var baselineDrops: Set<String> = []        // members the server's import loses
    var backupStatus: Int? = nil                // e.g. 404: the hub has no backups endpoint yet
    var backupBlobOverride: String? = nil       // a wrong blob id in the backup answer
    var backupRequests: [ProjectBackupBody] = []
    var storedBackups: [ProjectBackup] = []
    var rawRequests: [(String, String?)] = []
    /// Large files: complete ones (path → sha256), partial uploads, every chunk request.
    var large: [String: String] = [:]
    var partial: [String: Data] = [:]
    var chunkCalls: [(path: String, offset: Int64, bytes: Int)] = []
    /// Drop the partial upload of this path after N chunks (simulates a lost connection / restart).
    var dropPartialAfterChunks: [String: Int] = [:]
    var failChunkAt: Int64? = nil
    /// Every completed large write: (path, baseHash, force).
    var largeWrites: [(path: String, baseHash: String?, force: Bool)] = []
    /// Large files Claude changed on the server (accept / pull back hands them out as large entries).
    var largeWorktree: [String: Data] = [:]
    var chunkDelayNanos: UInt64 = 0
    /// Exclude lists received, and every baseline / exclude / push call in order.
    var excludeCalls: [[ExcludedPath]] = []
    var events: [String] = []
    var excludesStatus: Int? = nil              // e.g. 404 (an older hub)
    var failExcludes = 0                        // the next N sends fail (offline)
    private var commitSeq = 0

    func with<T>(_ f: (FakeTransport) -> T) -> T { lock.withLock { f(self) } }

    private func commitLocked() -> String {
        commitSeq += 1
        let c = "c\(commitSeq)"
        commits[c] = local
        return c
    }

    func uploadBaseline(projectId: String, archive: URL, encoding: BaselineEncoding) async throws {
        if let s = baselineStatus { throw HubError.http(status: s, message: "nope", code: nil) }
        let members = (try? BaselineArchiver.list(archive)) ?? []
        // Unpack like the hub so `local` really has the files.
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fake-baseline-\(UUID().uuidString.prefix(6))")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        var env = ["PATH": "/usr/bin:/bin"]
        if let z = BaselineArchiver.findZstd() { env["PATH"] = (z as NSString).deletingLastPathComponent + ":/usr/bin:/bin" }
        _ = try? ProcessRunner.run("/usr/bin/tar", ["-x", "-f", archive.path, "-C", dir.path], environment: env)
        let files = SyncTreeScanner.scan(root: dir).descendants().filter { $0.kind == .file }.map(\.path)
        lock.withLock {
            events.append("baseline")
            baselineCalls.append((encoding, members))
            for path in files where !baselineDrops.contains(path) {
                let f = (path: path, hash: FileHasher.sha256((try? Data(contentsOf: dir.appendingPathComponent(path))) ?? Data()))
                let d = (try? Data(contentsOf: dir.appendingPathComponent(f.path))) ?? Data()
                local[f.path] = f.hash
                blobs[f.hash] = d
                worktree[f.path] = d
            }
            _ = commitLocked()
        }
    }

    func setLocal(_ map: [String: String]) { lock.withLock { local = map } }

    /// What an accept on the server does to one file (the web page or another device).
    func acceptOnServer(_ path: String, _ data: Data?) {
        lock.withLock {
            if let data {
                let h = FileHasher.sha256(data)
                local[path] = h; blobs[h] = data; worktree[path] = data
            } else {
                local.removeValue(forKey: path); worktree.removeValue(forKey: path)
            }
            _ = commitLocked()
        }
    }

    func manifest(projectId: String, entries: [ManifestEntry]) async throws -> ManifestResponse {
        lock.withLock { manifestLocked(entries) }
    }

    private func manifestLocked(_ entries: [ManifestEntry]) -> ManifestResponse {
        manifestCalls += 1
        let mine = Dictionary(uniqueKeysWithValues: entries.map { ($0.path, $0.hash) })
        let need = entries.filter { (local[$0.path] ?? large[$0.path]) != $0.hash }.map(\.path)
        let del = Set(local.keys).union(large.keys).filter { mine[$0] == nil }.sorted()
        return ManifestResponse(need: need, delete: del, localCommit: commits.isEmpty ? commitLocked() : "c\(commitSeq)")
    }

    func pushFiles(projectId: String, ops: [SyncOp]) async throws -> SyncResult {
        try lock.withLock { try pushLocked(ops) }
    }

    private func pushLocked(_ ops: [SyncOp]) throws -> SyncResult {
        if failNextPush { failNextPush = false; throw HubError.transport("network down") }
        if let s = pushHTTPStatus { throw HubError.http(status: s, message: "disk_block", code: "disk_block") }
        pushes.append(ops)
        var results: [SyncResultItem] = []
        for op in ops {
            switch op {
            case let .write(path, hash, _, _, _, content, force):
                if conflictPaths.contains(path) && force != true {
                    results.append(SyncResultItem(path: path, status: .conflict, reason: "both sides changed"))
                } else if local[path] == hash {
                    results.append(SyncResultItem(path: path, status: .noop))
                } else {
                    local[path] = hash
                    if let content, let d = Data(base64Encoded: content) { blobs[hash] = d; worktree[path] = d }
                    conflictPaths.remove(path)
                    results.append(SyncResultItem(path: path, status: .applied))
                }
            case let .delete(path, _, force):
                if conflictPaths.contains(path) && force != true {
                    results.append(SyncResultItem(path: path, status: .conflict, reason: "both sides changed"))
                } else {
                    local.removeValue(forKey: path)
                    large.removeValue(forKey: path)
                    worktree.removeValue(forKey: path)
                    results.append(SyncResultItem(path: path, status: .applied))
                }
            }
        }
        return SyncResult(localCommit: commitLocked(), results: results)
    }

    func rawFile(projectId: String, path: String, ref: String?) async throws -> Data? {
        lock.withLock {
            rawRequests.append((path, ref))
            guard let ref else { return worktree[path] }
            if ref == "local" { return local[path].flatMap { blobs[$0] } }
            if let b = storedBackups.first(where: { $0.ref == ref }), let f = b.files.first(where: { $0.path == path }) {
                return blobs.values.first { FileHasher.gitBlobOid($0) == f.blob }
            }
            guard let h = commits[ref]?[path] else { return nil }
            return blobs[h]
        }
    }

    func accept(projectId: String, _ body: AcceptBody) async throws -> AcceptResponse {
        lock.withLock {
            var files: [AcceptedFile] = []
            for (path, data) in worktree where local[path] != FileHasher.sha256(data) {
                local[path] = FileHasher.sha256(data); blobs[FileHasher.sha256(data)] = data
                files.append(AcceptedFile(path: path, contentBase64: data.base64EncodedString(), deleted: false))
            }
            for (path, data) in largeWorktree where large[path] != FileHasher.sha256(data) {
                large[path] = FileHasher.sha256(data); largeContent[path] = data
                files.append(AcceptedFile(path: path, contentBase64: nil, deleted: false, large: true, sha256: FileHasher.sha256(data), size: Int64(data.count)))
            }
            for path in local.keys where worktree[path] == nil {
                local.removeValue(forKey: path)
                files.append(AcceptedFile(path: path, contentBase64: nil, deleted: true))
            }
            return AcceptResponse(localCommit: commitLocked(), files: files.sorted { $0.path < $1.path })
        }
    }

    func createBackup(projectId: String, _ body: ProjectBackupBody) async throws -> ProjectBackup {
        try lock.withLock {
            if let s = backupStatus { throw HubError.http(status: s, message: "no backups", code: nil) }
            backupRequests.append(body)
            let id = "b\(backupRequests.count)"
            var files: [ProjectBackup.File] = []
            for f in body.files {
                let d = Data(base64Encoded: f.dataBase64) ?? Data()
                blobs[FileHasher.sha256(d)] = d
                files.append(.init(path: f.path, blob: backupBlobOverride ?? FileHasher.gitBlobOid(d), size: Int64(d.count)))
            }
            let b = ProjectBackup(id: id, ref: "refs/backups/mac/\(id)", commit: "bk\(id)", client: body.client, reason: body.reason,
                                  at: Formatters.iso(Date()), files: files)
            storedBackups.append(b)
            return b
        }
    }

    func backups(projectId: String) async throws -> [ProjectBackup] {
        try lock.withLock {
            if let s = backupStatus { throw HubError.http(status: s, message: "no backups", code: nil) }
            return storedBackups
        }
    }

    /// Range downloads: (path, ref, offset) of every chunk.
    var rangeRequests: [(path: String, ref: String?, offset: Int64)] = []
    /// Large server versions served by the store (path → bytes), as the hub resolves pointers.
    var largeContent: [String: Data] = [:]

    func downloadRaw(projectId: String, path: String, ref: String?, to file: URL, chunk: Int64) async throws -> Bool {
        let whole: Data? = try await {
            if let d = lock.withLock({ largeContent[path] ?? largeWorktree[path] }) { return d }
            return try await rawFile(projectId: projectId, path: path, ref: ref)
        }()
        guard let whole else { return false }
        FileManager.default.createFile(atPath: file.path, contents: nil)
        let h = try FileHandle(forWritingTo: file)
        defer { try? h.close() }
        var offset: Int64 = 0
        repeat {
            lock.withLock { rangeRequests.append((path, ref, offset)) }
            let end = min(Int64(whole.count), offset + chunk)
            try h.write(contentsOf: whole.subdata(in: Int(offset)..<Int(end)))
            offset = end
        } while offset < Int64(whole.count)
        return true
    }

    func putExcludes(projectId: String, paths: [ExcludedPath]) async throws {
        try lock.withLock {
            events.append("excludes")
            if failExcludes > 0 { failExcludes -= 1; throw HubError.transport("network down") }
            if let s = excludesStatus { throw HubError.http(status: s, message: "no route", code: nil) }
            excludeCalls.append(paths)
        }
    }

    func largeFileProgress(projectId: String, file: LargeFile) async throws -> LargeFileUploadResponse {
        lock.withLock {
            if large[file.path] == file.sha256 { return LargeFileUploadResponse(path: file.path, received: file.size, complete: false) }
            return LargeFileUploadResponse(path: file.path, received: Int64(partial[file.path]?.count ?? 0), complete: false)
        }
    }

    /// Like the hub: chunks in order; a wrong offset → 409 with what it holds; at `size` the sha256 is
    /// checked and the write is recorded like a sync write (a conflict is a 200 with status `conflict`).
    func uploadLargeChunk(projectId: String, file: LargeFile, offset: Int64, data: Data) async throws -> LargeFileUploadResponse {
        if chunkDelayNanos > 0 { try await Task.sleep(nanoseconds: chunkDelayNanos) }
        return try lock.withLock {
            func complete() -> LargeFileUploadResponse {
                largeWrites.append((file.path, file.baseHash, file.force))
                if conflictPaths.contains(file.path) && !file.force {
                    return LargeFileUploadResponse(path: file.path, received: file.size, complete: true,
                                                   result: .init(status: .conflict, reason: "both sides changed"), localCommit: nil)
                }
                conflictPaths.remove(file.path)
                let status: SyncResultStatus = large[file.path] == file.sha256 ? .noop : .applied
                large[file.path] = file.sha256
                return LargeFileUploadResponse(path: file.path, received: file.size, complete: true, result: .init(status: status), localCommit: commitLocked())
            }
            if data.isEmpty && offset == file.size && (large[file.path] == file.sha256 || largeContent.values.contains { FileHasher.sha256($0) == file.sha256 }) {
                return complete()   // the store already holds this version
            }
            if let pushHTTPStatus { throw HubError.http(status: pushHTTPStatus, message: "disk_block", code: "disk_block") }
            if let f = failChunkAt, f == offset { failChunkAt = nil; throw HubError.transport("network down") }
            chunkCalls.append((file.path, offset, data.count))
            var held = partial[file.path] ?? Data()
            guard Int64(held.count) == offset else { return LargeFileUploadResponse(path: file.path, received: Int64(held.count), complete: false) }
            held.append(data)
            if Int64(held.count) >= file.size {
                partial.removeValue(forKey: file.path)
                guard FileHasher.sha256(held) == file.sha256 else { throw HubError.http(status: 422, message: "sha256 mismatch", code: nil) }
                return complete()
            }
            partial[file.path] = held
            if let n = dropPartialAfterChunks[file.path] {
                if n <= 1 { dropPartialAfterChunks.removeValue(forKey: file.path); partial.removeValue(forKey: file.path) }
                else { dropPartialAfterChunks[file.path] = n - 1 }
            }
            return LargeFileUploadResponse(path: file.path, received: Int64(held.count), complete: false)
        }
    }
}

/// Records every batch handed to the writer and executes it (or not).
final class RecordingWriter: LocalWriting, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var batches: [WriteBatch] = []
    var execute = true

    func apply(_ batch: WriteBatch) async throws -> WriteBatchResult {
        lock.withLock { batches.append(batch) }
        guard execute else { return WriteBatchResult(applied: [], refused: batch.items.map { WriteRefusal(path: $0.path, reason: "test: not executed") }) }
        return WriteBatchExecutor.execute(batch, deleteMode: .removeForTests)
    }

    var count: Int { lock.withLock { batches.count } }
}

/// Every file under `root` with its hash, size, mode and mtime: equal fingerprints = nothing was
/// created, modified or deleted.
func fingerprint(_ root: URL) -> [String: String] {
    var out: [String: String] = [:]
    let base = root.resolvingSymlinksInPath().path
    guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil, options: []) else { return out }
    for case let url as URL in e {
        let p = url.resolvingSymlinksInPath().path
        let rel = p.hasPrefix(base + "/") ? String(p.dropFirst(base.count + 1)) : url.lastPathComponent
        switch LocalEntry.stat(url) {
        case let .file(size, mode, mtime):
            out[rel] = "\(size):\(mode):\(mtime):\((try? FileHasher.sha256(fileAt: url)) ?? "?")"
        case .directory: out[rel] = "dir"
        case .symlink: out[rel] = "link"
        default: break
        }
    }
    return out
}

enum Fixtures {
    static func url(_ name: String) -> URL {
        Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures/events")!
    }

    static func data(_ name: String) -> Data { try! Data(contentsOf: url(name)) }
}

/// A value shared with URLProtocol callbacks.
final class Locked<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    var value: T { lock.withLock { v } }
    func mutate(_ f: (inout T) -> Void) { lock.withLock { f(&v) } }
}

/// UserDefaults suites for tests. Each suite is a plist inside one temporary folder per test
/// process (an absolute-path suite name), never in ~/Library/Preferences; the folder is removed
/// when the process exits.
enum TestDefaults {
    static let directory: URL = {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("workstation-test-defaults-\(ProcessInfo.processInfo.processIdentifier)", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        atexit { TestDefaults.cleanUp() }
        return d
    }()

    /// A new suite `<prefix>-<uuid>`.
    static func make(_ prefix: String) -> UserDefaults { named("\(prefix)-\(UUID().uuidString)") }

    /// The suite `name` (opened again by a test that checks persistence).
    static func named(_ name: String) -> UserDefaults {
        UserDefaults(suiteName: directory.appendingPathComponent(name).path)!
    }

    static func cleanUp() {
        try? FileManager.default.removeItem(at: directory)
    }
}
