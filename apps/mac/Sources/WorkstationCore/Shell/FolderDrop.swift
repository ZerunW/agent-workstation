import Foundation

/// Drops on the main window: folders become a Code session's directory (the shell takes the
/// drag, the page never sees it); plain files go to the page as a web upload.
public enum FolderDrop {
    /// The folders among dropped file URLs, in drop order. Packages (`.app`, `.pages`, …) count as
    /// files. Empty → the drop belongs to the page.
    public static func folders(in urls: [URL]) -> [URL] {
        urls.filter(isFolder)
    }

    static func isFolder(_ url: URL) -> Bool {
        guard url.isFileURL else { return false }
        if let v = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey, .isSymbolicLinkKey]),
           let isDir = v.isDirectory {
            return isDir && !(v.isPackage ?? false) && !(v.isSymbolicLink ?? false)
        }
        // Metadata unreadable: Finder writes folder URLs with a trailing slash.
        return url.hasDirectoryPath && url.pathExtension.isEmpty
    }
}
