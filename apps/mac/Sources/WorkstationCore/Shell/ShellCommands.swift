import Foundation

/// Menu commands of the shell. Each maps to a route or an action of the web app.
public enum ShellCommand: String, CaseIterable, Sendable {
    case newSession, commandPalette, find, toggleSidebar, stop
    case home, usage, instructions, memory, projects, skills, browserSites, admin
    case docs
    case reload, back, forward
    case zoomIn, zoomOut, actualSize
}

/// A ⌘-shortcut the web app already handles (`useHotkeys` in `pages/Workbench.tsx`). The shell
/// synthesises the keydown; when no page handler takes it (another page is open), it navigates to
/// `fallback` and, with `retryAfterFallback`, sends the shortcut again once the page is there.
public struct WebShortcut: Equatable, Sendable {
    public var key: String
    public var code: String
    public var shift: Bool
    public var fallback: String?
    public var retryAfterFallback: Bool

    public init(key: String, code: String, shift: Bool = false, fallback: String? = nil, retryAfterFallback: Bool = false) {
        self.key = key; self.code = code; self.shift = shift; self.fallback = fallback; self.retryAfterFallback = retryAfterFallback
    }
}

public enum ShellAction: Equatable, Sendable {
    case navigate(String)
    case shortcut(WebShortcut)
    case reload, goBack, goForward
    case zoom(Double)
}

public enum ShellCommandMap {
    public static let newSession = WebShortcut(key: "n", code: "KeyN", fallback: "/")
    public static let commandPalette = WebShortcut(key: "k", code: "KeyK", fallback: "/", retryAfterFallback: true)
    public static let toggleSidebar = WebShortcut(key: "/", code: "Slash", fallback: "/", retryAfterFallback: true)
    public static let stop = WebShortcut(key: ">", code: "Period", shift: true)
    /// ⌘F: the web app decides (find bar inside a session, session search elsewhere). No fallback: leaving the page
    /// (the home page is a new conversation) would be worse than doing nothing on a web version without the handler.
    public static let find = WebShortcut(key: "f", code: "KeyF")

    public static func action(for command: ShellCommand, zoom: Double) -> ShellAction {
        switch command {
        case .newSession: return .shortcut(newSession)
        case .commandPalette: return .shortcut(commandPalette)
        case .find: return .shortcut(find)
        case .toggleSidebar: return .shortcut(toggleSidebar)
        case .stop: return .shortcut(stop)
        case .home: return .navigate("/")
        case .usage: return .navigate("/usage")
        case .instructions: return .navigate("/instructions")
        case .memory: return .navigate("/memory")
        case .projects: return .navigate("/projects")
        case .skills: return .navigate("/skills")
        case .browserSites: return .navigate("/browser-sites")
        case .admin: return .navigate("/admin")
        case .docs: return .navigate("/readme")
        case .reload: return .reload
        case .back: return .goBack
        case .forward: return .goForward
        case .zoomIn: return .zoom(ZoomSteps.next(after: zoom))
        case .zoomOut: return .zoom(ZoomSteps.previous(before: zoom))
        case .actualSize: return .zoom(1)
        }
    }
}

/// Page zoom levels (Safari's).
public enum ZoomSteps {
    public static let levels: [Double] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]

    public static func next(after z: Double) -> Double { levels.first { $0 > z + 0.001 } ?? levels.last! }
    public static func previous(before z: Double) -> Double { levels.last { $0 < z - 0.001 } ?? levels.first! }
    public static func clamp(_ z: Double) -> Double { min(levels.last!, max(levels.first!, z.isFinite ? z : 1)) }
}
