import Foundation
@testable import WorkstationCore
@testable import WorkstationUI
import Testing

/// Fake `SF_DATALESS` flags for the UI tests (paths relative to `root`).
final class FakeCloudFlags: @unchecked Sendable {
    private let lock = NSLock()
    private var paths: Set<String> = []
    let root: String
    init(root: URL, _ paths: Set<String> = []) { self.root = root.resolvingSymlinksInPath().path + "/"; self.paths = paths }
    func set(_ p: Set<String>) { lock.withLock { paths = p } }
    var probe: CloudProbe {
        CloudProbe { [self] url in
            let full = url.resolvingSymlinksInPath().path
            guard full.hasPrefix(root) else { return false }
            return lock.withLock { paths.contains(String(full.dropFirst(root.count))) }
        }
    }
}

@MainActor
@Suite("Sync selection: the selection window")
struct LinkSelectionModelTests {
    func tree() -> (TempFolder, SyncTreeNode) {
        let f = TempFolder("workstation-select")
        f.write("README.md", "# r\n")
        f.write("src/a.c", "a"); f.write("src/b.c", "b"); f.write("src/c.c", "c"); f.write("src/d.c", "d"); f.write("src/sub/x.h", "x")
        f.write("data/raw.csv", "1"); f.write("data/notes.txt", "n")
        f.write(".git/HEAD", "ref")
        return (f, SyncTreeScanner.scan(root: f.url))
    }

    @Test func firstLevelAndThreeItemsUnderEachFolderAllChecked() {
        let (f, top) = tree()
        _ = f
        let m = LinkSelectionModel(root: top, folderName: "proj")
        let ids = m.rows.map(\.id)
        #expect(ids == ["data", "data/notes.txt", "data/raw.csv", "src", "src/sub", "src/a.c", "src/b.c", "src/+more", "README.md"])
        if case .more(let n) = m.rows.first(where: { $0.id == "src/+more" })!.kind { #expect(n == 2) } else { Issue.record("no +more row") }
        #expect(!ids.contains(".git"), ".git is never shown (never synced)")
        #expect(m.rows.compactMap(\.node).allSatisfy { m.state($0.path) == .checked }, "everything checked")
        #expect(m.totals == .init(files: 8, bytes: 11))
    }

    @Test func uncheckingAndTheDecisionsItMakes() {
        let (f, top) = tree()
        _ = f
        let m = LinkSelectionModel(root: top, folderName: "proj")
        m.toggle("data")
        m.toggle("src/b.c")
        #expect(m.state("data") == .unchecked && m.state("data/raw.csv") == .unchecked)
        #expect(m.state("src") == .mixed)
        #expect(m.totals == .init(files: 5, bytes: 8))
        // Checking an item inside an unchecked folder checks the folder again.
        m.toggle("data/raw.csv")
        #expect(m.state("data") == .mixed && m.state("data/raw.csv") == .checked && m.state("data/notes.txt") == .unchecked)
        m.toggle("data")
        m.toggle("data")
        let r = m.records()
        #expect(r["data"] == SyncRecord(kind: .folder, decision: .skip, source: .you))
        #expect(r["data/raw.csv"] == nil, "an unchecked folder decides alone")
        #expect(r["src"]?.decision == .sync && r["src/b.c"]?.decision == .skip && r["src/a.c"]?.decision == .sync)
        #expect(r["src/c.c"] == nil && r["src/d.c"] == nil, "not shown: no decision of their own")
        #expect(r["README.md"]?.decision == .sync && r[""] == nil)
        // What that means once linked: src/ has something unchecked, so its unshown items wait.
        let sel = SyncSelection(records: r)
        #expect(sel.effective("src/c.c", kind: .file).decision == nil && sel.effective("src/sub/x.h", kind: .file).decision == .sync)
        #expect(sel.effective("data/raw.csv", kind: .file).decision == .skip)
        #expect(sel.effective("new-root.txt", kind: .file).decision == nil, "the root has something unchecked: new root items ask")
    }

    @Test func cloudOnlyFilesHoldTheUploadUntilLocal() {
        let f = TempFolder("workstation-select-cloud")
        f.write("src/a.c", "a"); f.write("src/b.c", "b"); f.write("old/x.bin", "x")
        let cloud = FakeCloudFlags(root: f.url, ["src/b.c", "old/x.bin"])
        let m = LinkSelectionModel(root: SyncTreeScanner.scan(root: f.url, cloud: cloud.probe), folderName: "p")
        m.folderURL = f.url
        #expect(m.cloudOnlyUploading == ["old/x.bin", "src/b.c"])
        m.toggle("old")
        #expect(m.cloudOnlyUploading == ["src/b.c"], "unchecked paths do not count")
        cloud.set([])
        #expect(m.recheckCloud(cloud.probe) && m.cloudOnlyUploading.isEmpty)
    }
}

/// Nested in the serialized shell-flow suite: both drive the one shared MockHub.
extension ShellFlowTests {
@MainActor
@Suite("Sync selection: linking, new items, cloud-only files, the bridge")
struct SyncSelectionFlowTests {
    struct Rig {
        let shell: ShellModel
        let page: FakeWebPage
        let notifier: RecordingNotifier
        let store: TempFolder
    }

