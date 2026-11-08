import AppKit
import WorkstationCore
import SwiftUI

/// Linked Folders window (⌘⇧L) and Settings → Folders.
///
/// Link a folder or a single file three ways: Choose… (click down level by level), a typed or
/// pasted path, or drag and drop: each ending in the same confirmation before the first upload.
/// Per project: pending changes in both directions (Review…), conflicts, Pull Back (server copy
/// stays), Remove from Server… (separate, confirmed), History…, Pause, Unlink.
public struct LinkedFoldersView: View {
    @ObservedObject var shell: ShellModel
    @ObservedObject var projects: ProjectsModel
    var compact: Bool
    @ViewState private var typedPath = ""
    @ViewState private var typedError: String? = nil
    @ViewState private var dropTargeted: Bool

    public init(shell: ShellModel, projects: ProjectsModel, compact: Bool = false, dropTargeted: Bool = false) {
        self.shell = shell; self.projects = projects; self.compact = compact
        _dropTargeted = ViewState(wrappedValue: dropTargeted)
    }

    public var body: some View {
        Form {
            Section {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        if !compact { Text("Linked Folders").font(.headline) }
                        Text("Folders and files on this Mac mirrored to the server. Mac changes sync on their own; server changes wait for your approval.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    Button { shell.linkWithPanel() } label: { Label("Choose…", systemImage: "folder.badge.plus") }
                        .disabled(!canLink)
                        .accessibilityIdentifier("linkChoose")
                }
                HStack(spacing: 8) {
                    TextField("Path", text: $typedPath, prompt: Text("Paste or type a path, e.g. ~/code/sample-app or ~/notes.md"))
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(linkTyped)
                        .onChange(of: typedPath) { _, _ in typedError = nil }
                        .accessibilityIdentifier("linkPath")
                    Button("Link", action: linkTyped)
                        .disabled(!canLink || typedPath.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if let typedError {
                    Label(typedError, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(Theme.danger)
                }
                Text("You can also drag folders or files here, or onto Agent Workstation in the Dock.")
                    .font(.caption).foregroundStyle(.secondary)
                if !projects.isConnected {
                    Label(shell.phase.isOnline ? "Sign in in the main window to link folders." : "Not connected to the hub.",
                          systemImage: "person.crop.circle.badge.questionmark")
                        .font(.callout).foregroundStyle(.secondary)
                }
                if let d = shell.disk, d.level != .ok { StorageLine(status: d) }
                if let m = projects.message {
                    HStack(alignment: .firstTextBaseline) {
                        Text(m).font(.callout).foregroundStyle(.secondary)
                        Spacer()
                        Button { projects.message = nil } label: { Image(systemName: "xmark") }
                            .buttonStyle(.borderless).accessibilityLabel("Dismiss")
                    }
                }
            }

            if projects.linked.isEmpty && projects.isConnected {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Nothing linked yet").font(.body.weight(.medium))
                        Text("Linking uploads the folder once you confirm (ignoring .git, node_modules, build, dist, .venv, target and your .gitignore rules). A single file links as a project of its own.")
                            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 2)
                }
            }

            ForEach(projects.linked) { p in
                Section {
                    LinkedFolderRow(shell: shell, projects: projects, linked: p, status: projects.status(p.id), hub: projects.hubProject(p.id))
                }
            }

            let serverOnly = projects.hubProjects.filter { hp in !projects.linked.contains { $0.id == hp.id } }
            if !serverOnly.isEmpty {
                Section("On the server only") {
                    ForEach(serverOnly) { hp in
                        LabeledContent {
                            Text("\(hp.pendingFiles) to review · \(Formatters.bytes(hp.sizeBytes))").foregroundStyle(.secondary)
                        } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(hp.name)
                                    if let o = hp.origin { Text("Linked from \(o)").font(.caption).foregroundStyle(.secondary) }
                                }
                            } icon: { Image(systemName: "externaldrive") }
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .frame(minWidth: 540, idealWidth: 620, minHeight: compact ? 380 : 460)
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Theme.accent, style: StrokeStyle(lineWidth: 2, dash: [7, 5]))
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.accent.opacity(0.08)))
                    .overlay(Label("Drop to link", systemImage: "folder.badge.plus").font(.title3.weight(.medium)).foregroundStyle(Theme.accent))
                    .padding(10)
                    .allowsHitTesting(false)
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            shell.linkDropped(urls)
            return !urls.isEmpty
        } isTargeted: { dropTargeted = $0 }
        .sheet(isPresented: Binding(get: { !projects.pendingLinks.isEmpty }, set: { if !$0 { projects.cancelPendingLinks() } })) {
            LinkConfirmView(projects: projects)
        }
    }

    var canLink: Bool { projects.isConnected && !projects.linking && shell.diskLevel != .block }

    func linkTyped() {
        let text = typedPath
        Task {
            do {
                try await shell.linkTypedPath(text)
                typedPath = ""
                typedError = nil
            } catch {
                typedError = error.localizedDescription
            }
        }
    }
}

