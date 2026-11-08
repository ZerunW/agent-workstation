import AppKit
import Combine
import Foundation
import WorkstationCore

/// Opens the shell's native windows (AppKit-managed so the main window can be shown again
/// from a notification click even after it was closed). Tests record the calls.
@MainActor
public protocol ShellWindowPresenting: AnyObject {
    func showMain()
    func showLinkedFolders()
    /// The native review window (the only place approvals happen).
    func showReview(projectId: String, incoming: Bool)
    func showHistory(projectId: String)
}

/// A folder being linked for a new Code session (shown over the main window), or why it failed.
public struct FolderSessionState: Equatable {
    public var folder: URL
    public var error: String?
    /// The upload waits for cloud-only files: the one line to show.
    public var cloudWaiting: String?
    public var name: String { folder.lastPathComponent }
    public init(folder: URL, error: String? = nil, cloudWaiting: String? = nil) {
        self.folder = folder; self.error = error; self.cloudWaiting = cloudWaiting
    }
}

/// A short status shown over the main window.
public struct ShellNotice: Equatable, Identifiable {
    public let id = UUID()
    public var text: String
    public var isError: Bool
    public init(text: String, isError: Bool) { self.text = text; self.isError = isError }
}

/// The server-changes sheet on the main window.
public enum IncomingSheet: Equatable, Identifiable {
    case conflict(IncomingConflictState)
    case server(ServerChangesState)

    public var id: String {
        switch self {
        case .conflict(let c): return "conflict:" + c.id
        case .server(let b): return "server:" + b.projectId + ":" + b.items.map(\.path).joined(separator: "\n")
        }
    }
    /// One sheet of each kind per project.
    var slot: String {
        switch self {
        case .conflict(let c): return "conflict:" + c.projectId
        case .server(let b): return "server:" + b.projectId
        }
    }
}

/// Incoming server changes nobody approved in this app: "Apply to Mac" or "Later".
public struct ServerChangesState: Equatable {
    public struct Item: Equatable, Hashable {
        public var path: String
        public var kind: PendingChange.Kind
        public init(path: String, kind: PendingChange.Kind) { self.path = path; self.kind = kind }
    }
    public var projectId: String
    public var projectName: String
    public var items: [Item]
    public var title: String {
        "\(items.count == 1 ? (items[0].path as NSString).lastPathComponent : "\(items.count) files") from the server"
    }
    public init(projectId: String, projectName: String, items: [Item]) {
        self.projectId = projectId; self.projectName = projectName; self.items = items
    }
}

/// Incoming server changes for files with unsynced local edits (one project).
public struct IncomingConflictState: Equatable, Identifiable {
    public var projectId: String
    public var projectName: String
    public var paths: [String]
    /// The local version of each file when the sheet came up (nil = absent).
    public var seen: [String: String?]
    public var backupsAvailable: Bool
    /// "Overwrite without backup" was chosen: the sheet asks once more.
    public var confirmingLoss = false
    public var id: String { projectId + ":" + paths.joined(separator: "\n") }
    public var title: String {
        "\(paths.count == 1 ? (paths[0] as NSString).lastPathComponent : "\(paths.count) files") changed on this Mac and on the server"
    }
    public init(projectId: String, projectName: String, paths: [String], seen: [String: String?] = [:], backupsAvailable: Bool) {
        self.projectId = projectId; self.projectName = projectName; self.paths = paths; self.seen = seen; self.backupsAvailable = backupsAvailable
    }
}

/// A folder that is not linked yet, dropped or picked for a Code session: the selection window
/// (the same one File → Link Folder shows) decides what is uploaded.
public struct FolderUploadConfirmation: Identifiable, Equatable {
    public let id = UUID()
    public var target: LinkTarget
    /// What the default selection would upload (nil = counting).
    public var preview: UploadPreview?
    /// The selection window's model (nil while the folder is being scanned).
    public var selection: LinkSelectionModel?
    public var name: String { target.picked.lastPathComponent }
    public init(target: LinkTarget, preview: UploadPreview? = nil, selection: LinkSelectionModel? = nil) {
        self.target = target; self.preview = preview; self.selection = selection
    }
    public static func == (a: Self, b: Self) -> Bool {
        a.id == b.id && a.target == b.target && a.preview == b.preview && a.selection === b.selection
    }
}

/// Root model of the native shell around the hub's web app.
///
/// Native on purpose: the hub address (first run / Settings), folder sync (FSEvents), system
/// notifications + Dock badge from the hub WebSocket, menu commands mapped to web routes and
/// shortcuts, downloads, and the offline state. Everything else: sessions, transcript,
/// composer, usage, memory, projects review, skills, admin, login: is the web app.
@MainActor
public final class ShellModel: ObservableObject, WebPageDelegate {
    public struct Dependencies {
        public var settings: AppSettings
        public var urlSession: URLSession?
        public var store: LinkedProjectStore
        public var makeEventSource: (URL, String) -> HubEventSource
        public var notifier: Notifier
        public var launchAtLogin: LaunchAtLoginControlling
        /// Executes approved write batches (the WorkstationWriter XPC service inside AgentWorkstation.app).
        public var writer: LocalWriting
        public var syncUsesWatcher: Bool
        public var openURL: (URL) -> Void
        public var reveal: (URL) -> Void
        /// Seconds between automatic reachability retries while offline (0 = off).
        public var offlineRetryInterval: TimeInterval
        /// The native folder picker for the page's folder button (a sheet on `window` when given).
        public var pickFolder: @MainActor (NSWindow?) async -> URL?
        /// Check for Updates: alerts, the running build, the release public key, where dmgs are saved,
        /// seconds between automatic checks (0 = launch only).
        public var updateAlerts: UpdateAlerting
        public var currentBuild: String?
        /// Update channel of this build (`WorkstationPlatform`: `mac` / `mac-intel`).
        public var appPlatform: String
        public var releasePublicKey: Data?
        public var downloadsDirectory: URL
        public var updateCheckInterval: TimeInterval
        /// Tailscale hint in the offline state: the system resolver, the installed-app lookup by
        /// bundle identifier, and launching an app.
        public var resolveHost: @Sendable (String) -> [String]
        public var appForBundleID: (String) -> URL?
        public var openApplication: (URL) -> Void