    func signedIn(cloud: CloudProbe = .system) async -> Rig {
        let hub = MockHub.shared
        hub.reset()
        let settings = AppSettings(defaults: TestDefaults.make("workstation-sync"), environment: [:])
        settings.hubURLString = MockHub.baseURL.absoluteString
        let notifier = RecordingNotifier()
        let store = TempFolder("workstation-sync-store")
        let deps = ShellModel.Dependencies(settings: settings, urlSession: MockHub.session(), store: LinkedProjectStore(directory: store.url),
                                           makeEventSource: { _, _ in FakeEventSource() }, notifier: notifier,
                                           launchAtLogin: StaticLaunchAtLogin(), writer: CountingWriter(), syncUsesWatcher: false,
                                           openURL: { _ in }, reveal: { _ in }, offlineRetryInterval: 0,
                                           updateAlerts: FakeUpdateAlerts(), updateCheckInterval: 0)
        let shell = ShellModel(deps: deps)
        shell.projects.cloudProbe = cloud
        shell.projects.cloudRecheckInterval = 0.1
        let page = FakeWebPage()
        shell.page = page
        await shell.connect()
        page.answers[WebScripts.readUser] = "bob"
        shell.webPageDidFinishLoad()
        _ = await until { shell.projects.isConnected }
        return Rig(shell: shell, page: page, notifier: notifier, store: store)
    }

    func serverFiles(_ pid: String) -> Set<String> { Set(MockHub.shared.with { $0.local[pid] ?? [:] }.keys) }

    @Test func theWindowDecidesThenNewItemsFollowTheRule() async throws {
        let r = await signedIn()
        let projects = r.shell.projects
        let folder = TempFolder("workstation-sel-link")
        folder.write("src/main.c", "int main(){}\n")
        folder.write("recordings/run1.mov", "data")
        folder.write("notes.md", "n")
        folder.write(".git/HEAD", "ref")
        await projects.prepareLinks([folder.url])
        let plan = try #require(projects.pendingLinks.first)
        let model = try #require(plan.selection)
        model.toggle("recordings")
        let linked = try #require(await projects.confirmPendingLink(plan.id))
        let pid = linked.id
        #expect(await until { projects.status(pid).phase == .watching })
        #expect(serverFiles(pid) == ["src/main.c", "notes.md"], "unchecked and .git stay here")
        // The server got the exclude list (own skips) before the first upload.
        let requests = MockHub.shared.with { $0.requests }
        let put = try #require(requests.firstIndex(of: "PUT /api/projects/\(pid)/excludes"))
        let baseline = try #require(requests.firstIndex(of: "POST /api/projects/\(pid)/baseline"))
        #expect(put < baseline)
        #expect(MockHub.shared.with { $0.excludes[pid] } == [["path": "recordings", "kind": "folder"]])
        let engine = try #require(projects.engine(pid))

        // src/ has nothing unchecked: a new file there syncs with no prompt.
        folder.write("src/util.c", "u")
        await engine.handleLocalChanges(["src/util.c"])
        #expect(serverFiles(pid).contains("src/util.c"))
        // The root has recordings/ unchecked: a new root item waits (Sync tab + notification).
        folder.write("todo.txt", "t")
        await engine.handleLocalChanges(["todo.txt"])
        #expect(!serverFiles(pid).contains("todo.txt"))
        #expect(await engine.currentSelection().pending["todo.txt"] != nil)
        #expect(await until { r.notifier.posted.contains { $0.id == "selection-\(pid)" } })
        // Inside the unchecked folder: never syncs, never asks.
        folder.write("recordings/run2.mov", "data")
        await engine.handleLocalChanges(["recordings/run2.mov"])
        #expect(await engine.currentSelection().pending["recordings/run2.mov"] == nil && !serverFiles(pid).contains("recordings/run2.mov"))
        // Deciding the waiting item.
        await projects.decide(pid, [SyncDecisionInput(path: "todo.txt", kind: .file, decision: .sync)])
        #expect(serverFiles(pid).contains("todo.txt"))
        // Unchecking from the Sync tab updates the server's list.
        await projects.decide(pid, [SyncDecisionInput(path: "notes.md", kind: .file, decision: .skip)])
        #expect(MockHub.shared.with { $0.excludes[pid] } == [["path": "notes.md", "kind": "file"], ["path": "recordings", "kind": "folder"]])
    }

