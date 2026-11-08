import Darwin
import Foundation

/// Cloud-only files: placeholders a File Provider (OneDrive, Google Drive, Dropbox, Box…) or iCloud
/// Drive keeps on disk without their content. Reading one makes the system fetch it first (which can
/// take forever), so they are recognised from metadata alone and never opened, read or hashed.
public struct CloudProbe: Sendable {
    /// `lstat` `st_flags` & `SF_DATALESS`.
    public static let datalessFlag: UInt32 = 0x4000_0000

    public var isDataless: @Sendable (URL) -> Bool
    public init(isDataless: @escaping @Sendable (URL) -> Bool) { self.isDataless = isDataless }

    /// The real flags (metadata only; `lstat` never materializes a file).
    public static let system = CloudProbe { url in
        var st = Darwin.stat()
        guard lstat(url.path, &st) == 0 else { return false }
        return st.st_flags & datalessFlag != 0
    }
}

public enum CloudFileError: Error, Equatable, LocalizedError {
    case cloudOnly(String)
    public var errorDescription: String? {
        if case .cloudOnly(let p) = self { return "\(p) is only in the cloud" }
        return nil
    }
}

/// Which cloud a folder lives in, and the Finder command that keeps it downloaded.
public struct CloudProvider: Equatable, Sendable {
    public var name: String
    /// nil = no known menu item ("keep it downloaded").
    public var finderCommand: String?

    public static let generic = CloudProvider(name: "the cloud", finderCommand: nil)

    /// `~/Library/CloudStorage/<Name>-<account>/…` → that provider; `~/Library/Mobile Documents/…`
    /// (or a path that resolves there, e.g. a Desktop synced to iCloud) → iCloud Drive.
    public static func detect(_ url: URL, home: String = NSHomeDirectory(),
                              resolve: (String) -> String = { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }) -> CloudProvider {
        for path in [url.path, resolve(url.path)] {
            if let p = fromPath(path, home: home) { return p }
        }
        return .generic
    }

    static func fromPath(_ path: String, home: String) -> CloudProvider? {
        let homes = [home, "/private" + home].map { $0.hasSuffix("/") ? String($0.dropLast()) : $0 }
        for h in homes {
            if path == h + "/Library/Mobile Documents" || path.hasPrefix(h + "/Library/Mobile Documents/") {
                return CloudProvider(name: "iCloud Drive", finderCommand: "Keep Downloaded")
            }
            let cs = h + "/Library/CloudStorage/"
            guard path.hasPrefix(cs) else { continue }
            let folder = path.dropFirst(cs.count).split(separator: "/").first.map(String.init) ?? ""
            let first = folder.split(separator: "-").first.map(String.init) ?? folder
            switch first.lowercased() {
            case "onedrive": return CloudProvider(name: "OneDrive", finderCommand: "Always Keep on This Device")
            case "googledrive": return CloudProvider(name: "Google Drive", finderCommand: "Available offline")
            case "dropbox": return CloudProvider(name: "Dropbox", finderCommand: "Make available offline")
            case "box": return CloudProvider(name: "Box", finderCommand: "Make available offline")
            default: return first.isEmpty ? .generic : CloudProvider(name: first, finderCommand: nil)
            }
        }
        return nil
    }

    /// "220 files are only in OneDrive."
    public func countLine(_ n: Int) -> String {
        "\(n.formatted()) file\(n == 1 ? " is" : "s are") only in \(name)."
    }

    /// "In Finder, choose “Always Keep on This Device” for this folder."
    public var hint: String {
        finderCommand.map { "In Finder, choose “\($0)” for this folder." } ?? "In Finder, keep this folder downloaded."
    }

    /// The one line the UI shows.
    public func message(_ n: Int) -> String { countLine(n) + " " + hint }

    /// "3 files only in OneDrive" (status lines, notifications).
    public func shortLine(_ n: Int) -> String { "\(n.formatted()) file\(n == 1 ? "" : "s") only in \(name)" }
}
