import AppKit
import Combine
import WorkstationCore
import SwiftUI

/// The shell's AppKit windows: the main window (web app) and Linked Folders. AppKit-managed so
/// the main window keeps its web view across ⌘W (it is hidden, not destroyed) and can be brought
/// back from a notification click, the Dock or the Window menu.
///
/// Closing the window never quits Agent Workstation (like Slack): the page keeps running in the hidden web
/// view, the native hub connection stays up and notifications still arrive. Only ⌘Q / Quit quits.
@MainActor
public final class ShellWindows: NSObject, ShellWindowPresenting, NSWindowDelegate {
    public let shell: ShellModel
    public let web: WebShellController
    let metrics = WindowMetrics()
    /// Brings a window forward (tests record instead of showing anything on screen).
    public var present: (NSWindow) -> Void = { w in
        w.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    /// `applicationShouldTerminateAfterLastWindowClosed`: closing the last window keeps Agent Workstation running.
    public static let terminatesAfterLastWindowClosed = false
    private var main: NSWindow?
    private var folders: NSWindow?
    private var reviews: [String: (window: NSWindow, model: ReviewModel)] = [:]
    private var histories: [String: NSWindow] = [:]
    private var cancellables: Set<AnyCancellable> = []

    /// - Parameter web: nil = the live controller (persistent website data store).
    public init(shell: ShellModel, web: WebShellController? = nil) {
        self.shell = shell
        self.web = web ?? WebShellController()
        super.init()
        self.web.delegate = shell
        self.web.hubURLProvider = { [weak shell] in shell?.hubURL }
        shell.windows = self
    }

    /// The one main window (created once, then only hidden and shown again).
    public var mainWindow: NSWindow? { main }

    public func showMain() {
        present(main ?? makeMain())
    }

    /// Dock icon click (`applicationShouldHandleReopen`): no visible window → the same main window again.
    @discardableResult
    public func reopen(hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows { showMain() }
        return true
    }

    public func showLinkedFolders() {
        present(folders ?? makeFolders())
    }

    /// The review window of one project (approvals happen only here).
    public func showReview(projectId: String, incoming: Bool) {
        if let r = reviews[projectId] {
            r.model.incoming = incoming
            present(r.window)
            return
        }
        let model = ReviewModel(projectId: projectId, projects: shell.projects, incoming: incoming)
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = "Review: \(shell.projects.project(projectId)?.name ?? "Project")"
        w.isReleasedWhenClosed = false
        w.tabbingMode = .disallowed
        w.contentView = NSHostingView(rootView: ReviewView(model: model) { [weak w] in w?.close() })
        w.setFrameAutosaveName("WorkstationReview")
        if !w.setFrameUsingName("WorkstationReview") { w.center() }
        reviews[projectId] = (w, model)
        present(w)
    }

    public func showHistory(projectId: String) {
        if let w = histories[projectId] { present(w); return }
        // A restored version is written by itself (or raises the conflict sheet over local edits);
        // the review window opens only if something is still staged afterwards.
        let view = HistoryView(projects: shell.projects, projectId: projectId) { [weak self] in
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                guard let self, !self.shell.projects.status(projectId).incoming.isEmpty, self.shell.incomingConflict == nil else { return }
                self.showReview(projectId: projectId, incoming: true)
            }
        }
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 620),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = "History: \(shell.projects.project(projectId)?.name ?? "Project")"
        w.isReleasedWhenClosed = false
        w.contentView = NSHostingView(rootView: view)
        w.center()
        histories[projectId] = w
        present(w)
    }

    private func makeMain() -> NSWindow {
        let root = ShellRootView(shell: shell, metrics: metrics, web: ShellWebView(controller: web))
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                         backing: .buffered, defer: false)
        w.title = "Agent Workstation"
        w.titleVisibility = .hidden
        w.titlebarAppearsTransparent = true
        w.titlebarSeparatorStyle = .none
        w.isReleasedWhenClosed = false
        w.tabbingMode = .disallowed
        w.collectionBehavior.insert(.fullScreenPrimary)
        w.backgroundColor = Theme.pageBackground
        w.minSize = NSSize(width: 720, height: 480)
        w.contentView = NSHostingView(rootView: root)
        w.setFrameAutosaveName("WorkstationMain")
        if !w.setFrameUsingName("WorkstationMain") { w.center() }
        w.delegate = self
        main = w
        metrics.update(from: w)
        shell.page = web
        shell.$pageTitle.sink { [weak w] t in w?.title = t }.store(in: &cancellables)
        // Keyboard shortcuts reach the page first once it is there.
        shell.$pageLoaded.filter { $0 }.sink { [weak self, weak w] _ in
            guard let self, let w, !(w.firstResponder is NSText) else { return }
            if w.firstResponder === w || w.firstResponder == nil { w.makeFirstResponder(self.web.webView) }
        }.store(in: &cancellables)
        return w
    }

    private func makeFolders() -> NSWindow {
        let view = LinkedFoldersView(shell: shell, projects: shell.projects)
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 560),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = "Linked Folders"
        w.isReleasedWhenClosed = false
        w.tabbingMode = .disallowed
        w.contentView = NSHostingView(rootView: view)
        w.setFrameAutosaveName("WorkstationLinkedFolders")
        if !w.setFrameUsingName("WorkstationLinkedFolders") { w.center() }
        folders = w
        // Badge: pending changes in the title.
        shell.projects.objectWillChange.receive(on: RunLoop.main).sink { [weak self, weak w] _ in
            guard let self else { return }
            let n = self.shell.projects.pendingCount
            w?.title = n > 0 ? "Linked Folders: \(n) to review" : "Linked Folders"
        }.store(in: &cancellables)
        return w
    }

    // MARK: NSWindowDelegate (main window)

    /// ⌘W / the close button on the main window: hide it. The web view, its page and the hub
    /// connection stay alive; the same window comes back on reopen.
    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender === main else { return true }
        sender.orderOut(nil)
        return false
    }

    public func windowDidResize(_ notification: Notification) { if let w = main { metrics.update(from: w) } }
    public func windowDidEnterFullScreen(_ notification: Notification) { if let w = main { metrics.update(from: w) } }
    public func windowDidExitFullScreen(_ notification: Notification) { if let w = main { metrics.update(from: w) } }
}