    @Test func droppedFolderOpensTheSameWindowAndCancelLinksNothing() async throws {
        let r = await signedIn()
        let folder = TempFolder("workstation-sel-drop")
        folder.write("pkg/package.xml", "<package/>"); folder.write("pkg/src/node.cpp", "x"); folder.write("build/out.o", "o")
        r.shell.folderDropped([folder.url])
        #expect(await until { r.shell.uploadConfirmation?.selection != nil })
        let model = try #require(r.shell.uploadConfirmation?.selection)
        #expect(model.rows.map(\.id).contains("build"), "no rules: everything shown and checked")
        r.shell.cancelFolderUpload()
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(MockHub.shared.with { $0.projects }.isEmpty)

        r.shell.folderDropped([folder.url])
        #expect(await until { r.shell.uploadConfirmation?.selection != nil })
        r.shell.uploadConfirmation?.selection?.toggle("build")
        let loads = r.page.loads.count
        await r.shell.confirmFolderUpload()
        #expect(await until { r.page.loads.count > loads })
        let pid = try #require(MockHub.shared.with { $0.projects }.first?.id)
        #expect(serverFiles(pid) == ["pkg/package.xml", "pkg/src/node.cpp"])
    }

    @Test func cloudOnlyFilesMakeTheLinkWaitThenItContinues() async throws {
        let folder = TempFolder("workstation-sel-cloud")
        folder.write("src/a.c", "a"); folder.write("src/b.c", "b")
        let cloud = FakeCloudFlags(root: folder.url, ["src/b.c"])
        let r = await signedIn(cloud: cloud.probe)
        let projects = r.shell.projects
        await projects.prepareLinks([folder.url])
        let plan = try #require(projects.pendingLinks.first)
        let model = try #require(plan.selection)
        #expect(model.cloudOnlyUploading == ["src/b.c"])
        #expect(await projects.confirmPendingLink(plan.id) == nil, "nothing uploads while files are only in the cloud")
        #expect(MockHub.shared.with { $0.projects }.isEmpty)
        // Downloaded: the re-check notices, the window lets it go.
        cloud.set([])
        #expect(await until { model.cloudOnlyUploading.isEmpty })
        let linked = try #require(await projects.confirmPendingLink(plan.id))
        #expect(await until { projects.status(linked.id).phase == .watching })
        #expect(serverFiles(linked.id) == ["src/a.c", "src/b.c"])

        // After linking: evicted → not a change; a new cloud-only file is not uploaded; one notification.
        let engine = try #require(projects.engine(linked.id))
        let pushes = MockHub.shared.with { $0.pushedOps.count }
        folder.write("src/c.c", "c")
        cloud.set(["src/a.c", "src/c.c"])
        await engine.handleLocalChanges(["src/a.c", "src/c.c"])
        #expect(MockHub.shared.with { $0.pushedOps.count } == pushes)
        #expect(serverFiles(linked.id) == ["src/a.c", "src/b.c"])
        #expect(await until { projects.status(linked.id).cloudOnly == 2 })
        #expect(await until { r.notifier.posted.filter { $0.id == "cloud-\(linked.id)" }.count == 1 })
        let note = try #require(r.notifier.posted.first { $0.id == "cloud-\(linked.id)" })
        #expect(note.title.hasPrefix("2 files only in the cloud"))
        await engine.handleLocalChanges(["src/a.c"])
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(r.notifier.posted.filter { $0.id == "cloud-\(linked.id)" }.count == 1, "one per project, not per file or per scan")
        // Local again: it syncs normally.
        cloud.set([])
        await engine.handleLocalChanges(["src/a.c", "src/c.c"])
        #expect(serverFiles(linked.id).contains("src/c.c"))
        #expect(projects.status(linked.id).cloudOnly == 0)
    }

