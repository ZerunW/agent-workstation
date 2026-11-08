import AppKit
import WorkstationCore
import SwiftUI

/// Titlebar height of the main window (0 in full screen), kept current by `ShellWindows`.
@MainActor
public final class WindowMetrics: ObservableObject {
    @Published public var titlebarHeight: CGFloat
    public init(titlebarHeight: CGFloat = 28) { self.titlebarHeight = titlebarHeight }

    func update(from window: NSWindow) {
        let h = max(0, window.frame.height - window.contentLayoutRect.height)
        if abs(h - titlebarHeight) > 0.5 { titlebarHeight = h }
    }
}

/// Main window content: the web app under a transparent titlebar. The traffic lights sit on a
/// thin native strip painted in the page's own top-edge colours (sidebar colour over the web
/// sidebar, main colour after it), so the page's layout is left alone and nothing is covered.
/// The offline state, the loading state and the first-run sheet are native.
public struct ShellRootView<Web: View>: View {
    @ObservedObject var shell: ShellModel
    @ObservedObject var metrics: WindowMetrics
    let web: Web

    public init(shell: ShellModel, metrics: WindowMetrics, web: Web) {
        self.shell = shell; self.metrics = metrics; self.web = web
    }

    public var body: some View {
        ZStack(alignment: .top) {
            Color(nsColor: Theme.pageBackground)
            VStack(spacing: 0) {
                if !shell.chrome.overlay {
                    TitlebarStrip(chrome: shell.chrome).frame(height: metrics.titlebarHeight)
                }
                web
            }
            // A dropped or picked folder: the same selection window as File → Link Folder, once scanned.
            .sheet(item: Binding(get: { shell.uploadConfirmation?.selection != nil ? shell.uploadConfirmation : nil },
                                 set: { if $0 == nil { shell.cancelFolderUpload() } })) { c in
                if let model = c.selection {
                    LinkSelectionView(projects: shell.projects, target: c.target, model: model,
                                      onCancel: { shell.cancelFolderUpload() }, onConfirm: { await shell.confirmFolderUpload() })
                }
            }
            // Dismissed only by its buttons (a queued conflict for another project may follow).
            .background(Color.clear.sheet(item: Binding(get: { shell.incomingSheet }, set: { _ in })) { sheet in
                Group {
                    switch sheet {
                    case .conflict(let c): IncomingConflictSheet(shell: shell, conflict: c)
                    case .server(let b): ServerChangesSheet(shell: shell, changes: b)
                    }
                }
                .interactiveDismissDisabled()
            })
            if shell.chrome.overlay {
                // The page reserves the titlebar area itself; keep it draggable.
                TitlebarStrip(chrome: shell.chrome).frame(height: metrics.titlebarHeight)
            }
            stateOverlay
            VStack(spacing: 8) {
                if let fs = shell.folderSession, shell.phase.isOnline {
                    FolderSessionBadge(shell: shell, state: fs)
                }
                if let d = shell.updates.download {
                    UpdateDownloadBadge(state: d)
                }
                if let n = shell.notice {
                    NoticeBadge(shell: shell, notice: n)
                }
            }
            .padding(.top, metrics.titlebarHeight + 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .ignoresSafeArea()
        .frame(minWidth: 720, minHeight: 480)
        .sheet(isPresented: $shell.showFirstRun) {
            FirstRunView(shell: shell).interactiveDismissDisabled()
        }
    }

    @ViewBuilder var stateOverlay: some View {
        switch shell.phase {
        case .offline(let message):
            OfflineView(shell: shell, message: message)
                .padding(.top, metrics.titlebarHeight)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(nsColor: Theme.pageBackground))
                .overlay(alignment: .top) { TitlebarStrip(chrome: .unknown).frame(height: metrics.titlebarHeight) }
        case .needsHubURL:
            Color(nsColor: Theme.pageBackground)
                .overlay(alignment: .top) { TitlebarStrip(chrome: .unknown).frame(height: metrics.titlebarHeight) }
        case .connecting, .online:
            if !shell.pageLoaded {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(nsColor: Theme.pageBackground))
                    .allowsHitTesting(false)
                    .overlay(alignment: .top) { TitlebarStrip(chrome: .unknown).frame(height: metrics.titlebarHeight) }
            }
        }
    }
}

/// Before a folder that is not linked yet is uploaded: its name, file count and size.
struct FolderUploadSheet: View {
    @ObservedObject var shell: ShellModel
    let confirmation: FolderUploadConfirmation

    /// The live state (the count arrives after the sheet is up).
    var current: FolderUploadConfirmation { shell.uploadConfirmation?.id == confirmation.id ? shell.uploadConfirmation! : confirmation }