/// "Link and upload?": one confirmation for everything picked, typed or dropped.
public struct LinkConfirmView: View {
    @ObservedObject var projects: ProjectsModel
    public init(projects: ProjectsModel) { self.projects = projects }

    public var body: some View {
        if let plan = projects.pendingLinks.first, let model = plan.selection {
            LinkSelectionView(projects: projects, plan: plan, model: model)
        } else {
            plainConfirmation
        }
    }

    var plainConfirmation: some View {
        let plans = projects.pendingLinks
        let files = plans.reduce(0) { $0 + $1.files }
        let bytes = plans.reduce(Int64(0)) { $0 + $1.bytes }
        return VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "arrow.up.doc.on.clipboard").font(.system(size: 26)).foregroundStyle(Theme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(plans.count == 1 ? "Link “\(plans[0].target.picked.lastPathComponent)”?" : "Link \(plans.count) items?").font(.title3.weight(.semibold))
                    Text("Uploads \(files.formatted()) file\(files == 1 ? "" : "s") (\(Formatters.bytes(bytes))) to the server. Your files on this Mac are only read.")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            VStack(spacing: 0) {
                ForEach(plans) { p in
                    HStack(spacing: 8) {
                        Image(systemName: p.target.isSingleFile ? "doc" : "folder").foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(p.target.picked.lastPathComponent).font(.body.weight(.medium))
                            Text(p.target.picked.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        }
                        Spacer()
                        Text(p.target.isSingleFile ? Formatters.bytes(p.bytes) : "\(p.files.formatted()) files · \(Formatters.bytes(p.bytes))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                    if p.id != plans.last?.id { Divider() }
                }
            }
            if !projects.linkErrors.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(projects.linkErrors, id: \.self) { e in
                        Label(e, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(Theme.warning)
                    }
                }
            }
            HStack {
                Spacer()
                Button("Cancel") { projects.cancelPendingLinks() }.keyboardShortcut(.cancelAction)
                Button("Link and Upload") { Task { await projects.confirmPendingLinks() } }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("confirmLink")
            }
        }
        .padding(22)
        .frame(width: 500)
    }
}

/// Server storage warning inside the folders window (never offers automatic deletion).
struct StorageLine: View {
    let status: DiskStatus
    var body: some View {
        let block = status.level == .block
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(block ? "Server storage \(Int(status.usedPercent.rounded()))% used: syncing to the server is paused"
                           : "Server storage \(Int(status.usedPercent.rounded()))% used")
                    .font(.callout.weight(.medium))
                Text(block ? "Your changes stay pending on this Mac until usage drops below \(Int(status.blockPercent))%. Nothing is deleted automatically."
                           : "Nothing is deleted automatically. Remove projects you no longer need from the server yourself.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        } icon: {
            Image(systemName: block ? "externaldrive.badge.xmark" : "externaldrive.badge.exclamationmark")
                .foregroundStyle(block ? Theme.danger : Theme.warning)
        }
    }
}

