import AppKit
import WorkstationCore
import SwiftUI

/// The window shown before a folder is linked (every way of linking): the first level, a few items
/// under each folder, checkboxes (all checked to start), what "Link and Upload" sends.
struct LinkSelectionView: View {
    @ObservedObject var projects: ProjectsModel
    let target: LinkTarget
    @ObservedObject var model: LinkSelectionModel
    let onCancel: () -> Void
    let onConfirm: () async -> Void

    /// File → Link Folder, the typed path, the Dock icon: the plan on screen.
    init(projects: ProjectsModel, plan: LinkPlan, model: LinkSelectionModel) {
        self.projects = projects
        self.target = plan.target
        self.model = model
        self.onCancel = { [projects] in projects.cancelPendingLink(plan.id) }
        self.onConfirm = { [projects] in _ = await projects.confirmPendingLink(plan.id) }
    }

    /// A folder dropped or picked for a Code session.
    init(projects: ProjectsModel, target: LinkTarget, model: LinkSelectionModel, onCancel: @escaping () -> Void, onConfirm: @escaping () async -> Void) {
        self.projects = projects; self.target = target; self.model = model; self.onCancel = onCancel; self.onConfirm = onConfirm
    }

    var body: some View {
        let totals = model.totals
        let cloud = model.cloudOnlyUploading
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "folder.fill").font(.system(size: 24)).foregroundStyle(Theme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Link “\(target.picked.lastPathComponent)”").font(.title3.weight(.semibold))
                    Text(target.picked.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(model.rows) { row in SelectionRow(model: model, row: row) }
                }
                .padding(.vertical, 4)
            }
            .frame(height: 340)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.03)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.08)))
            if !cloud.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "icloud.and.arrow.down").foregroundStyle(Theme.warning)
                    Text(model.provider.message(cloud.count)).font(.callout).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("selectionCloudOnly")
                    Spacer(minLength: 6)
                    if let url = model.folderURL {
                        Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                    }
                }
            }
            if !projects.linkErrors.isEmpty {
                ForEach(projects.linkErrors, id: \.self) { e in
                    Label(e, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(Theme.warning)
                }
            }
            HStack {
                Text("\(totals.files.formatted()) file\(totals.files == 1 ? "" : "s") · \(Formatters.bytes(totals.bytes))")
                    .font(.callout).foregroundStyle(.secondary).monospacedDigit()
                    .accessibilityIdentifier("selectionTotals")
                Spacer()
                Button("Cancel") { onCancel() }.keyboardShortcut(.cancelAction)
                Button("Link and Upload") { Task { await onConfirm() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!cloud.isEmpty)
                    .accessibilityIdentifier("confirmLink")
            }
        }
        .padding(22)
        .frame(width: 580)
    }
}

/// One row: checkbox (checked / mixed / unchecked), name, size; or the "+N more" line.
struct SelectionRow: View {
    @ObservedObject var model: LinkSelectionModel
    let row: LinkSelectionModel.Row

    var body: some View {
        HStack(spacing: 6) {
            Color.clear.frame(width: CGFloat(row.depth) * 22, height: 1)
            switch row.kind {
            case .more(let n):
                Color.clear.frame(width: 16, height: 1)
                Text("+\(n.formatted()) more").font(.system(size: 12)).foregroundStyle(.tertiary)
            case .item(let node):
                let state = model.state(node.path)
                Button { model.toggle(node.path) } label: {
                    Image(systemName: state == .checked ? "checkmark.square.fill" : state == .mixed ? "minus.square.fill" : "square")
                        .foregroundStyle(state == .unchecked ? Color.secondary : Theme.accent)
                }
                .buttonStyle(.plain)
                Image(systemName: node.isFolder ? "folder" : "doc").foregroundStyle(.secondary).font(.system(size: 12))
                Text(node.name).font(.system(size: 12.5)).lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(state == .unchecked ? .secondary : .primary)
                if node.kind == .file && node.size > SyncSelection.largeFileBytes {
                    Text(SyncSelection.largeReason(node.size)).font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(1)
                }
                Spacer(minLength: 6)
                Text(node.isFolder ? "\(node.fileCount.formatted()) · \(Formatters.bytes(node.totalBytes))" : Formatters.bytes(node.size))
                    .font(.system(size: 11)).foregroundStyle(.tertiary).monospacedDigit()
            }
            if case .more = row.kind { Spacer() }
        }
        .padding(.horizontal, 8).padding(.vertical, 3)
        .contentShape(Rectangle())
    }
}
