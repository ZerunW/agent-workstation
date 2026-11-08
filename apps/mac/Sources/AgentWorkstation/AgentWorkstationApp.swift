import AppKit
import WorkstationCore
import WorkstationUI
import SwiftUI

/// Agent Workstation: a thin native shell around the hub's web app. The main window and Linked Folders are
/// AppKit windows (`ShellWindows`); SwiftUI provides Settings (⌘,) and the menu commands.
@main
struct WorkstationApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Settings {
            SettingsView(shell: delegate.shell)
        }
        .commands { ShellCommands(shell: delegate.shell, windows: delegate.windows) }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let shell = ShellModel(deps: .live())
    private(set) lazy var windows = ShellWindows(shell: shell)

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Needed when the binary runs outside a bundle (swift run); harmless inside AgentWorkstation.app.
        NSApp.setActivationPolicy(.regular)
        windows.showMain()
        Task { await shell.bootstrap() }
    }

    /// Closing the window keeps Agent Workstation running in the background; only ⌘Q / Quit quits.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { ShellWindows.terminatesAfterLastWindowClosed }

    /// Folders / files dropped on the Dock icon (or `open -a Agent Workstation <path>`): the link flow, with its
    /// confirmation. Nothing is written anywhere by this.
    func application(_ application: NSApplication, open urls: [URL]) {
        shell.linkDropped(urls)
    }

    /// Dock click with every window closed brings the main window back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        windows.reopen(hasVisibleWindows: flag)
    }
}
