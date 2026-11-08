import AppKit
import Foundation
import WorkstationCore
@testable import WorkstationUI
import SwiftUI

// MARK: - Offscreen rendering

/// Renders SwiftUI views to PNG **without showing anything on screen**: the hosting view
/// lives in an NSWindow that is never ordered in (no `orderFront`, no `makeKey`), placed far
/// off-screen, in a process whose activation policy is `.prohibited` (no Dock icon, no menu
/// bar). `cacheDisplay` then draws the window's view hierarchy: including the SwiftUI
/// toolbar: into a bitmap.
@MainActor
enum SnapshotRenderer {
    static var outputDirectory: URL {
        // apps/mac/Tests/WorkstationUITests/UITestSupport.swift → apps/mac/.build/snapshots
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/snapshots", isDirectory: true)
    }

    private(set) static var written: [URL] = []

    private static var cleaned = false

    static func prepare() {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        // Start from an empty folder so screens that no longer exist leave no stale PNGs behind.
        if !cleaned {
            cleaned = true
            try? FileManager.default.removeItem(at: outputDirectory)
        }
        try? FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
    }

    @discardableResult
    /// - Parameter chrome: render inside a titled window frame (traffic lights included), with a
    ///   transparent full-size titlebar like the shell's main window.
    static func render<V: View>(_ view: V, name: String, size: CGSize, dark: Bool, chrome: Bool = false,
                                settle: TimeInterval = 0.35) throws -> URL {
        prepare()
        let root = view
            .environment(\.colorScheme, dark ? .dark : .light)
            .frame(width: size.width, height: size.height)
        let host = NSHostingView(rootView: root)
        let style: NSWindow.StyleMask = chrome ? [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView] : [.borderless]
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: size.width, height: size.height),
                              styleMask: style, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        if chrome { window.titlebarAppearsTransparent = true; window.titleVisibility = .hidden; window.titlebarSeparatorStyle = .none }
        window.contentView = host
        host.frame = NSRect(origin: .zero, size: size)
        settleLayout(window, host, seconds: settle)
        precondition(!window.isVisible, "snapshot windows must never be shown")
        let target: NSView = chrome ? (window.contentView?.superview ?? host) : host
        guard let rep = target.bitmapImageRepForCachingDisplay(in: target.bounds) else { throw SnapshotError.noBitmap }
        target.cacheDisplay(in: target.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { throw SnapshotError.noPNG }
        let url = outputDirectory.appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
        try png.write(to: url)
        written.append(url)
        window.contentView = nil
        window.close()
        return url
    }

    static func settleLayout(_ window: NSWindow, _ host: NSView, seconds: TimeInterval) {
        let end = Date().addingTimeInterval(seconds)
        repeat {
            host.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        } while Date() < end
        host.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
    }

    enum SnapshotError: Error { case noBitmap, noPNG }
}

// MARK: - Fakes

final class FakeEventSource: HubEventSource {
    var onEvent: ((ServerEvent) -> Void)?
    var onState: ((SocketState) -> Void)?
    private(set) var started = false
    private(set) var subscribed: [String] = []
    private(set) var sent: [ClientEvent] = []

    func start() { started = true; onState?(.connected) }
    func stop() { started = false }
    func subscribe(sessionId: String, lastSeq: Int) { subscribed.append(sessionId) }
    func unsubscribe(sessionId: String) { subscribed.removeAll { $0 == sessionId } }
    func send(_ event: ClientEvent) { sent.append(event) }

    /// Delivers an event on the main queue, like HubSocket.
    func emit(_ e: ServerEvent) { DispatchQueue.main.async { self.onEvent?(e) } }
}

/// Records what the shell asks of the web view; answers evaluations from `answers` (by script).
@MainActor
final class FakeWebPage: WebPage {
    var currentURL: URL?
    var pageZoom: Double = 1
    var loads: [URL] = []
    var scripts: [String] = []
    var reloads = 0, backs = 0, forwards = 0
    /// Result of `evaluate` for a script (exact match), else `defaultAnswer`.
    var answers: [String: Any] = [:]
    var defaultAnswer: Any? = nil

