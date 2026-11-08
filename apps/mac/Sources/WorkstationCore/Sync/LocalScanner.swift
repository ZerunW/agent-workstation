import CryptoKit
import Foundation

/// Hashes are lowercase hex SHA-256 of the raw file bytes (the protocol's `hash` /
/// `baseHash`). They are *not* git blob ids.
public enum FileHasher {
    public static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Git blob id: SHA-1 of `blob <size>\0` + bytes (what the hub reports for backed-up files).
    public static func gitBlobOid(_ data: Data) -> String {
        var h = Insecure.SHA1()
        h.update(data: Data("blob \(data.count)\0".utf8))
        h.update(data: data)
        return h.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Git blob id of a file, streamed.
    public static func gitBlobOid(fileAt url: URL) throws -> String {
        let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        var hasher = Insecure.SHA1()
        hasher.update(data: Data("blob \(size)\0".utf8))
        while let chunk = try h.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    public static func sha256(fileAt url: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        var hasher = SHA256()
        while let chunk = try h.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// What `lstat` says about a path (symlinks are never followed).
public enum LocalEntry: Equatable, Sendable {
    case file(size: Int64, mode: Int, mtime: TimeInterval)
    case directory
    case symlink
    case other
    case absent

    public static func stat(_ url: URL) -> LocalEntry {
        var st = Darwin.stat()
        guard lstat(url.path, &st) == 0 else { return .absent }
        switch st.st_mode & S_IFMT {
        case S_IFREG:
            let mtime = TimeInterval(st.st_mtimespec.tv_sec) + TimeInterval(st.st_mtimespec.tv_nsec) / 1e9
            return .file(size: Int64(st.st_size), mode: Int(st.st_mode & 0o7777), mtime: mtime)
        case S_IFDIR: return .directory
        case S_IFLNK: return .symlink
        default: return .other
        }
    }
}

public struct ScannedFile: Hashable, Sendable {
    public var path: String
    public var size: Int64
    public var mode: Int
    public var hash: String

    public var manifestEntry: ManifestEntry { ManifestEntry(path: path, hash: hash, size: size, mode: mode) }
}

public struct SkippedFile: Hashable, Sendable, Identifiable {
    public enum Reason: Hashable, Sendable {
        case symlink
        case tooLarge(Int64)
        case unreadable(String)
        /// A cloud-only placeholder (not read until it is downloaded).
        case cloudOnly

        public var label: String {
            switch self {
            case .cloudOnly: return "only in the cloud"
            case .symlink: return "symlink (not synced)"
            case .tooLarge(let n): return "too large (\(Formatters.bytes(n)) > \(Formatters.bytes(WorkstationProtocol.maxSyncFileBytes)))"
            case .unreadable(let e): return "unreadable: \(e)"
            }
        }
    }

    public var path: String
    public var reason: Reason
    public var id: String { path }

    public init(path: String, reason: Reason) { self.path = path; self.reason = reason }
}

public struct ScanResult: Sendable {
    public var files: [ScannedFile]
    public var skipped: [SkippedFile]
    public var matcher: IgnoreMatcher
    /// The walk was stopped early (`stop` returned true): the counts are a lower bound.
    public var truncated = false

    public var manifest: [ManifestEntry] { files.map(\.manifestEntry) }
    public var totalBytes: Int64 { files.reduce(0) { $0 + $1.size } }
    public var hashes: [String: String] { Dictionary(uniqueKeysWithValues: files.map { ($0.path, $0.hash) }) }
}

/// Remembers hashes by (size, mtime) so periodic reconciles do not re-read unchanged files.
public final class HashCache: @unchecked Sendable {
    private var entries: [String: (size: Int64, mtime: TimeInterval, hash: String)] = [:]
    private let lock = NSLock()
    /// A cloud-only file is never read (`CloudFileError.cloudOnly`).
    public let probe: CloudProbe
    /// Reads a file's sha256 (tests spy on it).
    public let hasher: @Sendable (URL) throws -> String

    public init(probe: CloudProbe = .system, hasher: @escaping @Sendable (URL) throws -> String = { try FileHasher.sha256(fileAt: $0) }) {
        self.probe = probe
        self.hasher = hasher
    }

    public func hash(path: String, url: URL, size: Int64, mtime: TimeInterval) throws -> String {
        if probe.isDataless(url) { throw CloudFileError.cloudOnly(path) }
        lock.lock()
        if let e = entries[path], e.size == size, e.mtime == mtime { lock.unlock(); return e.hash }
        lock.unlock()
        let h = try hasher(url)
        lock.lock(); entries[path] = (size, mtime, h); lock.unlock()
        return h
    }

    public func invalidate(_ path: String) { lock.lock(); entries.removeValue(forKey: path); lock.unlock() }
}

/// Walks a local folder applying ignore rules. Never follows symlinks; skips (and reports)
/// symlinks and files larger than `MAX_SYNC_FILE_BYTES`; never descends into `.git`.
public enum LocalScanner {
    /// - Parameters:
    ///   - hashContents: false = sizes only (link preview: file count and size before the first upload).
    ///   - stop: checked as the walk goes (time budget, cancellation); true ends it early (`truncated`).
    public static func scan(root: URL, extraPatterns: [String] = [], useGitignore: Bool = true,
                            cache: HashCache? = nil, maxFileBytes: Int64 = WorkstationProtocol.maxSyncFileBytes,
                            hashContents: Bool = true, stop: (() -> Bool)? = nil, probe: CloudProbe = .system) -> ScanResult {
        var matcher = IgnoreMatcher()
        if !extraPatterns.isEmpty { matcher.add(patterns: extraPatterns, base: "") }
        var files: [ScannedFile] = []
        var skipped: [SkippedFile] = []
        var stopped = false
        walk(root: root, rel: "", matcher: &matcher, useGitignore: useGitignore, cache: cache, maxFileBytes: maxFileBytes,
             hashContents: hashContents, files: &files, skipped: &skipped, stop: stop, stopped: &stopped, probe: probe)
        files.sort { $0.path.utf8.lexicographicallyPrecedes($1.path.utf8) }
        skipped.sort { $0.path < $1.path }
        var r = ScanResult(files: files, skipped: skipped, matcher: matcher)
        r.truncated = stopped
        return r
    }

    /// Single-file project: only `path` inside `root` (no ignore rules: the person picked it).
    public static func scanSingle(root: URL, path: String, cache: HashCache? = nil,
                                  maxFileBytes: Int64 = WorkstationProtocol.maxSyncFileBytes, probe: CloudProbe = .system) -> ScanResult {
        let url = root.appendingPathComponent(path)
        var files: [ScannedFile] = []
        var skipped: [SkippedFile] = []
        switch LocalEntry.stat(url) {
        case .file(let size, let mode, let mtime):
            if probe.isDataless(url) { skipped.append(SkippedFile(path: path, reason: .cloudOnly)); break }
            if size > maxFileBytes { skipped.append(SkippedFile(path: path, reason: .tooLarge(size))); break }
            do {
                let h = try cache?.hash(path: path, url: url, size: size, mtime: mtime) ?? FileHasher.sha256(fileAt: url)
                files.append(ScannedFile(path: path, size: size, mode: mode, hash: h))
            } catch {
                skipped.append(SkippedFile(path: path, reason: .unreadable(error.localizedDescription)))
            }
        case .symlink: skipped.append(SkippedFile(path: path, reason: .symlink))
        default: break
        }
        return ScanResult(files: files, skipped: skipped, matcher: IgnoreMatcher())
    }

    /// Scans only `subpath` (a directory) with an existing matcher: used for FSEvents
    /// batches that touch a whole directory (e.g. a folder moved into the project).
    public static func scanSubtree(root: URL, subpath: String, matcher: IgnoreMatcher, cache: HashCache? = nil,
                                   maxFileBytes: Int64 = WorkstationProtocol.maxSyncFileBytes, probe: CloudProbe = .system) -> ScanResult {
        var m = matcher
        var files: [ScannedFile] = []
        var skipped: [SkippedFile] = []
        var stopped = false
        walk(root: root, rel: subpath, matcher: &m, useGitignore: false, cache: cache, maxFileBytes: maxFileBytes,
             hashContents: true, files: &files, skipped: &skipped, stop: nil, stopped: &stopped, probe: probe)
        files.sort { $0.path < $1.path }
        return ScanResult(files: files, skipped: skipped, matcher: m)
    }

    private static func walk(root: URL, rel: String, matcher: inout IgnoreMatcher, useGitignore: Bool, cache: HashCache?,
                             maxFileBytes: Int64, hashContents: Bool, files: inout [ScannedFile], skipped: inout [SkippedFile],
                             stop: (() -> Bool)?, stopped: inout Bool, probe: CloudProbe) {
        if stopped { return }
        if let stop, stop() { stopped = true; return }
        let dirURL = rel.isEmpty ? root : root.appendingPathComponent(rel, isDirectory: true)
        if useGitignore {
            let gi = dirURL.appendingPathComponent(".gitignore")
            if case .file = LocalEntry.stat(gi), let text = try? String(contentsOf: gi, encoding: .utf8) {
                matcher.add(gitignore: text, base: rel)
            }
        }
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dirURL.path) else { return }
        for (i, name) in names.sorted().enumerated() {
            if stopped { return }
            if i % 256 == 255, let stop, stop() { stopped = true; return }
            if name == ".git" { continue }
            let childRel = rel.isEmpty ? name : rel + "/" + name
            let url = dirURL.appendingPathComponent(name)
            switch LocalEntry.stat(url) {
            case .directory:
                if matcher.isIgnored(childRel, isDirectory: true) { continue }
                walk(root: root, rel: childRel, matcher: &matcher, useGitignore: useGitignore, cache: cache,
                     maxFileBytes: maxFileBytes, hashContents: hashContents, files: &files, skipped: &skipped,
                     stop: stop, stopped: &stopped, probe: probe)
            case .file(let size, let mode, let mtime):
                if matcher.isIgnored(childRel, isDirectory: false) { continue }
                if size > maxFileBytes { skipped.append(SkippedFile(path: childRel, reason: .tooLarge(size))); continue }
                if !hashContents { files.append(ScannedFile(path: childRel, size: size, mode: mode, hash: "")); continue }
                // A cloud-only placeholder is never read (reading would fetch it first).
                if probe.isDataless(url) { skipped.append(SkippedFile(path: childRel, reason: .cloudOnly)); continue }
                do {
                    let h = try cache?.hash(path: childRel, url: url, size: size, mtime: mtime) ?? FileHasher.sha256(fileAt: url)
                    files.append(ScannedFile(path: childRel, size: size, mode: mode, hash: h))
                } catch {
                    skipped.append(SkippedFile(path: childRel, reason: .unreadable(error.localizedDescription)))
                }
            case .symlink:
                if matcher.isIgnored(childRel, isDirectory: false) { continue }
                skipped.append(SkippedFile(path: childRel, reason: .symlink))
            case .other, .absent:
                continue
            }
        }
    }
}
