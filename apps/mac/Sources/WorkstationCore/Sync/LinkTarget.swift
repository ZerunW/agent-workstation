import Foundation

/// What linking a picked / typed / dropped path means: a whole folder, or one file synced as a
/// project of its own (root = its parent folder, restricted to that file).
public struct LinkTarget: Equatable, Sendable {
    /// What the person picked.
    public var picked: URL
    /// Folder the sync engine works in.
    public var root: URL
    /// Single-file link: the file's name inside `root`.
    public var onlyPath: String?
    /// Project name on the server (`[A-Za-z0-9._-]{1,64}`).
    public var name: String

    public var isSingleFile: Bool { onlyPath != nil }

    public enum Problem: Error, Equatable, LocalizedError {
        case empty
        case notAbsolute(String)
        case missing(String)
        case unreadable(String)
        case symlink(String)
        case notRegular(String)
        case tooLarge(String, Int64)

        public var errorDescription: String? {
            switch self {
            case .empty: return "Enter the path of a folder or file."
            case .notAbsolute(let p): return "“\(p)” is not a full path. Start with / or ~."
            case .missing(let p): return "Nothing exists at \(p)."
            case .unreadable(let p): return "\(p) can't be read (check its permissions)."
            case .symlink(let p): return "\(p) is a symbolic link. Pick the folder or file it points to."
            case .notRegular(let p): return "\(p) is neither a folder nor a regular file."
            case .tooLarge(let p, let n): return "\(p) is \(Formatters.bytes(n)): files over \(Formatters.bytes(WorkstationProtocol.maxSyncFileBytes)) can't be synced."
            }
        }
    }

    /// A pasted or typed path → file URL: trims whitespace and surrounding quotes, accepts
    /// `file://` URLs and shell-escaped spaces (`My\ Folder`), expands `~`.
    public static func url(fromTyped raw: String) throws -> URL {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.count >= 2, let f = s.first, let l = s.last, (f == "\"" && l == "\"") || (f == "'" && l == "'") {
            s = String(s.dropFirst().dropLast())
        }
        guard !s.isEmpty else { throw Problem.empty }
        if s.hasPrefix("file://"), let u = URL(string: s), u.isFileURL { return u.standardizedFileURL }
        if !s.hasPrefix("'") { s = s.replacingOccurrences(of: "\\ ", with: " ") }
        s = (s as NSString).expandingTildeInPath
        guard s.hasPrefix("/") else { throw Problem.notAbsolute(raw.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return URL(fileURLWithPath: s).standardizedFileURL
    }

    /// Checks that `url` can be linked and works out root / onlyPath / name.
    public static func inspect(_ url: URL, maxFileBytes: Int64 = WorkstationProtocol.maxSyncFileBytes) throws -> LinkTarget {
        let u = url.standardizedFileURL
        var shown = u.path
        let home = NSHomeDirectory()
        if shown.hasPrefix(home + "/") { shown = "~" + shown.dropFirst(home.count) }
        switch LocalEntry.stat(u) {
        case .absent: throw Problem.missing(shown)
        case .symlink: throw Problem.symlink(shown)
        case .other: throw Problem.notRegular(shown)
        case .directory:
            guard FileManager.default.isReadableFile(atPath: u.path),
                  (try? FileManager.default.contentsOfDirectory(atPath: u.path)) != nil else { throw Problem.unreadable(shown) }
            return LinkTarget(picked: u, root: u, onlyPath: nil, name: projectName(u.lastPathComponent))
        case .file(let size, _, _):
            guard FileManager.default.isReadableFile(atPath: u.path) else { throw Problem.unreadable(shown) }
            guard size <= maxFileBytes else { throw Problem.tooLarge(shown, size) }
            return LinkTarget(picked: u, root: u.deletingLastPathComponent(), onlyPath: u.lastPathComponent,
                              name: projectName(u.lastPathComponent))
        }
    }

    /// Project names must match `[A-Za-z0-9._-]{1,64}`.
    public static func projectName(_ raw: String) -> String {
        var s = String(raw.unicodeScalars.map { c -> Character in
            (CharacterSet.alphanumerics.contains(c) && c.isASCII) || c == "." || c == "_" || c == "-" ? Character(c) : "-"
        })
        while s.hasPrefix(".") { s.removeFirst() }
        if s.isEmpty { s = "project" }
        return String(s.prefix(64))
    }
}

/// Read-only security-scoped bookmarks for linked folders and files. Inside the sandbox the app
/// can only *read* what the person picked; outside it (tests, `swift run`) a plain bookmark is used.
public enum Bookmarks {
    public static func readOnly(for url: URL) -> Data? {
        if let d = try? url.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess], includingResourceValuesForKeys: nil, relativeTo: nil) {
            return d
        }
        return try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
    }

    /// Resolves a bookmark (following a moved folder). `stale` = recreate it.
    public static func resolve(_ data: Data) -> (url: URL, stale: Bool)? {
        var stale = false
        if let u = try? URL(resolvingBookmarkData: data, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &stale) {
            return (u, stale)
        }
        if let u = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) {
            return (u, stale)
        }
        return nil
    }
}