    @Test func dropPathWaitsForCloudOnlyFilesToo() async throws {
        let folder = TempFolder("workstation-sel-drop-cloud")
        folder.write("a.txt", "a"); folder.write("b.txt", "b")
        let cloud = FakeCloudFlags(root: folder.url, ["b.txt"])
        let r = await signedIn(cloud: cloud.probe)
        r.shell.folderDropped([folder.url])
        #expect(await until { r.shell.uploadConfirmation?.selection != nil })
        await r.shell.confirmFolderUpload()
        #expect(r.shell.uploadConfirmation != nil, "Link and Upload does nothing while files are only in the cloud")
        cloud.set([])
        #expect(await until { r.shell.uploadConfirmation?.selection?.cloudOnlyUploading.isEmpty == true })
        await r.shell.confirmFolderUpload()
        #expect(await until { MockHub.shared.with { $0.projects }.count == 1 })
    }

    @Test func theBridgeServesOnlyLinkedProjects() async throws {
        let r = await signedIn()
        let projects = r.shell.projects
        let folder = TempFolder("workstation-sel-bridge")
        folder.write("src/a.c", "a"); folder.write("dist/b.js", "b")
        await projects.prepareLinks([folder.url])
        projects.pendingLinks.first?.selection?.toggle("dist")
        let linked = try #require(await projects.confirmPendingLinks().first)
        let pid = linked.id
        #expect(await until { projects.status(pid).phase == .watching })
        #expect(WebShellController.replyHandlerNames == ["workstationSync"])

        let status = try await r.shell.webPage(syncRequest: ["op": "status", "projectId": .string(pid)]).get()
        #expect(status["folder"]?.stringValue == linked.name && status["pending"]?.intValue == 0)
        #expect(try await r.shell.webPage(syncRequest: ["op": "status", "projectId": "not-linked-here"]).get() == .null)
        #expect(await r.shell.webPage(syncRequest: ["op": "list", "projectId": "not-linked-here"]) == .failure(.notLinked))
        #expect(await r.shell.webPage(syncRequest: ["op": "list", "projectId": .string(pid), "dir": "../.."]) == .failure(.invalid("dir")))
        let rows = try await r.shell.webPage(syncRequest: ["op": "list", "projectId": .string(pid)]).get().arrayValue ?? []
        let byPath = Dictionary(uniqueKeysWithValues: rows.compactMap { row in row["path"]?.stringValue.map { ($0, row) } })
        #expect(byPath["src"]?["effective"]?.stringValue == "sync" && byPath["dist"]?["effective"]?.stringValue == "skip")
        #expect(try await r.shell.webPage(syncRequest: ["op": "decide", "projectId": .string(pid),
                                                        "decisions": [["path": "dist", "kind": "folder", "decision": "sync"]]]).get() == .bool(true))
        #expect(serverFiles(pid).contains("dist/b.js"))
        #expect(await until { r.page.scripts.contains(WebScripts.syncChanged(pid)) })
        #expect(await r.shell.webPage(syncRequest: ["op": "decide", "projectId": .string(pid),
                                                    "decisions": [["path": "/etc/passwd", "kind": "file", "decision": "sync"]]]) == .failure(.invalid("decisions")))
        #expect(try await r.shell.webPage(syncRequest: ["op": "recheck", "projectId": .string(pid)]).get() == .bool(true))
    }
}
}
