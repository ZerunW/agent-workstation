import Foundation

/// What never syncs, whatever the selection says.
public enum SyncRules {
    public static let gitReason = "Git metadata stays on this Mac"
}

/// A folder tree as the selection window sees it: sizes and counts (`.git` is not walked, only
/// counted). Symlinks are listed, never followed; cloud-only files are flagged from metadata.
public final class SyncTreeNode: @unchecked Sendable {
    public enum Kind: Sendable { case folder, file, symlink }
    public let name: String
    /// Relative to the linked folder ("" = the root); folders without a trailing "/".
    public let path: String
    public let kind: Kind
    public var size: Int64 = 0
    public var mode: Int = 0o644
    public var children: [SyncTreeNode] = []
    /// Files beneath (`.git`: as far as counted).
    public var fileCount = 0
    public var totalBytes: Int64 = 0
    /// Extension counts beneath ("(none)" for none).
    public var extensions: [String: Int] = [:]
    /// false for `.git` (contents not listed).
    public var descended = true
    /// `.git`: never synced.
    public var isGit: Bool { kind == .folder && name == ".git" }
    /// A cloud-only placeholder (metadata says so; never read).
    public var cloudOnly = false

    init(name: String, path: String, kind: Kind) { self.name = name; self.path = path; self.kind = kind }

    public var isFolder: Bool { kind == .folder }
    public var folders: [SyncTreeNode] { children.filter(\.isFolder) }
    public var files: [SyncTreeNode] { children.filter { $0.kind == .file } }
    public var symlinks: [SyncTreeNode] { children.filter { $0.kind == .symlink } }

    /// Extension as the tree text shows it (".py", "(none)").
    var displayExtension: String {
        let e = (name as NSString).pathExtension
        return (e.isEmpty || name.hasPrefix(".") && !name.dropFirst().contains(".")) ? "(none)" : "." + e
    }

    public func node(at path: String) -> SyncTreeNode? {
        if path == self.path { return self }
        for c in children where path == c.path || path.hasPrefix(c.path + "/") { return c.node(at: path) }
        return nil
    }

    /// Every node beneath (depth first, this one excluded).
    public func descendants() -> [SyncTreeNode] { children.flatMap { [$0] + $0.descendants() } }
}

public enum SyncTreeScanner {
    public static func scan(root: URL, cloud: CloudProbe = .system) -> SyncTreeNode {
        let top = SyncTreeNode(name: root.lastPathComponent, path: "", kind: .folder)
        walk(top, dir: root, cloud: cloud)
        return top
    }

    static func walk(_ node: SyncTreeNode, dir: URL, cloud: CloudProbe) {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
        for name in names.sorted(by: { $0.localizedStandardCompare($1) == .orderedAscending }) {
            let path = node.path.isEmpty ? name : node.path + "/" + name
            let url = dir.appendingPathComponent(name)
            switch LocalEntry.stat(url) {
            case .symlink:
                node.children.append(SyncTreeNode(name: name, path: path, kind: .symlink))
            case let .file(size, mode, _):
                let child = SyncTreeNode(name: name, path: path, kind: .file)
                child.size = size; child.mode = mode
                child.cloudOnly = cloud.isDataless(url)
                node.fileCount += 1; node.totalBytes += size
                node.extensions[child.displayExtension, default: 0] += 1
                node.children.append(child)
            case .directory:
                let child = SyncTreeNode(name: name, path: path, kind: .folder)
                if name == ".git" {
                    child.descended = false
                    child.fileCount = countFiles(url, limit: 200_000)
                } else {
                    walk(child, dir: url, cloud: cloud)
                    node.fileCount += child.fileCount; node.totalBytes += child.totalBytes
                    for (k, v) in child.extensions { node.extensions[k, default: 0] += v }
                }
                node.children.append(child)
            default:
                continue
            }
        }
    }

    static func countFiles(_ url: URL, limit: Int) -> Int {
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.isRegularFileKey], options: []) else { return 0 }
        var n = 0
        for case let u as URL in e {
            if (try? u.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true { n += 1 }
            if n >= limit { break }
        }
        return n
    }
}