    func load(_ url: URL) { loads.append(url); currentURL = url }
    func evaluate(_ js: String) async -> Any? { scripts.append(js); return answers[js] ?? defaultAnswer }
    func reload() { reloads += 1 }
    func goBack() { backs += 1 }
    func goForward() { forwards += 1 }
}

/// Counts batches handed to the writer and executes them (deletions removed, not trashed).
final class CountingWriter: LocalWriting, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var batches: [WriteBatch] = []
    /// Where deletions go (default: removed, for tests that do not look at it).
    var deleteMode: WriteBatchExecutor.DeleteMode = .removeForTests
    /// The writer itself fails (XPC service gone, …).
    var failure: Error?
    var count: Int { lock.withLock { batches.count } }
    func apply(_ batch: WriteBatch) async throws -> WriteBatchResult {
        let (mode, failure): (WriteBatchExecutor.DeleteMode, Error?) = lock.withLock { batches.append(batch); return (deleteMode, self.failure) }
        if let failure { throw failure }
        return WriteBatchExecutor.execute(batch, deleteMode: mode)
    }
}

@MainActor
final class FakeWindows: ShellWindowPresenting {
    var calls: [String] = []
    func showMain() { calls.append("main") }
    func showLinkedFolders() { calls.append("folders") }
    func showReview(projectId: String, incoming: Bool) { calls.append("review:\(projectId):\(incoming ? "in" : "out")") }
    func showHistory(projectId: String) { calls.append("history:\(projectId)") }
}

/// The native folder picker: answers from `answers` (nil = cancelled), or waits while `hold` is set.
@MainActor
final class FakeFolderPicker {
    var calls = 0
    var answers: [URL?] = []
    var hold = false
    private var waiting: CheckedContinuation<URL?, Never>?

    nonisolated init() {}

    func pick() async -> URL? {
        calls += 1
        if hold { return await withCheckedContinuation { waiting = $0 } }
        return answers.isEmpty ? nil : answers.removeFirst()
    }

    func release(_ url: URL?) { hold = false; waiting?.resume(returning: url); waiting = nil }
}

/// Polls until `cond` is true (async propagation through Tasks / main queue).
@MainActor
func until(_ timeout: TimeInterval = 10, _ cond: @MainActor () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if cond() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return cond()
}

final class TempFolder {
    let url: URL
    init(_ name: String) {
        url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString.prefix(6))", isDirectory: true)
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
    deinit { try? FileManager.default.removeItem(at: url) }
    @discardableResult func write(_ rel: String, _ text: String) -> URL {
        let u = url.appendingPathComponent(rel)
        try! FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! Data(text.utf8).write(to: u)
        return u
    }
    func read(_ rel: String) -> String? { (try? Data(contentsOf: url.appendingPathComponent(rel))).map { String(decoding: $0, as: UTF8.self) } }

    /// Every file with its hash, size, mode and mtime.
    func fingerprint() -> [String: String] {
        var out: [String: String] = [:]
        let base = url.resolvingSymlinksInPath().path
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: nil) else { return out }
        for case let u as URL in e {
            if case let .file(size, mode, mtime) = LocalEntry.stat(u) {
                let p = u.resolvingSymlinksInPath().path
                out[p.hasPrefix(base) ? String(p.dropFirst(base.count)) : p] = "\(size):\(mode):\(mtime):\((try? FileHasher.sha256(fileAt: u)) ?? "?")"
            }
        }
        return out
    }
}

/// UserDefaults suites for tests. Each suite is a plist inside one temporary folder per test
/// process (an absolute-path suite name), never in ~/Library/Preferences; the folder is removed
/// when the process exits.
enum TestDefaults {
    static let directory: URL = {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("workstation-test-defaults-\(ProcessInfo.processInfo.processIdentifier)", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        atexit { TestDefaults.cleanUp() }
        return d
    }()

    /// A new suite `<prefix>-<uuid>`.
    static func make(_ prefix: String) -> UserDefaults { named("\(prefix)-\(UUID().uuidString)") }

    /// The suite `name` (opened again by a test that checks persistence).
    static func named(_ name: String) -> UserDefaults {
        UserDefaults(suiteName: directory.appendingPathComponent(name).path)!
    }

    static func cleanUp() {
        try? FileManager.default.removeItem(at: directory)
    }
}
