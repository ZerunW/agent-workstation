import Foundation

/// What the sync engine needs from the hub (HubClient conforms; tests inject a fake).
public protocol SyncTransport: AnyObject, Sendable {
    func uploadBaseline(projectId: String, archive: URL, encoding: BaselineEncoding) async throws
    func manifest(projectId: String, entries: [ManifestEntry]) async throws -> ManifestResponse
    func pushFiles(projectId: String, ops: [SyncOp]) async throws -> SyncResult
    /// Working-tree bytes, or (with `ref`) the bytes at a commit / ref / blob. nil = 404.
    func rawFile(projectId: String, path: String, ref: String?) async throws -> Data?
    func accept(projectId: String, _ body: AcceptBody) async throws -> AcceptResponse
    func createBackup(projectId: String, _ body: ProjectBackupBody) async throws -> ProjectBackup
    func backups(projectId: String) async throws -> [ProjectBackup]
    /// Large files (> MAX_SYNC_FILE_BYTES): what the hub holds, and one chunk.
    func largeFileProgress(projectId: String, file: LargeFile) async throws -> LargeFileUploadResponse
    func uploadLargeChunk(projectId: String, file: LargeFile, offset: Int64, data: Data) async throws -> LargeFileUploadResponse
    /// A server version streamed to `file` (HTTP Range); false = not on the server.
    func downloadRaw(projectId: String, path: String, ref: String?, to file: URL, chunk: Int64) async throws -> Bool
    /// The project's exclude list on the server (replaces the previous one). An older hub without
    /// the route answers 404, which callers ignore.
    func putExcludes(projectId: String, paths: [ExcludedPath]) async throws
}

/// protocol `ProjectExcludesBody.paths[]`.
public struct ExcludedPath: Codable, Equatable, Sendable {
    public var path: String
    public var kind: SyncKind
    public init(path: String, kind: SyncKind) { self.path = path; self.kind = kind }
}

extension HubClient {
    public func putExcludes(projectId: String, paths: [ExcludedPath]) async throws {
        struct Body: Encodable { var paths: [ExcludedPath] }
        let req = makeRequest(Routes.projectExcludes(projectId), body: try encode(Body(paths: paths)), timeout: 60)
        try await perform(req, accept: [404])
    }
}

extension HubClient: SyncTransport {}

public enum SyncPhase: Equatable, Sendable {
    case idle
    case scanning
    case uploadingBaseline
    case reconciling
    case watching
    case pushing(Int)
    /// A large file (> MAX_SYNC_FILE_BYTES) in chunks: name, percent.
    case uploadingLarge(String, Int)
    case writing(Int)
    case paused(String)
    case error(String)

    public var label: String {
        switch self {
        case .idle: return "Idle"
        case .scanning: return "Scanning…"
        case .uploadingBaseline: return "Uploading…"
        case .reconciling: return "Checking the server…"
        case .watching: return "Watching"
        case .pushing(let n): return "Syncing \(n) change\(n == 1 ? "" : "s") to the server…"
        case .uploadingLarge(let name, let pct): return "Uploading \(name) (\(pct)%)…"
        case .writing(let n): return "Applying \(n) change\(n == 1 ? "" : "s")…"
        case .paused(let r): return "Paused: \(r)"
        case .error(let e): return "Error: \(e)"
        }
    }

    public var isBusy: Bool {
        switch self {
        case .scanning, .uploadingBaseline, .reconciling, .pushing, .uploadingLarge, .writing: return true
        default: return false
        }
    }
}

public struct SyncStatus: Equatable, Sendable {
    public var phase: SyncPhase = .idle
    public var trackedFiles = 0
    public var localBytes: Int64 = 0
    /// Local changes waiting for approval ("Sync to server").
    public var outgoing: [PendingChange] = []
    /// Server versions waiting for approval ("Apply to Mac").
    public var incoming: [PendingChange] = []
    /// Incoming paths whose local file has edits the server has not seen.
    public var incomingWithLocalEdits: [String] = []
    public var conflicts: [SyncConflictInfo] = []
    /// Files the scanner refused (symlinks, > MAX_SYNC_FILE_BYTES, unreadable).
    public var skipped: [SkippedFile] = []
    /// Files the hub answered `skipped` for.
    public var hubSkipped: [SyncConflictInfo] = []
    public var lastSyncAt: Date?
    public var lastError: String?
    public var baselineEncoding: String?
    public var pushesBlocked = false
    /// New items waiting for the person (sync selection).
    public var pendingSelection = 0
    /// Files decided `sync` that are only in the cloud (evicted after syncing, or never local yet).
    public var cloudOnly = 0
    /// `POST /api/projects/:id/backups` exists (nil = not checked yet). Without it "Back up and
    /// overwrite" is unavailable, so un-synced local edits are never overwritten.
    public var backupsAvailable: Bool?

    public init() {}
}

/// What the person chose for an incoming file whose local copy has edits the server has not seen.
public enum LocalEditChoice: String, CaseIterable, Sendable {
    /// Upload the local version to the server's backups, then apply the incoming version.
    case backUpAndOverwrite
    /// Apply the incoming version without a backup: only after a second, explicit confirmation
    /// naming the files (`confirmedLoss`).
    case overwriteWithoutBackup
    /// Sync the local version to the server instead; the incoming change for that file is dropped.
    case syncMineInstead
    /// Leave both as they are.
    case skip
}

/// One version to restore from the server: read `path` at `ref` and check it (`sha256` for apply
/// history, `blob` for server backups); `absent` = the file did not exist then (restore = delete).
public struct RestoreItem: Equatable, Sendable {
    public var path: String
    public var ref: String?
    public var sha256: String?
    public var blob: String?
    public var absent: Bool
    public init(path: String, ref: String?, sha256: String? = nil, blob: String? = nil, absent: Bool = false) {
        self.path = path; self.ref = ref; self.sha256 = sha256; self.blob = blob; self.absent = absent
    }

    /// The version before an apply (`HistoryFile.oldHash` at `oldRef`).
    public static func before(_ f: HistoryFile) -> RestoreItem {
        RestoreItem(path: f.path, ref: f.oldRef, sha256: f.oldHash, absent: f.oldHash == nil)
    }

    public static func backup(_ b: ProjectBackup, _ f: ProjectBackup.File) -> RestoreItem {
        RestoreItem(path: f.path, ref: b.ref, blob: f.blob)
    }
}

public struct SyncReport: Equatable, Sendable {
    public var pushed: [String] = []
    public var conflicts: [SyncConflictInfo] = []
    /// Changed again after it was reviewed: not sent, shown again.
    public var stale: [String] = []
}

public struct ApplyReport: Equatable, Sendable {
    public var applied: [String] = []
    public var refused: [WriteRefusal] = []
    public var skipped: [String] = []
    public var syncedInstead: [String] = []
    public var backups: [ProjectBackup] = []
    public init() {}
}

