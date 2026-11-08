import AppKit
import Foundation
@testable import WorkstationCore
@testable import WorkstationUI
import Testing

/// Closing the main window keeps Agent Workstation running: the window is hidden, the same window and web
/// view come back on reopen or a notification click. Headless: the window is never ordered in
/// (`present` records instead), no hub is contacted.
@MainActor
@Suite("Main window lifecycle", .serialized)
struct WindowLifecycleTests {
    struct Rig {
        let shell: ShellModel
        let windows: ShellWindows
        let presented: Box
    }

    final class Box { var windows: [NSWindow] = [] }

    func makeRig() -> Rig {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let settings = AppSettings(defaults: TestDefaults.make("workstation-window"), environment: [:])
        let store = FileManager.default.temporaryDirectory.appendingPathComponent("workstation-window-store-\(UUID().uuidString.prefix(6))")
        let deps = ShellModel.Dependencies(settings: settings, store: LinkedProjectStore(directory: store),
                                           makeEventSource: { _, _ in FakeEventSource() }, notifier: RecordingNotifier(),
                                           launchAtLogin: StaticLaunchAtLogin(), writer: CountingWriter(), syncUsesWatcher: false,
                                           openURL: { _ in }, reveal: { _ in }, offlineRetryInterval: 0,
                                           updateAlerts: FakeUpdateAlerts(), updateCheckInterval: 0)
        let shell = ShellModel(deps: deps)
        let windows = ShellWindows(shell: shell, web: WebShellController(persistent: false))
        let box = Box()
        windows.present = { box.windows.append($0) }
        return Rig(shell: shell, windows: windows, presented: box)
    }

    @Test func closingLastWindowDoesNotQuit() {
        #expect(ShellWindows.terminatesAfterLastWindowClosed == false)
    }

    @Test func closeHidesAndReopenShowsTheSameWindowAndWebView() throws {
        let r = makeRig()
        r.windows.showMain()
        let main = try #require(r.windows.mainWindow)
        let webView = r.windows.web.webView
        #expect(r.presented.windows.map { ObjectIdentifier($0) } == [ObjectIdentifier(main)])
        #expect(r.shell.page === r.windows.web)
        #expect(main.styleMask.contains(.closable) && !main.isReleasedWhenClosed && main.delegate === r.windows)
        #expect(!main.isVisible, "never shown in tests")

        // ⌘W / close button: hidden, not closed; nothing is torn down.
        #expect(r.windows.windowShouldClose(main) == false)
        #expect(r.windows.mainWindow === main)
        #expect(r.windows.web.webView === webView)
        #expect(r.shell.page === r.windows.web)
        #expect(r.windows.web.delegate === r.shell)

        // Dock icon with no visible window → the same window again; with one visible → nothing new.
        #expect(r.windows.reopen(hasVisibleWindows: false))
        #expect(r.presented.windows.count == 2 && r.presented.windows.last === main)
        #expect(r.windows.reopen(hasVisibleWindows: true))
        #expect(r.presented.windows.count == 2)
        // Window menu → "Agent Workstation" (⌘1) uses the same path.
        r.windows.showMain()
        #expect(r.presented.windows.count == 3 && r.presented.windows.allSatisfy { $0 === main })
        #expect(r.windows.web.webView === webView)
    }

    @Test func notificationClickWhileClosedShowsTheWindowAndOpensTheSession() throws {
        let r = makeRig()
        r.windows.showMain()
        let main = try #require(r.windows.mainWindow)
        _ = r.windows.windowShouldClose(main)
        let sid = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e"
        r.shell.openFromNotification(NotificationRoute.session(sid))
        #expect(r.presented.windows.count == 2 && r.presented.windows.last === main, "the same window comes back")
        #expect(r.shell._pendingRoute == "/s/\(sid)", "opens that session once the page is there")
    }

    @Test func otherWindowsStillCloseNormally() throws {
        let r = makeRig()
        r.windows.showLinkedFolders()
        let folders = try #require(r.presented.windows.last)
        #expect(r.windows.windowShouldClose(folders) == true)
    }
}