/// The Help menu: replaces SwiftUI's default item (a help-book search with nothing to search).
public enum HelpMenu {
    public struct Item: Equatable {
        public var title: String
        public var command: ShellCommand
        /// ⌘ + this character.
        public var key: Character
    }
    public static let items = [Item(title: "Agent Workstation Docs", command: .docs, key: "?")]
}

/// Menu commands. Most map to the web app (routes or its own ⌘-shortcuts, see `ShellCommandMap`).
public struct ShellCommands: Commands {
    @ObservedObject var shell: ShellModel
    let windows: ShellWindowPresenting

    public init(shell: ShellModel, windows: ShellWindowPresenting) {
        self.shell = shell
        self.windows = windows
    }

    public var body: some Commands {
        CommandGroup(replacing: .help) {
            ForEach(HelpMenu.items, id: \.title) { item in
                Button(item.title) { shell.perform(item.command) }
                    .keyboardShortcut(KeyEquivalent(item.key), modifiers: .command)
            }
        }
        CommandGroup(after: .appInfo) {
            Button("Check for Updates…") { shell.updates.checkManually() }
        }
        CommandGroup(replacing: .newItem) {
            Button("New Session") { shell.perform(.newSession) }
                .keyboardShortcut("n", modifiers: .command)
            Button("Link Folder or File…") { shell.linkWithPanel() }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(!shell.projects.isConnected || shell.diskLevel == .block)
        }
        CommandGroup(after: .pasteboard) {
            Divider()
            Button("Find") { shell.perform(.find) }
                .keyboardShortcut("f", modifiers: .command)
            Button("Command Palette") { shell.perform(.commandPalette) }
                .keyboardShortcut("k", modifiers: .command)
        }
        CommandGroup(after: .sidebar) {
            Button("Toggle Sidebar") { shell.perform(.toggleSidebar) }
                .keyboardShortcut("/", modifiers: .command)
            Button("Reload Page") { shell.perform(.reload) }
                .keyboardShortcut("r", modifiers: .command)
            Divider()
            Button("Actual Size") { shell.perform(.actualSize) }
                .keyboardShortcut("0", modifiers: .command)
                .disabled(abs(shell.pageZoom - 1) < 0.001)
            Button("Zoom In") { shell.perform(.zoomIn) }
                .keyboardShortcut("=", modifiers: .command)
            Button("Zoom Out") { shell.perform(.zoomOut) }
                .keyboardShortcut("-", modifiers: .command)
            Divider()
        }
        CommandMenu("Go") {
            Button("Back") { shell.perform(.back) }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(!shell.canGoBack)
            Button("Forward") { shell.perform(.forward) }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(!shell.canGoForward)
            Divider()
            Button("Sessions") { shell.perform(.home) }
                .keyboardShortcut("h", modifiers: [.command, .shift])
            Button("Projects") { shell.perform(.projects) }
                .keyboardShortcut("p", modifiers: [.command, .shift])
            Button("Usage") { shell.perform(.usage) }
                .keyboardShortcut("u", modifiers: .command)
            Button("Instructions") { shell.perform(.instructions) }
            Button("Memory") { shell.perform(.memory) }
                .keyboardShortcut("m", modifiers: [.command, .shift])
            Button("Skills") { shell.perform(.skills) }
            Button("Browser Sites") { shell.perform(.browserSites) }
            if shell.isAdmin { Button("Admin") { shell.perform(.admin) } }
        }
        CommandMenu("Session") {
            Button("Stop Response") { shell.perform(.stop) }
                .keyboardShortcut(".", modifiers: [.command, .shift])
        }
        CommandGroup(before: .windowList) {
            Button("Agent Workstation") { windows.showMain() }
                .keyboardShortcut("1", modifiers: .command)
            Button(shell.projects.pendingCount > 0 ? "Linked Folders (\(shell.projects.pendingCount) to review)" : "Linked Folders") { windows.showLinkedFolders() }
                .keyboardShortcut("l", modifiers: [.command, .shift])
            Divider()
        }
    }
}
