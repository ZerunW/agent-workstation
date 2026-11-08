import WorkstationCore
import SwiftUI

/// History of one linked project: what was applied on this Mac (metadata only: the versions live
/// on the server) and the backups kept on the server. Restore fetches the old version from the
/// server and offers it in the review window; nothing is written here.
public struct HistoryView: View {
    @ObservedObject var projects: ProjectsModel
    let projectId: String
    var openReview: () -> Void
    @ViewState private var backups: [ProjectBackup] = []
    @ViewState private var backupsNote: String? = nil
    @ViewState private var message: String? = nil
    @ViewState private var working = false

    public init(projects: ProjectsModel, projectId: String, backups: [ProjectBackup]? = nil, openReview: @escaping () -> Void = {}) {
        self.projects = projects
        self.projectId = projectId
        self.openReview = openReview
        if let backups { _backups = ViewState(wrappedValue: backups) }
    }

    public var body: some View {
        let batches = projects.history(projectId)
        Form {
            Section {
                VStack(alignment: .leading, spacing: 3) {
                    Text(projects.project(projectId)?.name ?? "History").font(.headline)
                    Text("Every change applied to this Mac, and the local versions backed up on the server before they were overwritten. Restore brings an old version back through the review window.")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if let message { Text(message).font(.callout).foregroundStyle(.secondary) }
            }
            Section("Applied on this Mac") {
                if batches.isEmpty {
                    Text("Nothing has been applied to this Mac yet.").foregroundStyle(.secondary)
                }
                ForEach(batches) { b in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(b.at.formatted(date: .abbreviated, time: .shortened)).font(.body.weight(.medium))
                            Text("· \(b.files.count) file\(b.files.count == 1 ? "" : "s")").foregroundStyle(.secondary)
                            Spacer()
                            Button("Restore All") { restore(b.files.map(RestoreItem.before)) }
                                .controlSize(.small)
                                .disabled(working || b.files.contains { $0.oldHash != nil && $0.oldRef == nil })
                        }
                        ForEach(b.files) { f in fileRow(f) }
                    }
                    .padding(.vertical, 2)
                }
            }
            Section("Backups on the server") {
                if let backupsNote { Text(backupsNote).foregroundStyle(.secondary) }
                else if backups.isEmpty { Text("No backups yet.").foregroundStyle(.secondary) }
                ForEach(backups) { b in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(Formatters.parseISO(b.at)?.formatted(date: .abbreviated, time: .shortened) ?? b.at).font(.body.weight(.medium))
                            Text("· before \(b.reason == .delete ? "deleting" : b.reason == .overwrite ? "overwriting" : "a manual backup") · \(b.client)")
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button("Restore All") { restore(b.files.map { RestoreItem.backup(b, $0) }) }.controlSize(.small).disabled(working)
                        }
                        ForEach(b.files, id: \.path) { f in
                            HStack {
                                Text(f.path).font(.system(.caption, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                                Spacer()
                                Text(Formatters.bytes(f.size)).font(.caption).foregroundStyle(.secondary)
                                Button("Restore") { restore([RestoreItem.backup(b, f)]) }.controlSize(.mini).disabled(working)
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .formStyle(.grouped)
        .frame(minWidth: 560, minHeight: 440)
        .task { await loadBackups() }
    }

    func fileRow(_ f: HistoryFile) -> some View {
        HStack(spacing: 8) {
            KindBadge(kind: f.op == .delete ? .deleted : (f.oldHash == nil ? .added : .modified))
            Text(f.path).font(.system(.caption, design: .monospaced)).lineLimit(1).truncationMode(.middle)
            if f.backedUp { Text("backed up").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1).background(Capsule().fill(Color.secondary.opacity(0.15))) }
            Spacer()
            Text("\(short(f.oldHash)) → \(short(f.newHash))").font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
            Button("Restore") { restore([RestoreItem.before(f)]) }
                .controlSize(.mini)
                .disabled(working || (f.oldHash != nil && f.oldRef == nil))
                .help(f.oldHash != nil && f.oldRef == nil ? "The server has no record of where this version is kept." : "Bring back the version before this change (reviewed first)")
        }
    }

    func short(_ h: String?) -> String { h.map { String($0.prefix(7)) } ?? "absent" }

    func loadBackups() async {
        do {
            backups = try await projects.serverBackups(projectId)
            backupsNote = nil
        } catch let e as HubError where [404, 405, 501].contains(e.status ?? 0) {
            backupsNote = "This hub doesn't keep backups yet."
        } catch {
            if backups.isEmpty { backupsNote = error.localizedDescription }
        }
    }

    func restore(_ items: [RestoreItem]) {
        working = true
        Task {
            do {
                let n = try await projects.restore(projectId, items: items)
                message = n == 0 ? "Those versions are already on this Mac." : "\(n) version\(n == 1 ? "" : "s") ready to review."
                if n > 0 { openReview() }
            } catch {
                message = error.localizedDescription
            }
            working = false
        }
    }
}