/// Folder sync for one linked project: Mac → server changes inside the
/// checked scope are pushed automatically, and Mac-side writes are approval-gated.
///
/// * FSEvents and reconciles record local edits as *outgoing* changes and server changes as
///   *incoming* changes. Local edits inside the checked scope are pushed on their own
///   (`autoPushLocked`); conflicts and anything a blocked disk or network refuses stay outgoing
///   for the review window, where `syncToServer` sends them ("Sync selected / all"). Server
///   changes are never written automatically.
/// * Server → Mac happens only in `applyIncoming` ("Apply selected / all"). The engine never
///   writes a file itself: it hands an approved `WriteBatch` to the writer, which refuses any
///   item whose local file is not exactly what the batch expects: the last-synced version
///   (its content is in the server's history) or, after "Back up and overwrite", the version the
///   server confirmed backing up. Un-synced local content can never be lost.
public actor SyncEngine {
    public nonisolated let project: LinkedProject
    public nonisolated let echo = EchoSuppressor()
    public nonisolated var root: URL { project.localURL }

    private let transport: SyncTransport
    private let store: LinkedProjectStore
    private let writer: LocalWriting
    private let useWatcher: Bool
    private var state: ProjectSyncState
    private var status = SyncStatus()
    private let cache: HashCache
    /// Cloud-only placeholders are recognised from metadata and never read.
    public nonisolated let cloud: CloudProbe
    private var cloudPaths: Set<String> = []
    private var selection: SyncSelection
    /// No selection stored yet: built at start (migration of an existing link, or the defaults).
    private var needsSelection: Bool
    private var onPending: (@Sendable ([String]) -> Void)?
    /// The exclude list the server has (nil = not sent yet / to be sent again).
    private var excludesSent: [ExcludedPath]?
    /// A large-file upload in flight (cancelled by `stop()`).
    private var largeUpload: Task<LargeFileUploadResponse, Error>?
    private var watcher: FolderWatcher?
    private var pollTask: Task<Void, Never>?
    private var blockedReason: String?
    private var userPaused = false
    private var retryTask: Task<Void, Never>?
    private var retryAttempt = 0
    private var onStatus: (@Sendable (SyncStatus) -> Void)?
    private var onConflict: (@Sendable (SyncConflictInfo) -> Void)?
    public var builder = SyncBatchBuilder()
    /// Backups are split at this many decoded bytes per request (contract: ≤ 50 MB).
    public var maxBackupBytes = 50 * 1024 * 1024
    public var clientName = "mac:" + (Host.current().localizedName ?? ProcessInfo.processInfo.hostName)

    private var locked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init(project: LinkedProject, transport: SyncTransport, store: LinkedProjectStore, writer: LocalWriting,
                useWatcher: Bool = true, cloud: CloudProbe = .system, hasher: (@Sendable (URL) throws -> String)? = nil) {
        self.cloud = cloud
        self.cache = hasher.map { HashCache(probe: cloud, hasher: $0) } ?? HashCache(probe: cloud)
        self.project = project
        self.transport = transport
        self.store = store
        self.writer = writer
        self.useWatcher = useWatcher
        self.state = store.loadState(project.id)
        self.userPaused = project.paused
        let stored = store.loadSelection(project.id)
        self.selection = stored ?? SyncSelection()
        self.needsSelection = stored == nil && project.onlyPath == nil
    }

    /// New waiting items (paths) were recorded: the shell batches them for the AI and the page.
    public func setPendingHandler(_ h: (@Sendable ([String]) -> Void)?) { onPending = h }

    // MARK: Sync selection

    public func currentSelection() -> SyncSelection { selection }

    /// The person's answers (Sync tab, pending items); then syncs what they opened up.
    public func applyDecisions(_ inputs: [SyncDecisionInput]) async {
        await acquire(); defer { release() }
        selection.apply(inputs)
        status.pendingSelection = selection.pending.count
        store.saveSelection(project.id, selection)
        emit()
        await sendExcludesLocked()
        guard !userPaused, state.baselineDone else { return }
        await reconcileLocked(scan: nil)
    }

    /// Re-check: scans `dir` again for waiting items and returns them.
    public func recheck(under dir: String) async -> [String] {
        await acquire(); defer { release() }
        let scan = await scanTree(start: dir)
        absorb(scan, full: dir.isEmpty)
        if !dir.isEmpty { notePending(scan.undecided, replacingUnder: dir) }
        emit()
        return selection.pending.keys.filter { dir.isEmpty || $0 == dir || $0.hasPrefix(dir + "/") }.sorted()
    }

    /// The project's own `skip` decisions (not inherited rows), as the server's exclude list.
    public static func excludes(for selection: SyncSelection) -> [ExcludedPath] {
        selection.records.filter { $0.value.decision == .skip && !$0.key.isEmpty }
            .map { ExcludedPath(path: $0.key, kind: $0.value.kind) }
            .sorted { $0.path < $1.path }
            .prefix(10_000).map { $0 }
    }

    /// Sends the exclude list when it differs from what the server has. 404 (an older hub) counts as
    /// done; other failures leave it to the next reconcile.
    private func sendExcludesLocked() async {
        guard project.onlyPath == nil else { return }
        let list = Self.excludes(for: selection)
        guard list != excludesSent else { return }
        do {
            try await transport.putExcludes(projectId: project.id, paths: list)
            excludesSent = list
        } catch {
            excludesSent = nil
        }
    }

    /// Builds the selection of a link that has none: rules, plus the old matcher's exclusions; an
    /// existing link approves every top-level folder holding synced files and keeps each synced
    /// root file; a new link (no selection window) approves every top-level folder and root file
    /// the rules leave open.
    private func buildMissingSelection() async {
        let root = self.root, extra = project.extraIgnore, known = state.known
        let sel = (try? await offloadBlocking { SelectionDefaults.selection(root: root, extraIgnore: extra, known: known) })
            ?? SelectionDefaults.selection(root: root, extraIgnore: extra, known: known)
        selection = sel
        needsSelection = false
        store.saveSelection(project.id, selection)
    }

    public func setHandlers(status: (@Sendable (SyncStatus) -> Void)?, conflict: (@Sendable (SyncConflictInfo) -> Void)?) {
        onStatus = status
        onConflict = conflict
        emit()
    }

    public func currentStatus() -> SyncStatus { status }
    public func knownHashes() -> [String: String] { state.known }
    public func syncState() -> ProjectSyncState { state }

    // MARK: Lifecycle

    /// Initial upload (first time, after the person confirmed linking) → reconcile → watch.
    public func start() async {
        await acquire(); defer { release() }
        guard !userPaused else { setPhase(.paused("paused by you")); return }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDir), isDir.boolValue else {
            setPhase(.error("folder not found: \(root.path)")); return
        }
        setPhase(.scanning)
        if needsSelection { await buildMissingSelection() }
        // Before anything is uploaded (and once for links made before the server took the list).
        excludesSent = nil
        await sendExcludesLocked()
        let scan = await scanTree()
        absorb(scan)
        if !state.baselineDone { await initialUploadLocked(scan) }
        await reconcileLocked(scan: scan)
        startWatching()
    }

    public func stop() {
        largeUpload?.cancel()
        largeUpload = nil
        watcher?.stop()
        watcher = nil
        pollTask?.cancel()
        pollTask = nil
        retryTask?.cancel()
        retryTask = nil
        setPhase(.idle)
    }

    public func setUserPaused(_ paused: Bool) async {
        userPaused = paused
        if paused {
            watcher?.stop(); watcher = nil
            pollTask?.cancel(); pollTask = nil
            setPhase(.paused("paused by you"))
        } else {
            await start()
        }
    }

    /// Compare with the server (launch, activation, every 10 min, `review_changed`, FSEvents drops).
    public func reconcile() async {
        await acquire(); defer { release() }
        guard !userPaused else { return }
        await reconcileLocked(scan: nil)
    }

    /// Watcher batches: what changed on this Mac. Inside the decided-`sync` scope it is synced on
    /// its own (conflicts stay pending); new paths with no decision become waiting items.
    public func handleLocalChanges(_ paths: Set<String>, rescan: Bool = false) async {
        await acquire(); defer { release() }
        guard !userPaused else { return }
        var paths = paths
        if let only = project.onlyPath {
            guard rescan || paths.contains(where: { $0 == only || $0.isEmpty || only.hasPrefix($0 + "/") }) else { return }
            paths = [only]
        } else if rescan || paths.contains(where: { ($0 as NSString).lastPathComponent == ".gitignore" }) || needsSelection {
            await reconcileLocked(scan: nil)
            return
        }
        let found = await collectChanges(paths)
        if !found.waiting.isEmpty { notePending(found.waiting, replacingUnder: nil) }
        guard state.baselineDone else { store.saveState(project.id, state); emit(); return }
        let conflicted = Set(status.conflicts.map(\.path))
        var push: [LocalChange] = []
        for c in found.changes {
            if conflicted.contains(c.path) { recordOutgoing(c) } else { push.append(c) }
        }
        await autoPushLocked(push)
        await uploadLargeLocked(found.large.filter { !conflicted.contains($0.path) })
        refreshLocalEdits()
        store.saveState(project.id, state)
        emit()
    }

    /// Disk guard (`disk_status` block): syncing to the server is refused until space is back.
    public func setPushesBlocked(_ reason: String?) async {
        await acquire(); defer { release() }
        blockedReason = reason
        status.pushesBlocked = reason != nil
        if let reason { setPhase(.paused(reason)) } else if case .paused = status.phase, !userPaused { setPhase(.watching) }
    }

    /// `sync_conflict` over WebSocket.
    public func noteConflict(path: String, reason: String) {
        addConflict(SyncConflictInfo(path: path, reason: reason))
    }

    // MARK: Approval: Mac → server

    /// "Sync selected / all to server". `approvedHashes`: the version the person reviewed for a
    /// path (nil value = reviewed as deleted); a file that changed since is not sent (`stale`).
    @discardableResult
    public func syncToServer(_ paths: [String]? = nil, approvedHashes: [String: String?] = [:]) async throws -> SyncReport {
        await acquire(); defer { release() }
        let report = try await syncLocked(paths, approvedHashes: approvedHashes)
        refreshLocalEdits()
        store.saveState(project.id, state)
        emit()
        return report
    }

    private func syncLocked(_ paths: [String]?, approvedHashes: [String: String?]) async throws -> SyncReport {
        if let reason = blockedReason { throw HubError.blocked("Syncing to the server is paused (\(reason)). Your changes stay pending.") }
        let selected = (paths ?? state.outgoing.keys.sorted()).compactMap { state.outgoing[$0] }
        var report = SyncReport()
        var changes: [LocalChange] = []
        for e in selected {
            // Never synced and only in the cloud: nothing to send until it is downloaded.
            if isCloudOnly(e.path) && state.known[e.path] == nil { report.stale.append(e.path); continue }
            let cur = currentChange(e.path)
            let approved: String?
            if let a = approvedHashes[e.path] { approved = a } else { approved = e.hash }
            guard cur.hash == approved else {
                report.stale.append(e.path)
                recordOutgoing(cur)
                continue
            }
            changes.append(cur)
        }
        // Large files go through the chunked route (completion is the sync write).
        var large: [LargeFile] = []
        changes.removeAll { c in
            guard case let .present(p, h, size, mode) = c, size > SyncSelection.largeFileBytes else { return false }
            large.append(LargeFile(path: p, sha256: h, size: size, mode: mode))
            return true
        }
        if !large.isEmpty {
            // "Keep mine" for a conflict re-sends with force; anything else goes as usual.
            let conflicted = Set(status.conflicts.map(\.path))
            await uploadLargeLocked(large.filter { conflicted.contains($0.path) }, force: true)
            await uploadLargeLocked(large.filter { !conflicted.contains($0.path) })
            for f in large where state.known[f.path] == f.sha256 { report.pushed.append(f.path); state.outgoing.removeValue(forKey: f.path) }
            report.conflicts += status.conflicts.filter { c in large.contains { $0.path == c.path } }
        }
        guard !changes.isEmpty else { return report }
        let sending = Set(changes.map(\.path))
        let force = sending.intersection(status.conflicts.map(\.path))
        let outcome = try await pushLocked(changes, force: force, mustSend: sending)
        for p in outcome.applied { state.outgoing.removeValue(forKey: p) }
        report.pushed += outcome.applied
        report.conflicts += outcome.conflicts
        return report
    }

    /// Conflict: put this Mac's version on the server (`force`; the server keeps Claude's in its history).
    public func keepMine(_ path: String) async throws {
        await acquire(); defer { release() }
        let cur = currentChange(path)
        if state.outgoing[path] == nil {
            state.outgoing[path] = PendingChange(path: path, kind: cur.hash == nil ? .deleted : (state.known[path] == nil ? .added : .modified),
                                                 hash: cur.hash, baseHash: state.known[path], origin: .mac)
        }
        let r = try await syncLocked([path], approvedHashes: [path: cur.hash])
        if r.pushed.contains(path) { removeConflict(path) }
        refreshLocalEdits()
        store.saveState(project.id, state)
        emit()
    }

    // MARK: Approval: server → Mac

    /// "Apply selected / all to Mac". Files whose local copy has un-synced edits follow `choices`
    /// (default: back up and overwrite when the hub supports backups, else skip).
    /// - Parameters:
    ///   - seenLocalHashes: the local version the person saw in the diff (nil value = absent); a
    ///     file that changed since is refused.
    ///   - confirmedLoss: paths the person confirmed losing local changes for ("Overwrite without
    ///     backup" → second confirmation). That choice is refused for any other path.
    @discardableResult
    public func applyIncoming(_ paths: [String]? = nil, choices: [String: LocalEditChoice] = [:],
                              seenLocalHashes: [String: String?] = [:], confirmedLoss: Set<String> = []) async throws -> ApplyReport {
        await acquire(); defer { release() }
        var report = ApplyReport()
        let selected = (paths ?? state.incoming.keys.sorted()).compactMap { state.incoming[$0] }
        var items: [WriteItem] = []
        var toBackup: [(entry: PendingChange, data: Data)] = []
        var syncInstead: [String] = []
        for e in selected {
            let cur = currentHash(e.path)
            let known = state.known[e.path]
            // Nothing local to lose: the file is the last-synced version, or it is gone.
            if cur == known || cur == nil {
                if let item = writeItem(for: e, expected: cur, report: &report) { items.append(item) } else if e.kind == .deleted && cur == nil {
                    finishIncoming(e, newHash: nil)
                    report.applied.append(e.path)
                }
                continue
            }
            let fallback: LocalEditChoice = status.backupsAvailable == true ? .backUpAndOverwrite : .skip
            let choice = choices[e.path] ?? fallback
            let seen: String? = { if let s = seenLocalHashes[e.path] { return s }; return e.baseHash }()
            if choice == .backUpAndOverwrite || choice == .overwriteWithoutBackup, cur != seen {
                report.refused.append(WriteRefusal(path: e.path, reason: "the file changed on this Mac since you reviewed it"))
                continue
            }
            switch choice {
            case .backUpAndOverwrite:
                guard status.backupsAvailable != false else { report.skipped.append(e.path); continue }
                if isCloudOnly(e.path) {
                    report.refused.append(WriteRefusal(path: e.path, reason: "only in the cloud: keep it downloaded first"))
                    continue
                }
                if case .file(let size, _, _) = LocalEntry.stat(root.appendingPathComponent(e.path)), size > SyncSelection.largeFileBytes {
                    report.refused.append(WriteRefusal(path: e.path, reason: "a large file can't be backed up before overwriting"))
                    continue
                }
                guard let data = try? Data(contentsOf: root.appendingPathComponent(e.path)), FileHasher.sha256(data) == cur else {
                    report.refused.append(WriteRefusal(path: e.path, reason: "the local file changed while it was being read"))
                    continue
                }
                toBackup.append((e, data))
            case .overwriteWithoutBackup:
                guard confirmedLoss.contains(e.path) else {
                    report.refused.append(WriteRefusal(path: e.path, reason: "overwriting without a backup was not confirmed"))
                    continue
                }
                if let item = writeItem(for: e, expected: cur, report: &report) { items.append(item) }
            case .syncMineInstead:
                syncInstead.append(e.path)
            case .skip:
                report.skipped.append(e.path)
            }
        }

        // 1. Back up the local versions on the server; only confirmed backups may be overwritten.
        var backupRefs: [String: String] = [:]
        if !toBackup.isEmpty {
            for (reason, group) in [(ProjectBackupBody.Reason.overwrite, toBackup.filter { $0.entry.kind != .deleted }),
                                    (.delete, toBackup.filter { $0.entry.kind == .deleted })] where !group.isEmpty {
                for chunk in backupChunks(group) {
                    let body = ProjectBackupBody(client: clientName, reason: reason,
                                                 files: chunk.map { .init(path: $0.entry.path, dataBase64: $0.data.base64EncodedString(), mode: currentMode($0.entry.path)) })
                    do {
                        let backup = try await transport.createBackup(projectId: project.id, body)
                        status.backupsAvailable = true
                        report.backups.append(backup)
                        for (e, data) in chunk {
                            guard backup.files.contains(where: { $0.path == e.path && $0.blob == Self.gitBlobOid(data) }) else {
                                report.refused.append(WriteRefusal(path: e.path, reason: "the server did not confirm the backup: nothing was overwritten"))
                                continue
                            }
                            backupRefs[e.path] = backup.ref
                            if let item = writeItem(for: e, expected: FileHasher.sha256(data), backedUpBlob: Self.gitBlobOid(data), report: &report) {
                                items.append(item)
                            }
                        }
                    } catch {
                        if let s = (error as? HubError)?.status, [404, 405, 501].contains(s) { status.backupsAvailable = false }
                        for (e, _) in chunk {
                            report.refused.append(WriteRefusal(path: e.path, reason: "backup failed (\(error.localizedDescription)): nothing was overwritten"))
                        }
                    }
                }
            }
        }

        // 2. The writer applies the approved batch.
        if !items.isEmpty {
            setPhase(.writing(items.count))
            for item in items { echo.expect(item.path, hash: item.op == .write ? item.hash : nil) }
            let batch = WriteBatch(root: root.path, items: items)
            let result: WriteBatchResult
            do {
                result = try await writer.apply(batch)
            } catch {
                for item in items { echo.cancel(item.path) }
                setPhase(.watching)
                emit()
                throw error
            }
            for r in result.refused { echo.cancel(r.path) }
            report.refused += result.refused
            var files: [HistoryFile] = []
            var conflictSides: [String] = []
            for p in result.applied {
                guard let e = state.incoming[p], let item = items.first(where: { $0.path == p }) else { continue }
                cache.invalidate(p)
                let synced = item.expectedHash == state.known[p]
                files.append(HistoryFile(path: p, op: item.op, oldHash: item.expectedHash, newHash: item.hash,
                                         oldRef: backupRefs[p] ?? (synced ? state.knownRefs[p] : nil), backedUp: backupRefs[p] != nil))
                if e.origin == .conflict { conflictSides.append(p) }
                finishIncoming(e, newHash: item.hash)
                report.applied.append(p)
            }
            if !files.isEmpty {
                try? store.history.record(HistoryBatch(id: batch.id, at: Date(), projectId: project.id, projectName: project.name, files: files))
            }
            // The server side of a conflict now lives here too: make the server's `local` match it.
            if !conflictSides.isEmpty {
                let changes = conflictSides.map { currentChange($0) }
                if let o = try? await pushLocked(changes, force: Set(conflictSides), mustSend: Set(conflictSides)) {
                    for p in o.applied { removeConflict(p, emitNow: false); state.outgoing.removeValue(forKey: p) }
                }
            }
            setPhase(blockedReason.map { .paused($0) } ?? .watching)
        }

        // 3. "Sync my version instead": the incoming change for that file is dropped.
        if !syncInstead.isEmpty {
            for p in syncInstead {
                state.incoming.removeValue(forKey: p)
                recordOutgoing(currentChange(p))
            }
            let r = try await syncLocked(syncInstead, approvedHashes: [:])
            report.syncedInstead = r.pushed
        }

        store.pruneIncoming(project.id, keep: Set(state.incoming.values.compactMap(\.hash)))
        refreshLocalEdits()
        store.saveState(project.id, state)
        emit()
        return report
    }

    private func writeItem(for e: PendingChange, expected: String?, backedUpBlob: String? = nil, report: inout ApplyReport) -> WriteItem? {
        switch e.kind {
        case .deleted:
            guard expected != nil else { return nil }   // already gone
            return .delete(e.path, expected: expected)
        case .added, .modified:
            if let h = e.hash, (e.size ?? 0) > SyncSelection.largeFileBytes, let file = store.incomingFile(project.id, hash: h) {
                // Large: the writer copies the hash-checked store file.
                var item = WriteItem.write(e.path, file: file, hash: h, expected: expected, mode: e.mode)
                item.backedUpBlob = backedUpBlob
                return item
            }
            guard let h = e.hash, let data = store.incoming(project.id, hash: h) else {
                report.refused.append(WriteRefusal(path: e.path, reason: "the server version is no longer available: check the server again"))
                return nil
            }
            var item = WriteItem.write(e.path, data: data, expected: expected, mode: e.mode)
            item.backedUpBlob = backedUpBlob
            return item
        }
    }

    /// Bookkeeping after an incoming change reached the Mac.
    private func finishIncoming(_ e: PendingChange, newHash: String?) {
        state.incoming.removeValue(forKey: e.path)
        switch e.origin {
        case .restore:
            // An older version: the server still has the newer one, so this is now a local change.
            recordOutgoing(currentChange(e.path))
        case .accepted, .server, .conflict:
            if let newHash { state.known[e.path] = newHash } else { state.known.removeValue(forKey: e.path) }
            state.knownRefs[e.path] = e.origin == .accepted ? state.localCommit : nil
            state.outgoing.removeValue(forKey: e.path)
        case .mac:
            break
        }
    }

    private func backupChunks(_ items: [(entry: PendingChange, data: Data)]) -> [[(entry: PendingChange, data: Data)]] {
        var out: [[(entry: PendingChange, data: Data)]] = []
        var cur: [(entry: PendingChange, data: Data)] = []
        var bytes = 0
        for i in items {
            if !cur.isEmpty && (bytes + i.data.count > maxBackupBytes || cur.count >= 500) { out.append(cur); cur = []; bytes = 0 }
            cur.append(i)
            bytes += i.data.count
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }

    // MARK: Proposals from the server (nothing local is touched)

    /// "Pull back": accept every pending change on the server, then offer the files for "Apply to
    /// Mac". The server copy stays as it is; nothing on the server is deleted.
    @discardableResult
    public func pullBack() async throws -> Int {
        await acquire(); defer { release() }
        let resp = try await transport.accept(projectId: project.id, .all)
        state.localCommit = resp.localCommit
        var files: [(String, ServerVersion)] = []
        for f in resp.files {
            if f.deleted { files.append((f.path, .absent)); continue }
            if f.large == true || f.data == nil {
                // Large: streamed at the accepted commit, checked against the announced sha256.
                let version = try await fetchServer(f.path, ref: resp.localCommit)
                if let want = f.sha256 {
                    let got: String? = { switch version { case .data(let d): return FileHasher.sha256(d); case .file(_, let h, _): return h; case .absent: return nil } }()
                    guard got == want else {
                        if case .file(let u, _, _) = version { try? FileManager.default.removeItem(at: u) }
                        throw HubError.blocked("The server returned a different version of \(f.path).")
                    }
                }
                files.append((f.path, version))
            } else if let d = f.data {
                files.append((f.path, .data(d)))
            }
        }
        let n = try queueIncomingLocked(files, origin: .accepted)
        store.saveState(project.id, state)
        emit()
        return n
    }

    /// Conflict: fetch the server's version and offer it for "Apply to Mac".
    public func useServerVersion(_ path: String) async throws {
        await acquire(); defer { release() }
        let version = try await fetchServer(path, ref: "local")
        _ = try queueIncomingLocked([(path, version)], origin: .conflict)
        store.saveState(project.id, state)
        emit()
    }

    /// History → Restore: read each version from the server (at the recorded commit / backup ref),
    /// verify it, and offer it for "Apply to Mac". Nothing is written here.
    @discardableResult
    public func restore(_ items: [RestoreItem]) async throws -> Int {
        await acquire(); defer { release() }
        var fetched: [(String, ServerVersion)] = []
        for f in items {
            if f.absent { fetched.append((f.path, .absent)); continue }
            guard let ref = f.ref else { throw HubError.blocked("The server has no record of where that version of \(f.path) is kept.") }
            let version = try await fetchServer(f.path, ref: ref)
            switch version {
            case .absent: throw HubError.blocked("The server no longer has that version of \(f.path).")
            case .data(let data):
                if let want = f.sha256, FileHasher.sha256(data) != want { throw HubError.blocked("The server returned a different version of \(f.path).") }
                if let want = f.blob, FileHasher.gitBlobOid(data) != want { throw HubError.blocked("The server returned a different version of \(f.path).") }
            case .file(let url, let h, _):
                let blobOK = try f.blob.map { try FileHasher.gitBlobOid(fileAt: url) == $0 } ?? true
                guard f.sha256.map({ $0 == h }) ?? true, blobOK else {
                    try? FileManager.default.removeItem(at: url)
                    throw HubError.blocked("The server returned a different version of \(f.path).")
                }
            }
            fetched.append((f.path, version))
        }
        let n = try queueIncomingLocked(fetched, origin: .restore)
        store.saveState(project.id, state)
        emit()
        return n
    }

    /// Server backups of this project (History).
    public func serverBackups() async throws -> [ProjectBackup] {
        try await transport.backups(projectId: project.id)
    }

    @discardableResult
    private func queueIncomingLocked(_ files: [(String, ServerVersion)], origin: PendingChange.Origin) throws -> Int {
        var n = 0
        for (path, version) in files {
            guard Self.isSafeRelative(path), !IgnoreMatcher.isAlwaysExcluded(path), project.onlyPath == nil || path == project.onlyPath else {
                if case .file(let u, _, _) = version { try? FileManager.default.removeItem(at: u) }
                continue
            }
            let cur = currentHash(path)
            if case .file(let url, let h, let size) = version {
                if h == cur {
                    try? FileManager.default.removeItem(at: url)
                    if origin != .restore {
                        state.incoming.removeValue(forKey: path)
                        state.known[path] = h
                        recordOutgoing(currentChange(path))
                    }
                    continue
                }
                try store.saveIncomingFile(project.id, url, hash: h)
                state.incoming[path] = PendingChange(path: path, kind: cur == nil ? .added : .modified, hash: h, size: size,
                                                     mode: currentMode(path), baseHash: cur, origin: origin)
                n += 1
                continue
            }
            if case .data(let data) = version {
                let h = FileHasher.sha256(data)
                if h == cur {
                    // Already identical on this Mac.
                    if origin != .restore {
                        state.incoming.removeValue(forKey: path)
                        state.known[path] = h
                        recordOutgoing(currentChange(path))
                    }
                    continue
                }
                _ = try store.saveIncoming(project.id, data)
                state.incoming[path] = PendingChange(path: path, kind: cur == nil ? .added : .modified, hash: h, size: Int64(data.count),
                                                     mode: currentMode(path), baseHash: cur, origin: origin)
            } else {
                guard cur != nil else {
                    if origin != .restore {
                        state.incoming.removeValue(forKey: path)
                        state.known.removeValue(forKey: path)
                    }
                    continue
                }
                state.incoming[path] = PendingChange(path: path, kind: .deleted, hash: nil, baseHash: cur, origin: origin)
            }
            n += 1
        }
        refreshLocalEdits()
        return n
    }

    // MARK: Content for the review window (reads only)

    public func localContent(_ path: String) -> Data? {
        guard Self.isSafeRelative(path), case .file = LocalEntry.stat(root.appendingPathComponent(path)), !isCloudOnly(path) else { return nil }
        return try? Data(contentsOf: root.appendingPathComponent(path))
    }

    public func incomingContent(_ path: String) -> Data? {
        guard let h = state.incoming[path]?.hash else { return nil }
        return store.incoming(project.id, hash: h)
    }

    /// The server's version for an outgoing diff: the last-synced commit when known, else the working tree.
    public func serverContent(_ path: String) async throws -> Data? {
        if let ref = state.knownRefs[path], let d = try? await transport.rawFile(projectId: project.id, path: path, ref: ref),
           FileHasher.sha256(d) == state.known[path] {
            return d
        }
        return try await transport.rawFile(projectId: project.id, path: path, ref: "local")
    }

    // MARK: Internals (call only while holding the mutex)

    private func scanTree(start sub: String = "") async -> SelectionScan {
        let root = self.root, cache = self.cache, only = project.onlyPath
        if let only {
            let probe = cloud
            let single = LocalScanner.scanSingle(root: root, path: only, cache: cache, probe: probe)
            var s = SelectionScan()
            s.files = single.files
            s.skipped = single.skipped
            if probe.isDataless(root.appendingPathComponent(only)) {
                s.skipped.removeAll { $0.path == only }
                if let k = state.known[only], case .file(let size, let mode, _) = LocalEntry.stat(root.appendingPathComponent(only)) {
                    s.files = [ScannedFile(path: only, size: size, mode: mode, hash: k)]
                    s.evicted = [only]
                } else {
                    s.cloudOnly = [only]
                }
                return s
            }
            if case .file(let size, let mode, let mtime) = LocalEntry.stat(root.appendingPathComponent(only)), size > SyncSelection.largeFileBytes,
               let h = try? cache.hash(path: only, url: root.appendingPathComponent(only), size: size, mtime: mtime) {
                // The person picked this one file: it syncs as a large file.
                s.large = [LargeFile(path: only, sha256: h, size: size, mode: mode)]
                s.skipped.removeAll { $0.path == only }
            }
            return s
        }
        let sel = selection, knownHashes = state.known, probe = cloud
        return (try? await offloadBlocking {
            SelectionScanner.scan(root: root, selection: sel, knownHashes: knownHashes, cache: cache, start: sub, probe: probe)
        }) ?? SelectionScanner.scan(root: root, selection: sel, knownHashes: knownHashes, cache: cache, start: sub, probe: probe)
    }

    /// Takes in a full scan: status counts, new rule decisions, the waiting items.
    private func absorb(_ scan: SelectionScan, full: Bool = true) {
        if full {
            status.skipped = scan.skipped
            status.trackedFiles = scan.files.count + scan.large.count
            status.localBytes = scan.totalBytes
            cloudPaths = Set(scan.cloudOnly + scan.evicted)
            status.cloudOnly = cloudPaths.count
        }
        guard project.onlyPath == nil else { return }
        notePending(scan.undecided, replacingUnder: full ? "" : nil)
    }

    /// Records waiting items (new ones are announced); with `replacingUnder` set, items no longer
    /// found there are dropped.
    private func notePending(_ items: [SyncPendingItem], replacingUnder scope: String?) {
        var added: [String] = []
        let found = Set(items.map(\.path))
        if let scope {
            for k in Array(selection.pending.keys) where (scope.isEmpty || k == scope || k.hasPrefix(scope + "/")) && !found.contains(k) {
                selection.pending.removeValue(forKey: k)
            }
        }
        for var item in items {
            if let old = selection.pending[item.path] {
                item.detectedAt = old.detectedAt
                if item.large != true { item.suggestion = old.suggestion; item.source = old.source; item.reason = old.reason }
            } else {
                added.append(item.path)
            }
            selection.pending[item.path] = item
        }
        selection.prunePending()
        status.pendingSelection = selection.pending.count
        store.saveSelection(project.id, selection)
        if !added.isEmpty { onPending?(added) }
    }

    /// The first upload of a newly linked folder (the person confirmed it while linking): the
    /// files decided `sync`: small ones as one baseline archive, large ones in chunks.
    private func initialUploadLocked(_ scan: SelectionScan) async {
        guard blockedReason == nil else { status.lastError = "server storage is full: the first upload waits until space is freed"; return }
        setPhase(.uploadingBaseline)
        if scan.files.isEmpty {
            state.baselineDone = true
            store.saveState(project.id, state)
            await uploadLargeLocked(scan.large)
            return
        }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("workstation-baseline-\(project.id)-\(UUID().uuidString.prefix(6))")
        defer { try? FileManager.default.removeItem(at: tmp) }
        do {
            let root = self.root, paths = scan.files.map(\.path)
            let enc = try await offloadBlocking { try BaselineArchiver.create(root: root, paths: paths, output: tmp) }
            try await transport.uploadBaseline(projectId: project.id, archive: tmp, encoding: enc)
            state.known = scan.hashes
            state.baselineDone = true
            state.baselineEncoding = enc.rawValue
            status.baselineEncoding = enc.rawValue
        } catch let e as HubError where e.status == 507 {
            status.lastError = "server storage is full: the first upload waits until space is freed"
        } catch let e as HubError where [404, 405, 415, 501].contains(e.status ?? 0) {
            // Hub without a baseline endpoint: upload file by file (still the confirmed first upload).
            do {
                let all = scan.files.map { LocalChange.present(path: $0.path, hash: $0.hash, size: $0.size, mode: $0.mode) }
                _ = try await pushLocked(all, mustSend: Set(all.map(\.path)))
                state.baselineDone = true
                state.baselineEncoding = "per-file"
                status.baselineEncoding = "per-file"
            } catch {
                status.lastError = "first upload failed: \(error.localizedDescription)"
            }
        } catch {
            status.lastError = "first upload failed: \(error.localizedDescription)"
        }
        store.saveState(project.id, state)
        if state.baselineDone { await uploadLargeLocked(scan.large) }
    }

    /// Chunked uploads of large files decided `sync` that the server lacks (or holds in another
    /// version), with `baseHash` = the version last seen. Completion is a sync write: its result goes
    /// the way of a `SyncResult` entry (a conflict stays pending; "keep mine" re-sends with `force`).
    /// `stop()` cancels an upload in flight.
    private func uploadLargeLocked(_ files: [LargeFile], force: Bool = false) async {
        for var f in files where state.known[f.path] != f.sha256 {
            guard blockedReason == nil, !Task.isCancelled else { return }
            f.baseHash = state.known[f.path]
            f.force = force
            let name = (f.path as NSString).lastPathComponent
            setPhase(.uploadingLarge(name, 0))
            do {
                let total = max(1, f.size)
                let file = f, root = self.root, pid = project.id, transport = self.transport
                let task = Task { [weak self] in
                    try await LargeFileUploader.upload(file, root: root, projectId: pid, transport: transport) { [weak self] sent in
                        let pct = Int(Double(sent) * 100 / Double(total))
                        Task { await self?.setLargeProgress(name, pct) }
                    }
                }
                largeUpload = task
                defer { largeUpload = nil }
                let r = try await task.value
                switch r.result?.status ?? .applied {
                case .applied, .noop, .merged:
                    state.known[f.path] = f.sha256
                    if let lc = r.localCommit { state.knownRefs[f.path] = lc; state.localCommit = lc } else { state.knownRefs.removeValue(forKey: f.path) }
                    state.outgoing.removeValue(forKey: f.path)
                    removeConflict(f.path, emitNow: false)
                case .conflict:
                    addConflict(SyncConflictInfo(path: f.path, reason: r.result?.reason ?? "both sides changed"))
                    recordOutgoing(.present(path: f.path, hash: f.sha256, size: f.size, mode: f.mode))
                case .skipped, .needContent:
                    let s = SyncConflictInfo(path: f.path, reason: r.result?.reason ?? "skipped by the hub")
                    if !status.hubSkipped.contains(s) { status.hubSkipped.append(s) }
                }
                store.saveState(project.id, state)
            } catch is CancellationError {
                break
            } catch let e as HubError where e.status == 507 {
                status.pushesBlocked = true
                status.lastError = "server storage is full: \(name) waits until space is freed"
                return
            } catch {
                status.lastError = "\(name): \(error.localizedDescription)"
            }
        }
        if case .uploadingLarge = status.phase { setPhase(.watching) }
    }

    private func setLargeProgress(_ name: String, _ pct: Int) {
        if case .uploadingLarge(let n, _) = status.phase, n == name { setPhase(.uploadingLarge(name, min(100, pct))) }
    }

    /// A server version, streamed to disk (HTTP Range): small ones are read back, large ones stay
    /// a hash-checked file.
    enum ServerVersion {
        case absent
        case data(Data)
        case file(URL, hash: String, size: Int64)
    }

    private func fetchServer(_ path: String, ref: String?) async throws -> ServerVersion {
        let tmp = store.downloadURL(project.id)
        do {
            guard try await transport.downloadRaw(projectId: project.id, path: path, ref: ref, to: tmp, chunk: LargeFileUploader.chunkBytes) else {
                try? FileManager.default.removeItem(at: tmp)
                return .absent
            }
            let size = (try? FileManager.default.attributesOfItem(atPath: tmp.path)[.size] as? NSNumber)?.int64Value ?? 0
            if size <= SyncSelection.largeFileBytes {
                let data = try Data(contentsOf: tmp)
                try? FileManager.default.removeItem(at: tmp)
                return .data(data)
            }
            let hash = try await offloadBlocking { try FileHasher.sha256(fileAt: tmp) }
            return .file(tmp, hash: hash, size: size)
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            throw error
        }
    }

    /// Compares the folder with the server's `local` and syncs what this Mac changed inside the
    /// decided-`sync` scope (edits, new files, deletions: pushed on their own; only conflicts
    /// stay pending). A file this Mac did not change is never sent (so changes accepted elsewhere
    /// are not overwritten); the server's newer versions are fetched and offered as incoming —
    /// never written without the person.
    private func reconcileLocked(scan existing: SelectionScan?) async {
        setPhase(.reconciling)
        await sendExcludesLocked()   // a failed send is retried here (offline, hub restarting)
        let scan: SelectionScan
        if let existing { scan = existing } else { scan = await scanTree() }
        absorb(scan)
        if !state.baselineDone {
            await initialUploadLocked(scan)
            if !state.baselineDone { fail(status.lastError ?? "first upload failed"); return }
        }
        let response: ManifestResponse
        do {
            response = try await transport.manifest(projectId: project.id, entries: scan.manifest)
        } catch {
            fail(error.localizedDescription)
            return
        }
        let need = Set(response.need)
        let deletes = Set(response.delete)
        let hashes = scan.hashes
        let largeHere = scan.largeHashes
        /// Paths whose server version may differ from what this Mac last synced.
        var check: [String] = []
        /// What this Mac changed: synced now.
        var push: [LocalChange] = []
        var largeChanged: [LargeFile] = []
        for f in scan.large {
            if !need.contains(f.path) {
                state.known[f.path] = f.sha256
                state.outgoing.removeValue(forKey: f.path)
                if state.incoming[f.path]?.hash == f.sha256 { state.incoming.removeValue(forKey: f.path) }
            } else if state.known[f.path] == f.sha256 {
                check.append(f.path)
            } else {
                largeChanged.append(f)
                if state.known[f.path] != nil { check.append(f.path) }
            }
        }
        for f in scan.files {
            if !need.contains(f.path) {
                // Identical on both sides.
                state.known[f.path] = f.hash
                if let c = response.localCommit { state.knownRefs[f.path] = c }
                state.outgoing.removeValue(forKey: f.path)
                if state.incoming[f.path]?.hash == f.hash { state.incoming.removeValue(forKey: f.path) }
            } else if state.known[f.path] == f.hash {
                // Unchanged here, different on the server.
                state.outgoing.removeValue(forKey: f.path)
                check.append(f.path)
            } else {
                // Changed here (maybe on the server too).
                push.append(.present(path: f.path, hash: f.hash, size: f.size, mode: f.mode))
                if state.known[f.path] != nil { check.append(f.path) }
            }
        }
        for p in response.delete where hashes[p] == nil && largeHere[p] == nil {
            let eff = selection.effective(p, kind: .file)
            if eff.decision == .skip { continue }
            if state.known[p] != nil, LocalEntry.stat(root.appendingPathComponent(p)) == .absent {
                if eff.decision == .sync || project.onlyPath != nil { push.append(.absent(path: p)) } else { recordOutgoing(.absent(path: p)) }
            }
            check.append(p)
        }
        for k in Array(state.known.keys) where hashes[k] == nil && largeHere[k] == nil && !deletes.contains(k) {
            // Gone on both sides.
            state.known.removeValue(forKey: k)
            state.knownRefs.removeValue(forKey: k)
            state.outgoing.removeValue(forKey: k)
        }
        for k in Array(state.outgoing.keys) where hashes[k] == nil && state.known[k] == nil { state.outgoing.removeValue(forKey: k) }
        state.localCommit = response.localCommit
        state.lastReconcileAt = Date()

        // Offer the server's newer versions, read from its `local` branch (first 100 per reconcile;
        // already offered ones stay as they are).
        var fetched: [(String, ServerVersion)] = []
        for p in check.sorted().prefix(100) where state.incoming[p] == nil {
            let version: ServerVersion
            do { version = try await fetchServer(p, ref: "local") } catch { continue }
            let here = hashes[p] ?? largeHere[p]
            switch version {
            case .data(let data):
                let h = FileHasher.sha256(data)
                if h == state.known[p] || h == here { continue }   // server unchanged, or already identical
                fetched.append((p, version))
            case .file(let url, let h, _):
                if h == state.known[p] || h == here { try? FileManager.default.removeItem(at: url); continue }
                fetched.append((p, version))
            case .absent:
                guard here != nil && state.known[p] != nil else { break }
                if state.knownRefs[p] == nil {
                    // Never confirmed at a server commit (e.g. it did not make it into the first upload):
                    // not a deletion on the server: send it again.
                    state.known.removeValue(forKey: p)
                    if let f = scan.files.first(where: { $0.path == p }) { push.append(.present(path: f.path, hash: f.hash, size: f.size, mode: f.mode)) }
                    else if let f = scan.large.first(where: { $0.path == p }) { largeChanged.append(f) }
                } else {
                    fetched.append((p, .absent))   // deleted on the server
                }
            }
        }
        _ = try? queueIncomingLocked(fetched, origin: .server)
        if let available = try? await probeBackups() { status.backupsAvailable = available }
        status.lastSyncAt = Date()
        status.lastError = nil
        retryAttempt = 0
        store.saveState(project.id, state)

        // Mac → server inside the decided scope: on its own.
        let conflicted = Set(status.conflicts.map(\.path))
        let pendingOut = state.outgoing.values.filter { !conflicted.contains($0.path) && !isCloudOnly($0.path)
            && (project.onlyPath != nil || selection.effective($0.path, kind: .file).decision == .sync) }
            .map { currentChange($0.path) }
        await autoPushLocked((push + pendingOut.filter { c in !push.contains { $0.path == c.path } }).filter { !conflicted.contains($0.path) })
        await uploadLargeLocked(largeChanged.filter { !conflicted.contains($0.path) })
        store.saveState(project.id, state)
        setPhase(blockedReason.map { .paused($0) } ?? .watching)
    }

    /// Pushes changes inside the decided scope. Conflicts: and everything while pushing is
    /// refused (disk guard, network): stay as outgoing entries for the review window.
    private func autoPushLocked(_ changes: [LocalChange]) async {
        guard !changes.isEmpty else { return }
        guard blockedReason == nil else {
            for c in changes { recordOutgoing(c) }
            return
        }
        do {
            let outcome = try await pushLocked(changes, mustSend: Set(changes.map(\.path)))
            for p in outcome.applied { state.outgoing.removeValue(forKey: p) }
            let conflicted = Set(outcome.conflicts.map(\.path))
            for c in changes where conflicted.contains(c.path) { recordOutgoing(c) }
        } catch {
            for c in changes { recordOutgoing(c) }
        }
        refreshLocalEdits()
    }

    private func probeBackups() async throws -> Bool {
        do {
            _ = try await transport.backups(projectId: project.id)
            return true
        } catch let e as HubError where [404, 405, 501].contains(e.status ?? 0) {
            return false
        }
    }

    private func recordOutgoing(_ change: LocalChange) {
        switch change {
        case let .present(p, h, size, mode):
            if state.known[p] == h { state.outgoing.removeValue(forKey: p); return }
            state.outgoing[p] = PendingChange(path: p, kind: state.known[p] == nil ? .added : .modified, hash: h, size: size, mode: mode,
                                              baseHash: state.known[p], origin: .mac)
        case .absent(let p):
            if state.known[p] == nil { state.outgoing.removeValue(forKey: p); return }
            state.outgoing[p] = PendingChange(path: p, kind: .deleted, hash: nil, baseHash: state.known[p], origin: .mac)
        }
    }

    private func refreshLocalEdits() {
        status.incomingWithLocalEdits = state.incoming.keys.filter { p in
            let cur = currentHash(p)
            return cur != nil && cur != state.known[p]
        }.sorted()
    }

    /// A cloud-only placeholder (never read).
    public nonisolated func isCloudOnly(_ path: String) -> Bool { cloud.isDataless(root.appendingPathComponent(path)) }

    private func currentHash(_ path: String) -> String? {
        let url = root.appendingPathComponent(path)
        guard case let .file(size, _, mtime) = LocalEntry.stat(url) else { return nil }
        // Evicted after syncing: still the synced version as far as anything here can tell, unread.
        if cloud.isDataless(url) { return state.known[path] ?? "cloud-only" }
        return try? cache.hash(path: path, url: url, size: size, mtime: mtime)
    }

    private func currentChange(_ path: String) -> LocalChange {
        let url = root.appendingPathComponent(path)
        guard case let .file(size, mode, mtime) = LocalEntry.stat(url) else { return .absent(path: path) }
        if cloud.isDataless(url) { return .present(path: path, hash: state.known[path] ?? "cloud-only", size: size, mode: mode) }
        cache.invalidate(path)
        guard let h = try? cache.hash(path: path, url: url, size: size, mtime: mtime) else { return .absent(path: path) }
        return .present(path: path, hash: h, size: size, mode: mode)
    }

    struct CollectedChanges {
        var changes: [LocalChange] = []
        var large: [LargeFile] = []
        var waiting: [SyncPendingItem] = []
    }

    /// Stats each path under the selection; echo suppression; expands folders (subtree scans).
    private func collectChanges(_ paths: Set<String>) async -> CollectedChanges {
        var out = CollectedChanges()
        var seen: Set<String> = []
        for p in paths.sorted() {
            guard Self.isSafeRelative(p), !IgnoreMatcher.isAlwaysExcluded(p) else { continue }
            if seen.contains(where: { p.hasPrefix($0 + "/") }) { continue }
            let url = root.appendingPathComponent(p)
            switch LocalEntry.stat(url) {
            case .file, .directory:
                if project.onlyPath != nil {
                    guard case let .file(size, mode, mtime) = LocalEntry.stat(url) else { continue }
                    cache.invalidate(p)
                    guard let hash = try? cache.hash(path: p, url: url, size: size, mtime: mtime) else { continue }
                    if echo.shouldSuppress(p, observedHash: hash) { continue }
                    if size > SyncSelection.largeFileBytes { out.large.append(LargeFile(path: p, sha256: hash, size: size, mode: mode)) }
                    else if state.known[p] != hash { out.changes.append(.present(path: p, hash: hash, size: size, mode: mode)) }
                    continue
                }
                seen.insert(p)
                cache.invalidate(p)
                let sub = await scanTree(start: p)
                cloudPaths = cloudPaths.filter { $0 != p && !$0.hasPrefix(p + "/") }.union(sub.cloudOnly + sub.evicted)
                status.cloudOnly = cloudPaths.count
                for f in sub.files where state.known[f.path] != f.hash && !echo.shouldSuppress(f.path, observedHash: f.hash) {
                    out.changes.append(.present(path: f.path, hash: f.hash, size: f.size, mode: f.mode))
                }
                out.large += sub.large.filter { state.known[$0.path] != $0.sha256 && !echo.shouldSuppress($0.path, observedHash: $0.sha256) }
                out.waiting += sub.undecided
                if LocalEntry.stat(url) == .directory {
                    let present = Set(sub.files.map(\.path))
                    for k in state.known.keys where k.hasPrefix(p + "/") && !present.contains(k) {
                        if LocalEntry.stat(root.appendingPathComponent(k)) == .absent, selection.effective(k, kind: .file).decision == .sync {
                            out.changes.append(.absent(path: k))
                        }
                    }
                }
            case .absent:
                if echo.shouldSuppress(p, observedHash: nil) { continue }
                for k in state.known.keys where k == p || k.hasPrefix(p + "/") {
                    if project.onlyPath != nil || selection.effective(k, kind: .file).decision == .sync { out.changes.append(.absent(path: k)) }
                }
                for k in Array(selection.pending.keys) where k == p || k.hasPrefix(p + "/") { selection.pending.removeValue(forKey: k) }
            case .symlink, .other:
                continue
            }
        }
        return out
    }

    /// Sends approved changes. Throws on transport errors and on the disk guard (507); changes stay pending.
    private func pushLocked(_ changes: [LocalChange], force: Set<String> = [], mustSend: Set<String> = []) async throws -> SyncOutcome {
        guard !changes.isEmpty else { return SyncOutcome() }
        if let reason = blockedReason { throw HubError.blocked("Syncing to the server is paused (\(reason)).") }
        let root = self.root
        let plan = builder.plan(changes: changes, known: state.known, force: force, mustSend: mustSend) { p in
            try Data(contentsOf: root.appendingPathComponent(p))
        }
        for s in plan.skipped where !status.hubSkipped.contains(s) { status.hubSkipped.append(s) }
        guard !plan.batches.isEmpty else { return SyncOutcome() }
        setPhase(.pushing(plan.opCount))
        var total = SyncOutcome()
        do {
            for batch in plan.batches {
                var result = try await transport.pushFiles(projectId: project.id, ops: batch)
                var outcome = SyncBatchBuilder.apply(result, ops: batch, known: &state.known)
                if !outcome.needContent.isEmpty {
                    let retry = batch.filter { outcome.needContent.contains($0.path) }.compactMap { withContent($0) }
                    if !retry.isEmpty {
                        result = try await transport.pushFiles(projectId: project.id, ops: retry)
                        let o2 = SyncBatchBuilder.apply(result, ops: retry, known: &state.known)
                        outcome.applied += o2.applied
                        outcome.conflicts += o2.conflicts
                        outcome.skipped += o2.skipped
                        outcome.needContent = o2.needContent
                    }
                }
                for p in outcome.applied {
                    if let lc = result.localCommit, state.known[p] != nil { state.knownRefs[p] = lc } else { state.knownRefs.removeValue(forKey: p) }
                }
                if let lc = result.localCommit { state.localCommit = lc }
                total.applied += outcome.applied
                total.conflicts += outcome.conflicts
                total.skipped += outcome.skipped
                total.needContent += outcome.needContent
            }
        } catch let e as HubError where e.status == 507 {
            status.pushesBlocked = true
            store.saveState(project.id, state)
            setPhase(.paused("server storage is full"))
            throw HubError.blocked("Server storage is full: nothing was synced. Your changes stay pending.")
        } catch {
            store.saveState(project.id, state)
            status.lastError = error.localizedDescription
            setPhase(.watching)
            throw error
        }
        for c in total.conflicts { addConflict(c) }
        for s in total.skipped where !status.hubSkipped.contains(s) { status.hubSkipped.append(s) }
        for p in total.applied { removeConflict(p, emitNow: false) }
        state.lastPushAt = Date()
        status.lastSyncAt = Date()
        status.lastError = nil
        status.pushesBlocked = blockedReason != nil
        store.saveState(project.id, state)
        setPhase(.watching)
        return total
    }

    private func withContent(_ op: SyncOp) -> SyncOp? {
        guard case let .write(path, hash, size, mode, base, _, force) = op,
              let data = try? Data(contentsOf: root.appendingPathComponent(path)) else { return nil }
        return .write(path: path, hash: hash, size: size, mode: mode, baseHash: base, contentBase64: data.base64EncodedString(), force: force)
    }

    private func currentMode(_ path: String) -> Int? {
        if case .file(_, let mode, _) = LocalEntry.stat(root.appendingPathComponent(path)) { return mode }
        return nil
    }

    private func startWatching() {
        guard useWatcher, watcher == nil, pollTask == nil else { return }
        if let only = project.onlyPath {
            // One file: poll it (cheap: hashes are cached by size + mtime) instead of watching its whole parent folder.
            pollTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    guard !Task.isCancelled else { return }
                    await self?.handleLocalChanges([only])
                }
            }
            return
        }
        let w = FolderWatcher(root: root) { [weak self] paths, rescan in
            guard let self else { return }
            Task { await self.handleLocalChanges(paths, rescan: rescan) }
        }
        if w.start() { watcher = w }
    }

    private func addConflict(_ c: SyncConflictInfo) {
        if let i = status.conflicts.firstIndex(where: { $0.path == c.path }) { status.conflicts[i] = c }
        else {
            status.conflicts.append(c)
            onConflict?(c)
        }
        emit()
    }

    private func removeConflict(_ path: String, emitNow: Bool = true) {
        status.conflicts.removeAll { $0.path == path }
        if emitNow { emit() }
    }

    private func fail(_ message: String) {
        status.lastError = message
        setPhase(.error(message))
        scheduleRetry()
    }

    private func scheduleRetry(minimum: TimeInterval = 0) {
        guard retryTask == nil else { return }
        let delay = max(minimum, Backoff(base: 5, factor: 2, maximum: 300).delay(attempt: retryAttempt))
        retryAttempt += 1
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            await self.runRetry()
        }
    }

    private func runRetry() async {
        retryTask = nil
        await reconcile()
    }

    private func setPhase(_ p: SyncPhase) {
        status.phase = p
        emit()
    }

    private func emit() {
        status.outgoing = state.outgoing.values.sorted { $0.path < $1.path }
        status.incoming = state.incoming.values.sorted { $0.path < $1.path }
        let s = status
        onStatus?(s)
    }

    private func acquire() async {
        if !locked { locked = true; return }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func release() {
        if waiters.isEmpty { locked = false } else { waiters.removeFirst().resume() }
    }

    static func isSafeRelative(_ p: String) -> Bool {
        !p.isEmpty && !p.hasPrefix("/") && !p.split(separator: "/").contains("..") && !p.contains("\0")
    }

    /// Git blob id (SHA-1 of `blob <size>\0` + bytes), as the hub reports backed-up files.
    public static func gitBlobOid(_ data: Data) -> String { FileHasher.gitBlobOid(data) }
}

extension LocalChange {
    var hash: String? { if case .present(_, let h, _, _) = self { return h }; return nil }
}
