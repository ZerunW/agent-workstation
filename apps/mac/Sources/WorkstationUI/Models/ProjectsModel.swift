import AppKit
import Foundation
import WorkstationCore
import SystemConfiguration

public struct PendingConflict: Identifiable, Equatable {
    public var projectId: String
    public var projectName: String
    public var path: String
    public var reason: String
    public var id: String { projectId + ":" + path }
}

/// What a Code session for a folder needs (`ProjectsModel.planSessionFolder`).
public enum SessionFolderPlan: Equatable, Sendable {
    /// Already linked, or inside a linked folder: nothing is uploaded.
    case reuse(projectId: String, subpath: String)
    /// Not linked yet: link and upload after the person confirms.
    case link(LinkTarget)
}

/// File count and size of a first upload (`truncated` = counting stopped early; a lower bound).
public struct UploadPreview: Equatable, Sendable {
    public var files: Int
    public var bytes: Int64
    public var truncated: Bool
    public init(files: Int, bytes: Int64, truncated: Bool = false) { self.files = files; self.bytes = bytes; self.truncated = truncated }
}

/// A thread-safe "stop" switch for blocking work.
final class StopFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isSet: Bool { lock.withLock { value } }
    func set() { lock.withLock { value = true } }
}

/// A folder or file about to be linked: shown in the confirmation sheet before the first upload.
/// Folders carry their selection (rules at once, the AI streamed in, the person's checks).
public struct LinkPlan: Identifiable, Equatable {
    public var id = UUID()
    public var target: LinkTarget
    public var files: Int
    public var bytes: Int64
    public var skipped: Int
    public var selection: LinkSelectionModel?

    public init(target: LinkTarget, files: Int, bytes: Int64, skipped: Int, selection: LinkSelectionModel? = nil) {
        self.target = target; self.files = files; self.bytes = bytes; self.skipped = skipped; self.selection = selection
    }

    public static func == (a: LinkPlan, b: LinkPlan) -> Bool {
        a.id == b.id && a.target == b.target && a.files == b.files && a.bytes == b.bytes && a.skipped == b.skipped && a.selection === b.selection
    }
}

/// Linked folders and files with their sync engines.
///
/// Nothing in a linked folder is created, modified or deleted except by the writer. Server → Mac
/// (docs/MAC-APP.md, "Server changes back to the Mac"): an incoming change is written without a
/// further click only when the person decided it in this app: accepted in this window's Changes
/// tab (a live `AcceptedReport` with the same path and content hash) or restored from the History
/// window. Those writes keep the old version in History and send deletions to the Trash. Every
/// other incoming change waits for "Apply to Mac" in a native sheet; a file with unsynced local
/// edits is never overwritten without the conflict sheet. Mac → server changes in the checked
/// scope are pushed automatically; the rest wait in the review window.
/// Linking reads (and uploads after a confirmation).
@MainActor
public final class ProjectsModel: ObservableObject {
    @Published public private(set) var linked: [LinkedProject] = []
    @Published public var statuses: [String: SyncStatus] = [:]
    /// The user's projects on the server (names, sizes, pending review counts).
    @Published public var hubProjects: [Project] = []
    @Published public var linking = false
    @Published public var message: String?
    /// Waiting for "Link and Upload" in the confirmation sheet.
    @Published public var pendingLinks: [LinkPlan] = []
    /// Paths that could not be linked (shown with the confirmation sheet / as a message).
    @Published public var linkErrors: [String] = []
    /// Disk guard reason while syncing to the server is paused.
    @Published public private(set) var blockedReason: String?

