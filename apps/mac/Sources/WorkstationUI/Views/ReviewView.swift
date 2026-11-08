import WorkstationCore
import SwiftUI

/// Review window for one linked project: the file list with checkboxes on the left, a git-style
/// unified diff on the right, and the approval buttons. Approvals happen only here.
public struct ReviewView: View {
    @ObservedObject var model: ReviewModel
    @ObservedObject var projects: ProjectsModel
    var onClose: () -> Void

    public init(model: ReviewModel, onClose: @escaping () -> Void = {}) {
        self.model = model
        self.projects = model.projects
        self.onClose = onClose
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(Web.line).frame(height: 1)
            HStack(spacing: 0) {
                fileList.frame(width: 290)
                Rectangle().fill(Web.line).frame(width: 1)
                detail.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Rectangle().fill(Web.line).frame(height: 1)
            footer
        }
        .background(Web.bg)
        .foregroundStyle(Web.fg)
        .frame(minWidth: 860, minHeight: 520)
        .task(id: "\(model.incoming)-\(model.entries.count)") {
            if model.diff == nil, let f = model.focused ?? model.entries.first?.path { await model.show(f) }
        }
        .alert("Overwrite without a backup?", isPresented: Binding(get: { !model.confirmLoss.isEmpty }, set: { if !$0 { model.cancelLoss() } })) {
            Button("Overwrite and Lose Changes", role: .destructive) { Task { await model.confirmLossAndApply() } }
            Button("Cancel", role: .cancel) { model.cancelLoss() }
        } message: {
            Text("Your local changes to \(Self.list(model.confirmLoss)) will be permanently lost. This can't be undone.")
        }
    }

    static func list(_ paths: [String]) -> String {
        let names = paths.map { ($0 as NSString).lastPathComponent }
        if names.count <= 3 { return names.joined(separator: ", ") }
        return names.prefix(3).joined(separator: ", ") + " and \(names.count - 3) more"
    }

    // MARK: Header

