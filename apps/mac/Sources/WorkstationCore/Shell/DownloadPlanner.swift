import Foundation

/// Where page downloads (file downloads, project zips, blob saves) land: `~/Downloads/<name>`,
/// never overwriting: `name (1).ext`, `name (2).ext`, … like Safari.
public enum DownloadPlanner {
    public static var downloadsDirectory: URL {
        FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads", isDirectory: true)
    }

    /// Multi-part extensions kept together when numbering (`a.tar.gz` → `a (1).tar.gz`).
    static let compoundExtensions = ["tar.gz", "tar.zst", "tar.bz2", "tar.xz"]

    /// A safe single file name: no path separators or control characters, no leading dots, ≤ 200 characters.
    public static func sanitize(_ suggested: String?) -> String {
        var s = (suggested ?? "").replacingOccurrences(of: "\\", with: "/")
        s = s.split(separator: "/").last.map(String.init) ?? ""
        s = String(s.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.map(Character.init))
        s = s.replacingOccurrences(of: ":", with: "-").trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasPrefix(".") { s.removeFirst() }
        if s.isEmpty { return "download" }
        if s.count > 200 {
            let (stem, ext) = split(s)
            s = String(stem.prefix(200 - ext.count)) + ext
        }
        return s
    }

    /// `stem` + `.ext` (with the leading dot), compound extensions recognised.
    static func split(_ name: String) -> (String, String) {
        let lower = name.lowercased()
        for c in compoundExtensions where lower.hasSuffix("." + c) && lower.count > c.count + 1 {
            return (String(name.dropLast(c.count + 1)), String(name.suffix(c.count + 1)))
        }
        if let dot = name.lastIndex(of: "."), dot != name.startIndex {
            return (String(name[..<dot]), String(name[dot...]))
        }
        return (name, "")
    }

    /// First free destination for `suggested` in `directory`.
    public static func destination(suggested: String?, in directory: URL = downloadsDirectory,
                                   exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }) -> URL {
        let name = sanitize(suggested)
        let first = directory.appendingPathComponent(name, isDirectory: false)
        guard exists(first) else { return first }
        let (stem, ext) = split(name)
        var n = 1
        while true {
            let candidate = directory.appendingPathComponent("\(stem) (\(n))\(ext)", isDirectory: false)
            if !exists(candidate) { return candidate }
            n += 1
        }
    }
}