    /// A new conflict needs the person (the shell posts a notification).
    public var onConflict: ((PendingConflict) -> Void)?
    /// Counts of pending changes went up: (project, outgoing, incoming).
    public var onPendingIncreased: ((LinkedProject, Int, Int) -> Void)?
    /// Apply approved incoming changes without asking and raise the sheets (off only in tests of the review window).
    public var autoApplyIncoming = true
    /// How long an accept report from the page authorises matching server changes.
    public static let reportLifetime: TimeInterval = 5 * 60
    /// Clock (tests move it past `reportLifetime`).
    public var now: () -> Date = Date.init
    /// Incoming changes nobody approved in this app (new ones since the last call): (project, items).
    public var onServerChanges: ((LinkedProject, [PendingChange]) -> Void)?
    /// Incoming changes were written to the Mac automatically: (project, paths).
    public var onAutoApplied: ((LinkedProject, [String]) -> Void)?
    /// An automatic apply failed or was refused: (project, one line).
    public var onAutoApplyFailed: ((LinkedProject, String) -> Void)?
    /// Incoming changes hit files with unsynced local edits (new ones since the last call): (project, paths).
    public var onIncomingConflict: ((LinkedProject, [String]) -> Void)?
    /// Sync selection changed for a project (pending items or decisions): the shell tells the page.
    public var onSyncChanged: ((String) -> Void)?
    /// New items now wait in a project: (project, how many wait).
    public var onSelectionPending: ((LinkedProject, Int) -> Void)?
    /// Cloud-only detection (tests inject fake flags).
    public var cloudProbe: CloudProbe = .system
    /// Seconds between metadata re-checks while cloud-only files hold up a link.
    public var cloudRecheckInterval: TimeInterval = 3
    /// More files of a project became cloud-only: (project, count, provider). One notification per project.
    public var onCloudOnly: ((LinkedProject, Int, CloudProvider) -> Void)?

    public let store: LinkedProjectStore
    public let writer: LocalWriting
    private let useWatcher: Bool
    private var engines: [String: SyncEngine] = [:]
    private var scopes: [String: URL] = [:]
    private var client: HubClient?
    public private(set) var user: String?
    private var hubURL: String?
    private var timer: Timer?
    private var lastActivationReconcile = Date.distantPast
    private var generation = 0
    private var reviewReconcile: [String: Task<Void, Never>] = [:]
    private var autoApplying: Set<String> = []
    /// `path|hash` of incoming items an automatic apply already failed on (not retried automatically).
    private var autoApplyFailed: [String: Set<String>] = [:]
    /// `path|hash` of conflicting incoming items already surfaced.
    private var surfacedConflicts: [String: Set<String>] = [:]
    /// `path|hash` of unapproved incoming items already put in an "Apply to Mac" sheet.
    private var surfacedServerChanges: [String: Set<String>] = [:]
    /// Accept reports from this window's Changes tab, per project: `path|sha256` → when.
    private var acceptReports: [String: [String: Date]] = [:]
    /// `path|hash` restored from the History window (a native click): written directly.
    private var nativeApproved: [String: Set<String>] = [:]

    public enum ReconcileReason { case launch, activation, timer, manual }

    public init(store: LinkedProjectStore, writer: LocalWriting, useWatcher: Bool = true) {
        self.store = store
        self.writer = writer
        self.useWatcher = useWatcher
    }

    public var isConnected: Bool { client != nil }
    public func engine(_ projectId: String) -> SyncEngine? { engines[projectId] }
    public func hubProject(_ id: String) -> Project? { hubProjects.first { $0.id == id } }
    public func project(_ id: String) -> LinkedProject? { linked.first { $0.id == id } }
    public func status(_ id: String) -> SyncStatus { statuses[id] ?? SyncStatus() }

    /// Pending changes across all linked folders (menu badge).
    public var pendingCount: Int { statuses.values.reduce(0) { $0 + $1.outgoing.count + $1.incoming.count } }

    // MARK: Lifecycle