    var header: some View {
        HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.project?.name ?? "Review").font(.system(size: 15, weight: .semibold))
                Text(model.incoming ? "Changes from the server: nothing is written on this Mac until you apply it."
                                    : "Changes on this Mac: nothing is sent to the server until you sync it.")
                    .font(.system(size: 12)).foregroundStyle(Web.muted)
            }
            Spacer()
            Picker("", selection: $model.incoming) {
                Text("On this Mac · \(model.status.outgoing.count)").tag(false)
                Text("From the server · \(model.status.incoming.count)").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 300)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    // MARK: File list

    var fileList: some View {
        VStack(spacing: 0) {
            HStack {
                Toggle(isOn: Binding(get: { !model.entries.isEmpty && model.checked.count == model.entries.count },
                                     set: { model.checked = $0 ? Set(model.entries.map(\.path)) : [] })) {
                    Text("Select all").font(.system(size: 12))
                }
                .toggleStyle(.checkbox)
                Spacer()
                Text("\(model.checked.count) of \(model.entries.count)").font(.system(size: 11)).foregroundStyle(Web.subtle)
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(model.entries) { e in row(e) }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
            }
        }
        .background(Web.sidebar)
    }

    func row(_ e: PendingChange) -> some View {
        let dir = (e.path as NSString).deletingLastPathComponent
        return HStack(spacing: 8) {
            Toggle("", isOn: Binding(get: { model.checked.contains(e.path) },
                                     set: { on in if on { model.checked.insert(e.path) } else { model.checked.remove(e.path) } }))
                .toggleStyle(.checkbox)
                .labelsHidden()
            KindBadge(kind: e.kind)
            VStack(alignment: .leading, spacing: 1) {
                Text((e.path as NSString).lastPathComponent).font(.system(size: 13)).lineLimit(1).truncationMode(.middle)
                if !dir.isEmpty { Text(dir).font(.system(size: 11)).foregroundStyle(Web.subtle).lineLimit(1).truncationMode(.head) }
            }
            Spacer(minLength: 4)
            if let size = e.size, size > SyncSelection.largeFileBytes {
                Text(Formatters.bytes(size)).font(.system(size: 11)).foregroundStyle(Web.subtle).monospacedDigit()
            }
            if model.hasLocalEdits(e.path) {
                Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 11)).foregroundStyle(Web.warn)
                    .help("This file has local edits the server hasn't seen")
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 7).fill(model.focused == e.path ? Web.active : .clear))
        .contentShape(Rectangle())
        .onTapGesture { Task { await model.show(e.path) } }
    }

    // MARK: Detail

    @ViewBuilder var detail: some View {
        if model.entries.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "checkmark.circle").font(.system(size: 28)).foregroundStyle(Web.ok)
                Text("Nothing to review").font(.system(size: 14, weight: .medium))
                Text(model.incoming ? "No changes from the server are waiting." : "No local changes are waiting.")
                    .font(.system(size: 12)).foregroundStyle(Web.muted)
            }
        } else if let d = model.diff, let focused = model.focused, d.path == focused {
            VStack(spacing: 0) {
                fileHeader(d)
                if model.hasLocalEdits(focused) { LocalEditsPanel(model: model, path: focused).padding(12) }
                Rectangle().fill(Web.line).frame(height: 1)
                DiffBody(doc: d)
            }
            .background(Web.surface)
        } else {
            ProgressView().controlSize(.small)
        }
    }

    func fileHeader(_ d: DiffDocument) -> some View {
        HStack(spacing: 10) {
            Text(d.path).font(Web.mono).lineLimit(1).truncationMode(.middle)
            Spacer()
            if !d.isBinary && !d.tooLarge {
                Text("+\(d.additions)").font(.system(size: 12, weight: .medium, design: .monospaced)).foregroundStyle(Web.ok)
                Text("−\(d.deletions)").font(.system(size: 12, weight: .medium, design: .monospaced)).foregroundStyle(Web.danger)
            }
            Text(model.incoming ? "this Mac → server version" : "server → this Mac").font(.system(size: 11)).foregroundStyle(Web.subtle)
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
    }

    // MARK: Footer

    var footer: some View {
        HStack(spacing: 10) {
            if let r = model.result {
                Text(r).font(.system(size: 12)).foregroundStyle(Web.muted).lineLimit(2)
            }
            Spacer()
            Button("Not Now") { onClose() }
                .keyboardShortcut(.cancelAction)
            Button(model.incoming ? "Apply All to Mac" : "Sync All to Server") { Task { await model.approveAll() } }
                .disabled(model.entries.isEmpty || model.busy)
            Button(model.incoming ? "Apply Selected to Mac" : "Sync Selected to Server") { Task { await model.approveSelected() } }
                .keyboardShortcut(.defaultAction)
                .disabled(model.checked.isEmpty || model.busy)
                .accessibilityIdentifier("approveSelected")
        }
        .controlSize(.large)
        .padding(.horizontal, 16).padding(.vertical, 12)
    }
}

/// A / M / D badge.
struct KindBadge: View {
    let kind: PendingChange.Kind
    var body: some View {
        Text(kind == .added ? "A" : kind == .deleted ? "D" : "M")
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundStyle(color)
            .frame(width: 18, height: 18)
            .background(RoundedRectangle(cornerRadius: 4).fill(color.opacity(0.14)))
    }
    var color: Color { kind == .added ? Web.ok : kind == .deleted ? Web.danger : Web.warn }
}

