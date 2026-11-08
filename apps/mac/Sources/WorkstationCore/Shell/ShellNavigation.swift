import Foundation

/// URLs of the hub's web app (the same React app a browser loads from `<hub>/`).
public enum ShellURLs {
    /// `<hub>/`: the full web UI (not the transcript-only `embed.html`).
    public static func app(base: URL) -> URL { url(for: "/", base: base) }

    /// `<hub><path>`; `path` is a web route such as `/usage` or `/s/<id>` (a missing leading `/` is added).
    public static func url(for path: String, base: URL) -> URL {
        var root = base.absoluteString
        while root.hasSuffix("/") { root.removeLast() }
        let p = path.hasPrefix("/") ? path : "/" + path
        return URL(string: root + p) ?? base
    }

    /// Same scheme, host and port (default ports normalised: `http://h` == `http://h:80`).
    public static func isHubOrigin(_ url: URL?, base: URL) -> Bool {
        guard let url, let s1 = url.scheme?.lowercased(), let s2 = base.scheme?.lowercased(), s1 == s2,
              let h1 = url.host?.lowercased(), let h2 = base.host?.lowercased(), h1 == h2 else { return false }
        return effectivePort(url) == effectivePort(base)
    }

    static func effectivePort(_ u: URL) -> Int? {
        if let p = u.port { return p }
        switch u.scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }

    /// Path + query of a hub URL (`/s/abc?x=1`), `/` when empty.
    public static func route(of url: URL) -> String {
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let path = c?.percentEncodedPath.isEmpty == false ? c!.percentEncodedPath : "/"
        c?.fragment = nil
        if let q = c?.percentEncodedQuery, !q.isEmpty { return path + "?" + q }
        return path
    }

    /// Web route of one session.
    public static func sessionRoute(_ id: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return "/s/" + (id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id)
    }

    /// `/?new=code&cwd=<dir>`: a new Code session draft working in `dir` (a server path such as
    /// `projects/<name>`). Everything but ASCII letters, digits, `-._~` and `/` is percent-encoded
    /// (`+` too, which `URLSearchParams` would read as a space).
    public static func newCodeSessionRoute(cwd: String, panel: String? = nil) -> String {
        var allowed = CharacterSet()
        allowed.insert(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~/")
        return "/?new=code&cwd=" + (cwd.addingPercentEncoding(withAllowedCharacters: allowed) ?? cwd) + (panel.map { "&panel=" + $0 } ?? "")
    }

    /// Where the Sync tab of a project opens (`?panel=sync`): its most recent Code session, else a
    /// new Code session draft in the project's server directory.
    public static func syncPanelRoute(latestSession: String?, projectPath: String) -> String {
        if let id = latestSession { return sessionRoute(id) + "?panel=sync" }
        return newCodeSessionRoute(cwd: projectPath, panel: "sync")
    }

    /// `<hub>/?new=code&cwd=<dir>`.
    public static func newCodeSession(cwd: String, base: URL) -> URL {
        url(for: newCodeSessionRoute(cwd: cwd), base: base)
    }
}

/// What the web view does with a navigation (link click, `window.open`, redirect, form post…).
public enum NavigationDecision: Equatable, Sendable {
    /// Let WebKit load it in place.
    case allow
    /// Hand it to the default browser / mail client and cancel in the web view.
    case openExternally(URL)
    /// A new-window request inside the hub origin: load it in the main window instead.
    case loadInMainFrame(URL)
    /// Turn it into a download (`<a download>`, blob URLs).
    case download
    /// Drop it (a file dragged onto a page that does not handle drops, unknown schemes).
    case cancel
}

public enum NavigationPolicy {
    /// - Parameters:
    ///   - isMainFrame: the navigation targets the top-level frame (false for iframes).
    ///   - opensNewWindow: `target=_blank` / `window.open` (WebKit reports no target frame).
    ///   - shouldDownload: WebKit's `shouldPerformDownload` (`<a download>`).
    public static func decide(url: URL?, hub: URL, isMainFrame: Bool, opensNewWindow: Bool, shouldDownload: Bool) -> NavigationDecision {
        guard let url, let scheme = url.scheme?.lowercased() else { return .cancel }
        if shouldDownload { return .download }
        switch scheme {
        case "http", "https":
            if ShellURLs.isHubOrigin(url, base: hub) {
                return opensNewWindow ? .loadInMainFrame(url) : .allow
            }
            // Other origins: embedded frames may load in place; anything top-level leaves the app.
            if !isMainFrame && !opensNewWindow { return .allow }
            return .openExternally(url)
        case "mailto", "tel", "facetime", "sms":
            return .openExternally(url)
        case "about", "blob", "data":
            return opensNewWindow ? .cancel : .allow
        default:
            // file:// (a drop the page did not handle) and everything else stays out of the shell.
            return .cancel
        }
    }

    /// Main-frame responses the web view cannot show, or that ask to be saved, become downloads.
    public static func shouldDownload(response mimeType: String?, canShowMIMEType: Bool, contentDisposition: String?) -> Bool {
        if let cd = contentDisposition?.trimmingCharacters(in: .whitespaces).lowercased(), cd.hasPrefix("attachment") { return true }
        return !canShowMIMEType && mimeType != nil
    }
}

/// Where a click on a notification (or a native button) takes the person.
public enum ShellDestination: Equatable, Sendable {
    /// A route of the web app in the main window.
    case web(String)
    /// The native Linked Folders window (sync conflicts are resolved there).
    case linkedFolders
    /// The native review window of one linked project (local changes, or changes from the server).
    case review(projectId: String, incoming: Bool)
    /// Reveal a file in Finder (finished downloads).
    case reveal(String)
    case none
}

/// The `userInfo` carried by system notifications and how a click is routed.
public enum NotificationRoute {
    public static let sessionKey = "sessionId"
    public static let routeKey = "route"
    public static let windowKey = "window"
    public static let revealKey = "reveal"
    public static let reviewKey = "review"
    public static let sideKey = "side"

    public static func session(_ id: String) -> [String: String] { [sessionKey: id] }
    public static func web(_ route: String) -> [String: String] { [routeKey: route] }
    public static let linkedFolders: [String: String] = [windowKey: "linked-folders"]
    public static func reveal(_ path: String) -> [String: String] { [revealKey: path] }
    public static func review(_ projectId: String, incoming: Bool) -> [String: String] {
        [reviewKey: projectId, sideKey: incoming ? "incoming" : "outgoing"]
    }

    public static func destination(for info: [String: String]) -> ShellDestination {
        if let sid = info[sessionKey], !sid.isEmpty { return .web(ShellURLs.sessionRoute(sid)) }
        if let r = info[routeKey], r.hasPrefix("/") { return .web(r) }
        if let pid = info[reviewKey], !pid.isEmpty { return .review(projectId: pid, incoming: info[sideKey] == "incoming") }
        if info[windowKey] == "linked-folders" { return .linkedFolders }
        if let p = info[revealKey], !p.isEmpty { return .reveal(p) }
        return .none
    }
}
