import AppKit
import Foundation
@testable import WorkstationCore
@testable import WorkstationUI
import SwiftUI
import Testing

/// Fixture data for snapshots of the remaining native UI (no network: nothing connects).
@MainActor
enum SnapshotFixture {
    static let hub = URL(string: "http://192.168.1.50:9000")!

    static let project = Project(id: "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e", user: "alice", name: "workstation", localCommit: "a1b2c3",
                                 pendingFiles: 3, sizeBytes: 48_300_000, origin: "Alice's MacBook Air")
    static let serverOnly = Project(id: "p2", user: "alice", name: "sample-app", pendingFiles: 0, sizeBytes: 15_900_000_000, origin: "my-mac")

    static let diskWarn = DiskStatus(level: .warn, usedPercent: 84, totalBytes: 128_000_000_000, freeBytes: 20_400_000_000)

    /// The web app's top-edge colours as the bootstrap script reports them (light / dark tokens).
    static func chrome(dark: Bool) -> TitlebarChrome {
        dark ? TitlebarChrome(sidebarWidth: 272, sidebar: RGBA(31, 30, 29), main: RGBA(38, 38, 36), divider: RGBA(61, 60, 57))
             : TitlebarChrome(sidebarWidth: 272, sidebar: RGBA(240, 238, 230), main: RGBA(250, 249, 245), divider: RGBA(229, 226, 217))
    }

    static func makeShell(phase: ShellModel.Phase = .online, username: String? = "alice") -> ShellModel {
        let defaults = TestDefaults.make("workstation-snap")
        let settings = AppSettings(defaults: defaults, environment: ["WORKSTATION_HUB_URL": hub.absoluteString])
        settings.username = username
        let store = LinkedProjectStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("workstation-snap-store-\(UUID().uuidString.prefix(6))"))
        let deps = ShellModel.Dependencies(settings: settings, store: store, makeEventSource: { _, _ in FakeEventSource() },
                                           notifier: RecordingNotifier(), launchAtLogin: StaticLaunchAtLogin(available: true, enabled: true),
                                           writer: CountingWriter(), syncUsesWatcher: false, openURL: { _ in }, reveal: { _ in }, offlineRetryInterval: 0)
        let shell = ShellModel(deps: deps)
        shell._setPhase(phase)
        return shell
    }

    static let notes = LinkedProject(id: "n1", name: "notes.md", localPath: NSHomeDirectory() + "/Documents", hubURL: "http://192.168.1.50:9000",
                                     user: "alice", onlyPath: "notes.md")

    static func outgoing() -> [PendingChange] {
        [PendingChange(path: "apps/mac/README.md", kind: .modified, hash: "a", size: 9_800, origin: .mac),
         PendingChange(path: "apps/mac/Sources/WorkstationCore/Sync/LineDiff.swift", kind: .added, hash: "b", size: 6_100, origin: .mac),
         PendingChange(path: "docs/old-notes.md", kind: .deleted, hash: nil, origin: .mac)]
    }

    static func incoming() -> [PendingChange] {
        [PendingChange(path: "packages/hub/src/ws/server.ts", kind: .modified, hash: "c", size: 12_400, origin: .accepted),
         PendingChange(path: "assets/logo.png", kind: .modified, hash: "d", size: 31_000, origin: .accepted),
         PendingChange(path: "packages/hub/src/old.ts", kind: .deleted, hash: nil, origin: .accepted)]
    }

    /// Linked folders with every state the folders window can show.
    static func populate(_ shell: ShellModel) {
        let p = shell.projects
        p._setConnected(user: "alice", hubURL: hub)
        p.hubProjects = [project, serverOnly]
        let lp = LinkedProject(id: project.id, name: "workstation", localPath: NSHomeDirectory() + "/Downloads/workstation", hubURL: hub.absoluteString, user: "alice")
        p._setLinked([lp, notes])
        var st = SyncStatus()
        st.phase = .watching
        st.trackedFiles = 1_284
        st.localBytes = 47_900_000
        st.outgoing = outgoing()
        st.incoming = incoming()
        st.conflicts = [SyncConflictInfo(path: "packages/hub/src/ws/server.ts", reason: "both sides changed")]
        st.skipped = [SkippedFile(path: "data/big-dataset.bin", reason: .tooLarge(240_000_000)), SkippedFile(path: "node_link", reason: .symlink)]
        st.lastSyncAt = Date()
        p.statuses[project.id] = st
        var ns = SyncStatus()
        ns.phase = .watching
        ns.trackedFiles = 1
        ns.localBytes = 4_200
        p.statuses[notes.id] = ns
    }

    /// A realistic diff for the review window.
    static func diff() -> DiffDocument {
        let old = """
        export function backoff(attempt: number): number {
          const base = 1000;
          const max = 30_000;
          return Math.min(max, base * 2 ** attempt);
        }

        export function reconnect(socket: WebSocket) {
          socket.close();
          setTimeout(() => connect(), backoff(0));
        }
        """
        let new = """
        export function backoff(attempt: number, jitter = 0.2): number {
          const base = 1000;
          const max = 30_000;
          const delay = Math.min(max, base * 2 ** attempt);
          return delay * (1 - jitter + Math.random() * 2 * jitter);
        }

        export function reconnect(socket: WebSocket, attempt: number) {
          socket.close();
          setTimeout(() => connect(), backoff(attempt));
        }
        """
        return LineDiff.document(path: "packages/hub/src/ws/server.ts", old: Data(old.utf8), new: Data(new.utf8))
    }
}