    static func countLine(_ p: UploadPreview?) -> String {
        guard let p else { return "…" }
        let more = p.truncated ? "+" : ""
        return "\(p.files.formatted())\(more) file\(p.files == 1 && !p.truncated ? "" : "s") · \(Formatters.bytes(p.bytes))\(more)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "folder.fill").font(.system(size: 28)).foregroundStyle(Theme.accent)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Upload “\(current.name)” to the server?")
                        .font(.headline).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Text(Self.countLine(current.preview)).font(.callout).foregroundStyle(.secondary).monospacedDigit()
                        .accessibilityIdentifier("folderUploadCount")
                }
            }
            HStack {
                Spacer()
                Button("Cancel") { shell.cancelFolderUpload() }
                    .keyboardShortcut(.cancelAction)
                Button("Upload") { Task { await shell.confirmFolderUpload() } }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}

/// Server changes for files with unsynced local edits: the review window's choices, nothing written
/// until one is clicked.
struct IncomingConflictSheet: View {
    @ObservedObject var shell: ShellModel
    let conflict: IncomingConflictState

    var current: IncomingConflictState { shell.incomingConflict?.id == conflict.id ? shell.incomingConflict! : conflict }

    func choose(_ c: LocalEditChoice) { Task { await shell.resolveIncomingConflict(c) } }

    var body: some View {
        let c = current
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 26)).foregroundStyle(Theme.warning)
                VStack(alignment: .leading, spacing: 3) {
                    Text(c.confirmingLoss ? "Overwrite \(c.paths.count == 1 ? (c.paths[0] as NSString).lastPathComponent : "\(c.paths.count) files") without a backup?" : c.title)
                        .font(.headline).fixedSize(horizontal: false, vertical: true)
                    Text(c.projectName).font(.callout).foregroundStyle(.secondary)
                }
            }
            if c.paths.count > 1 {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(c.paths.prefix(8), id: \.self) { p in
                        Text(p).font(.system(size: 11, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                    }
                    if c.paths.count > 8 { Text("+\(c.paths.count - 8)").font(.caption).foregroundStyle(.secondary) }
                }
                .padding(.leading, 38)
            }
            HStack {
                if c.confirmingLoss {
                    Spacer()
                    Button("Cancel") { shell.cancelConflictLoss() }.keyboardShortcut(.cancelAction)
                    Button("Overwrite", role: .destructive) { choose(.overwriteWithoutBackup) }
                } else {
                    Button(LocalEditsPanel.title(.skip)) { choose(.skip) }.keyboardShortcut(.cancelAction)
                    Spacer()
                    Button(LocalEditsPanel.title(.syncMineInstead)) { choose(.syncMineInstead) }
                    Button(LocalEditsPanel.title(.overwriteWithoutBackup)) { choose(.overwriteWithoutBackup) }
                    Button(LocalEditsPanel.title(.backUpAndOverwrite)) { choose(.backUpAndOverwrite) }
                        .keyboardShortcut(.defaultAction)
                        .disabled(!c.backupsAvailable)
                }
            }
        }
        .padding(20)
        .frame(width: 660)
    }
}

/// Server changes nobody approved in this app: the files with A / M / D marks, "Apply to Mac" or "Later".
struct ServerChangesSheet: View {
    @ObservedObject var shell: ShellModel
    let changes: ServerChangesState

    var current: ServerChangesState { shell.serverChanges?.projectId == changes.projectId ? shell.serverChanges! : changes }

    var body: some View {
        let b = current
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "arrow.down.doc.fill").font(.system(size: 26)).foregroundStyle(Theme.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text(b.title).font(.headline).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Text(b.projectName).font(.callout).foregroundStyle(.secondary)
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(b.items, id: \.self) { item in
                        HStack(spacing: 8) {
                            KindBadge(kind: item.kind)
                            Text(item.path).font(.system(size: 12, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: min(CGFloat(b.items.count) * 22 + 4, 260))
            .padding(.leading, 38)
            HStack {
                Spacer()
                Button("Later") { shell.laterServerChanges() }.keyboardShortcut(.cancelAction)
                Button("Apply to Mac") { Task { await shell.applyServerChanges() } }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 480)
    }
}

/// `test.py → Mac` (hides by itself) or a one-line error (stays until dismissed).
struct NoticeBadge: View {
    @ObservedObject var shell: ShellModel
    let notice: ShellNotice

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: notice.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(notice.isError ? Color.orange : Color.green)
            Text(notice.text).lineLimit(1).truncationMode(.middle)
            if notice.isError {
                Button { shell.dismissNotice() } label: { Image(systemName: "xmark") }.buttonStyle(.borderless)
            }
        }
        .badgeCapsule()
    }
}

/// The new app build on its way to ~/Downloads.
struct UpdateDownloadBadge: View {
    let state: UpdateDownloadState

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.down.circle").foregroundStyle(.secondary)
            Text("Agent Workstation \(state.version)").fontWeight(.medium).lineLimit(1)
            ProgressView(value: state.fraction).frame(width: 120)
            Text("\(Int((state.fraction * 100).rounded()))%").foregroundStyle(.secondary).monospacedDigit()
        }
        .badgeCapsule()
    }
}