struct LinkedFolderRow: View {
    @ObservedObject var shell: ShellModel
    @ObservedObject var projects: ProjectsModel
    let linked: LinkedProject
    let status: SyncStatus
    let hub: Project?
    @ViewState private var confirmPull = false
    @ViewState private var confirmRemove = false
    @ViewState private var confirmDiscard = false
    @ViewState private var showSkipped = false
    @ViewState private var working = false
    @ViewState private var error: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: linked.isSingleFile ? "doc.fill" : "folder.fill").font(.system(size: 20)).foregroundStyle(Theme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(linked.name).font(.body.weight(.semibold))
                    Text(linked.pickedURL.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 8)
                PhaseBadge(phase: status.phase)
            }
            Text(stats).font(.caption).foregroundStyle(.secondary)
            if status.cloudOnly > 0 {
                let provider = CloudProvider.detect(linked.localURL)
                HStack(spacing: 6) {
                    Image(systemName: "icloud.and.arrow.down").foregroundStyle(Theme.warning)
                    Text("\(provider.shortLine(status.cloudOnly)). \(provider.hint)").font(.caption).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    Button("Show in Finder") { projects.revealInFinder(linked.id) }.controlSize(.small)
                }
            }
            if !status.outgoing.isEmpty || !status.incoming.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    if !status.outgoing.isEmpty {
                        pendingLine(icon: "arrow.up.circle.fill", text: "\(status.outgoing.count) local change\(status.outgoing.count == 1 ? "" : "s") not on the server yet",
                                    incoming: false)
                    }
                    if !status.incoming.isEmpty {
                        pendingLine(icon: "arrow.down.circle.fill", text: "\(status.incoming.count) change\(status.incoming.count == 1 ? "" : "s") from the server to review",
                                    incoming: true)
                    }
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.accent.opacity(0.08)))
            }
            if !status.conflicts.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Label("\(status.conflicts.count) conflict\(status.conflicts.count == 1 ? "" : "s"): changed on both sides", systemImage: "exclamationmark.triangle.fill")
                        .font(.callout.weight(.medium)).foregroundStyle(Theme.warning)
                    ForEach(status.conflicts) { c in
                        HStack {
                            Text(c.path).font(.system(.caption, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Button("Keep Mine") { Task { await projects.keepMine(linked.id, path: c.path) } }
                                .help("Put your version on the server; the server keeps Claude's in its history")
                            Button("Review Server's…") { useServer(c.path) }
                                .help("See the server's version and decide in the review window")
                        }
                        .controlSize(.small)
                    }
                }
            }
            if let e = status.lastError, !status.phase.isBusy {
                Text(e).font(.caption).foregroundStyle(Theme.danger).lineLimit(3)
            }
            let skipped = status.skipped.map { ($0.path, $0.reason.label) } + status.hubSkipped.map { ($0.path, $0.reason) }
            if !skipped.isEmpty {
                DisclosureGroup(isExpanded: $showSkipped) {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(skipped.enumerated()), id: \.offset) { _, s in
                            HStack {
                                Text(s.0).font(.system(.caption, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                                Spacer()
                                Text(s.1).font(.caption).foregroundStyle(.tertiary)
                            }
                        }
                    }
                } label: {
                    Text("\(skipped.count) file\(skipped.count == 1 ? "" : "s") not synced").font(.caption).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 8) {
                Button("Pull Back…") { confirmPull = true }
                    .help("Accept the server's pending changes and review them before anything is written here. The server copy stays.")
                Button("Review on Web…") { shell.open(.web("/projects/\(linked.id)")) }
                Button("History…") { shell.windows?.showHistory(projectId: linked.id) }
                Spacer()
                Button("Remove from Server…", role: .destructive) { confirmRemove = true }
                    .accessibilityIdentifier("removeFromServer")
                Menu {
                    Button("Check the Server Now") { Task { await projects.reconcile(linked.id) } }
                    Button(linked.paused ? "Resume" : "Pause") { Task { await projects.setPaused(linked.id, !linked.paused) } }
                    Button("Show in Finder") { projects.revealInFinder(linked.id) }
                    Divider()
                    Button("Unlink (Keep Both Copies)") { Task { await projects.unlink(linked.id) } }
                } label: { Image(systemName: "ellipsis.circle") }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .accessibilityLabel("More actions for \(linked.name)")
            }
            .controlSize(.small)
            .disabled(working)
            if let error { Text(error).font(.caption).foregroundStyle(Theme.danger) }
        }
        .padding(.vertical, 2)
        .confirmationDialog("Pull back “\(linked.name)”?", isPresented: $confirmPull) {
            Button("Pull Back and Review") { pullBack() }
        } message: {
            Text("Claude's pending changes are accepted on the server and shown for review. Nothing is written on this Mac until you apply it, and the server copy stays exactly where it is.")
        }
        .confirmationDialog("Remove “\(linked.name)” from the server?", isPresented: $confirmRemove) {
            Button("Remove from Server", role: .destructive) { remove(discard: false) }
        } message: {
            Text(removeMessage)
        }
        .confirmationDialog("The server still has changes you have not pulled back.", isPresented: $confirmDiscard) {
            Button("Pull Back First") { pullBack() }
            Button("Discard Them and Remove", role: .destructive) { remove(discard: true) }
        } message: {
            Text("Removing now permanently deletes \(hub?.pendingFiles ?? 0) change\((hub?.pendingFiles ?? 0) == 1 ? "" : "s") that exist only on the server. Your folder on this Mac is not touched either way.")
        }
    }

    var removeMessage: String {
        var s = "Deletes the server copy of \(linked.name)"
        if let hub { s += " (\(Formatters.bytes(hub.sizeBytes)))" }
        s += " and its review history on the server."
        if let n = hub?.pendingFiles, n > 0 { s += " \(n) change\(n == 1 ? "" : "s") on the server have not been pulled back." }
        s += " Your \(linked.isSingleFile ? "file" : "folder") on this Mac (\(linked.pickedURL.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))) is not touched; syncing for it stops."
        return s
    }

    func pendingLine(icon: String, text: String, incoming: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon).foregroundStyle(Theme.accent)
            Text(text).font(.callout)
            Spacer()
            Button("Review…") { shell.open(.review(projectId: linked.id, incoming: incoming)) }
                .controlSize(.small)
                .accessibilityIdentifier(incoming ? "reviewIncoming" : "reviewOutgoing")
        }
    }

    var stats: String {
        var parts = [linked.isSingleFile ? "single file" : "\(status.trackedFiles.formatted()) files", Formatters.bytes(status.localBytes)]
        if let hub { parts.append("\(Formatters.bytes(hub.sizeBytes)) on server") }
        if let hub, hub.pendingFiles > 0 { parts.append("\(hub.pendingFiles) to review on the web") }
        return parts.joined(separator: " · ")
    }

    func useServer(_ path: String) {
        Task {
            do {
                try await projects.useServerVersion(linked.id, path: path)
                shell.open(.review(projectId: linked.id, incoming: true))
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    func pullBack() {
        working = true
        Task {
            do {
                let n = try await projects.pullBack(linked.id)
                if n > 0 { shell.open(.review(projectId: linked.id, incoming: true)) }
            } catch {
                self.error = error.localizedDescription
            }
            working = false
        }
    }

    func remove(discard: Bool) {
        working = true
        Task {
            do {
                try await projects.removeFromServer(linked.id, discardRemaining: discard)
            } catch let e as HubError where e.status == 409 || e.status == 412 {
                confirmDiscard = true
            } catch {
                self.error = error.localizedDescription
            }
            working = false
        }
    }
}

struct PhaseBadge: View {
    let phase: SyncPhase
    var body: some View {
        HStack(spacing: 5) {
            if phase.isBusy { ProgressView().controlSize(.mini) } else { Dot(color: color, size: 7) }
            Text(phase.label).font(.caption.weight(.medium)).lineLimit(1)
        }
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(Capsule().fill(Color.secondary.opacity(0.12)))
        .foregroundStyle(.secondary)
        .frame(maxWidth: 260, alignment: .trailing)
    }

    var color: Color {
        switch phase {
        case .watching: return Theme.success
        case .error: return Theme.danger
        case .paused: return Theme.warning
        default: return Color.secondary
        }
    }
}