/// Stand-in for the web view in window snapshots (WKWebView renders out of process, so it never
/// shows up in `cacheDisplay`): the web app's sidebar and main colours with skeleton rows.
struct WebPlaceholder: View {
    let dark: Bool
    var body: some View {
        let c = SnapshotFixture.chrome(dark: dark)
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Circle().fill(Color(nsColor: NSColor(hex: 0x0F766E))).frame(width: 24, height: 24)
                    RoundedRectangle(cornerRadius: 4).fill(.secondary.opacity(0.35)).frame(width: 90, height: 10)
                }
                RoundedRectangle(cornerRadius: 8).fill(.secondary.opacity(0.14)).frame(height: 28)
                ForEach(0..<7, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 4).fill(.secondary.opacity(i == 1 ? 0.3 : 0.18)).frame(width: CGFloat(150 + (i * 37) % 80), height: 10)
                }
                Spacer()
            }
            .padding(.horizontal, 16).padding(.top, 10)
            .frame(width: c.sidebarWidth - 1, alignment: .leading)
            .frame(maxHeight: .infinity)
            .background(Color(nsColor: NSColor(c.sidebar!)))
            Rectangle().fill(Color(nsColor: NSColor(c.divider!))).frame(width: 1)
            VStack(spacing: 12) {
                Spacer()
                Text("web app (WKWebView)").font(.caption).foregroundStyle(.secondary)
                RoundedRectangle(cornerRadius: 14).strokeBorder(.secondary.opacity(0.3)).frame(width: 520, height: 88)
            }
            .padding(.bottom, 28)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(nsColor: NSColor(c.main!)))
        }
        .environment(\.colorScheme, dark ? .dark : .light)
    }
}

@MainActor
@Suite("Offscreen snapshots of the native UI", .serialized)
struct SnapshotTests {
    func both(_ name: String, size: CGSize, chrome: Bool = false, _ make: (Bool) -> AnyView) throws {
        for dark in [false, true] {
            let url = try SnapshotRenderer.render(make(dark), name: name, size: size, dark: dark, chrome: chrome)
            let bytes = (try? Data(contentsOf: url).count) ?? 0
            print("snapshot: \(url.path)")
            #expect(bytes > 2_000, "\(url.lastPathComponent) looks empty")
        }
    }