        public init(settings: AppSettings, urlSession: URLSession? = nil, store: LinkedProjectStore,
                    makeEventSource: @escaping (URL, String) -> HubEventSource, notifier: Notifier,
                    launchAtLogin: LaunchAtLoginControlling, writer: LocalWriting = InProcessWriter(), syncUsesWatcher: Bool = true,
                    openURL: @escaping (URL) -> Void = { NSWorkspace.shared.open($0) },
                    reveal: @escaping (URL) -> Void = { NSWorkspace.shared.activateFileViewerSelecting([$0]) },
                    offlineRetryInterval: TimeInterval = 15,
                    pickFolder: @escaping @MainActor (NSWindow?) async -> URL? = Dependencies.folderPanel,
                    updateAlerts: UpdateAlerting? = nil, currentBuild: String? = AppBuild.running, appPlatform: String = AppPlatform.running,
                    releasePublicKey: Data? = ReleaseSignature.bundledPublicKey,
                    downloadsDirectory: URL = DownloadPlanner.downloadsDirectory, updateCheckInterval: TimeInterval = 24 * 3600,
                    resolveHost: @escaping @Sendable (String) -> [String] = { TailnetHost.resolve($0) },
                    appForBundleID: @escaping (String) -> URL? = { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) },
                    openApplication: @escaping (URL) -> Void = { NSWorkspace.shared.openApplication(at: $0, configuration: NSWorkspace.OpenConfiguration()) }) {
            self.settings = settings; self.urlSession = urlSession; self.store = store; self.makeEventSource = makeEventSource
            self.notifier = notifier; self.launchAtLogin = launchAtLogin; self.writer = writer; self.syncUsesWatcher = syncUsesWatcher
            self.openURL = openURL; self.reveal = reveal; self.offlineRetryInterval = offlineRetryInterval
            self.pickFolder = pickFolder
            self.updateAlerts = updateAlerts ?? SystemUpdateAlerts()
            self.currentBuild = currentBuild; self.appPlatform = appPlatform; self.releasePublicKey = releasePublicKey
            self.downloadsDirectory = downloadsDirectory; self.updateCheckInterval = updateCheckInterval
            self.resolveHost = resolveHost; self.appForBundleID = appForBundleID; self.openApplication = openApplication
        }

        /// One folder, nothing else selectable.
        @MainActor public static func folderPanel(_ window: NSWindow?) async -> URL? {
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            panel.prompt = "Choose"
            let response: NSApplication.ModalResponse
            if let window {
                response = await withCheckedContinuation { cont in panel.beginSheetModal(for: window) { cont.resume(returning: $0) } }
            } else {
                response = panel.runModal()
            }
            return response == .OK ? panel.url : nil
        }

        @MainActor public static func live() -> Dependencies {
            Dependencies(settings: AppSettings(), store: LinkedProjectStore(),
                         makeEventSource: { url, user in HubSocket(baseURL: url, user: user) },
                         notifier: SystemNotifier(), launchAtLogin: SystemLaunchAtLogin(),
                         writer: liveWriter())
        }