    /// Loads what is linked for this hub + user and starts the engines (read-only access).
    public func start(client: HubClient, user: String, hubURL: String) async {
        stopAll()
        let gen = generation
        self.client = client
        self.user = user
        self.hubURL = hubURL
        linked = store.load().filter { $0.user == user && $0.hubURL == hubURL }.map(openScope)
        await refreshHubProjects()
        for p in linked {
            guard gen == generation else { return }
            await startEngine(for: p)
        }
        guard gen == generation else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.reconcileAll(reason: .timer) }
        }
    }

    /// Stops every engine (logout, hub change, quitting). Links and pending changes stay saved.
    public func stopAll() {
        generation += 1
        timer?.invalidate()
        timer = nil
        let all = engines.values
        engines = [:]
        for e in all { Task { await e.stop() } }
        for url in scopes.values { url.stopAccessingSecurityScopedResource() }
        scopes = [:]
        client = nil
        user = nil
        hubURL = nil
        linked = []
        statuses = [:]
        hubProjects = []
        autoApplyFailed = [:]
        surfacedConflicts = [:]
        surfacedServerChanges = [:]
        nativeApproved = [:]
    }

    public func refreshHubProjects() async {
        guard let client else { return }
        if let list = try? await client.projects() { hubProjects = list }
    }

    /// Resolves the read-only bookmark (following a moved folder) and starts read-only access.
    private func openScope(_ p: LinkedProject) -> LinkedProject {
        guard let data = p.bookmark, let r = Bookmarks.resolve(data) else { return p }
        var q = p
        if r.url.startAccessingSecurityScopedResource() { scopes[p.id] = r.url }
        let url = r.url.standardizedFileURL
        if p.isSingleFile {
            q.localPath = url.deletingLastPathComponent().path
            q.onlyPath = url.lastPathComponent
        } else {
            q.localPath = url.path
        }
        if r.stale, let fresh = Bookmarks.readOnly(for: url) { q.bookmark = fresh }
        if q != p { store.upsert(q) }
        return q
    }

    private func startEngine(for p: LinkedProject) async {
        guard let client else { return }
        let gen = generation
        let engine = SyncEngine(project: p, transport: client, store: store, writer: writer, useWatcher: useWatcher, cloud: cloudProbe)
        engines[p.id] = engine
        let pid = p.id
        await engine.setHandlers(
            status: { [weak self] s in Task { @MainActor in self?.statusArrived(pid, s) } },
            conflict: { [weak self] c in Task { @MainActor in self?.conflictArrived(pid, c) } }
        )
        await engine.setPendingHandler { [weak self] paths in Task { @MainActor in self?.pendingArrived(pid, paths) } }
        if let blockedReason { await engine.setPushesBlocked(blockedReason) }
        await engine.start()
        guard gen == generation else { await engine.stop(); return }
        statusArrived(pid, await engine.currentStatus())
    }

    private func statusArrived(_ pid: String, _ s: SyncStatus) {
        let old = statuses[pid]
        statuses[pid] = s
        guard let p = project(pid) else { return }
        if s.outgoing.count > (old?.outgoing.count ?? 0) || s.incoming.count > (old?.incoming.count ?? 0) {
            onPendingIncreased?(p, s.outgoing.count, s.incoming.count)
        }
        if s.cloudOnly > (old?.cloudOnly ?? 0) { onCloudOnly?(p, s.cloudOnly, CloudProvider.detect(p.localURL)) }
        handleIncoming(p, s)
    }

    // MARK: Server → Mac (automatic for clean files, conflict sheet for local edits)

    static func incomingKey(_ e: PendingChange) -> String { e.path + "|" + (e.hash ?? "-") }

    /// The page reported a successful accept in this window's Changes tab.
    public func noteAccepted(_ report: AcceptedReport) {
        let at = now()
        var live = (acceptReports[report.projectId] ?? [:]).filter { at.timeIntervalSince($0.value) <= Self.reportLifetime }
        for f in report.files { live[f.path + "|" + (f.sha256 ?? "-")] = at }
        acceptReports[report.projectId] = live
        if let p = project(report.projectId) { handleIncoming(p, status(p.id)) }
    }

    /// A live report lists this path with this content (or as deleted).
    func isReported(_ pid: String, _ e: PendingChange) -> Bool {
        guard (e.kind == .deleted) == (e.hash == nil), let at = acceptReports[pid]?[Self.incomingKey(e)] else { return false }
        return now().timeIntervalSince(at) <= Self.reportLifetime
    }

    private func handleIncoming(_ p: LinkedProject, _ s: SyncStatus) {
        guard autoApplyIncoming, !p.paused, engines[p.id] != nil else { return }
        let edits = Set(s.incomingWithLocalEdits)
        let failed = autoApplyFailed[p.id] ?? []
        let native = nativeApproved[p.id] ?? []
        let clean = s.incoming.filter { !edits.contains($0.path) }
        let approved = clean.filter { (native.contains(Self.incomingKey($0)) || isReported(p.id, $0)) && !failed.contains(Self.incomingKey($0)) }
        if !approved.isEmpty, !autoApplying.contains(p.id) { autoApply(p.id, approved) }

        // Not approved here → the "Apply to Mac" sheet (once per set; new items bring it back).
        let approvedKeys = Set(approved.map(Self.incomingKey))
        let unapproved = clean.filter { !approvedKeys.contains(Self.incomingKey($0)) && !native.contains(Self.incomingKey($0)) && !isReported(p.id, $0) }
        let serverKeys = Set(unapproved.map(Self.incomingKey))
        let shownServer = surfacedServerChanges[p.id] ?? []
        surfacedServerChanges[p.id] = serverKeys
        if !serverKeys.subtracting(shownServer).isEmpty { onServerChanges?(p, unapproved) }

        let conflicting = s.incoming.filter { edits.contains($0.path) }
        let keys = Set(conflicting.map(Self.incomingKey))
        let before = surfacedConflicts[p.id] ?? []
        surfacedConflicts[p.id] = keys
        if !keys.subtracting(before).isEmpty { onIncomingConflict?(p, conflicting.map(\.path)) }
    }

    /// Writes approved incoming changes through the writer, after checking that each staged
    /// version really has the approved hash. A file that gained local edits meanwhile is skipped
    /// (the engine re-checks every file; `.skip` covers exactly those) and becomes a conflict.
    private func autoApply(_ pid: String, _ items: [PendingChange]) {
        guard let engine = engines[pid] else { return }
        autoApplying.insert(pid)
        let gen = generation
        Task {
            var paths: [String] = []
            for e in items {
                if let h = e.hash {
                    guard let data = await engine.incomingContent(e.path), FileHasher.sha256(data) == h else {
                        autoApplyFailed[pid, default: []].insert(Self.incomingKey(e))
                        continue
                    }
                }
                paths.append(e.path)
            }
            let outcome: Result<ApplyReport, Error>
            do {
                outcome = .success(paths.isEmpty ? ApplyReport()
                                   : try await engine.applyIncoming(paths, choices: Dictionary(uniqueKeysWithValues: paths.map { ($0, .skip) })))
            } catch {
                outcome = .failure(error)
            }
            autoApplying.remove(pid)
            guard gen == generation, let p = project(pid) else { return }
            let staged = await engine.currentStatus()
            switch outcome {
            case .success(let r):
                let refused = Set(r.refused.map(\.path))
                for e in staged.incoming where refused.contains(e.path) { autoApplyFailed[pid, default: []].insert(Self.incomingKey(e)) }
                if !r.applied.isEmpty { onAutoApplied?(p, r.applied) }
                if let first = r.refused.first { onAutoApplyFailed?(p, "\(first.path): \(first.reason)") }
            case .failure(let error):
                for e in staged.incoming where paths.contains(e.path) { autoApplyFailed[pid, default: []].insert(Self.incomingKey(e)) }
                onAutoApplyFailed?(p, error.localizedDescription.split(whereSeparator: \.isNewline).first.map(String.init) ?? "Couldn't apply the changes.")
            }
            statusArrived(pid, staged)
        }
    }

    private func conflictArrived(_ pid: String, _ c: SyncConflictInfo) {
        let name = project(pid)?.name ?? hubProject(pid)?.name ?? "project"
        onConflict?(PendingConflict(projectId: pid, projectName: name, path: c.path, reason: c.reason))
    }

    // MARK: Sync selection: new items, the AI pass, the person's decisions

    /// New waiting items: the page hears about it, and one notification per project carries the count.
    func pendingArrived(_ pid: String, _ paths: [String]) {
        onSyncChanged?(pid)
        if let p = project(pid) { onSelectionPending?(p, max(statuses[pid]?.pendingSelection ?? 0, paths.count)) }
    }

    /// The person's answers from the Sync tab or the pending list.
    public func decide(_ pid: String, _ inputs: [SyncDecisionInput]) async {
        guard let engine = engines[pid] else { return }
        await engine.applyDecisions(inputs)
        statusArrived(pid, await engine.currentStatus())
        onSyncChanged?(pid)
    }

    /// Scans `dir` again for waiting items.
    public func recheck(_ pid: String, dir: String) async {
        guard let engine = engines[pid] else { return }
        _ = await engine.recheck(under: dir)
        onSyncChanged?(pid)
    }

    /// The pending items of a linked project, oldest first.
    public func pendingItems(_ pid: String) async -> [SyncPendingItem] {
        guard let engine = engines[pid] else { return [] }
        return await engine.currentSelection().pending.values.sorted { ($0.detectedAt, $0.path) < ($1.detectedAt, $1.path) }
    }

    /// The children of `dir` ("" = the root) as Sync tab rows, folders first.
    public func entries(_ pid: String, dir: String) async -> [SyncEntry] {
        guard let engine = engines[pid], let p = project(pid), !p.isSingleFile else { return [] }
        let sel = await engine.currentSelection()
        let known = Set(await engine.knownHashes().keys)
        let root = p.localURL
        return (try? await offloadBlocking { SyncEntries.list(root: root, dir: dir, selection: sel, known: known) }) ?? []
    }

    // MARK: Linking (picker, typed path, drag and drop) → confirmation → first upload

    /// Checks each path and prepares the confirmation ("Upload N files (size) to the server?").
    public func prepareLinks(_ urls: [URL]) async {
        linkErrors = []
        var plans: [LinkPlan] = []
        for url in urls {
            do {
                let t = try LinkTarget.inspect(url)
                if let problem = overlap(t) { linkErrors.append(problem); continue }
                if plans.contains(where: { $0.target.picked == t.picked }) { continue }
                if let only = t.onlyPath {
                    let scan = LocalScanner.scanSingle(root: t.root, path: only)
                    plans.append(LinkPlan(target: t, files: scan.files.count, bytes: scan.totalBytes, skipped: scan.skipped.count))
                } else {
                    let model = await selectionModel(for: t)
                    let totals = model.totals
                    plans.append(LinkPlan(target: t, files: totals.files, bytes: totals.bytes, skipped: 0, selection: model))
                }
            } catch {
                linkErrors.append(error.localizedDescription)
            }
        }
        pendingLinks = plans
        if plans.isEmpty, !linkErrors.isEmpty { message = linkErrors.joined(separator: "\n") }
        watchCloudOnlyPlans()
    }

    /// While a plan on screen has cloud-only files, re-check their flags every few seconds
    /// (metadata only); the window enables "Link and Upload" once none remain.
    func watchCloudOnlyPlans() {
        for m in pendingLinks.compactMap(\.selection) { m.watchCloud(cloudProbe, interval: cloudRecheckInterval) }
    }

    /// The selection window's model for a folder being linked: scanned (rules, cloud-only flags),
    /// the AI pass started, the cloud re-check running.
    public func selectionModel(for t: LinkTarget) async -> LinkSelectionModel {
        let root = t.root, probe = cloudProbe
        let top = (try? await offloadBlocking { SyncTreeScanner.scan(root: root, cloud: probe) }) ?? SyncTreeScanner.scan(root: root, cloud: probe)
        let model = LinkSelectionModel(root: top, folderName: t.name)
        model.folderURL = root
        model.provider = CloudProvider.detect(root)
        model.watchCloud(cloudProbe, interval: cloudRecheckInterval)
        return model
    }

    /// The default selection's files (rules applied, large files waiting) that are only in the cloud.
    nonisolated static func cloudOnlyToUpload(_ root: URL, probe: CloudProbe) -> Int {
        let top = SyncTreeScanner.scan(root: root, cloud: probe)
        return top.descendants().filter { $0.kind == .file && $0.cloudOnly && $0.size <= SyncSelection.largeFileBytes }.count
    }

    /// Waits (re-checking metadata every few seconds, cancellable) until no file that would upload
    /// is only in the cloud; `onWaiting` gets each count while any remain.
    public func waitForLocalFiles(_ root: URL, onWaiting: @escaping @MainActor (Int, CloudProvider) -> Void) async throws {
        let provider = CloudProvider.detect(root), probe = cloudProbe
        while true {
            try Task.checkCancellation()
            let n = (try? await offloadBlocking { Self.cloudOnlyToUpload(root, probe: probe) }) ?? 0
            if n == 0 { return }
            onWaiting(n, provider)
            try await Task.sleep(nanoseconds: UInt64(cloudRecheckInterval * 1_000_000_000))
        }
    }

    /// The text field: `~/code/sample-app`, a pasted path, a `file://` URL.
    public func prepareTypedLink(_ text: String) async throws {
        let url = try LinkTarget.url(fromTyped: text)
        _ = try LinkTarget.inspect(url)   // a clear error right at the field
        await prepareLinks([url])
        if let first = linkErrors.first, pendingLinks.isEmpty { throw HubError.blocked(first) }
    }

    public func cancelPendingLinks() {
        for m in pendingLinks.compactMap(\.selection) { m.stopCloudWatch() }
        pendingLinks = []
    }

    /// "Cancel" for the plan on screen (the next one, if any, follows).
    public func cancelPendingLink(_ id: UUID) { pendingLinks.removeAll { $0.id == id } }

    /// "Link and Upload" for the plan on screen.
    @discardableResult
    public func confirmPendingLink(_ id: UUID) async -> LinkedProject? {
        guard let plan = pendingLinks.first(where: { $0.id == id }) else { return nil }
        // Nothing uploads while files that would are only in the cloud.
        if let m = plan.selection, !m.cloudOnlyUploading.isEmpty { return nil }
        pendingLinks.removeAll { $0.id == id }
        do { return try await link(plan.target, selection: plan.selection.map { SyncSelection(records: $0.records()) }) } catch {
            linkErrors.append("\(plan.target.name): \(error.localizedDescription)")
            message = linkErrors.joined(separator: "\n")
            return nil
        }
    }

    /// "Link and Upload" for every pending plan (each with its selection as it stands).
    @discardableResult
    public func confirmPendingLinks() async -> [LinkedProject] {
        // Plans still holding cloud-only files stay on screen.
        let plans = pendingLinks.filter { $0.selection?.cloudOnlyUploading.isEmpty ?? true }
        pendingLinks.removeAll { p in plans.contains { $0.id == p.id } }
        var done: [LinkedProject] = []
        for plan in plans {
            do { done.append(try await link(plan.target, selection: plan.selection.map { SyncSelection(records: $0.records()) })) }
            catch { linkErrors.append("\(plan.target.name): \(error.localizedDescription)") }
        }
        if !linkErrors.isEmpty { message = linkErrors.joined(separator: "\n") }
        return done
    }

    // MARK: A folder as a Code session's directory (folder button, drop on the main window)

    /// What a Code session for `folder` needs: a folder that is already linked: or lies inside a
    /// linked folder: reuses that project (nothing is uploaded); anything else must be linked
    /// first, after the person confirms the upload. Problems that would stop the link (not signed
    /// in, not a folder, it contains a linked folder, server storage full) are thrown here, before
    /// anything is asked.
    public func planSessionFolder(_ folder: URL) throws -> SessionFolderPlan {
        guard isConnected else { throw HubError.blocked("Sign in to the hub first.") }
        let t = try LinkTarget.inspect(folder)
        guard !t.isSingleFile else { throw HubError.blocked("\(t.picked.lastPathComponent) is not a folder.") }
        let picked = Self.realPath(t.picked)
        if let p = linkedFolder(for: t.picked) { return .reuse(projectId: p.id, subpath: "") }
        if let p = linked.first(where: { !$0.isSingleFile && picked.hasPrefix(Self.realPath($0.pickedURL) + "/") }) {
            return .reuse(projectId: p.id, subpath: String(picked.dropFirst(Self.realPath(p.pickedURL).count + 1)))
        }
        if let problem = overlap(t) { throw HubError.blocked(problem) }
        if let blockedReason { throw HubError.blocked("Paused: \(blockedReason)") }
        return .link(t)
    }

    /// Carries out a plan (for `.link`, only after the person confirmed the upload) and returns the
    /// server directory, once the project's first upload is done. Linking goes through `link(_:)`,
    /// the same path as File → Link Folder.
    public func sessionDirectory(_ plan: SessionFolderPlan, selection: SyncSelection? = nil) async throws -> String {
        let project: LinkedProject
        var sub = ""
        switch plan {
        case .reuse(let id, let subpath):
            guard let p = self.project(id) else { throw HubError.blocked("Not connected") }
            project = p
            sub = subpath
        case .link(let t):
            project = try await link(t, selection: selection)
        }
        try await ensureFirstUpload(project)
        let base = hubProject(project.id)?.path ?? "projects/\(project.name)"
        return sub.isEmpty ? base : base + "/" + sub
    }

    /// File count and size of what the first upload would send (same scanner and ignore rules as
    /// the upload), stopped after `budget` seconds or when the task is cancelled (`truncated`).
    public nonisolated static func uploadPreview(_ t: LinkTarget, budget: TimeInterval) async -> UploadPreview {
        let flag = StopFlag()
        let deadline = Date().addingTimeInterval(budget)
        let root = t.root
        return await withTaskCancellationHandler {
            let scan = try? await offloadBlocking {
                LocalScanner.scan(root: root, hashContents: false, stop: { flag.isSet || Date() >= deadline })
            }
            guard let scan else { return UploadPreview(files: 0, bytes: 0, truncated: true) }
            // What the default selection sends: the rules leave out more than the old list did.
            let rules = scan.truncated ? nil : try? await offloadBlocking { SyncTreeScanner.scan(root: root) }
            if let top = rules {
                let files = top.descendants().filter { n in
                    n.kind == .file && n.size <= SyncSelection.largeFileBytes
                }
                return UploadPreview(files: files.count, bytes: files.reduce(0) { $0 + $1.size })
            }
            return UploadPreview(files: scan.files.count, bytes: scan.totalBytes, truncated: scan.truncated)
        } onCancel: { flag.set() }
    }

    /// The linked folder (not a single file) at exactly this path.
    public func linkedFolder(for folder: URL) -> LinkedProject? {
        let path = Self.realPath(folder)
        return linked.first { !$0.isSingleFile && Self.realPath($0.pickedURL) == path }
    }

    /// Waits for (or retries) the project's first upload.
    private func ensureFirstUpload(_ p: LinkedProject) async throws {
        guard let e = engines[p.id] else { throw HubError.blocked("Not connected") }
        if await e.syncState().baselineDone { return }
        await e.reconcile()
        if await e.syncState().baselineDone { return }
        if p.paused { throw HubError.blocked("\(p.name) is paused.") }
        throw HubError.blocked(await e.currentStatus().lastError ?? "First upload failed.")
    }

    static func realPath(_ u: URL) -> String { u.resolvingSymlinksInPath().standardizedFileURL.path }

    /// Already linked, or inside / around something linked?
    func overlap(_ t: LinkTarget) -> String? {
        func real(_ u: URL) -> String { Self.realPath(u) }
        let picked = real(t.picked)
        for p in linked {
            let mine = real(p.pickedURL)
            if mine == picked { return "\(p.name) is already linked." }
            if !p.isSingleFile, picked.hasPrefix(mine + "/") { return "\(t.picked.lastPathComponent) is already synced as part of \(p.name)." }
            if !t.isSingleFile, mine.hasPrefix(picked + "/") { return "\(t.picked.lastPathComponent) contains \(p.name), which is linked on its own." }
        }
        return nil
    }

    /// Create project → (selection stored) → first upload → reconcile → watch. Without a
    /// selection the engine builds the defaults (rules; every top-level folder and root file left open).
    @discardableResult
    func link(_ t: LinkTarget, selection: SyncSelection? = nil) async throws -> LinkedProject {
        guard let client, let user, let hubURL else { throw HubError.blocked("Sign in to the hub first.") }
        if let problem = overlap(t) { throw HubError.blocked(problem) }
        linking = true
        defer { linking = false }
        var project: Project?
        var lastError: Error?
        for attempt in 0..<5 {
            let name = attempt == 0 ? t.name : "\(t.name.prefix(60))-\(attempt + 1)"
            do {
                project = try await client.createProject(name: name, origin: Self.computerName())
                break
            } catch let e as HubError where e.status == 409 {
                lastError = e
                continue
            }
        }
        guard let project else { throw lastError ?? HubError.blocked("Could not create the project") }
        var lp = LinkedProject(id: project.id, name: project.name, localPath: t.root.path, hubURL: hubURL, user: user,
                               onlyPath: t.onlyPath, bookmark: Bookmarks.readOnly(for: t.picked))
        store.upsert(lp)
        if let selection, !t.isSingleFile { store.saveSelection(project.id, selection) }
        lp = openScope(lp)
        linked.append(lp)
        hubProjects.removeAll { $0.id == project.id }
        hubProjects.append(project)
        await startEngine(for: lp)
        return lp
    }

    /// Stops syncing; the local folder and the server copy are left exactly as they are.
    public func unlink(_ id: String) async {
        if let e = engines.removeValue(forKey: id) { await e.stop() }
        scopes.removeValue(forKey: id)?.stopAccessingSecurityScopedResource()
        store.remove(id: id)
        linked.removeAll { $0.id == id }
        statuses.removeValue(forKey: id)
    }

    public func setPaused(_ id: String, _ paused: Bool) async {
        guard let i = linked.firstIndex(where: { $0.id == id }) else { return }
        linked[i].paused = paused
        store.upsert(linked[i])
        await engines[id]?.setUserPaused(paused)
    }

    // MARK: Reconcile (detection only)

    public func reconcileAll(reason: ReconcileReason) {
        if reason == .activation {
            guard Date().timeIntervalSince(lastActivationReconcile) > 30 else { return }
            lastActivationReconcile = Date()
        }
        for e in engines.values { Task { await e.reconcile() } }
    }

    public func reconcile(_ id: String) async { await engines[id]?.reconcile() }

    public func setPushesBlocked(_ reason: String?) {
        guard reason != blockedReason else { return }
        blockedReason = reason
        for e in engines.values { Task { await e.setPushesBlocked(reason) } }
    }

    /// WebSocket `review_changed` (an accept or reject on the server): keep the pending count current
    /// and check the server again, so accepted versions are offered as incoming changes.
    public func reviewChanged(projectId: String, localCommit: String?, pendingFiles: Int) {
        if let i = hubProjects.firstIndex(where: { $0.id == projectId }) {
            hubProjects[i].pendingFiles = pendingFiles
            hubProjects[i].localCommit = localCommit
        }
        guard let e = engines[projectId] else { return }
        reviewReconcile[projectId]?.cancel()
        reviewReconcile[projectId] = Task {
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard !Task.isCancelled else { return }
            await e.reconcile()
        }
    }

    /// WebSocket `sync_conflict`.
    public func noteConflict(projectId: String, path: String, reason: String) {
        if let e = engines[projectId] { Task { await e.noteConflict(path: path, reason: reason) } }
    }

    // MARK: Approvals (native review window only)

    public func syncToServer(_ id: String, paths: [String]?, approvedHashes: [String: String?] = [:]) async throws -> SyncReport {
        guard let e = engines[id] else { throw HubError.blocked("Not connected") }
        let r = try await e.syncToServer(paths, approvedHashes: approvedHashes)
        statusArrived(id, await e.currentStatus())
        return r
    }

    public func applyIncoming(_ id: String, paths: [String]?, choices: [String: LocalEditChoice] = [:],
                              seenLocalHashes: [String: String?] = [:], confirmedLoss: Set<String> = []) async throws -> ApplyReport {
        guard let e = engines[id] else { throw HubError.blocked("Not connected") }
        let r = try await e.applyIncoming(paths, choices: choices, seenLocalHashes: seenLocalHashes, confirmedLoss: confirmedLoss)
        statusArrived(id, await e.currentStatus())
        return r
    }

    public func keepMine(_ id: String, path: String) async {
        guard let e = engines[id] else { return }
        do { try await e.keepMine(path); message = "Your version of \(path) is on the server now." } catch { message = error.localizedDescription }
    }

    /// Conflict → the server's version is offered for review (nothing is written yet).
    public func useServerVersion(_ id: String, path: String) async throws {
        guard let e = engines[id] else { return }
        try await e.useServerVersion(path)
    }

    // MARK: Pull back / Remove from server (separate actions)

    /// Accepts every pending change on the server and offers the files for "Apply to Mac". The server
    /// copy stays; nothing is deleted on the server or written on this Mac yet.
    @discardableResult
    public func pullBack(_ id: String) async throws -> Int {
        guard let e = engines[id] else { throw HubError.blocked("Not connected") }
        let n = try await e.pullBack()
        await refreshHubProjects()
        message = n == 0 ? "Nothing to pull back." : "\(n) change\(n == 1 ? "" : "s") from the server are ready to review."
        return n
    }

    /// Deletes the server copy (after the confirmation dialog). The local folder is not touched;
    /// syncing for it stops. Without `discardRemaining` the hub refuses when unaccepted changes exist.
    public func removeFromServer(_ id: String, discardRemaining: Bool) async throws {
        guard let client else { throw HubError.blocked("Not connected") }
        try await client.deleteProject(id, discardRemaining: discardRemaining)
        await unlink(id)
        hubProjects.removeAll { $0.id == id }
        message = "Removed from the server. Your folder on this Mac is unchanged."
    }

    // MARK: History

    public func history(_ id: String) -> [HistoryBatch] { store.history.batches(projectId: id) }

    public func serverBackups(_ id: String) async throws -> [ProjectBackup] {
        guard let e = engines[id] else { throw HubError.blocked("Not connected") }
        return try await e.serverBackups()
    }

    /// Restore → the old versions are fetched from the server and offered for review.
    @discardableResult
    public func restore(_ id: String, items: [RestoreItem]) async throws -> Int {
        guard let e = engines[id] else { throw HubError.blocked("Not connected") }
        let n = try await e.restore(items)
        // Restored from the History window: a native click, written directly.
        let paths = Set(items.map(\.path))
        let staged = await e.currentStatus()
        for c in staged.incoming where paths.contains(c.path) && c.origin == .restore { nativeApproved[id, default: []].insert(Self.incomingKey(c)) }
        statusArrived(id, staged)
        return n
    }

    // MARK: Display helpers

    public func revealInFinder(_ id: String) {
        guard let p = project(id) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([p.pickedURL])
    }

    static func computerName() -> String? {
        (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? ProcessInfo.processInfo.hostName
    }

    /// Test / snapshot hooks.
    public func _setLinked(_ list: [LinkedProject]) { linked = list }
    public func _setConnected(user: String, hubURL: URL) {
        client = HubClient(baseURL: hubURL, user: user)   // no request is made
        self.user = user
        self.hubURL = hubURL.absoluteString
    }
}