    /// The main window: traffic lights on the native strip, painted in the page's own colours.
    @Test func mainWindowShell() throws {
        let shell = SnapshotFixture.makeShell()
        shell._setPageLoaded(true)
        try both("main-window", size: CGSize(width: 1100, height: 640), chrome: true) { dark in
            shell._setChrome(SnapshotFixture.chrome(dark: dark))
            return AnyView(ShellRootView(shell: shell, metrics: WindowMetrics(), web: WebPlaceholder(dark: dark)))
        }
    }

    /// A dropped / picked folder on its way to a Code session, and the one-line error.
    @Test func folderSessionBadge() throws {
        let shell = SnapshotFixture.makeShell()
        shell._setPageLoaded(true)
        let folder = URL(fileURLWithPath: NSHomeDirectory() + "/code/sample-app", isDirectory: true)
        try both("folder-session-linking", size: CGSize(width: 900, height: 420), chrome: true) { dark in
            shell._setChrome(SnapshotFixture.chrome(dark: dark))
            shell._setFolderSession(FolderSessionState(folder: folder))
            return AnyView(ShellRootView(shell: shell, metrics: WindowMetrics(), web: WebPlaceholder(dark: dark)))
        }
        try both("folder-session-error", size: CGSize(width: 900, height: 420), chrome: true) { dark in
            shell._setChrome(SnapshotFixture.chrome(dark: dark))
            shell._setFolderSession(FolderSessionState(folder: folder, error: "sample-app contains workstation, which is linked on its own."))
            return AnyView(ShellRootView(shell: shell, metrics: WindowMetrics(), web: WebPlaceholder(dark: dark)))
        }
    }

    /// The upload sheet for a folder that is not linked yet: counting, then counted.
    @Test func folderUploadSheet() throws {
        let shell = SnapshotFixture.makeShell()
        let sampleApp = URL(fileURLWithPath: NSHomeDirectory() + "/code/sample-app", isDirectory: true)
        let target = LinkTarget(picked: sampleApp, root: sampleApp, onlyPath: nil, name: "sample-app")
        let counting = FolderUploadConfirmation(target: target)
        shell._setUploadConfirmation(counting)
        try both("folder-upload-counting", size: CGSize(width: 420, height: 130)) { _ in
            AnyView(FolderUploadSheet(shell: shell, confirmation: counting).background(.background))
        }
        let counted = FolderUploadConfirmation(target: target, preview: UploadPreview(files: 1_932, bytes: 214_000_000))
        shell._setUploadConfirmation(counted)
        try both("folder-upload-confirm", size: CGSize(width: 420, height: 130)) { _ in
            AnyView(FolderUploadSheet(shell: shell, confirmation: counted).background(.background))
        }
    }