        /// Inside AgentWorkstation.app: the XPC service (one sandboxed child per batch). `swift run`: the same
        /// sandboxed child, started directly. Only without the writer binary: in-process.
        static func liveWriter() -> LocalWriting {
            if XPCWriter.isBundled { return XPCWriter() }
            if let child = ChildProcessWriter.sibling() { return child }
            return InProcessWriter()
        }
    }

    public enum Phase: Equatable {
        /// First run: no hub address yet.
        case needsHubURL
        case connecting
        case online
        case offline(String)

        public var isOnline: Bool { self == .online }
    }

    public let deps: Dependencies
    public var settings: AppSettings { deps.settings }
    public var notifier: Notifier { deps.notifier }

    @Published public private(set) var phase: Phase = .connecting
    @Published public var showFirstRun = false
    /// Signed-in user as reported by the web app (`localStorage["workstation.user"]`).
    @Published public private(set) var username: String?
    @Published public private(set) var isAdmin = false
    /// Current web route (`/`, `/s/<id>`, `/usage`, …).
    @Published public private(set) var route = "/"
    @Published public private(set) var pageTitle = "Agent Workstation"
    @Published public private(set) var canGoBack = false
    @Published public private(set) var canGoForward = false
    @Published public private(set) var chrome = TitlebarChrome.unknown
    @Published public private(set) var pendingPermissions: [String: PermissionRequest] = [:]
    @Published public private(set) var disk: DiskStatus?
    @Published public private(set) var socketState: SocketState = .disconnected
    @Published public private(set) var pageZoom: Double
    /// The page has loaded once since the last hub change (hides the loading spinner).
    @Published public private(set) var pageLoaded = false
    @Published public var lastError: String?
    /// Offline and the hub is a Tailscale address: `Tailscale is not connected` + open / get Tailscale.
    @Published public private(set) var tailnetHint: TailscaleApp.Target?
    /// A folder on its way to becoming a Code session's directory (folder button or drop).
    @Published public private(set) var folderSession: FolderSessionState?
    /// A short status over the main window (`test.py → Mac`, or a one-line error).
    @Published public private(set) var notice: ShellNotice?
    /// The sheet on the main window for server changes: a conflict (local edits) or "Apply to Mac".
    /// One at a time; the rest queue (conflicts first).
    @Published public private(set) var incomingSheet: IncomingSheet?
    private var sheetQueue: [IncomingSheet] = []
    public var incomingConflict: IncomingConflictState? { if case .conflict(let c)? = incomingSheet { return c }; return nil }
    public var serverChanges: ServerChangesState? { if case .server(let b)? = incomingSheet { return b }; return nil }
    /// A folder that is not linked yet, waiting for "Upload" in the sheet on the main window.
    @Published public private(set) var uploadConfirmation: FolderUploadConfirmation?

    public let projects: ProjectsModel
    public let updates: UpdateModel
    public weak var page: WebPage? {
        didSet {
            page?.pageZoom = pageZoom
            if phase.isOnline && !pageLoaded { loadApp() }
        }
    }
    public weak var windows: ShellWindowPresenting?

    public private(set) var client: HubClient?
    private var events: HubEventSource?
    private var servicesUser: String?
    private var generation = 0
    private var sessionTitles: [String: String] = [:]
    private var sessionStatus: [String: SessionStatus] = [:]
    /// Sessions as last reported (cwd, kind, activity): for routes into a project's sessions.
    private var sessions: [String: Session] = [:]
    private var lastTurnNotified: [String: Date] = [:]
    private var bootstrapped = false
    private var activationObserver: NSObjectProtocol?
    private var retryTimer: Timer?
    private var projectsObserver: AnyCancellable?
    private var updatesObserver: AnyCancellable?
    /// A route asked for before the page was ready (notification click while offline / loading).
    private var pendingRoute: String?
    private var pickingFolder = false
    private var previewTask: Task<Void, Never>?
    private var cloudWaiter: Task<Void, Error>?

    public init(deps: Dependencies) {
        self.deps = deps
        self.pageZoom = deps.settings.pageZoom
        self.username = deps.settings.username
        self.projects = ProjectsModel(store: deps.store, writer: deps.writer, useWatcher: deps.syncUsesWatcher)
        let settings = deps.settings
        updates = UpdateModel(config: .init(settings: settings, urlSession: deps.urlSession, hubURL: { settings.hubURL },
                                            currentBuild: deps.currentBuild, platform: deps.appPlatform, publicKey: deps.releasePublicKey,
                                            downloadsDirectory: deps.downloadsDirectory, reveal: deps.reveal,
                                            alerts: deps.updateAlerts, interval: deps.updateCheckInterval))
        projects.onConflict = { [weak self] c in self?.conflictArrived(c) }
        projects.onPendingIncreased = { [weak self] p, out, inc in self?.pendingIncreased(p, outgoing: out, incoming: inc) }
        projects.onAutoApplied = { [weak self] p, paths in self?.autoApplied(p, paths) }
        projects.onAutoApplyFailed = { [weak self] p, line in self?.applyFailed(p, line) }
        projects.onIncomingConflict = { [weak self] p, paths in self?.incomingConflictArrived(p, paths) }
        projects.onServerChanges = { [weak self] p, items in self?.serverChangesArrived(p, items) }
        projects.onSyncChanged = { [weak self] pid in self?.syncChanged(pid) }
        projects.onSelectionPending = { [weak self] p, n in self?.selectionPending(p, n) }
        projects.onCloudOnly = { [weak self] p, n, provider in self?.cloudOnlyArrived(p, n, provider) }
        // Menus and the folders window reflect sync state.
        projectsObserver = projects.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        updatesObserver = updates.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
    }

    public var hubURL: URL? { settings.hubURL }
    public var diskLevel: DiskLevel { disk?.level ?? .ok }

    // MARK: Lifecycle

    /// Called once at launch: notification wiring, activation hook, first run or connect.
    public func bootstrap() async {
        guard !bootstrapped else { return }
        bootstrapped = true
        if let sys = notifier as? SystemNotifier {
            sys.enabled = { [weak self] in self?.settings.notificationsEnabled ?? true }
            sys.onActivate = { [weak self] info in self?.openFromNotification(info) }
            sys.attach()
        }
        // Once, on the first launch; a "Don't Allow" is final (no reminders).
        if !settings.notificationPermissionAsked {
            settings.notificationPermissionAsked = true
            notifier.requestAuthorization()
        }
        activationObserver = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.appDidBecomeActive() }
        }
        guard settings.hasHubURL else {
            phase = .needsHubURL
            showFirstRun = true
            return
        }
        await connect()
    }

    /// Reachability probe → load the web app → start the native services for the signed-in user.
    public func connect() async {
        retryTimer?.invalidate()
        retryTimer = nil
        guard let url = settings.hubURL else {
            phase = .needsHubURL
            showFirstRun = true
            return
        }
        phase = .connecting
        let probe = HubClient(baseURL: url, user: nil, session: deps.urlSession)
        guard await probe.health() else {
            goOffline("Can't reach the hub at \(url.absoluteString).")
            return
        }
        phase = .online
        showFirstRun = false
        tailnetHint = nil
        updates.hubConnected()
        if !(ShellURLs.isHubOrigin(page?.currentURL, base: url) && pageLoaded) { loadApp() }
        await startServices(user: username)
    }

    /// Full load of the web app (or of the route someone asked for meanwhile).
    private func loadApp() {
        guard let url = settings.hubURL, let page else { return }
        let path = pendingRoute ?? "/"
        pendingRoute = nil
        page.load(ShellURLs.url(for: path, base: url))
    }

    /// Offline view "Try Again", ⌘R while offline.
    public func retry() { Task { await connect() } }

    private func goOffline(_ message: String) {
        phase = .offline(message)
        pageLoaded = false
        stopServices()
        scheduleRetry()
        updateTailnetHint()
    }

    /// Classifies the hub host (literal, *.ts.net, or getaddrinfo off the main thread).
    private func updateTailnetHint() {
        guard let url = settings.hubURL, let host = url.host else { tailnetHint = nil; return }
        let resolve = deps.resolveHost
        Task {
            let tailnet = (try? await offloadBlocking { TailnetHost.isTailnet(host: host, resolve: resolve) }) ?? false
            guard case .offline = phase, settings.hubURL == url else { return }
            tailnetHint = tailnet ? TailscaleApp.target(lookup: deps.appForBundleID) : nil
        }
    }

    /// `Open Tailscale` / `Get Tailscale`.
    public func openTailscale() {
        switch tailnetHint ?? TailscaleApp.target(lookup: deps.appForBundleID) {
        case .app(let url): deps.openApplication(url)
        case .download: deps.openURL(TailscaleApp.downloadURL)
        }
    }

    private func scheduleRetry() {
        retryTimer?.invalidate()
        guard deps.offlineRetryInterval > 0 else { return }
        retryTimer = Timer.scheduledTimer(withTimeInterval: deps.offlineRetryInterval, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, case .offline = self.phase else { return }
                await self.connect()
            }
        }
    }

    /// First-run sheet / Settings / offline view: a new hub address. The username is the new
    /// origin's (its own login page), so the cached one is dropped.
    public func setHubURL(_ raw: String) async throws {
        guard let url = AppSettings.normalizeHubURL(raw) else { throw HubError.invalidURL(raw) }
        let changed = url != settings.hubURL || !settings.hasHubURL
        settings.hubURLString = url.absoluteString
        if changed {
            tailnetHint = nil
            stopServices()
            setUsername(nil)
            pageLoaded = false
            chrome = .unknown
        }
        // The first-run sheet stays up (showing the error) until an address answers.
        await connect()
        if case .offline(let why) = phase { throw HubError.blocked(why) }
    }

    // MARK: Native services (WebSocket, sync) for the signed-in user

    private func startServices(user: String?) async {
        guard phase.isOnline, let url = settings.hubURL else { return }
        if let user, user == servicesUser, client != nil { return }
        stopServices()
        guard let user else { return }
        generation += 1
        let gen = generation
        servicesUser = user
        let c = HubClient(baseURL: url, user: user, session: deps.urlSession)
        client = c
        let src = deps.makeEventSource(url, user)
        src.onEvent = { [weak self] ev in self?.handle(ev) }
        src.onState = { [weak self] st in self?.socketState = st }
        events = src
        src.start()
        // Titles for notifications, admin flag for the Go menu, disk guard.
        if let list = try? await c.sessions(kind: nil), gen == generation {
            for s in list { sessionTitles[s.id] = s.title; sessionStatus[s.id] = s.status; sessions[s.id] = s }
        }
        if let me = try? await c.me(), gen == generation { isAdmin = me.user.isAdmin }
        if let d = try? await c.disk(), gen == generation { applyDisk(d) }
        guard gen == generation else { return }
        await projects.start(client: c, user: user, hubURL: url.absoluteString)
    }

    private func stopServices() {
        generation += 1
        events?.stop()
        events = nil
        socketState = .disconnected
        client = nil
        servicesUser = nil
        isAdmin = false
        projects.stopAll()
        for id in pendingPermissions.keys { notifier.withdraw(id: "perm-\(id)") }
        pendingPermissions = [:]
        notifier.setBadge(0)
        sessionTitles = [:]
        sessionStatus = [:]
        sessions = [:]
    }

    private func setUsername(_ name: String?) {
        username = name
        settings.username = name
    }

    /// The web app signed in, switched user or logged out.
    public func webUserChanged(_ raw: String?) async {
        let name = UserIdentity.normalize(raw)
        guard name != username || (name != nil && servicesUser != name && phase.isOnline) else { return }
        setUsername(name)
        await startServices(user: name)
    }

    // MARK: WebPageDelegate

    public func webPage(didReceive message: JSONValue) {
        switch ShellMessage.parse(message) {
        case .user(let name):
            Task { await webUserChanged(name) }
        case .route(let path):
            route = path
        case .chrome(let c):
            chrome = c
        case .pickFolder:
            pickFolderForSession()
        case .accepted(let report):
            projects.noteAccepted(report)
        case .notify(let n):
            webNotification(n)
        case .unknown:
            break
        }
    }

    public func webPageDidFinishLoad() {
        pageLoaded = true
        // A load finished while the probe still says offline (the hub came back): reconnect the services.
        if case .offline = phase { retry() }
        if let url = page?.currentURL, ShellURLs.isHubOrigin(url, base: settings.hubURL ?? url) { route = ShellURLs.route(of: url) }
        if let r = pendingRoute {
            pendingRoute = nil
            navigate(to: r)
        }
        // Belt and braces next to the bootstrap script's own report.
        Task {
            let value = await page?.evaluate(WebScripts.readUser)
            await webUserChanged(value as? String)
        }
    }

    public func webPage(didFailLoad message: String) {
        goOffline(message)
    }

    public func webPage(stateChanged title: String, canGoBack: Bool, canGoForward: Bool) {
        pageTitle = title.isEmpty ? "Agent Workstation" : title
        self.canGoBack = canGoBack
        self.canGoForward = canGoForward
    }

    public func webPage(downloadFinished url: URL) {
        notifier.post(id: "download-\(url.lastPathComponent)-\(Int(Date().timeIntervalSince1970))", title: "Download finished",
                      body: url.lastPathComponent, userInfo: NotificationRoute.reveal(url.path))
    }

    public func webPage(downloadFailed name: String, error: String) {
        notifier.post(id: "download-failed-\(name)", title: "Download failed", body: "\(name): \(error)", userInfo: [:])
    }

    public func webPage(open url: URL) { deps.openURL(url) }

    public func webPage(droppedFolders folders: [URL]) { folderDropped(folders) }

    /// `window.__workstationShell.sync.*`: only for projects linked on this Mac; every argument checked.
    public func webPage(syncRequest body: JSONValue) async -> Result<JSONValue, SyncBridgeError> {
        let request: SyncBridgeRequest
        switch SyncBridgeRequest.parse(body, isLinked: { [projects] in projects.project($0) != nil }) {
        case .success(let r): request = r
        case .failure(let e): return .failure(e)
        }
        switch request {
        case .status(let pid):
            guard let p = projects.project(pid), !p.isSingleFile else { return .success(.null) }
            let pending = projects.status(pid).pendingSelection
            return .success(["folder": .string(p.name), "pending": .number(Double(pending))])
        case .pending(let pid):
            return .success(.array(await projects.pendingItems(pid).map(\.json)))
        case .list(let pid, let dir):
            return .success(.array(await projects.entries(pid, dir: dir).map(\.json)))
        case .decide(let pid, let decisions):
            await projects.decide(pid, decisions)
            return .success(.bool(true))
        case .recheck(let pid, let dir):
            await projects.recheck(pid, dir: dir)
            return .success(.bool(true))
        }
    }

    /// The page re-reads the Sync tab of that project.
    func syncChanged(_ pid: String) {
        guard pageLoaded, let page else { return }
        Task { _ = await page.evaluate(WebScripts.syncChanged(pid)) }
    }

    /// New items wait in a linked folder: one notification per project (replaced as the count
    /// changes); a click opens the Sync tab in the project's most recent Code session, else in a
    /// new Code session draft in the project's directory.
    func selectionPending(_ p: LinkedProject, _ count: Int) {
        guard count > 0 else { return }
        notifier.post(id: "selection-\(p.id)", title: "\(count) new item\(count == 1 ? "" : "s") in \(p.name)", body: p.localPath,
                      userInfo: NotificationRoute.web(syncPanelRoute(p.id)))
    }

    /// Files of a linked folder are only in the cloud: one notification per project.
    func cloudOnlyArrived(_ p: LinkedProject, _ count: Int, _ provider: CloudProvider) {
        notifier.post(id: "cloud-\(p.id)", title: "\(provider.shortLine(count)) · \(p.name)", body: provider.hint,
                      userInfo: NotificationRoute.linkedFolders)
    }

    func syncPanelRoute(_ pid: String) -> String {
        let path = projects.hubProject(pid)?.path ?? "projects/\(projects.project(pid)?.name ?? pid)"
        let latest = sessions.values
            .filter { $0.kind == .code && ($0.cwd == path || $0.cwd.hasPrefix(path + "/")) }
            .max { $0.lastActiveAt < $1.lastActiveAt }
        return ShellURLs.syncPanelRoute(latestSession: latest?.id, projectPath: path)
    }

    // MARK: Menu commands

    public func perform(_ command: ShellCommand) {
        run(ShellCommandMap.action(for: command, zoom: pageZoom))
    }

    func run(_ action: ShellAction) {
        switch action {
        case .navigate(let path):
            windows?.showMain()
            navigate(to: path)
        case .shortcut(let s):
            windows?.showMain()
            guard pageLoaded, let page else { if let f = s.fallback { navigate(to: f) }; return }
            Task { _ = await page.evaluate(WebScripts.shortcut(s)) }
        case .reload:
            if phase.isOnline && pageLoaded { page?.reload() } else { retry() }
        case .goBack:
            page?.goBack()
        case .goForward:
            page?.goForward()
        case .zoom(let z):
            setZoom(z)
        }
    }

    public func setZoom(_ z: Double) {
        let v = ZoomSteps.clamp(z)
        pageZoom = v
        settings.pageZoom = v
        page?.pageZoom = v
    }

    /// Web route in the main window: client-side when the app is loaded, a full load otherwise.
    public func navigate(to path: String) {
        guard let base = settings.hubURL, let page else { pendingRoute = path; return }
        if pageLoaded, ShellURLs.isHubOrigin(page.currentURL, base: base) {
            Task { _ = await page.evaluate(WebScripts.navigate(path)) }
        } else {
            pendingRoute = path
            if phase.isOnline { loadApp() }
        }
    }

    public func open(_ destination: ShellDestination) {
        switch destination {
        case .web(let path):
            windows?.showMain()
            navigate(to: path)
        case .linkedFolders:
            windows?.showLinkedFolders()
        case .review(let pid, let incoming):
            windows?.showReview(projectId: pid, incoming: incoming)
        case .reveal(let path):
            deps.reveal(URL(fileURLWithPath: path))
        case .none:
            windows?.showMain()
        }
    }

    /// Notification click.
    public func openFromNotification(_ info: [String: String]) {
        if let sid = info[NotificationRoute.sessionKey], !sid.isEmpty {
            openSession(sid)
            return
        }
        open(NotificationRoute.destination(for: info))
    }

    /// A notification click for a session: the web app's `__workstationOpenSession(id)` when the page
    /// has it, else a navigation to `/s/<id>`.
    public func openSession(_ id: String) {
        windows?.showMain()
        guard let base = settings.hubURL, let page, pageLoaded, ShellURLs.isHubOrigin(page.currentURL, base: base) else {
            navigate(to: ShellURLs.sessionRoute(id))
            return
        }
        Task {
            let handled = await page.evaluate(WebScripts.openSession(id)) as? Bool ?? false
            if !handled { navigate(to: ShellURLs.sessionRoute(id)) }
        }
    }

    /// `__workstationShell.notify(...)`: shown unless Agent Workstation is frontmost with that session on screen.
    private func webNotification(_ n: WebNotification) {
        if let sid = n.sessionId, notifier.appIsActive, isOnScreen(sessionId: sid) { return }
        notifier.post(id: n.identifier, title: n.title, body: n.body, userInfo: n.sessionId.map(NotificationRoute.session) ?? [:])
    }

    func isOnScreen(sessionId: String) -> Bool {
        let path = route.split(separator: "?", maxSplits: 1).first.map(String.init) ?? route
        return path == ShellURLs.sessionRoute(sessionId) || path.hasPrefix(ShellURLs.sessionRoute(sessionId) + "/")
    }

    // MARK: Hub events (native WebSocket)

    public func handle(_ event: ServerEvent) {
        switch event {
        case .snapshot(_, let session, let pending):
            if let session { noteSession(session) }
            if let pending { addPermission(pending) }
        case .sessionUpdated(let s):
            noteSession(s)
        case .sessionState(let sid, let status, _):
            let was = sessionStatus[sid]
            sessionStatus[sid] = status
            if (was?.isBusy ?? false) && status == .idle { turnDone(sessionId: sid) }
        case .sessionDeleted(let sid):
            sessionTitles.removeValue(forKey: sid)
            sessionStatus.removeValue(forKey: sid)
            sessions.removeValue(forKey: sid)
            for (rid, r) in pendingPermissions where r.sessionId == sid { removePermission(rid) }
        case .permissionRequest(let req):
            addPermission(req)
        case .permissionResolved(_, let rid, _), .permissionCancelled(_, let rid):
            removePermission(rid)
        case .reviewChanged(let pid, let commit, let pending):
            projects.reviewChanged(projectId: pid, localCommit: commit, pendingFiles: pending)
        case .syncConflict(let pid, let path, let reason):
            projects.noteConflict(projectId: pid, path: path, reason: reason)
        case .diskStatus(let d):
            applyDisk(d)
        case .welcome, .replay, .message, .sessionSettings, .fileEvent, .usageLimits, .memoriesChanged,
             .contextUsage, .notice, .error, .pong, .unknown:
            break   // the web app shows these
        }
    }

    private func noteSession(_ s: Session) {
        sessionTitles[s.id] = s.title
        sessions[s.id] = s
        let was = sessionStatus[s.id]
        sessionStatus[s.id] = s.status
        if (was?.isBusy ?? false) && s.status == .idle { turnDone(sessionId: s.id) }
    }

    private func addPermission(_ req: PermissionRequest) {
        let isNew = pendingPermissions[req.requestId] == nil
        pendingPermissions[req.requestId] = req
        notifier.setBadge(pendingPermissions.count)
        guard isNew else { return }
        // The page shows the prompt itself when the person is looking at that session.
        if notifier.appIsActive && route == ShellURLs.sessionRoute(req.sessionId) { return }
        let title = sessionTitles[req.sessionId] ?? "Claude"
        notifier.post(id: "perm-\(req.requestId)", title: "Permission needed: \(title)",
                      body: "\(req.toolName): \(req.summary)", userInfo: NotificationRoute.session(req.sessionId))
    }

    private func removePermission(_ rid: String) {
        guard pendingPermissions.removeValue(forKey: rid) != nil else { return }
        notifier.withdraw(id: "perm-\(rid)")
        notifier.setBadge(pendingPermissions.count)
    }

    private func turnDone(sessionId: String) {
        if let last = lastTurnNotified[sessionId], Date().timeIntervalSince(last) < 5 { return }
        lastTurnNotified[sessionId] = Date()
        guard !notifier.appIsActive else { return }
        let info = sessionTitles[sessionId]
        notifier.post(id: "done-\(sessionId)-\(Int(Date().timeIntervalSince1970))", title: "Claude finished",
                      body: info ?? "Session", userInfo: NotificationRoute.session(sessionId))
    }

    /// "3 local changes in sample-app: Review…" / "2 changes from the server for sample-app: Review…".
    private func pendingIncreased(_ p: LinkedProject, outgoing: Int, incoming: Int) {
        if outgoing > 0 {
            notifier.post(id: "pending-out-\(p.id)", title: "\(outgoing) local change\(outgoing == 1 ? "" : "s") in \(p.name)",
                          body: "Review…: these could not sync on their own.", userInfo: NotificationRoute.review(p.id, incoming: false))
        }
        // Incoming changes are applied automatically (or raise the conflict sheet): no notification here.
    }

    // MARK: Server → Mac

    private func autoApplied(_ p: LinkedProject, _ paths: [String]) {
        pruneServerSheets(p.id, applied: Set(paths))
        let what = paths.count == 1 ? (paths[0] as NSString).lastPathComponent : "\(paths.count) files"
        show(ShellNotice(text: "\(what) → Mac", isError: false))
    }

    private func applyFailed(_ p: LinkedProject, _ line: String) {
        show(ShellNotice(text: "\(p.name): \(line)", isError: true))
        notifier.post(id: "apply-failed-\(p.id)", title: "Couldn't apply changes to \(p.name)", body: line,
                      userInfo: NotificationRoute.review(p.id, incoming: true))
    }

    /// Successes hide by themselves; errors stay until dismissed.
    private func show(_ n: ShellNotice) {
        notice = n
        guard !n.isError else { return }
        let id = n.id
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.noticeSeconds * 1_000_000_000))
            if self?.notice?.id == id { self?.notice = nil }
        }
    }

    public static var noticeSeconds: Double = 4

    public func dismissNotice() { notice = nil }

    private func incomingConflictArrived(_ p: LinkedProject, _ paths: [String]) {
        let title = paths.count == 1 ? (paths[0] as NSString).lastPathComponent : "\(paths.count) files"
        notifier.post(id: "incoming-conflict-\(p.id)", title: "\(title) changed on this Mac and on the server", body: p.name,
                      userInfo: NotificationRoute.review(p.id, incoming: true))
        Task {
            // The local versions the person decides about (a later edit makes the engine refuse).
            var seen: [String: String?] = [:]
            if let e = projects.engine(p.id) {
                for path in paths { seen[path] = await e.localContent(path).map(FileHasher.sha256) }
            }
            let c = IncomingConflictState(projectId: p.id, projectName: p.name, paths: paths, seen: seen,
                                          backupsAvailable: projects.status(p.id).backupsAvailable == true)
            pruneServerSheets(p.id, applied: Set(paths))   // the conflict sheet takes these files
            enqueue(.conflict(c))
        }
    }

    /// Server changes nobody approved in this app: the "Apply to Mac" sheet, plus a notification
    /// when Agent Workstation is not frontmost.
    private func serverChangesArrived(_ p: LinkedProject, _ items: [PendingChange]) {
        let b = ServerChangesState(projectId: p.id, projectName: p.name, items: items.map { ServerChangesState.Item(path: $0.path, kind: $0.kind) })
        if !notifier.appIsActive {
            notifier.post(id: "server-changes-\(p.id)", title: b.title, body: p.name, userInfo: NotificationRoute.web("/"))
        }
        enqueue(.server(b))
    }

    /// "Apply to Mac": exactly the listed files, through the same writer path (local edits that
    /// appeared meanwhile are skipped and go to the conflict sheet).
    public func applyServerChanges() async {
        guard let b = serverChanges else { return }
        nextSheet()
        let paths = b.items.map(\.path)
        do {
            let r = try await projects.applyIncoming(b.projectId, paths: paths, choices: Dictionary(uniqueKeysWithValues: paths.map { ($0, .skip) }))
            guard let p = projects.project(b.projectId) else { return }
            if let first = r.refused.first { applyFailed(p, "\(first.path): \(first.reason)") }
            else if !r.applied.isEmpty { autoApplied(p, r.applied) }
        } catch {
            if let p = projects.project(b.projectId) { applyFailed(p, error.localizedDescription) }
        }
    }

    /// "Later": the files stay staged (Linked Folders lists them); the sheet returns with new items.
    public func laterServerChanges() {
        guard serverChanges != nil else { return }
        nextSheet()
    }

    private func enqueue(_ sheet: IncomingSheet) {
        if let a = incomingSheet, a.slot == sheet.slot {
            incomingSheet = sheet
            return
        }
        sheetQueue.removeAll { $0.slot == sheet.slot }
        if incomingSheet == nil { incomingSheet = sheet; return }
        if case .conflict = sheet, let i = sheetQueue.firstIndex(where: { if case .server = $0 { return true }; return false }) {
            sheetQueue.insert(sheet, at: i)
        } else {
            sheetQueue.append(sheet)
        }
    }

    private func nextSheet() {
        incomingSheet = sheetQueue.isEmpty ? nil : sheetQueue.removeFirst()
    }

    /// Files written (or taken by a conflict sheet) leave the "Apply to Mac" sheets.
    private func pruneServerSheets(_ pid: String, applied: Set<String>) {
        func pruned(_ s: IncomingSheet) -> IncomingSheet? {
            guard case .server(var b) = s, b.projectId == pid else { return s }
            b.items.removeAll { applied.contains($0.path) }
            return b.items.isEmpty ? nil : .server(b)
        }
        sheetQueue = sheetQueue.compactMap(pruned)
        if let a = incomingSheet {
            if let kept = pruned(a) { if kept != a { incomingSheet = kept } } else { nextSheet() }
        }
    }

    /// A choice in the conflict sheet (the same choices as the review window). "Overwrite without
    /// backup" asks once more first.
    public func resolveIncomingConflict(_ choice: LocalEditChoice) async {
        guard let c = incomingConflict else { return }
        if choice == .overwriteWithoutBackup && !c.confirmingLoss {
            var confirming = c
            confirming.confirmingLoss = true
            incomingSheet = .conflict(confirming)
            return
        }
        if choice == .backUpAndOverwrite && !c.backupsAvailable { return }
        nextSheet()
        guard choice != .skip else { return }
        do {
            let r = try await projects.applyIncoming(c.projectId, paths: c.paths, choices: Dictionary(uniqueKeysWithValues: c.paths.map { ($0, choice) }),
                                                     seenLocalHashes: c.seen, confirmedLoss: choice == .overwriteWithoutBackup ? Set(c.paths) : [])
            let p = projects.project(c.projectId)
            if let first = r.refused.first, let p { applyFailed(p, "\(first.path): \(first.reason)") }
            else if !r.applied.isEmpty, let p { autoApplied(p, r.applied) }
        } catch {
            if let p = projects.project(c.projectId) { applyFailed(p, error.localizedDescription) }
        }
    }

    /// Back from the "without backup" confirmation.
    public func cancelConflictLoss() {
        guard var c = incomingConflict else { return }
        c.confirmingLoss = false
        incomingSheet = .conflict(c)
    }

    private func conflictArrived(_ c: PendingConflict) {
        notifier.post(id: "conflict-\(c.projectId)-\(c.path)", title: "Sync conflict in \(c.projectName)",
                      body: "\(c.path) changed on both sides.", userInfo: NotificationRoute.linkedFolders)
    }

    /// Disk guard: notify on warn / block, pause sync pushes while blocked. Nothing is ever deleted automatically.
    public func applyDisk(_ status: DiskStatus) {
        let old = disk?.level ?? .ok
        disk = status
        if status.level != old && status.level != .ok {
            notifier.post(id: "disk-\(status.level.rawValue)", title: status.level == .block ? "Server storage full" : "Server storage running low",
                          body: "\(Int(status.usedPercent))% used: pull back projects you no longer need.", userInfo: NotificationRoute.web("/projects"))
        }
        projects.setPushesBlocked(status.level == .block ? "server storage ≥ \(Int(status.blockPercent))%" : nil)
    }

    // MARK: Linked folders

    /// File → Link Folder or File… / "Choose…": click down level by level, pick folders or files.
    public func linkWithPanel() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = true
        panel.treatsFilePackagesAsDirectories = false
        panel.prompt = "Link"
        panel.message = "Choose folders or single files to mirror to the server"
        guard panel.runModal() == .OK else { return }
        let urls = panel.urls
        windows?.showLinkedFolders()
        Task { await projects.prepareLinks(urls) }
    }

    /// Running inside the App Sandbox (the packaged app with entitlements).
    public static var isSandboxed: Bool { ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] != nil }

    /// The path field. Inside the sandbox Agent Workstation may only read what the person picks, so the
    /// typed path opens the picker right there for one confirming click.
    public func linkTypedPath(_ text: String) async throws {
        let url = try LinkTarget.url(fromTyped: text)
        guard Self.isSandboxed else {
            try await projects.prepareTypedLink(text)
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = url.deletingLastPathComponent()
        panel.nameFieldStringValue = url.lastPathComponent
        panel.prompt = "Link"
        panel.message = "Select “\(url.lastPathComponent)” to let Agent Workstation read it"
        guard panel.runModal() == .OK else { return }
        await projects.prepareLinks(panel.urls)
    }

    /// Files / folders dropped on the Linked Folders window or the Dock icon (`application(_:open:)`).
    public func linkDropped(_ urls: [URL]) {
        let files = urls.filter(\.isFileURL)
        guard !files.isEmpty else { return }
        windows?.showLinkedFolders()
        guard projects.isConnected else {
            projects.message = "Sign in to the hub in the main window first, then drop the folder again."
            return
        }
        Task { await projects.prepareLinks(files) }
    }

    // MARK: A folder as a Code session's directory

    /// `__workstationShell.pickFolder()`: the person picks the folder in the native panel. The message
    /// carries nothing, so the page can never choose a path or start a link by itself.
    func pickFolderForSession() {
        guard !pickingFolder, uploadConfirmation == nil else { return }
        pickingFolder = true
        let window = page?.hostWindow
        Task {
            let url = await deps.pickFolder(window)
            pickingFolder = false
            if let url { await openFolderSession(url) }
        }
    }

    /// Folders dropped on the main window (the web view keeps them from the page). A session has
    /// one directory: the first folder is used.
    public func folderDropped(_ folders: [URL]) {
        guard let first = folders.first(where: \.isFileURL) else { return }
        Task { await openFolderSession(first) }
    }

    /// Seconds the upload sheet spends counting files before it shows what it has (as "N+").
    public static let uploadPreviewBudget: TimeInterval = 15

    /// Reuse the folder's link (nothing uploaded) or ask before linking it, then open a new Code
    /// session draft working in it.
    public func openFolderSession(_ folder: URL) async {
        if uploadConfirmation != nil { return }
        if let s = folderSession, s.error == nil { return }
        let plan: SessionFolderPlan
        do {
            guard settings.hubURL != nil else { throw HubError.blocked("No hub address.") }
            plan = try projects.planSessionFolder(folder)
        } catch {
            folderSessionFailed(folder, error)
            return
        }
        switch plan {
        case .reuse:
            folderSession = FolderSessionState(folder: folder)
            await runFolderSession(folder, plan)
        case .link(let t):
            folderSession = nil
            windows?.showMain()
            let confirmation = FolderUploadConfirmation(target: t)
            uploadConfirmation = confirmation
            previewTask = Task { [weak self] in
                guard let self else { return }
                let model = await self.projects.selectionModel(for: t)
                guard !Task.isCancelled, self.uploadConfirmation?.id == confirmation.id else { model.stopCloudWatch(); return }
                self.uploadConfirmation?.selection = model
                let preview = await ProjectsModel.uploadPreview(t, budget: Self.uploadPreviewBudget)
                guard !Task.isCancelled, self.uploadConfirmation?.id == confirmation.id else { return }
                self.uploadConfirmation?.preview = preview
            }
        }
    }

    /// "Link and Upload" in the window: link with the decisions made there (project, read-only
    /// bookmark, first upload), then the session. Nothing happens while files that would upload
    /// are only in the cloud.
    public func confirmFolderUpload() async {
        guard let c = uploadConfirmation else { return }
        if let m = c.selection, !m.cloudOnlyUploading.isEmpty { return }
        previewTask?.cancel()
        previewTask = nil
        c.selection?.stopCloudWatch()
        uploadConfirmation = nil
        folderSession = FolderSessionState(folder: c.target.picked)
        await runFolderSession(c.target.picked, .link(c.target), selection: c.selection.map { SyncSelection(records: $0.records()) })
    }

    /// "Cancel" in the window: nothing is created, kept or opened.
    public func cancelFolderUpload() {
        previewTask?.cancel()
        previewTask = nil
        uploadConfirmation?.selection?.stopCloudWatch()
        uploadConfirmation = nil
    }

    private func runFolderSession(_ folder: URL, _ plan: SessionFolderPlan, selection: SyncSelection? = nil) async {
        do {
            if case .link(let t) = plan {
                // Files that would upload but are only in the cloud: wait (re-checking) until they are local.
                let waiter = Task { [weak self, projects] in
                    try await projects.waitForLocalFiles(t.root) { [weak self] n, provider in
                        self?.folderSession = FolderSessionState(folder: folder, cloudWaiting: provider.message(n))
                    }
                }
                cloudWaiter = waiter
                defer { cloudWaiter = nil }
                try await waiter.value
                folderSession = FolderSessionState(folder: folder)
            }
            let cwd = try await projects.sessionDirectory(plan, selection: selection)
            folderSession = nil
            windows?.showMain()
            pendingRoute = ShellURLs.newCodeSessionRoute(cwd: cwd)
            loadApp()
        } catch is CancellationError {
            folderSession = nil
        } catch {
            folderSessionFailed(folder, error)
        }
    }

    private func folderSessionFailed(_ folder: URL, _ error: Error) {
        let line = error.localizedDescription.split(whereSeparator: \.isNewline).first.map(String.init) ?? "Couldn't link the folder."
        folderSession = FolderSessionState(folder: folder, error: line)
    }

    /// The badge's ×: an error goes away; a wait for cloud-only files is given up (nothing was created).
    public func dismissFolderSession() {
        if folderSession?.error != nil { folderSession = nil }
        if folderSession?.cloudWaiting != nil { cloudWaiter?.cancel() }
    }

    /// App became active: reconcile linked folders (throttled inside ProjectsModel), retry when offline.
    public func appDidBecomeActive() {
        projects.reconcileAll(reason: .activation)
        if case .offline = phase { retry() }
    }

    /// Test / snapshot hooks.
    public func _setPhase(_ p: Phase) { phase = p }
    public func _setChrome(_ c: TitlebarChrome) { chrome = c }
    public func _setDisk(_ d: DiskStatus?) { disk = d }
    public func _setTailnetHint(_ t: TailscaleApp.Target?) { tailnetHint = t }
    public var _pendingRoute: String? { pendingRoute }
    public func _setPageLoaded(_ v: Bool) { pageLoaded = v }
    public func _setFolderSession(_ s: FolderSessionState?) { folderSession = s }
    public func _setUploadConfirmation(_ c: FolderUploadConfirmation?) { uploadConfirmation = c }
    public func _setIncomingConflict(_ c: IncomingConflictState?) { incomingSheet = c.map(IncomingSheet.conflict) }
    public func _setServerChanges(_ b: ServerChangesState?) { incomingSheet = b.map(IncomingSheet.server) }
    public func _setNotice(_ n: ShellNotice?) { notice = n }
}
