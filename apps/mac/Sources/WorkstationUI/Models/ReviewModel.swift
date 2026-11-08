import Foundation
import WorkstationCore
import SwiftUI

/// State of one review window: the pending changes of a linked project in one direction, the
/// checked files, the diff on screen, and the per-file choices for incoming files that have
/// un-synced local edits. Its approve methods are the only callers of `syncToServer` /
/// `applyIncoming`, and they run only from buttons in this native window.
@MainActor
public final class ReviewModel: ObservableObject {
    public let projectId: String
    public let projects: ProjectsModel
    /// false = local changes (Mac → server), true = changes from the server (server → Mac).
    @Published public var incoming: Bool { didSet { if incoming != oldValue { resetSelection() } } }
    @Published public var checked: Set<String> = []
    @Published public var focused: String?
    @Published public var diff: DiffDocument?
    @Published public var loadingDiff = false
    @Published public var choices: [String: LocalEditChoice] = [:]
    @Published public var busy = false
    @Published public var result: String?
    /// Non-empty → the "will be permanently lost" confirmation is on screen for these paths.
    @Published public var confirmLoss: [String] = []
    private var pendingApproval: [String]?

    /// The version the person saw in the diff (nil value = absent).
    var seenLocal: [String: String?] = [:]
    var seenOutgoing: [String: String?] = [:]

    public init(projectId: String, projects: ProjectsModel, incoming: Bool) {
        self.projectId = projectId
        self.projects = projects
        self.incoming = incoming
        resetSelection()
    }

    public var project: LinkedProject? { projects.project(projectId) }
    public var status: SyncStatus { projects.status(projectId) }
    public var entries: [PendingChange] { incoming ? status.incoming : status.outgoing }
    public var backupsAvailable: Bool { status.backupsAvailable == true }

    public func hasLocalEdits(_ path: String) -> Bool { incoming && status.incomingWithLocalEdits.contains(path) }

    public func choice(for path: String) -> LocalEditChoice {
        if let c = choices[path], c != .backUpAndOverwrite || backupsAvailable { return c }
        return backupsAvailable ? .backUpAndOverwrite : .skip
    }

    public func resetSelection() {
        checked = Set(entries.map(\.path))
        focused = entries.first?.path
        diff = nil
        result = nil
    }

    // MARK: Diff

    public func show(_ path: String) async {
        focused = path
        loadingDiff = true
        defer { loadingDiff = false }
        guard let engine = projects.engine(projectId), let entry = entries.first(where: { $0.path == path }) else { diff = nil; return }
        // Large files: a binary entry with both sizes; never read into memory.
        let localSize: Int64? = { if case .file(let s, _, _) = LocalEntry.stat(engine.root.appendingPathComponent(path)) { return s }; return nil }()
        if (entry.size ?? 0) > SyncSelection.largeFileBytes || (localSize ?? 0) > SyncSelection.largeFileBytes {
            let local = engine.isCloudOnly(path) ? nil : localSize.flatMap { _ in try? FileHasher.sha256(fileAt: engine.root.appendingPathComponent(path)) }
            if incoming {
                seenLocal[path] = local
                diff = DiffDocument(path: path, oldSize: localSize, newSize: entry.kind == .deleted ? nil : entry.size, oldHash: local,
                                    newHash: entry.hash, isBinary: true, tooLarge: false, hunks: [])
            } else {
                seenOutgoing[path] = local
                diff = DiffDocument(path: path, oldSize: nil, newSize: localSize, oldHash: nil, newHash: local, isBinary: true, tooLarge: false, hunks: [])
            }
            return
        }
        let local = await engine.localContent(path)
        if incoming {
            let server = entry.kind == .deleted ? nil : await engine.incomingContent(path)
            seenLocal[path] = local.map(FileHasher.sha256)
            diff = LineDiff.document(path: path, old: local, new: server)
        } else {
            let server = entry.kind == .added ? nil : (try? await engine.serverContent(path)) ?? nil
            seenOutgoing[path] = local.map(FileHasher.sha256)
            diff = LineDiff.document(path: path, old: server, new: local)
        }
    }

    // MARK: Approval (buttons in this window only)

    public func approveSelected() async { await approve(entries.map(\.path).filter(checked.contains)) }
    public func approveAll() async { await approve(entries.map(\.path)) }

    /// After "Overwrite without backup" was confirmed in the destructive dialog.
    public func confirmLossAndApply() async {
        let paths = pendingApproval ?? []
        let confirmed = Set(confirmLoss)
        confirmLoss = []
        pendingApproval = nil
        await run(paths, confirmedLoss: confirmed)
    }

    public func cancelLoss() {
        confirmLoss = []
        pendingApproval = nil
    }

    func approve(_ paths: [String]) async {
        guard !paths.isEmpty else { return }
        if incoming {
            let loss = paths.filter { hasLocalEdits($0) && choice(for: $0) == .overwriteWithoutBackup }
            if !loss.isEmpty {
                // Second confirmation naming the files; nothing happens until it is confirmed.
                pendingApproval = paths
                confirmLoss = loss
                return
            }
        }
        await run(paths, confirmedLoss: [])
    }

    private func run(_ paths: [String], confirmedLoss: Set<String>) async {
        busy = true
        defer { busy = false }
        do {
            if incoming {
                var c: [String: LocalEditChoice] = [:]
                for p in paths where hasLocalEdits(p) { c[p] = choice(for: p) }
                let r = try await projects.applyIncoming(projectId, paths: paths, choices: c,
                                                         seenLocalHashes: seenLocal.filter { paths.contains($0.key) }, confirmedLoss: confirmedLoss)
                result = Self.describe(r)
            } else {
                let r = try await projects.syncToServer(projectId, paths: paths, approvedHashes: seenOutgoing.filter { paths.contains($0.key) })
                result = Self.describe(r)
            }
        } catch {
            result = error.localizedDescription
        }
        checked = checked.intersection(entries.map(\.path))
        if let f = focused, !entries.contains(where: { $0.path == f }) { focused = entries.first?.path; diff = nil }
    }

    static func describe(_ r: ApplyReport) -> String {
        var parts: [String] = []
        if !r.applied.isEmpty { parts.append("Applied \(r.applied.count) file\(r.applied.count == 1 ? "" : "s") to this Mac") }
        if !r.backups.isEmpty { parts.append("backed up \(r.backups.reduce(0) { $0 + $1.files.count }) on the server first") }
        if !r.syncedInstead.isEmpty { parts.append("synced \(r.syncedInstead.count) of yours to the server instead") }
        if !r.skipped.isEmpty { parts.append("skipped \(r.skipped.count)") }
        if !r.refused.isEmpty { parts.append("not applied: " + r.refused.map { "\($0.path) (\($0.reason))" }.joined(separator: "; ")) }
        return parts.isEmpty ? "Nothing to apply." : parts.joined(separator: " · ")
    }

    static func describe(_ r: SyncReport) -> String {
        var parts: [String] = []
        if !r.pushed.isEmpty { parts.append("Synced \(r.pushed.count) file\(r.pushed.count == 1 ? "" : "s") to the server") }
        if !r.conflicts.isEmpty { parts.append("\(r.conflicts.count) changed on both sides: see Linked Folders") }
        if !r.stale.isEmpty { parts.append("\(r.stale.count) changed again since you reviewed: review again") }
        return parts.isEmpty ? "Nothing to sync." : parts.joined(separator: " · ")
    }

    /// Snapshot hook.
    public func _setDiff(_ d: DiffDocument?, focused path: String?) { diff = d; focused = path }
}