    /// Server change over a local edit (the conflict sheet), and the `→ Mac` / error notices.
    @Test func incomingConflictAndNotices() throws {
        let shell = SnapshotFixture.makeShell()
        let one = IncomingConflictState(projectId: "p1", projectName: "sample-app", paths: ["src/test.py"], backupsAvailable: true)
        shell._setIncomingConflict(one)
        try both("incoming-conflict", size: CGSize(width: 660, height: 130)) { _ in
            AnyView(IncomingConflictSheet(shell: shell, conflict: one).background(.background))
        }
        var loss = IncomingConflictState(projectId: "p1", projectName: "sample-app", paths: ["src/test.py", "src/test2.py"], backupsAvailable: true)
        loss.confirmingLoss = true
        shell._setIncomingConflict(loss)
        try both("incoming-conflict-confirm-loss", size: CGSize(width: 660, height: 170)) { _ in
            AnyView(IncomingConflictSheet(shell: shell, conflict: loss).background(.background))
        }
        let server = ServerChangesState(projectId: "p1", projectName: "sample-app", items: [
            .init(path: "test.py", kind: .modified), .init(path: "test2.py", kind: .added), .init(path: "docs/old-notes.md", kind: .deleted)])
        shell._setServerChanges(server)
        try both("server-changes", size: CGSize(width: 480, height: 200)) { _ in
            AnyView(ServerChangesSheet(shell: shell, changes: server).background(.background))
        }
        let single = ServerChangesState(projectId: "p1", projectName: "sample-app", items: [.init(path: "src/test.py", kind: .modified)])
        shell._setServerChanges(single)
        try both("server-changes-one", size: CGSize(width: 480, height: 150)) { _ in
            AnyView(ServerChangesSheet(shell: shell, changes: single).background(.background))
        }
        shell._setIncomingConflict(nil)
        shell._setPageLoaded(true)
        try both("notice-applied", size: CGSize(width: 900, height: 480), chrome: true) { dark in
            shell._setChrome(SnapshotFixture.chrome(dark: dark))
            shell._setNotice(ShellNotice(text: "test.py → Mac", isError: false))
            return AnyView(ShellRootView(shell: shell, metrics: WindowMetrics(), web: WebPlaceholder(dark: dark)))
        }
        try both("notice-error", size: CGSize(width: 900, height: 480), chrome: true) { dark in
            shell._setChrome(SnapshotFixture.chrome(dark: dark))
            shell._setNotice(ShellNotice(text: "sample-app: test.py: the file changed on this Mac since you reviewed it", isError: true))
            return AnyView(ShellRootView(shell: shell, metrics: WindowMetrics(), web: WebPlaceholder(dark: dark)))
        }
    }

    /// The link selection window: rules' and the AI's skips with reasons, a mixed folder, the footer.
    @Test func linkSelectionWindow() throws {
        let f = TempFolder("workstation-snap-select")
        f.write("README.md", "# sample-app\n")
        f.write("src/main.c", String(repeating: "x", count: 4_000)); f.write("src/vendor/lib.h", "x")
        f.write("web/app.js", "a"); f.write("web/node_modules/p/i.js", "x")
        f.write("recordings/run1.mov", String(repeating: "b", count: 90_000))
        f.write("build/out.o", "o")
        let shell = SnapshotFixture.makeShell()
        f.write("src/a.c", "a"); f.write("src/b.c", "b"); f.write("src/c.c", "c")
        let model = LinkSelectionModel(root: SyncTreeScanner.scan(root: f.url), folderName: "sample-app")
        model.toggle("recordings")
        model.toggle("web/node_modules")
        let sampleApp = URL(fileURLWithPath: NSHomeDirectory() + "/code/sample-app", isDirectory: true)
        let plan = LinkPlan(target: LinkTarget(picked: sampleApp, root: sampleApp, onlyPath: nil, name: "sample-app"), files: 0, bytes: 0, skipped: 0, selection: model)
        try both("link-selection", size: CGSize(width: 580, height: 500)) { _ in
            AnyView(LinkSelectionView(projects: shell.projects, plan: plan, model: model).background(.background))
        }
    }

    @Test func offlineState() throws {
        let shell = SnapshotFixture.makeShell(phase: .offline("Can't reach the hub at http://192.168.1.50:9000."))
        try both("offline", size: CGSize(width: 1000, height: 620), chrome: true) { dark in
            AnyView(ShellRootView(shell: shell, metrics: WindowMetrics(), web: WebPlaceholder(dark: dark)))
        }
    }