/// Choices for an incoming file whose local copy has edits the server has not seen.
struct LocalEditsPanel: View {
    @ObservedObject var model: ReviewModel
    let path: String

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(model.backupsAvailable ? "Your local edits will be backed up on the server" : "This file has local edits the server hasn't seen",
                  systemImage: model.backupsAvailable ? "externaldrive.badge.checkmark" : "exclamationmark.triangle.fill")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(model.backupsAvailable ? Web.fg : Web.warn)
            ForEach(LocalEditChoice.allCases, id: \.self) { c in
                let disabled = c == .backUpAndOverwrite && !model.backupsAvailable
                Button { model.choices[path] = c } label: {
                    HStack(spacing: 7) {
                        Image(systemName: model.choice(for: path) == c ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(model.choice(for: path) == c ? Web.accent : Web.subtle)
                        Text(Self.title(c)).font(.system(size: 12))
                            .foregroundStyle(disabled ? Web.subtle : (c == .overwriteWithoutBackup ? Web.danger : Web.fg))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(disabled)
                .help(disabled ? "This hub can't keep backups yet, so nothing is overwritten with a backup." : Self.help(c))
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 9).fill(Web.warnSoft))
    }

    static func title(_ c: LocalEditChoice) -> String {
        switch c {
        case .backUpAndOverwrite: return "Back up and overwrite"
        case .overwriteWithoutBackup: return "Overwrite without backup…"
        case .syncMineInstead: return "Sync my version instead"
        case .skip: return "Skip"
        }
    }

    static func help(_ c: LocalEditChoice) -> String {
        switch c {
        case .backUpAndOverwrite: return "Your version is kept on the server (Backups), then the server's version is written here."
        case .overwriteWithoutBackup: return "Your local changes are lost. You'll be asked to confirm."
        case .syncMineInstead: return "Your version goes to the server; the server's change for this file is dropped."
        case .skip: return "Leave this file as it is for now."
        }
    }
}

/// Unified diff with old / new line numbers, red / green rows, hunk headers.
struct DiffBody: View {
    let doc: DiffDocument

    var body: some View {
        if doc.isBinary || doc.tooLarge || doc.hunks.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: doc.isBinary ? "doc.zipper" : "doc.text").font(.system(size: 26)).foregroundStyle(Web.subtle)
                Text(doc.isBinary ? "Binary file" : doc.tooLarge ? "Too large for a line diff" : (doc.identical ? "No changes" : "Empty file"))
                    .font(.system(size: 13, weight: .medium))
                Text("\(size(doc.oldSize)) → \(size(doc.newSize))").font(.system(size: 12)).foregroundStyle(Web.muted)
                Text("sha256 \(short(doc.oldHash)) → \(short(doc.newHash))").font(.system(size: 11, design: .monospaced)).foregroundStyle(Web.subtle)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            GeometryReader { geo in
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(doc.hunks) { h in
                            Text(h.header)
                                .font(Web.mono)
                                .foregroundStyle(Web.subtle)
                                .padding(.leading, 112)
                                .padding(.vertical, 4)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Web.hunk)
                            ForEach(Array(h.lines.enumerated()), id: \.offset) { _, line in DiffRow(line: line) }
                        }
                    }
                    .frame(minWidth: geo.size.width, alignment: .leading)
                }
            }
        }
    }

    func size(_ n: Int64?) -> String { n.map { Formatters.bytes($0) } ?? "absent" }
    func short(_ h: String?) -> String { h.map { String($0.prefix(10)) + "…" } ?? "—" }
}

struct DiffRow: View {
    let line: DiffLine
    var body: some View {
        HStack(spacing: 0) {
            Text(line.oldNumber.map(String.init) ?? "").frame(width: 44, alignment: .trailing).padding(.trailing, 6)
                .foregroundStyle(Web.subtle).background(gutter)
            Text(line.newNumber.map(String.init) ?? "").frame(width: 44, alignment: .trailing).padding(.trailing, 6)
                .foregroundStyle(Web.subtle).background(gutter)
            Text(sign).frame(width: 18).foregroundStyle(signColor)
            Text(verbatim: line.text.isEmpty ? " " : line.text.replacingOccurrences(of: "\t", with: "    "))
                .fixedSize(horizontal: true, vertical: false)
                .padding(.trailing, 16)
            Spacer(minLength: 0)
        }
        .font(Web.mono)
        .padding(.vertical, 1)
        .background(background)
    }

    var sign: String { line.kind == .added ? "+" : line.kind == .removed ? "−" : "" }
    var signColor: Color { line.kind == .added ? Web.ok : line.kind == .removed ? Web.danger : Web.subtle }
    var background: Color { line.kind == .added ? Web.diffAdd : line.kind == .removed ? Web.diffDel : .clear }
    var gutter: Color { line.kind == .added ? Web.diffAddStrong : line.kind == .removed ? Web.diffDelStrong : .clear }
}