extension View {
    /// The floating capsule the main window's status badges use.
    func badgeCapsule() -> some View {
        self
            .font(.callout)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.primary.opacity(0.08)))
            .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
            .frame(maxWidth: 520)
    }
}

/// A folder being linked for a new Code session: its name and sync phase, or a one-line error.
struct FolderSessionBadge: View {
    @ObservedObject var shell: ShellModel
    let state: FolderSessionState

    var body: some View {
        HStack(spacing: 8) {
            if let error = state.error {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(error).lineLimit(1).truncationMode(.middle)
                Button { shell.dismissFolderSession() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("folderSessionDismiss")
            } else if let waiting = state.cloudWaiting {
                Image(systemName: "icloud.and.arrow.down").foregroundStyle(Theme.warning)
                Text(waiting).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                Button("Show in Finder") { shell.deps.reveal(state.folder) }.buttonStyle(.borderless)
                Button { shell.dismissFolderSession() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless)
            } else {
                ProgressView().controlSize(.small)
                Text(state.name).fontWeight(.medium).lineLimit(1)
                if let label = phaseLabel { Text(label).foregroundStyle(.secondary).lineLimit(1) }
            }
        }
        .badgeCapsule()
    }

    /// The linked project's phase, as the Linked Folders window shows it.
    var phaseLabel: String? {
        guard let p = shell.projects.linkedFolder(for: state.folder) else { return nil }
        let phase = shell.projects.status(p.id).phase
        return phase.isBusy ? phase.label : nil
    }
}

/// "Can't reach your hub": Try Again, automatic retries, or a different address.
struct OfflineView: View {
    @ObservedObject var shell: ShellModel
    let message: String
    @ViewState private var editing = false

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(.secondary)
                .padding(.bottom, 4)
            Text("Can't reach your hub").font(.title2.weight(.semibold))
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            if let hint = shell.tailnetHint {
                Label("Tailscale is not connected", systemImage: "network.slash")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(Theme.warning)
                    .padding(.top, 2)
                    .accessibilityIdentifier("tailscaleHint")
                Button(hint.buttonTitle) { shell.openTailscale() }
                    .controlSize(.large)
                    .accessibilityIdentifier("openTailscale")
            }
            HStack(spacing: 10) {
                Button("Try Again") { shell.retry() }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("offlineRetry")
                Button("Change Address…") { editing.toggle() }
            }
            .controlSize(.large)
            .padding(.top, 6)
            if editing {
                HubAddressForm(shell: shell, buttonTitle: "Connect")
                    .frame(width: 380)
                    .padding(.top, 4)
            }
            Text("Agent Workstation keeps trying in the background. Is the server on, and is this Mac on the same network or tailnet?")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
                .padding(.top, 10)
        }
        .padding(32)
    }
}

/// The native strip under the traffic lights. Draws the page's top-edge colours and moves the
/// window on drag (double-click follows the system "double-click a window's title bar" setting).
struct TitlebarStrip: NSViewRepresentable {
    var chrome: TitlebarChrome

    func makeNSView(context: Context) -> TitlebarStripView {
        let v = TitlebarStripView()
        v.chrome = chrome
        return v
    }

    func updateNSView(_ nsView: TitlebarStripView, context: Context) { nsView.chrome = chrome }
}

final class TitlebarStripView: NSView {
    var chrome: TitlebarChrome = .unknown { didSet { if chrome != oldValue { needsDisplay = true } } }

    override var mouseDownCanMoveWindow: Bool { true }
    override var isOpaque: Bool { false }
    override var isFlipped: Bool { true }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard !chrome.overlay else { return }
        let main = chrome.main.map(NSColor.init) ?? Theme.pageBackground
        main.setFill()
        bounds.fill()
        guard chrome.sidebarWidth > 0 else { return }
        let w = min(CGFloat(chrome.sidebarWidth), bounds.width)
        (chrome.sidebar.map(NSColor.init) ?? main).setFill()
        NSRect(x: 0, y: 0, width: w, height: bounds.height).fill()
        if let d = chrome.divider {
            NSColor(d).setFill()
            NSRect(x: w - 1, y: 0, width: 1, height: bounds.height).fill()
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        if event.clickCount == 2 {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize" {
            case "Minimize": window.miniaturize(nil)
            case "None": break
            default: window.zoom(nil)
            }
            return
        }
        window.performDrag(with: event)
    }
}