    /// Offline with a Tailscale hub: the hint and the button (installed / not installed).
    @Test func offlineTailscaleHint() throws {
        let shell = SnapshotFixture.makeShell(phase: .offline("Can't reach the hub at https://workstation.example.com."))
        shell._setTailnetHint(.app(URL(fileURLWithPath: "/Applications/Tailscale.app")))
        try both("offline-tailscale", size: CGSize(width: 1000, height: 620), chrome: true) { dark in
            AnyView(ShellRootView(shell: shell, metrics: WindowMetrics(), web: WebPlaceholder(dark: dark)))
        }
        let missing = SnapshotFixture.makeShell(phase: .offline("Can't reach the hub at https://workstation.example.com."))
        missing._setTailnetHint(.download)
        try both("offline-tailscale-get", size: CGSize(width: 1000, height: 620), chrome: true) { dark in
            AnyView(ShellRootView(shell: missing, metrics: WindowMetrics(), web: WebPlaceholder(dark: dark)))
        }
    }

    @Test func firstRunSheet() throws {
        let shell = SnapshotFixture.makeShell(phase: .needsHubURL, username: nil)
        try both("first-run", size: CGSize(width: 480, height: 290)) { _ in AnyView(FirstRunView(shell: shell).background(.background)) }
        try both("first-run-error", size: CGSize(width: 480, height: 320)) { _ in
            AnyView(FirstRunView(shell: shell, error: "Can't reach the hub at http://192.168.1.50:9000.").background(.background))
        }
    }

    @Test func settings() throws {
        let shell = SnapshotFixture.makeShell()
        try both("settings-general", size: CGSize(width: 580, height: 470)) { _ in AnyView(GeneralSettingsView(shell: shell)) }
        let folders = SnapshotFixture.makeShell()
        SnapshotFixture.populate(folders)
        try both("settings-folders", size: CGSize(width: 580, height: 620)) { _ in
            AnyView(LinkedFoldersView(shell: folders, projects: folders.projects, compact: true))
        }
    }

    @Test func linkedFoldersWindow() throws {
        let shell = SnapshotFixture.makeShell()
        SnapshotFixture.populate(shell)
        shell._setDisk(SnapshotFixture.diskWarn)
        try both("linked-folders", size: CGSize(width: 620, height: 720)) { _ in
            AnyView(LinkedFoldersView(shell: shell, projects: shell.projects))
        }
        let empty = SnapshotFixture.makeShell()
        empty.projects._setConnected(user: "alice", hubURL: SnapshotFixture.hub)
        try both("linked-folders-empty", size: CGSize(width: 620, height: 380)) { _ in
            AnyView(LinkedFoldersView(shell: empty, projects: empty.projects))
        }
        let signedOut = SnapshotFixture.makeShell(username: nil)
        try both("linked-folders-signed-out", size: CGSize(width: 620, height: 300)) { _ in
            AnyView(LinkedFoldersView(shell: signedOut, projects: signedOut.projects))
        }
    }

