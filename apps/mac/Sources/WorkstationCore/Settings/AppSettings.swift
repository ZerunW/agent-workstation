import Foundation

/// Native preferences in `UserDefaults`. `WORKSTATION_HUB_URL` / `WORKSTATION_HUB_USER` environment variables
/// override the stored values for one launch (handy for development).
///
/// The username is *not* chosen natively: the web app's login page stores it in the web view's
/// localStorage (`workstation.user`). `username` here is only the last value the page reported, so the
/// sync engine and notifications can start before the page has finished loading.
public final class AppSettings: @unchecked Sendable {
    public static let defaultHubURL = "https://workstation.example-tailnet.ts.net"

    enum Key {
        static let hubURL = "hubURL"
        static let username = "username"
        static let notifications = "notificationsEnabled"
        static let pageZoom = "pageZoom"
        static let skippedUpdateBuild = "skippedUpdateBuild"
        static let notificationPermissionAsked = "notificationPermissionAsked"
    }

    public let defaults: UserDefaults
    private let environment: [String: String]

    public init(defaults: UserDefaults = .standard, environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.defaults = defaults
        self.environment = environment
    }

    /// The environment variable `name` (empty counts as unset).
    private func env(_ name: String) -> String? {
        if let v = environment[name], !v.isEmpty { return v }
        return nil
    }

    public var hubURLString: String {
        get {
            if let env = env("WORKSTATION_HUB_URL") { return env }
            return defaults.string(forKey: Key.hubURL) ?? Self.defaultHubURL
        }
        set { defaults.set(newValue, forKey: Key.hubURL) }
    }

    public var hubURL: URL? { Self.normalizeHubURL(hubURLString) }

    /// false until a hub address was confirmed once (first-run sheet) or given by `WORKSTATION_HUB_URL`.
    public var hasHubURL: Bool {
        if env("WORKSTATION_HUB_URL") != nil { return true }
        return defaults.string(forKey: Key.hubURL) != nil
    }

    /// Last username the web app reported (cache; the web view's localStorage is the source of truth).
    public var username: String? {
        get {
            if let env = env("WORKSTATION_HUB_USER"), Self.isValidUsername(env) { return env }
            let v = defaults.string(forKey: Key.username)
            return (v?.isEmpty ?? true) ? nil : v
        }
        set {
            if let newValue { defaults.set(newValue, forKey: Key.username) } else { defaults.removeObject(forKey: Key.username) }
        }
    }

    public var notificationsEnabled: Bool {
        get { defaults.object(forKey: Key.notifications) as? Bool ?? true }
        set { defaults.set(newValue, forKey: Key.notifications) }
    }

    /// Web view page zoom (⌘+ / ⌘- / ⌘0), 1 = 100 %.
    public var pageZoom: Double {
        get { (defaults.object(forKey: Key.pageZoom) as? Double).map(ZoomSteps.clamp) ?? 1 }
        set { defaults.set(ZoomSteps.clamp(newValue), forKey: Key.pageZoom) }
    }

    /// The system notification permission was asked for once (never again, whatever the answer).
    public var notificationPermissionAsked: Bool {
        get { defaults.bool(forKey: Key.notificationPermissionAsked) }
        set { defaults.set(newValue, forKey: Key.notificationPermissionAsked) }
    }

    /// The app build the person answered "Later" for: no automatic prompt for it again.
    public var skippedUpdateBuild: String? {
        get { defaults.string(forKey: Key.skippedUpdateBuild) }
        set { if let newValue { defaults.set(newValue, forKey: Key.skippedUpdateBuild) } else { defaults.removeObject(forKey: Key.skippedUpdateBuild) } }
    }

    /// `[a-z0-9_-]{1,32}` (protocol `Username`).
    public static func isValidUsername(_ s: String) -> Bool {
        guard (1...32).contains(s.count) else { return false }
        return s.unicodeScalars.allSatisfy { c in
            (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "_" || c == "-"
        }
    }

    /// A typed or stored hub address → URL without trailing slashes. A typed scheme is kept as is
    /// (only http / https). Without one: `http://` for an IP literal (v4 or v6), `localhost` /
    /// `*.localhost`, or an address with an explicit port (`100.64.0.9:9000`,
    /// `workstation.tailnet-name.ts.net:9000`); `https://` for every other host name (`workstation.example.com`).
    public static func normalizeHubURL(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") {
            let end = s.firstIndex(where: { "/?#".contains($0) }) ?? s.endIndex
            var authority = String(s[..<end])
            let rest = String(s[end...])
            // A bare IPv6 literal ("::1", "fe80::2") needs brackets in a URL.
            if !authority.hasPrefix("["), authority.filter({ $0 == ":" }).count >= 2 { authority = "[" + authority + "]" }
            s = (plainHTTP(authority: authority) ? "http://" : "https://") + authority + rest
        }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.host, !host.isEmpty else { return nil }
        return url
    }

    /// No scheme typed: is this an address that is served over plain HTTP?
    static func plainHTTP(authority: String) -> Bool {
        var host = authority.lowercased()
        if host.hasPrefix("[") {
            // [v6] or [v6]:port: an IP literal either way.
            return true
        }
        if let colon = host.lastIndex(of: ":") {
            let port = host[host.index(after: colon)...]
            if !port.isEmpty, port.allSatisfy(\.isNumber) { return true }   // explicit port
            host = String(host[..<colon])
        }
        if host == "localhost" || host.hasSuffix(".localhost") { return true }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts.allSatisfy { p in !p.isEmpty && p.count <= 3 && p.allSatisfy(\.isNumber) && (Int(p) ?? 256) <= 255 }
    }
}