    @Test func reviewWindow() throws {
        let shell = SnapshotFixture.makeShell()
        SnapshotFixture.populate(shell)
        let pid = SnapshotFixture.project.id
        // Changes from the server: a text diff with a file that has local edits (backup choices).
        shell.projects.statuses[pid]?.incomingWithLocalEdits = ["packages/hub/src/ws/server.ts"]
        shell.projects.statuses[pid]?.backupsAvailable = true
        let incoming = ReviewModel(projectId: pid, projects: shell.projects, incoming: true)
        incoming._setDiff(SnapshotFixture.diff(), focused: "packages/hub/src/ws/server.ts")
        incoming.checked = ["packages/hub/src/ws/server.ts", "packages/hub/src/old.ts"]
        try both("review-incoming", size: CGSize(width: 1100, height: 680)) { _ in AnyView(ReviewView(model: incoming)) }
        // Local changes: the plain diff.
        let outgoing = ReviewModel(projectId: pid, projects: shell.projects, incoming: false)
        var d = SnapshotFixture.diff()
        d.path = "apps/mac/README.md"
        outgoing._setDiff(d, focused: "apps/mac/README.md")
        try both("review-outgoing", size: CGSize(width: 1100, height: 620)) { _ in AnyView(ReviewView(model: outgoing)) }
        // A binary file, and backups unavailable on this hub.
        shell.projects.statuses[pid]?.backupsAvailable = false
        shell.projects.statuses[pid]?.incomingWithLocalEdits = ["assets/logo.png"]
        let binary = ReviewModel(projectId: pid, projects: shell.projects, incoming: true)
        binary._setDiff(LineDiff.document(path: "assets/logo.png", old: Data([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), new: Data([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9])),
                        focused: "assets/logo.png")
        try both("review-binary-no-backups", size: CGSize(width: 1100, height: 560)) { _ in AnyView(ReviewView(model: binary)) }
    }

    @Test func linkConfirmationAndDrop() throws {
        let shell = SnapshotFixture.makeShell()
        shell.projects._setConnected(user: "alice", hubURL: SnapshotFixture.hub)
        shell.projects.pendingLinks = [
            LinkPlan(target: LinkTarget(picked: URL(fileURLWithPath: NSHomeDirectory() + "/code/sample-app"), root: URL(fileURLWithPath: NSHomeDirectory() + "/code/sample-app"),
                                        onlyPath: nil, name: "sample-app"), files: 1_932, bytes: 214_000_000, skipped: 3),
            LinkPlan(target: LinkTarget(picked: URL(fileURLWithPath: NSHomeDirectory() + "/Documents/notes.md"), root: URL(fileURLWithPath: NSHomeDirectory() + "/Documents"),
                                        onlyPath: "notes.md", name: "notes.md"), files: 1, bytes: 4_200, skipped: 0),
        ]
        shell.projects.linkErrors = ["Agent Workstation is already linked."]
        try both("link-confirm", size: CGSize(width: 500, height: 330)) { _ in AnyView(LinkConfirmView(projects: shell.projects).background(.background)) }
        let drop = SnapshotFixture.makeShell()
        SnapshotFixture.populate(drop)
        try both("linked-folders-drop", size: CGSize(width: 620, height: 420)) { _ in
            AnyView(LinkedFoldersView(shell: drop, projects: drop.projects, dropTargeted: true))
        }
    }

    @Test func historyWindow() throws {
        let shell = SnapshotFixture.makeShell()
        SnapshotFixture.populate(shell)
        let pid = SnapshotFixture.project.id
        let now = Date()
        try shell.projects.store.history.record(HistoryBatch(id: "b1", at: now.addingTimeInterval(-3600 * 26), projectId: pid, projectName: "workstation", files: [
            HistoryFile(path: "packages/hub/src/ws/server.ts", op: .write, oldHash: "3f2a9c1d", newHash: "9b8e7d6c", oldRef: "commit12"),
            HistoryFile(path: "packages/hub/src/old.ts", op: .delete, oldHash: "77aa11bb", newHash: nil, oldRef: "commit12"),
        ]))
        try shell.projects.store.history.record(HistoryBatch(id: "b2", at: now.addingTimeInterval(-600), projectId: pid, projectName: "workstation", files: [
            HistoryFile(path: "README.md", op: .write, oldHash: "c0ffee12", newHash: "deadbeef", oldRef: "refs/backups/mac:Air/bk1", backedUp: true),
        ]))
        let backups = [ProjectBackup(id: "bk1", ref: "refs/backups/mac:Air/bk1", commit: "bcbk1", client: "mac:Alice's MacBook Air", reason: .overwrite,
                                     at: Formatters.iso(now.addingTimeInterval(-600)), files: [.init(path: "README.md", blob: "ce01", size: 4_246)])]
        try both("history", size: CGSize(width: 640, height: 620)) { _ in
            AnyView(HistoryView(projects: shell.projects, projectId: pid, backups: backups))
        }
    }

    @Test func zzPrintSnapshotPaths() {
        let dir = SnapshotRenderer.outputDirectory
        let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".png") }.sorted()
        print("\n=== Agent Workstation offscreen snapshots (\(files.count)) in \(dir.path) ===")
        for f in files { print(dir.appendingPathComponent(f).path) }
    }
}
