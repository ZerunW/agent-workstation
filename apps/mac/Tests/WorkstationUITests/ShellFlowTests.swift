import Foundation
@testable import WorkstationCore
@testable import WorkstationUI
import Testing

/// Headless end-to-end flows of the native shell: the real ShellModel / ProjectsModel /
/// SyncEngine against the in-process MockHub (URLProtocol), a fake event stream and a fake web
/// page that records loads and scripts. Asserts state, not pixels. Nothing is shown on screen.
@MainActor
@Suite("Shell flows against a mock hub", .serialized)
struct ShellFlowTests {
    struct Rig {
        let shell: ShellModel
        let page: FakeWebPage
        let windows: FakeWindows
        let events: FakeEventSource
        let notifier: RecordingNotifier
        let writer: CountingWriter
        let settings: AppSettings
        let store: TempFolder
    }

    func makeRig(hubURL: String? = MockHub.baseURL.absoluteString, cachedUser: String? = nil,
                 picker: FakeFolderPicker = FakeFolderPicker()) -> Rig {
        let hub = MockHub.shared
        hub.reset()
        let events = FakeEventSource()
        hub.events = events
        let defaults = TestDefaults.make("workstation-shell")
        let settings = AppSettings(defaults: defaults, environment: [:])
        if let hubURL { settings.hubURLString = hubURL }
        settings.username = cachedUser
        let notifier = RecordingNotifier()
        let store = TempFolder("workstation-shell-store")
        let writer = CountingWriter()
        let deps = ShellModel.Dependencies(settings: settings, urlSession: MockHub.session(), store: LinkedProjectStore(directory: store.url),
                                           makeEventSource: { _, _ in events }, notifier: notifier,
                                           launchAtLogin: StaticLaunchAtLogin(), writer: writer, syncUsesWatcher: false,
                                           openURL: { _ in }, reveal: { _ in }, offlineRetryInterval: 0,
                                           pickFolder: { _ in await picker.pick() })
        let shell = ShellModel(deps: deps)
        let page = FakeWebPage()
        let windows = FakeWindows()
        shell.page = page
        shell.windows = windows
        return Rig(shell: shell, page: page, windows: windows, events: events, notifier: notifier, writer: writer, settings: settings, store: store)
    }

    /// What WebKit reports once the app has loaded.
    func finishLoad(_ r: Rig, user: String?) async {
        r.page.answers[WebScripts.readUser] = user ?? ""
        r.shell.webPageDidFinishLoad()
        _ = await until { r.shell.username == user }
    }

    @Test func connectsLoadsTheWebAppAndFollowsTheWebUser() async throws {
        let r = makeRig()
        let hub = MockHub.shared

        // Health probe → load <hub>/ (the full web app, not embed.html). Nobody signed in → no services.
        await r.shell.connect()
        #expect(r.shell.phase == .online)
        #expect(r.page.loads.map(\.absoluteString) == ["http://mockhub.test:9000/"])
        await finishLoad(r, user: nil)
        #expect(r.shell.pageLoaded)
        #expect(r.shell.username == nil)
        #expect(!r.events.started)
        #expect(r.shell.client == nil)

        // The web login page stores the name → the bootstrap script reports it.
        r.shell.webPage(didReceive: ["type": "user", "user": "bob"])
        #expect(await until { r.events.started && r.shell.client?.user == "bob" })
        #expect(await until { r.shell.isAdmin }, "me → admin flag for the Go menu")
        #expect(r.settings.username == "bob", "cached for the next launch")
        #expect(hub.with { $0.userHeaders }.contains("bob"))
        #expect(await until { r.shell.projects.isConnected && r.shell.projects.user == "bob" })

        // Switching user in the web app restarts the services for the new user.
        r.shell.webPage(didReceive: ["type": "user", "user": "carol"])
        #expect(await until { r.shell.client?.user == "carol" && r.shell.projects.user == "carol" })
        #expect(!r.shell.isAdmin)

        // Invalid values are ignored like a logout; logging out stops everything.
        r.shell.webPage(didReceive: ["type": "user", "user": nil])
        #expect(await until { r.shell.client == nil })
        #expect(!r.events.started)
        #expect(!r.shell.projects.isConnected)
        #expect(r.settings.username == nil)

        // Route and title reports.
        r.shell.webPage(didReceive: ["type": "route", "path": "/usage"])
        #expect(r.shell.route == "/usage")
        r.shell.webPage(stateChanged: "Usage · Agent Workstation", canGoBack: true, canGoForward: false)
        #expect(r.shell.pageTitle == "Usage · Agent Workstation" && r.shell.canGoBack && !r.shell.canGoForward)
        r.shell.webPage(didReceive: ["type": "chrome", "overlay": false, "sidebarWidth": 272, "sidebar": [240, 238, 230, 1], "main": [250, 249, 245, 1]])
        #expect(r.shell.chrome.sidebarWidth == 272 && r.shell.chrome.main == RGBA(250, 249, 245))
    }

    @Test func usernameIsReadFromTheWebViewOnLoad() async throws {
        // Cached user from the last launch: services start right after the probe.
        let r = makeRig(cachedUser: "alice")
        await r.shell.connect()
        #expect(await until { r.shell.client?.user == "alice" })
        // The page's localStorage is the truth: it says carol.
        await finishLoad(r, user: "carol")
        #expect(await until { r.shell.client?.user == "carol" })
        #expect(r.page.scripts.contains(WebScripts.readUser))
        // A garbage answer from the evaluator signs out.
        r.page.answers[WebScripts.readUser] = 42
        r.shell.webPageDidFinishLoad()
        #expect(await until { r.shell.username == nil && r.shell.client == nil })
    }

    @Test func firstRunAndHubAddressChanges() async throws {
        let r = makeRig(hubURL: nil)
        #expect(!r.settings.hasHubURL)
        await r.shell.bootstrap()
        #expect(r.shell.phase == .needsHubURL)
        #expect(r.shell.showFirstRun)
        #expect(r.page.loads.isEmpty, "nothing loads before an address is confirmed")

        await #expect(throws: HubError.self) { try await r.shell.setHubURL("ftp://nope") }
        #expect(r.shell.showFirstRun)
        MockHub.shared.with { $0.healthy = false }
        await #expect(throws: HubError.self) { try await r.shell.setHubURL("mockhub.test:9000") }
        #expect(r.shell.showFirstRun, "an unreachable address keeps the sheet up with its error")
        MockHub.shared.with { $0.healthy = true }
        try await r.shell.setHubURL("mockhub.test:9000/")
        #expect(r.settings.hubURLString == "http://mockhub.test:9000", "normalised and persisted")
        #expect(AppSettings(defaults: r.settings.defaults, environment: [:]).hasHubURL)
        #expect(!r.shell.showFirstRun)
        #expect(r.shell.phase == .online)
        #expect(r.page.loads.last?.absoluteString == "http://mockhub.test:9000/")

        // Another hub: the old origin's user is dropped (each origin has its own web login).
        await finishLoad(r, user: "bob")
        #expect(await until { r.shell.client != nil })
        MockHub.shared.with { $0.healthy = false }
        await #expect(throws: HubError.self) { try await r.shell.setHubURL("http://mockhub.test:9000/other") }
        #expect(r.shell.username == nil && r.shell.client == nil)
        if case .offline = r.shell.phase {} else { Issue.record("expected offline, got \(r.shell.phase)") }
    }

    @Test func offlineStateAndRetry() async throws {
        let r = makeRig(cachedUser: "bob")
        MockHub.shared.with { $0.healthy = false }
        await r.shell.connect()
        guard case .offline(let why) = r.shell.phase else { Issue.record("not offline"); return }
        #expect(why.contains("mockhub.test:9000"))
        #expect(r.page.loads.isEmpty, "no WebKit error page: the native offline view shows instead")
        #expect(!r.events.started)

        // ⌘R while offline retries the probe instead of reloading a dead page.
        MockHub.shared.with { $0.healthy = true }
        r.shell.perform(.reload)
        #expect(await until { r.shell.phase == .online })
        #expect(r.page.loads.count == 1 && r.page.reloads == 0)
        #expect(await until { r.events.started })

        // A failed load (hub went away mid-session) → offline, services stopped; a later load → reconnect.
        await finishLoad(r, user: "bob")
        r.shell.webPage(didFailLoad: "The network connection was lost.")
        #expect(r.shell.phase == .offline("The network connection was lost."))
        #expect(!r.shell.pageLoaded && r.shell.client == nil)
        r.shell.retry()
        #expect(await until { r.shell.phase == .online && r.page.loads.count == 2 })
    }

    /// `__workstationShell.notify`: shown with identifier `web.<id>` (a repeat replaces it), routed to the
    /// session; not shown while Agent Workstation is frontmost on that very session.
    @Test func webNotificationsFromTheBridge() async throws {
        let r = makeRig()
        await r.shell.connect()
        await finishLoad(r, user: "bob")
        let sid = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e"
        func notify(_ id: String, _ title: String, sessionId: String? = sid) {
            var m: [String: JSONValue] = ["type": "notify", "id": .string(id), "title": .string(title), "body": "12 min"]
            if let sessionId { m["sessionId"] = .string(sessionId) }
            r.shell.webPage(didReceive: .object(m))
        }
        r.notifier.appIsActive = false
        notify("done-\(sid)", "Refactor finished")
        notify("done-\(sid)", "Refactor finished again")
        #expect(r.notifier.posted.map(\.id) == ["web.done-\(sid)", "web.done-\(sid)"], "same identifier → the system replaces it")
        #expect(r.notifier.posted.last?.title == "Refactor finished again" && r.notifier.posted.last?.body == "12 min")
        #expect(r.notifier.posted.last?.userInfo == NotificationRoute.session(sid))

        // Frontmost on that session → not shown; frontmost elsewhere, or in the background → shown.
        r.shell.webPage(didReceive: ["type": "route", "path": .string("/s/\(sid)?tab=files")])
        r.notifier.appIsActive = true
        notify("wait-1", "Waiting for you")
        #expect(r.notifier.posted.count == 2)
        r.notifier.appIsActive = false
        notify("wait-2", "Waiting for you")
        #expect(r.notifier.posted.count == 3)
        r.notifier.appIsActive = true
        r.shell.webPage(didReceive: ["type": "route", "path": "/usage"])
        notify("wait-3", "Waiting for you")
        notify("plain", "No session", sessionId: nil)
        #expect(r.notifier.posted.map(\.id).suffix(2) == ["web.wait-3", "web.plain"])
        #expect(r.notifier.posted.last?.userInfo == [:])
        // Malformed → nothing.
        r.shell.webPage(didReceive: ["type": "notify", "id": "x", "title": "t", "body": "b", "sessionId": "nope"])
        #expect(r.notifier.posted.count == 5)
    }

    /// A click opens the session: `__workstationOpenSession(id)` when the page has it, else `/s/<id>`.
    @Test func notificationClickOpensTheSession() async throws {
        let r = makeRig()
        await r.shell.connect()
        await finishLoad(r, user: "bob")
        let sid = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e"
        r.page.answers[WebScripts.openSession(sid)] = true
        r.shell.openFromNotification(NotificationRoute.session(sid))
        #expect(await until { r.page.scripts.contains(WebScripts.openSession(sid)) })
        #expect(r.windows.calls.last == "main")
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(!r.page.scripts.contains(WebScripts.navigate("/s/\(sid)")))
        // The page has no such function → navigate.
        r.page.answers[WebScripts.openSession(sid)] = false
        r.shell.openFromNotification(NotificationRoute.session(sid))
        #expect(await until { r.page.scripts.contains(WebScripts.navigate("/s/\(sid)")) })
    }

    /// Notification permission is asked once, on the first launch, never again (even if denied).
    @Test func notificationPermissionIsAskedOnce() async throws {
        let r = makeRig()
        #expect(!r.settings.notificationPermissionAsked)
        await r.shell.bootstrap()
        #expect(r.notifier.authorizationRequests == 1 && r.settings.notificationPermissionAsked)
        // Next launch, same settings.
        let notifier = RecordingNotifier()
        let deps = ShellModel.Dependencies(settings: r.settings, urlSession: MockHub.session(), store: LinkedProjectStore(directory: r.store.url),
                                           makeEventSource: { _, _ in FakeEventSource() }, notifier: notifier,
                                           launchAtLogin: StaticLaunchAtLogin(), writer: CountingWriter(), syncUsesWatcher: false,
                                           openURL: { _ in }, reveal: { _ in }, offlineRetryInterval: 0,
                                           updateAlerts: FakeUpdateAlerts(), updateCheckInterval: 0)
        let next = ShellModel(deps: deps)
        await next.bootstrap()
        #expect(notifier.authorizationRequests == 0)
    }

    /// Unreachable hub on a Tailscale address → `Tailscale is not connected` + open / get Tailscale;
    /// a LAN hub → no hint; the hint goes when the hub answers again.
    @Test func tailscaleHintWhenATailnetHubIsUnreachable() async throws {
        final class Box: @unchecked Sendable { var addresses = ["100.64.0.10"]; var opened: [URL] = []; var installed: [String: URL] = [:] }
        let box = Box()
        let tsApp = URL(fileURLWithPath: "/Applications/Tailscale.app")
        func rig() -> ShellModel {
            MockHub.shared.reset()
            let settings = AppSettings(defaults: TestDefaults.make("workstation-ts"), environment: [:])
            settings.hubURLString = MockHub.baseURL.absoluteString
            let store = TempFolder("workstation-ts-store")
            let deps = ShellModel.Dependencies(settings: settings, urlSession: MockHub.session(), store: LinkedProjectStore(directory: store.url),
                                               makeEventSource: { _, _ in FakeEventSource() }, notifier: RecordingNotifier(),
                                               launchAtLogin: StaticLaunchAtLogin(), writer: CountingWriter(), syncUsesWatcher: false,
                                               openURL: { box.opened.append($0) }, reveal: { _ in }, offlineRetryInterval: 0,
                                               updateAlerts: FakeUpdateAlerts(), updateCheckInterval: 0,
                                               resolveHost: { _ in box.addresses }, appForBundleID: { box.installed[$0] },
                                               openApplication: { box.opened.append($0) })
            return ShellModel(deps: deps)
        }

        // Tailnet hub, unreachable, Tailscale installed → Open Tailscale launches the app.
        box.installed = ["io.tailscale.ipn.macos": tsApp]
        let shell = rig()
        MockHub.shared.with { $0.healthy = false }
        await shell.connect()
        if case .offline = shell.phase {} else { Issue.record("expected offline") }
        #expect(await until { shell.tailnetHint == .app(tsApp) })
        shell.openTailscale()
        #expect(box.opened == [tsApp])
        // The hub answers again → no hint.
        MockHub.shared.with { $0.healthy = true }
        await shell.connect()
        #expect(shell.phase == .online && shell.tailnetHint == nil)

        // Not installed → Get Tailscale opens the download page.
        box.installed = [:]
        box.opened = []
        MockHub.shared.with { $0.healthy = false }
        await shell.connect()
        #expect(await until { shell.tailnetHint == .download })
        shell.openTailscale()
        #expect(box.opened == [TailscaleApp.downloadURL])

        // A LAN hub that is unreachable → no hint; reachable tailnet hub → no hint.
        box.addresses = ["192.168.1.50"]
        let lan = rig()
        MockHub.shared.with { $0.healthy = false }
        await lan.connect()
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(lan.tailnetHint == nil)
        box.addresses = ["100.64.0.10"]
        let up = rig()
        await up.connect()
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(up.phase == .online && up.tailnetHint == nil)
    }

    @Test func menuCommandsMapToWebRoutesAndActions() async throws {
        let r = makeRig()
        await r.shell.connect()
        await finishLoad(r, user: "bob")

        r.shell.perform(.usage)
        #expect(await until { r.page.scripts.contains(WebScripts.navigate("/usage")) }, "client-side navigation, no reload")
        #expect(r.windows.calls.last == "main", "navigation brings the main window forward")
        // Help → Agent Workstation Docs (⌘?): the readme in the main window.
        #expect(HelpMenu.items == [HelpMenu.Item(title: "Agent Workstation Docs", command: .docs, key: "?")])
        r.windows.calls = []
        r.shell.perform(.docs)
        #expect(await until { r.page.scripts.contains(WebScripts.navigate("/readme")) })
        #expect(r.windows.calls.first == "main", "the window comes forward first")
        r.shell.perform(.instructions)
        r.shell.perform(.memory)
        r.shell.perform(.browserSites)
        r.shell.perform(.projects)
        r.shell.perform(.home)
        #expect(await until { [WebScripts.navigate("/instructions"), WebScripts.navigate("/memory"), WebScripts.navigate("/browser-sites"),
                               WebScripts.navigate("/projects"), WebScripts.navigate("/")].allSatisfy(r.page.scripts.contains) })

        r.shell.perform(.newSession)
        #expect(await until { r.page.scripts.contains(WebScripts.shortcut(ShellCommandMap.newSession)) })
        r.shell.perform(.stop)
        #expect(await until { r.page.scripts.contains(WebScripts.shortcut(ShellCommandMap.stop)) })

        // ⌘F: sent to the page as ⌘F; the web app decides what it does. No palette, no search-field probing.
        r.shell.perform(.find)
        #expect(await until { r.page.scripts.contains(WebScripts.shortcut(ShellCommandMap.find)) })
        #expect(!r.page.scripts.contains(WebScripts.shortcut(ShellCommandMap.commandPalette)))

        r.shell.perform(.reload)
        r.shell.perform(.back)
        r.shell.perform(.forward)
        #expect(r.page.reloads == 1 && r.page.backs == 1 && r.page.forwards == 1)

        r.shell.perform(.zoomIn)
        r.shell.perform(.zoomIn)
        #expect(r.page.pageZoom == 1.25 && r.shell.pageZoom == 1.25)
        #expect(r.settings.pageZoom == 1.25, "zoom persists")
        r.shell.perform(.zoomOut)
        #expect(r.page.pageZoom == 1.1)
        r.shell.perform(.actualSize)
        #expect(r.page.pageZoom == 1)

        // Before the page is ready, a route waits and loads directly.
        let cold = makeRig()
        cold.shell.navigate(to: "/s/abc")
        await cold.shell.connect()
        #expect(cold.page.loads.map(\.absoluteString) == ["http://mockhub.test:9000/s/abc"])
    }

    @Test func notificationsAndDockBadge() async throws {
        let r = makeRig()
        let hub = MockHub.shared
        let s1 = hub.addSession(user: "bob", title: "Implement folder sync", status: .running)
        let s2 = hub.addSession(user: "bob", title: "Summarize the report", kind: .chat)
        await r.shell.connect()
        await finishLoad(r, user: "bob")
        #expect(await until { r.events.started })
        try await Task.sleep(nanoseconds: 100_000_000)   // session titles fetched

        // Permission request → badge + notification that opens the session.
        r.events.emit(.permissionRequest(PermissionRequest(requestId: "r1", sessionId: s1.id, toolName: "Bash", input: ["command": "ls"])))
        #expect(await until { r.notifier.badge == 1 })
        let perm = try #require(r.notifier.posted.first { $0.id == "perm-r1" })
        #expect(perm.title == "Permission needed: Implement folder sync")
        #expect(perm.body == "Bash: ls")
        #expect(NotificationRoute.destination(for: perm.userInfo) == .web("/s/\(s1.id)"))
        // Answered in the web app → badge cleared, notification withdrawn.
        r.events.emit(.permissionResolved(sessionId: s1.id, requestId: "r1", behavior: "allow"))
        #expect(await until { r.notifier.badge == 0 })
        #expect(r.notifier.withdrawn == ["perm-r1"])

        // Looking at that very session in the app → the page shows the prompt; only the badge changes.
        r.notifier.appIsActive = true
        r.shell.webPage(didReceive: ["type": "route", "path": .string("/s/\(s1.id)")])
        r.events.emit(.permissionRequest(PermissionRequest(requestId: "r2", sessionId: s1.id, toolName: "Write", input: ["file_path": "a.ts"])))
        #expect(await until { r.notifier.badge == 1 })
        #expect(!r.notifier.posted.contains { $0.id == "perm-r2" })
        r.events.emit(.permissionCancelled(sessionId: s1.id, requestId: "r2"))
        #expect(await until { r.notifier.badge == 0 })

        // Finished turns notify only while the app is in the background.
        r.events.emit(.sessionState(sessionId: s1.id, status: .idle, queuePosition: nil))
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(!r.notifier.posted.contains { $0.title.hasSuffix("finished") }, "app active → no banner")
        r.notifier.appIsActive = false
        r.events.emit(.sessionState(sessionId: s2.id, status: .running, queuePosition: nil))
        r.events.emit(.sessionState(sessionId: s2.id, status: .idle, queuePosition: nil))
        let done = try #require(await firstPosted(r) { $0.title == "Claude finished" })
        #expect(done.body == "Summarize the report")
        #expect(NotificationRoute.destination(for: done.userInfo) == .web("/s/\(s2.id)"))
        r.events.emit(.sessionUpdated(Session(id: s2.id, user: "bob", kind: .chat, title: "Summarize the report", status: .idle)))
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(r.notifier.posted.filter { $0.title == "Claude finished" }.count == 1, "de-duplicated")

        // Disk warnings → notification that opens /projects.
        r.events.emit(.diskStatus(DiskStatus(level: .warn, usedPercent: 84, totalBytes: 100, freeBytes: 16)))
        let disk = try #require(await firstPosted(r) { $0.title == "Server storage running low" })
        #expect(NotificationRoute.destination(for: disk.userInfo) == .web("/projects"))

        // Clicking notifications.
        r.shell.openFromNotification(perm.userInfo)
        #expect(r.windows.calls.last == "main")
        #expect(await until { r.page.scripts.contains(WebScripts.navigate("/s/\(s1.id)")) })
        r.shell.openFromNotification(NotificationRoute.linkedFolders)
        #expect(r.windows.calls.last == "folders")

        // Downloads finished in the page → notification that reveals the file.
        r.shell.webPage(downloadFinished: URL(fileURLWithPath: "/Users/me/Downloads/workstation (1).zip"))
        let dl = try #require(r.notifier.posted.last)
        #expect(dl.title == "Download finished" && dl.body == "workstation (1).zip")
        #expect(NotificationRoute.destination(for: dl.userInfo) == .reveal("/Users/me/Downloads/workstation (1).zip"))

        // Logging out clears the badge.
        r.events.emit(.permissionRequest(PermissionRequest(requestId: "r3", sessionId: s1.id, toolName: "Bash")))
        #expect(await until { r.notifier.badge == 1 })
        await r.shell.webUserChanged(nil)
        #expect(r.notifier.badge == 0)
    }

    func firstPosted(_ r: Rig, _ match: @escaping (RecordingNotifier.Posted) -> Bool) async -> RecordingNotifier.Posted? {
        _ = await until { r.notifier.posted.contains(where: match) }
        return r.notifier.posted.first(where: match)
    }

    /// Links `url` through the same path every input uses (prepare → confirmation → link).
    func link(_ r: Rig, _ urls: [URL]) async -> [LinkedProject] {
        await r.shell.projects.prepareLinks(urls)
        return await r.shell.projects.confirmPendingLinks()
    }

    /// What the Changes tab in this window does: the page reports the accept, the server advances.
    func acceptInApp(_ r: Rig, _ pid: String, _ path: String, _ data: Data?) {
        report(r, pid, [(path, data.map(FileHasher.sha256))])
        MockHub.shared.acceptOnServer(pid, path, data)
    }

    /// `window.__workstationShell.reportAccepted(...)` as the bootstrap posts it.
    func report(_ r: Rig, _ pid: String, _ files: [(String, String?)]) {
        let list: [JSONValue] = files.map { ["path": .string($0.0), "sha256": $0.1.map(JSONValue.string) ?? .null] }
        r.shell.webPage(didReceive: ["type": "accepted", "projectId": .string(pid), "localCommit": "c0ffee12", "files": .array(list)])
    }

    func signedIn(picker: FakeFolderPicker = FakeFolderPicker()) async -> Rig {
        let r = makeRig(picker: picker)
        await r.shell.connect()
        await finishLoad(r, user: "bob")
        _ = await until { r.shell.projects.isConnected }
        return r
    }

    @Test func folderSyncIsApprovalGatedBothWays() async throws {
        let r = await signedIn()
        let hub = MockHub.shared
        let projects = r.shell.projects

        // 1. Link: the confirmation shows the count and size; the first upload runs only after it.
        let folder = TempFolder("workstation-shell-folder")
        folder.write("README.md", "# demo\n")
        folder.write("src/main.c", "int main(){return 0;}\n")
        folder.write("node_modules/junk.js", "ignored")
        folder.write(".gitignore", "*.tmp\n")
        folder.write("scratch.tmp", "ignored too")
        await projects.prepareLinks([folder.url])
        #expect(projects.pendingLinks.count == 1)
        #expect(projects.pendingLinks.first?.files == 5, "no rules: every file but .git, checked")
        #expect(hub.with { $0.projects }.isEmpty, "nothing on the server before the confirmation")
        let linked = try #require(await projects.confirmPendingLinks().first)
        let pid = linked.id
        #expect(await until { projects.status(pid).phase == .watching })
        #expect(Set(hub.with { $0.local[pid] ?? [:] }.keys) == [".gitignore", "README.md", "src/main.c", "node_modules/junk.js", "scratch.tmp"])
        #expect(hub.with { $0.pushedOps }.isEmpty)
        let snapshot = folder.fingerprint()

        // 2. A local edit inside the decided scope syncs on its own; nothing waits.
        let engine = try #require(projects.engine(pid))
        folder.write("src/main.c", "int main(){return 1;}\n")
        await engine.handleLocalChanges(["src/main.c"])
        #expect(await until { hub.with { $0.pushedOps }.map(\.path) == ["src/main.c"] })
        #expect(projects.status(pid).outgoing.isEmpty)
        #expect(!r.notifier.posted.contains { $0.id == "pending-out-\(pid)" })

        // 3. A conflict stays pending and is announced; the review window shows the diff and syncs on approval.
        hub.with { $0.conflictPaths = ["README.md"] }
        folder.write("README.md", "# demo v2\n")
        await engine.handleLocalChanges(["README.md"])
        #expect(await until { projects.status(pid).outgoing.map(\.path) == ["README.md"] })
        let note = try #require(r.notifier.posted.first { $0.id == "pending-out-\(pid)" })
        #expect(note.title == "1 local change in \(linked.name)")
        #expect(NotificationRoute.destination(for: note.userInfo) == .review(projectId: pid, incoming: false))
        r.shell.openFromNotification(note.userInfo)
        #expect(r.windows.calls.last == "review:\(pid):out")
        let out = ReviewModel(projectId: pid, projects: projects, incoming: false)
        await out.show("README.md")
        #expect(out.diff?.hunks.first?.lines.map(\.kind) == [.removed, .added])
        await out.approveSelected()
        #expect(hub.with { $0.pushedOps }.last?.path == "README.md")
        #expect(projects.status(pid).outgoing.isEmpty)
        #expect(out.result?.contains("Synced 1 file") == true)

        // 4. Accepted on the server (web Changes tab / phone) → review_changed → written to the Mac
        //    by the writer without another prompt; the old version stays restorable in History.
        let mainV0 = FileHasher.sha256(Data("int main(){return 1;}\n".utf8))
        acceptInApp(r, pid, "src/main.c", Data("int main(){return 2;}\n".utf8))
        acceptInApp(r, pid, "src/new.c", Data("void f(void){}\n".utf8))
        #expect(await until(10) { folder.read("src/main.c") == "int main(){return 2;}\n" && folder.read("src/new.c") == "void f(void){}\n" })
        #expect(await until { projects.status(pid).incoming.isEmpty })
        #expect(r.writer.count >= 1)
        #expect(!r.notifier.posted.contains { $0.id.hasPrefix("pending-in-") || $0.id.hasPrefix("apply-failed-") }, "no notification for a normal apply")
        #expect(await until { r.shell.notice?.isError == false && r.shell.notice?.text.hasSuffix("→ Mac") == true })
        let written = projects.history(pid).flatMap(\.files)
        let mainEntry = try #require(written.first { $0.path == "src/main.c" })
        #expect(mainEntry.oldHash == mainV0 && mainEntry.oldRef != nil, "the overwritten version can be restored from the server")
        #expect(written.contains { $0.path == "src/new.c" })
        await engine.handleLocalChanges(["src/new.c", "src/main.c"])   // FSEvents echo
        #expect(projects.status(pid).outgoing.isEmpty, "our own writes are not local changes")
        _ = snapshot

        // 5. Pull back: accepts on the server and offers the files; the server copy stays.
        hub.with { $0.worktree[pid]?["CHANGELOG.md"] = Data("v1\n".utf8); $0.review[pid] = [ReviewFile(path: "CHANGELOG.md", status: "added")] }
        let pulled = try await projects.pullBack(pid)
        #expect(pulled == 1)
        #expect(await until { r.shell.serverChanges?.items.map(\.path) == ["CHANGELOG.md"] }, "not reported by the page → the Apply to Mac sheet")
        #expect(folder.read("CHANGELOG.md") == nil)
        await r.shell.applyServerChanges()
        #expect(folder.read("CHANGELOG.md") == "v1\n")
        #expect(hub.with { $0.projects }.contains { $0.id == pid }, "the server project stays")
        #expect(hub.with { $0.deletedProjects }.isEmpty)
        #expect(!hub.with { $0.requests }.contains("DELETE /api/projects/\(pid)"), "pull back never deletes the server copy")

        // 6. Disk block: syncing to the server is refused, changes stay pending.
        r.events.emit(.diskStatus(DiskStatus(level: .block, usedPercent: 96, totalBytes: 100, freeBytes: 4)))
        #expect(await until { projects.status(pid).pushesBlocked })
        folder.write("README.md", "# while blocked\n")
        await engine.handleLocalChanges(["README.md"])
        await #expect(throws: HubError.self) { try await projects.syncToServer(pid, paths: nil) }
        #expect(projects.status(pid).outgoing.count == 1)
        r.events.emit(.diskStatus(DiskStatus(level: .ok, usedPercent: 60, totalBytes: 100, freeBytes: 40)))
        #expect(await until { !projects.status(pid).pushesBlocked })
        #expect(try await projects.syncToServer(pid, paths: nil).pushed == ["README.md"])

        // 7. Logout keeps the link and pending state; signing in again restarts the engine.
        await r.shell.webUserChanged(nil)
        #expect(projects.linked.isEmpty && projects.engine(pid) == nil)
        await r.shell.webUserChanged("bob")
        #expect(await until { projects.linked.map(\.id) == [pid] && projects.engine(pid) != nil })

        // 8. Remove from server: a separate, confirmed action; pending changes need "discard"; the folder is untouched.
        hub.with { $0.review[pid] = [ReviewFile(path: "x.txt", status: "added")] }
        let before = folder.fingerprint()
        await #expect(throws: HubError.self) { try await projects.removeFromServer(pid, discardRemaining: false) }
        #expect(hub.with { $0.projects }.contains { $0.id == pid })
        try await projects.removeFromServer(pid, discardRemaining: true)
        #expect(hub.with { $0.deletedProjects } == [pid])
        #expect(projects.linked.isEmpty)
        #expect(folder.fingerprint() == before, "removing from the server never touches the local folder")
    }

    @Test func linkingByTypedPathDropAndSingleFile() async throws {
        let r = await signedIn()
        let hub = MockHub.shared
        let projects = r.shell.projects
        let dir = TempFolder("workstation-link")
        dir.write("notes.md", "# notes\n")
        dir.write("other.txt", "sibling\n")
        dir.write("code/app.c", "x\n")

        // Typed path: missing / relative → clear errors, nothing created.
        await #expect(throws: Error.self) { try await projects.prepareTypedLink(dir.url.appendingPathComponent("nope").path) }
        await #expect(throws: LinkTarget.Problem.self) { try await projects.prepareTypedLink("relative/path") }
        #expect(projects.pendingLinks.isEmpty && hub.with { $0.projects }.isEmpty)

        // Typed path to one file → a single-file project named after it.
        try await projects.prepareTypedLink(dir.url.appendingPathComponent("notes.md").path)
        #expect(projects.pendingLinks.first?.target.isSingleFile == true)
        let note = try #require(await projects.confirmPendingLinks().first)
        #expect(note.name == "notes.md" && note.onlyPath == "notes.md")
        #expect(await until { projects.status(note.id).phase == .watching })
        #expect(Set(hub.with { $0.local[note.id] ?? [:] }.keys) == ["notes.md"], "only that file is uploaded")

        // Drop: a folder, a file already linked, a missing path → one confirmation, clear errors.
        r.shell.linkDropped([dir.url.appendingPathComponent("code"), dir.url.appendingPathComponent("notes.md"), dir.url.appendingPathComponent("gone")])
        #expect(r.windows.calls.last == "folders")
        #expect(await until { projects.pendingLinks.count == 1 })
        #expect(projects.linkErrors.count == 2)
        let code = try #require(await projects.confirmPendingLinks().first)
        #expect(code.name == "code" && !code.isSingleFile)

        // A file inside a linked folder is refused.
        await projects.prepareLinks([dir.url.appendingPathComponent("code/app.c")])
        #expect(projects.pendingLinks.isEmpty && projects.linkErrors.first?.contains("already synced as part of code") == true)

        // Dock drop while signed out: a message, nothing linked.
        await r.shell.webUserChanged(nil)
        r.shell.linkDropped([dir.url.appendingPathComponent("other.txt")])
        #expect(projects.message?.contains("Sign in") == true)
    }

    @Test func unsyncedLocalEditsOfferBackupOrConfirmedOverwrite() async throws {
        let r = await signedIn()
        let hub = MockHub.shared
        let projects = r.shell.projects
        let folder = TempFolder("workstation-edits")
        folder.write("a.txt", "synced\n")
        folder.write("b.txt", "synced b\n")
        let pid = try #require(await link(r, [folder.url]).first?.id)
        let engine = try #require(projects.engine(pid))
        #expect(await until { projects.status(pid).phase == .watching })
        hub.with { $0.conflictPaths = ["a.txt", "b.txt"] }   // the server changed them too: the edits stay unsynced
        folder.write("a.txt", "my unsynced edit\n")
        folder.write("b.txt", "my b edit\n")
        await engine.handleLocalChanges(["a.txt", "b.txt"])
        hub.acceptOnServer(pid, "a.txt", Data("server a\n".utf8))
        hub.acceptOnServer(pid, "b.txt", Data("server b\n".utf8))
        #expect(await until(10) { projects.status(pid).incomingWithLocalEdits == ["a.txt", "b.txt"] })
        #expect(projects.status(pid).backupsAvailable == true)

        let review = ReviewModel(projectId: pid, projects: projects, incoming: true)
        #expect(review.choice(for: "a.txt") == .backUpAndOverwrite, "default")
        // "Overwrite without backup" waits for the second confirmation naming the file.
        review.choices["b.txt"] = .overwriteWithoutBackup
        review.checked = ["b.txt"]
        await review.approveSelected()
        #expect(review.confirmLoss == ["b.txt"])
        #expect(folder.read("b.txt") == "my b edit\n" && r.writer.count == 0)
        review.cancelLoss()
        #expect(folder.read("b.txt") == "my b edit\n")
        await review.approveSelected()
        await review.confirmLossAndApply()
        #expect(folder.read("b.txt") == "server b\n")
        #expect(hub.with { $0.backupBodies }.isEmpty, "no backup request for this choice")

        // Default: back up on the server, then overwrite.
        review.checked = ["a.txt"]
        await review.approveSelected()
        #expect(review.confirmLoss.isEmpty)
        #expect(hub.with { $0.backupBodies }.count == 1)
        #expect(hub.with { $0.backupBodies.first?.reason } == .overwrite)
        #expect(folder.read("a.txt") == "server a\n")
        #expect(projects.history(pid).first?.files.first?.backedUp == true)

        // Backups endpoint missing (404) → "Back up and overwrite" is unavailable; nothing is overwritten.
        hub.with { $0.backupsEnabled = false; $0.conflictPaths.insert("a.txt") }
        folder.write("a.txt", "edited again\n")
        await engine.handleLocalChanges(["a.txt"])
        hub.acceptOnServer(pid, "a.txt", Data("server a2\n".utf8))
        #expect(await until(10) { projects.status(pid).backupsAvailable == false && projects.status(pid).incomingWithLocalEdits == ["a.txt"] })
        review.choices["a.txt"] = .backUpAndOverwrite
        #expect(review.choice(for: "a.txt") == .skip, "greyed out → falls back to skip")
        review.checked = ["a.txt"]
        await review.approveSelected()
        #expect(folder.read("a.txt") == "edited again\n")
    }

    /// Approval is native-only: the page has one message handler and one user script, neither of
    /// which can queue, approve or execute a write; crafted messages change nothing (a server change
    /// over a local edit stays staged for the native conflict sheet).
    @Test func approvalIsNativeOnly() async throws {
        #expect(WebShellController.messageHandlerNames == ["workstationShell"])
        #expect(WebShellController.userScriptSources == [WebScripts.bootstrap])
        #expect(!WebScripts.bootstrap.contains("fetch"))
        let r = await signedIn()
        let hub = MockHub.shared
        let projects = r.shell.projects
        let folder = TempFolder("workstation-native")
        folder.write("a.txt", "synced\n")
        let pid = try #require(await link(r, [folder.url]).first?.id)
        #expect(await until { projects.status(pid).phase == .watching })
        hub.with { $0.conflictPaths = ["a.txt"] }
        folder.write("a.txt", "local edit\n")
        await projects.engine(pid)?.handleLocalChanges(["a.txt"])
        hub.acceptOnServer(pid, "a.txt", Data("server\n".utf8))
        #expect(await until(10) { projects.status(pid).incomingWithLocalEdits == ["a.txt"] })
        #expect(await until { r.shell.incomingConflict != nil })
        let before = folder.fingerprint()
        let pushes = hub.with { $0.pushedOps.count }
        let crafted: [JSONValue] = [
            ["type": "accepted", "projectId": .string(pid), "response": ["localCommit": "x", "files": [["path": "evil.txt", "contentBase64": "aGk=", "deleted": false]]]],
            ["type": "apply", "projectId": .string(pid)], ["type": "applyIncoming", "projectId": .string(pid), "paths": ["a.txt"]],
            ["type": "sync", "projectId": .string(pid)], ["type": "syncToServer", "projectId": .string(pid)],
            ["type": "write", "path": .string(folder.url.appendingPathComponent("evil.txt").path), "contentBase64": "aGk="],
            ["type": "link", "path": "/"], ["type": "pullBack", "projectId": .string(pid)], ["type": "restore", "projectId": .string(pid)],
            ["type": "user", "user": "bob"], ["type": "route", "path": "/projects"],
        ]
        for m in crafted { r.shell.webPage(didReceive: m) }
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(r.writer.count == 0)
        #expect(folder.fingerprint() == before)
        #expect(hub.with { $0.pushedOps.count } == pushes)
        #expect(projects.status(pid).incoming.map(\.path) == ["a.txt"], "queue unchanged")
        #expect(projects.pendingLinks.isEmpty)
        #expect(!hub.with { $0.requests }.contains("POST /api/projects/\(pid)/review/accept"))
    }

    // MARK: A folder as a Code session's directory

    func newSessionURL(_ cwd: String) -> String { ShellURLs.newCodeSession(cwd: cwd, base: MockHub.baseURL).absoluteString }

    /// Folder button: the native picker → the upload sheet → link (first upload) → the new Code
    /// session page. No other window opens; the page's message carries nothing that is used.
    @Test func pickFolderLinksThePickedFolderAndOpensACodeSession() async throws {
        let picker = FakeFolderPicker()
        let r = await signedIn(picker: picker)
        let hub = MockHub.shared
        let folder = TempFolder("workstation-pick")
        folder.write("README.md", "# pick\n")
        folder.write("src/a.c", "a\n")
        let decoy = TempFolder("workstation-decoy")
        decoy.write("secret.txt", "no\n")
        picker.answers = [folder.url]
        let loadsBefore = r.page.loads.count

        r.shell.webPage(didReceive: ["type": "pick_folder", "path": .string(decoy.url.path), "cwd": "projects/evil"])
        // The sheet: name and count after ignore rules; nothing exists on the server yet.
        #expect(await until { r.shell.uploadConfirmation?.preview != nil })
        #expect(picker.calls == 1)
        let sheet = try #require(r.shell.uploadConfirmation)
        #expect(sheet.name == folder.url.lastPathComponent)
        #expect(sheet.preview == UploadPreview(files: 2, bytes: 9, truncated: false))
        #expect(FolderUploadSheet.countLine(sheet.preview) == "2 files · 9 bytes")
        #expect(FolderUploadSheet.countLine(nil) == "…")
        #expect(hub.with { $0.projects }.isEmpty && r.shell.projects.store.load().isEmpty)
        #expect(r.page.loads.count == loadsBefore)
        // While the sheet is up, more picks and drops are ignored.
        r.shell.webPage(didReceive: ["type": "pick_folder"])
        await r.shell.openFolderSession(decoy.url)
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(r.shell.uploadConfirmation?.id == sheet.id && picker.calls == 1)

        await r.shell.confirmFolderUpload()
        #expect(r.shell.uploadConfirmation == nil)
        #expect(await until { r.page.loads.count > loadsBefore })
        let project = try #require(hub.with { $0.projects }.first)
        #expect(hub.with { $0.projects }.count == 1)
        #expect(r.shell.projects.linkedFolder(for: folder.url)?.id == project.id)
        #expect(Set(hub.with { $0.local[project.id] ?? [:] }.keys) == ["README.md", "src/a.c"], "first upload done before the page opens")
        #expect(project.path == "projects/\(project.name)")
        #expect(r.page.loads.last?.absoluteString == newSessionURL("projects/\(project.name)"))
        #expect(r.page.loads.count == loadsBefore + 1)
        #expect(r.shell.folderSession == nil)
        #expect(!r.windows.calls.contains("folders"), "no Linked Folders window for this path")
        #expect(r.shell.projects.pendingLinks.isEmpty)
        #expect(r.shell.projects.linkedFolder(for: decoy.url) == nil)

        // Cancelled picker: nothing happens.
        picker.answers = [nil]
        let loads = r.page.loads.count
        r.shell.webPage(didReceive: ["type": "pick_folder"])
        #expect(await until { picker.calls == 2 })
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(r.page.loads.count == loads)
        #expect(hub.with { $0.projects }.count == 1)
    }

    /// "Cancel" in the upload sheet: no project, no bookmark kept, no navigation.
    @Test func cancellingTheUploadSheetLeavesNothing() async throws {
        let picker = FakeFolderPicker()
        let r = await signedIn(picker: picker)
        let hub = MockHub.shared
        let folder = TempFolder("workstation-cancel")
        folder.write("a.txt", "a\n")
        let loads = r.page.loads.count

        r.shell.folderDropped([folder.url])
        #expect(await until { r.shell.uploadConfirmation != nil })
        r.shell.cancelFolderUpload()
        #expect(r.shell.uploadConfirmation == nil && r.shell.folderSession == nil)
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(hub.with { $0.projects }.isEmpty)
        #expect(!hub.with { $0.requests }.contains("POST /api/projects"))
        #expect(r.shell.projects.linked.isEmpty && r.shell.projects.store.load().isEmpty, "no link, no bookmark")
        #expect(r.page.loads.count == loads)
        #expect(!r.windows.calls.contains("folders"))

        // Upload count stops at its time budget and says so.
        let t = try LinkTarget.inspect(folder.url)
        let capped = await ProjectsModel.uploadPreview(t, budget: 0)
        #expect(capped.truncated)
        #expect(FolderUploadSheet.countLine(UploadPreview(files: 48_210, bytes: 0, truncated: true)).hasPrefix("48,210+ files"))
        #expect(await ProjectsModel.uploadPreview(t, budget: 30) == UploadPreview(files: 1, bytes: 2))
    }

    /// The page can only ask for the picker: no message links a path or writes anything, and
    /// `pick_folder` with extra fields does nothing but open the picker.
    @Test func thePageCannotLinkAPath() async throws {
        let picker = FakeFolderPicker()
        let r = await signedIn(picker: picker)
        let hub = MockHub.shared
        let folder = TempFolder("workstation-target")
        folder.write("a.txt", "a\n")
        let path = JSONValue.string(folder.url.path)
        let crafted: [JSONValue] = [
            ["type": "pick_folder", "path": path, "paths": [path], "url": .string(folder.url.absoluteString), "confirm": true],
            ["type": "link", "path": path], ["type": "link_folder", "path": path], ["type": "linkFolder", "path": path],
            ["type": "open_folder", "path": path], ["type": "folder", "path": path], ["type": "drop", "paths": [path]],
            ["type": "dropped_folders", "paths": [path]], ["type": "new_session", "cwd": path], ["type": "session_folder", "path": path],
            ["type": "route", "path": "/?new=code&cwd=projects/x"],
        ]
        let loads = r.page.loads.count
        for m in crafted { r.shell.webPage(didReceive: m) }
        #expect(await until { picker.calls == 1 })
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(picker.calls == 1, "only pick_folder opens the picker")
        #expect(hub.with { $0.projects }.isEmpty)
        #expect(!hub.with { $0.requests }.contains("POST /api/projects"))
        #expect(r.shell.projects.linked.isEmpty && r.shell.projects.store.load().isEmpty)
        #expect(r.writer.count == 0)
        #expect(r.page.loads.count == loads)
        #expect(r.shell.folderSession == nil)

        // While a picker is open, more requests are ignored.
        picker.hold = true
        r.shell.webPage(didReceive: ["type": "pick_folder"])
        r.shell.webPage(didReceive: ["type": "pick_folder"])
        #expect(await until { picker.calls == 2 })
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(picker.calls == 2)
        picker.release(nil)
    }

    /// A folder that is already linked is reused: no second project, no second first upload. A
    /// folder inside a linked one works in that project's subdirectory.
    @Test func droppedFolderAlreadyLinkedReusesTheProject() async throws {
        let r = await signedIn()
        let hub = MockHub.shared
        let projects = r.shell.projects
        let folder = TempFolder("workstation-reuse")
        folder.write("README.md", "# reuse\n")
        folder.write("My Docs/ü.md", "u\n")
        let pid = try #require(await link(r, [folder.url]).first?.id)
        #expect(await until { projects.status(pid).phase == .watching })
        let name = try #require(projects.project(pid)?.name)
        let baselines = hub.with { $0.requests }.filter { $0 == "POST /api/projects/\(pid)/baseline" }.count
        #expect(baselines == 1)
        r.windows.calls = []

        r.shell.folderDropped([folder.url])
        #expect(await until { r.page.loads.last?.absoluteString == newSessionURL("projects/\(name)") })
        #expect(r.shell.uploadConfirmation == nil, "already linked: no sheet")
        #expect(hub.with { $0.projects }.count == 1)
        #expect(hub.with { $0.requests }.filter { $0 == "POST /api/projects" }.count == 1)
        #expect(hub.with { $0.requests }.filter { $0 == "POST /api/projects/\(pid)/baseline" }.count == 1, "no second first upload")
        #expect(projects.linked.count == 1)

        // A subfolder of the linked folder: same project, its subdirectory (percent-encoded).
        r.shell.folderDropped([folder.url.appendingPathComponent("My Docs")])
        #expect(await until { r.page.loads.last?.absoluteString == newSessionURL("projects/\(name)/My Docs") })
        #expect(r.shell.uploadConfirmation == nil, "inside a linked folder: no sheet")
        #expect(r.page.loads.last?.absoluteString.hasSuffix("cwd=projects/\(name)/My%20Docs") == true)
        #expect(hub.with { $0.projects }.count == 1)
        #expect(r.windows.calls.allSatisfy { $0 == "main" })

        // A folder that contains a linked one: one short error, nothing created.
        let outer = folder.url.deletingLastPathComponent()
        let loads = r.page.loads.count
        await r.shell.openFolderSession(outer)
        #expect(r.shell.folderSession?.error?.contains("linked on its own") == true)
        #expect(r.shell.folderSession?.error?.contains("\n") == false)
        #expect(r.page.loads.count == loads && hub.with { $0.projects }.count == 1)
        r.shell.dismissFolderSession()
        #expect(r.shell.folderSession == nil)

        // Signed out: an error line, nothing linked.
        await r.shell.webUserChanged(nil)
        await r.shell.openFolderSession(folder.url)
        #expect(r.shell.folderSession?.error != nil)
    }

    // MARK: Server → Mac without a second review

    /// Accepting in the web Changes tab is the decision: the file is written by the writer with no
    /// prompt, the old version stays restorable, and only a short notice appears.
    @Test func acceptedServerChangeIsWrittenWithoutAPrompt() async throws {
        let r = await signedIn()
        let projects = r.shell.projects
        let folder = TempFolder("workstation-auto")
        folder.write("test.py", "print(1)\n")
        let pid = try #require(await link(r, [folder.url]).first?.id)
        #expect(await until { projects.status(pid).phase == .watching })

        acceptInApp(r, pid, "test.py", Data("print(2)\n".utf8))
        #expect(await until(10) { folder.read("test.py") == "print(2)\n" })
        #expect(await until { projects.status(pid).incoming.isEmpty })
        #expect(r.writer.count == 1)
        #expect(r.shell.incomingConflict == nil && r.shell.uploadConfirmation == nil)
        #expect(!r.windows.calls.contains { $0.hasPrefix("review:") })
        #expect(await until { r.shell.notice?.text == "test.py → Mac" && r.shell.notice?.isError == false })
        #expect(r.notifier.posted.isEmpty, "no notification for a normal apply")
        let h = try #require(projects.history(pid).first?.files.first)
        #expect(h.path == "test.py" && h.op == .write && h.oldHash == FileHasher.sha256(Data("print(1)\n".utf8)) && h.oldRef != nil)
        // The notice hides by itself.
        ShellModel.noticeSeconds = 0.2
        defer { ShellModel.noticeSeconds = 4 }
        acceptInApp(r, pid, "test.py", Data("print(3)\n".utf8))
        #expect(await until(10) { folder.read("test.py") == "print(3)\n" })
        #expect(await until { r.shell.notice == nil })
    }

    /// Accepted anywhere but this window (browser, API call), or with other content than the page
    /// reported, or after the report expired: the "Apply to Mac" sheet, never a silent write.
    @Test func unreportedServerChangesNeedApplyToMac() async throws {
        let r = await signedIn()
        let hub = MockHub.shared
        let projects = r.shell.projects
        let folder = TempFolder("workstation-unreported")
        folder.write("api.py", "1\n")
        folder.write("swap.py", "1\n")
        folder.write("late.py", "1\n")
        folder.write("gone.py", "1\n")
        let pid = try #require(await link(r, [folder.url]).first?.id)
        #expect(await until { projects.status(pid).phase == .watching })

        // 1. Accepted by an API call (no report), app not frontmost → sheet + notification.
        hub.acceptOnServer(pid, "api.py", Data("2\n".utf8))
        #expect(await until(10) { r.shell.serverChanges != nil })
        let sheet = try #require(r.shell.serverChanges)
        #expect(sheet.title == "api.py from the server")
        #expect(sheet.items == [ServerChangesState.Item(path: "api.py", kind: .modified)])
        #expect(folder.read("api.py") == "1\n" && r.writer.count == 0)
        #expect(r.notifier.posted.first { $0.id == "server-changes-\(pid)" }?.title == "api.py from the server")

        // Later: stays staged, the same set does not come back.
        r.shell.laterServerChanges()
        #expect(r.shell.serverChanges == nil)
        await projects.reconcile(pid)
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(r.shell.serverChanges == nil)
        #expect(projects.status(pid).incoming.map(\.path) == ["api.py"], "Linked Folders still lists it")

        // 2. Same path, other content than reported → sheet (with the earlier item); app frontmost → no notification.
        r.notifier.appIsActive = true
        let posted = r.notifier.posted.count
        report(r, pid, [("swap.py", FileHasher.sha256(Data("what the page saw\n".utf8)))])
        hub.acceptOnServer(pid, "swap.py", Data("something else\n".utf8))
        #expect(await until(10) { r.shell.serverChanges?.items.map(\.path) == ["api.py", "swap.py"] })
        #expect(r.shell.serverChanges?.title == "2 files from the server")
        #expect(folder.read("swap.py") == "1\n")
        #expect(r.notifier.posted.count == posted)
        r.shell.laterServerChanges()

        // 3. Reported, but more than 5 minutes ago → sheet.
        let realNow = Date()
        projects.now = { realNow }
        report(r, pid, [("late.py", FileHasher.sha256(Data("2\n".utf8))), ("gone.py", nil)])
        projects.now = { realNow.addingTimeInterval(ProjectsModel.reportLifetime + 1) }
        hub.acceptOnServer(pid, "late.py", Data("2\n".utf8))
        #expect(await until(10) { r.shell.serverChanges?.items.map(\.path).contains("late.py") == true })
        #expect(folder.read("late.py") == "1\n")

        // Apply to Mac writes exactly the listed files.
        let listed = try #require(r.shell.serverChanges?.items.map(\.path))
        await r.shell.applyServerChanges()
        #expect(r.shell.serverChanges == nil)
        #expect(folder.read("api.py") == "2\n" && folder.read("swap.py") == "something else\n" && folder.read("late.py") == "2\n")
        #expect(folder.read("gone.py") == "1\n", "not listed, not touched")
        #expect(Set(listed) == ["api.py", "swap.py", "late.py"])
        #expect(await until { projects.status(pid).incoming.isEmpty })
        projects.now = Date.init
    }

    /// A report that arrives after the change was staged still counts: the item is written and leaves the sheet.
    @Test func reportAfterStagingAppliesAndClearsTheSheet() async throws {
        let r = await signedIn()
        let hub = MockHub.shared
        let projects = r.shell.projects
        let folder = TempFolder("workstation-late-report")
        folder.write("a.py", "1\n")
        let pid = try #require(await link(r, [folder.url]).first?.id)
        #expect(await until { projects.status(pid).phase == .watching })
        hub.acceptOnServer(pid, "a.py", Data("2\n".utf8))
        #expect(await until(10) { r.shell.serverChanges != nil })
        report(r, pid, [("a.py", FileHasher.sha256(Data("2\n".utf8)))])
        #expect(await until { folder.read("a.py") == "2\n" })
        #expect(await until { r.shell.serverChanges == nil })
    }

    /// Sheets queue across projects; a conflict sheet goes before waiting "Apply to Mac" sheets.
    @Test func sheetsQueueAcrossProjects() async throws {
        let r = await signedIn()
        let hub = MockHub.shared
        let projects = r.shell.projects
        let one = TempFolder("workstation-q1"), two = TempFolder("workstation-q2"), three = TempFolder("workstation-q3")
        one.write("a.py", "1\n"); two.write("b.py", "1\n"); three.write("c.py", "1\n")
        let p1 = try #require(await link(r, [one.url]).first?.id)
        let p2 = try #require(await link(r, [two.url]).first?.id)
        let p3 = try #require(await link(r, [three.url]).first?.id)
        #expect(await until { [p1, p2, p3].allSatisfy { projects.status($0).phase == .watching } })
        hub.acceptOnServer(p1, "a.py", Data("2\n".utf8))
        #expect(await until(10) { r.shell.serverChanges?.projectId == p1 })
        hub.acceptOnServer(p2, "b.py", Data("2\n".utf8))
        three.write("c.py", "mine\n")
        _ = hub.with { $0.conflictPaths.insert("c.py") }
        await projects.engine(p3)?.handleLocalChanges(["c.py"])
        acceptInApp(r, p3, "c.py", Data("server\n".utf8))
        try await Task.sleep(nanoseconds: 1_500_000_000)
        #expect(r.shell.serverChanges?.projectId == p1, "the open sheet stays")
        r.shell.laterServerChanges()
        #expect(await until { r.shell.incomingConflict?.projectId == p3 }, "conflict first")
        #expect(three.read("c.py") == "mine\n", "reported, but local edits: never overwritten")
        await r.shell.resolveIncomingConflict(.skip)
        #expect(r.shell.serverChanges?.projectId == p2)
        r.shell.laterServerChanges()
        #expect(r.shell.incomingSheet == nil)
    }

    /// A deletion accepted on the server moves the file to the Trash: never a hard delete.
    @Test func serverDeletionGoesToTheTrash() async throws {
        let r = await signedIn()
        let projects = r.shell.projects
        let trash = TempFolder("workstation-trash")
        r.writer.deleteMode = .trashDirectory(trash.url)
        let folder = TempFolder("workstation-del")
        folder.write("keep.txt", "k\n")
        folder.write("old.txt", "bye\n")
        let pid = try #require(await link(r, [folder.url]).first?.id)
        #expect(await until { projects.status(pid).phase == .watching })

        acceptInApp(r, pid, "old.txt", nil)
        #expect(await until(10) { folder.read("old.txt") == nil })
        #expect(trash.read("old.txt") == "bye\n", "moved to the Trash")
        #expect(folder.read("keep.txt") == "k\n")
        #expect(await until { projects.history(pid).first?.files.first?.op == .delete })
        #expect(await until { r.shell.notice?.text == "old.txt → Mac" })
    }

    /// A server change over an unsynced local edit is not written: the conflict sheet comes up (once)
    /// with the review window's choices, plus a notification.
    @Test func conflictingLocalEditOpensTheConflictSheet() async throws {
        let r = await signedIn()
        let hub = MockHub.shared
        let projects = r.shell.projects
        let folder = TempFolder("workstation-conflict")
        folder.write("test.py", "print(1)\n")
        folder.write("other.py", "x = 1\n")
        folder.write("third.py", "3\n")
        let pid = try #require(await link(r, [folder.url]).first?.id)
        let engine = try #require(projects.engine(pid))
        #expect(await until { projects.status(pid).phase == .watching })
        hub.with { $0.conflictPaths = ["test.py", "third.py"] }
        folder.write("test.py", "print('mine')\n")
        await engine.handleLocalChanges(["test.py"])

        hub.acceptOnServer(pid, "test.py", Data("print('server')\n".utf8))
        #expect(await until(10) { r.shell.incomingConflict != nil })
        let c = try #require(r.shell.incomingConflict)
        #expect(c.paths == ["test.py"] && c.title == "test.py changed on this Mac and on the server")
        #expect(c.backupsAvailable)
        #expect(folder.read("test.py") == "print('mine')\n", "no overwrite")
        #expect(r.writer.count == 0)
        #expect(r.notifier.posted.filter { $0.id == "incoming-conflict-\(pid)" }.count == 1)

        // Skip: stays staged, not asked again for the same change.
        await r.shell.resolveIncomingConflict(.skip)
        #expect(r.shell.incomingConflict == nil)
        await projects.reconcile(pid)
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(r.shell.incomingConflict == nil)
        #expect(projects.status(pid).incoming.map(\.path) == ["test.py"])
        // Another server change → the sheet again (a clean file next to it is written on its own).
        acceptInApp(r, pid, "other.py", Data("x = 2\n".utf8))
        #expect(await until(10) { folder.read("other.py") == "x = 2\n" })
        folder.write("third.py", "mine 3\n")
        await engine.handleLocalChanges(["third.py"])
        hub.acceptOnServer(pid, "third.py", Data("server 3\n".utf8))
        #expect(await until(10) { r.shell.incomingConflict?.paths == ["test.py", "third.py"] })
        #expect(r.shell.incomingConflict?.title == "2 files changed on this Mac and on the server")
        #expect(folder.read("test.py") == "print('mine')\n" && folder.read("third.py") == "mine 3\n")

        // "Overwrite without backup" asks once more; "Back up and overwrite" keeps mine on the server.
        await r.shell.resolveIncomingConflict(.overwriteWithoutBackup)
        #expect(r.shell.incomingConflict?.confirmingLoss == true)
        #expect(folder.read("test.py") == "print('mine')\n")
        r.shell.cancelConflictLoss()
        await r.shell.resolveIncomingConflict(.backUpAndOverwrite)
        #expect(r.shell.incomingConflict == nil)
        #expect(folder.read("test.py") == "print('server')\n" && folder.read("third.py") == "server 3\n")
        #expect(Set(hub.with { $0.backupBodies }.flatMap(\.files).map(\.path)) == ["test.py", "third.py"], "my versions kept on the server")
        #expect(r.shell.notice?.text == "2 files → Mac")
    }

    /// A failed apply: one line over the main window and a notification; not retried in a loop.
    @Test func failedApplyShowsOneLineAndNotifies() async throws {
        let r = await signedIn()
        let projects = r.shell.projects
        let folder = TempFolder("workstation-fail")
        folder.write("test.py", "print(1)\n")
        let pid = try #require(await link(r, [folder.url]).first?.id)
        #expect(await until { projects.status(pid).phase == .watching })
        r.writer.failure = HubError.blocked("the writer is not available")

        acceptInApp(r, pid, "test.py", Data("print(2)\n".utf8))
        #expect(await until(10) { r.shell.notice?.isError == true })
        let notice = try #require(r.shell.notice)
        #expect(notice.text == "\(projects.project(pid)!.name): the writer is not available")
        #expect(!notice.text.contains("\n"))
        let note = try #require(r.notifier.posted.first { $0.id == "apply-failed-\(pid)" })
        #expect(note.title == "Couldn't apply changes to \(projects.project(pid)!.name)")
        #expect(folder.read("test.py") == "print(1)\n")
        await projects.reconcile(pid)
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(r.writer.count == 1, "not retried automatically")
        #expect(projects.status(pid).incoming.map(\.path) == ["test.py"], "still staged for the Linked Folders window")
        r.shell.dismissNotice()
        #expect(r.shell.notice == nil)
    }

    /// A restore started from the History window is a native click: written directly, no sheet.
    @Test func historyWindowRestoreIsWrittenDirectly() async throws {
        let r = await signedIn()
        let hub = MockHub.shared
        let projects = r.shell.projects
        let folder = TempFolder("workstation-history")
        folder.write("a.txt", "v1\n")
        let pid = try #require(await link(r, [folder.url]).first?.id)
        #expect(await until { projects.status(pid).phase == .watching })
        acceptInApp(r, pid, "a.txt", Data("v2\n".utf8))
        #expect(await until(10) { folder.read("a.txt") == "v2\n" })
        #expect(await until { projects.history(pid).first?.files.first != nil })
        let file = try #require(projects.history(pid).first?.files.first)
        // Restore (a click in the History window) fetches the old version and writes it.
        let n = try await projects.restore(pid, items: [RestoreItem.before(file)])
        #expect(n == 1)
        #expect(hub.with { $0.requests }.contains("GET /api/projects/\(pid)/raw"))
        #expect(await until { folder.read("a.txt") == "v1\n" })
        #expect(r.shell.incomingSheet == nil)
        #expect(projects.status(pid).outgoing.map(\.path) == ["a.txt"], "now a local change to review")
    }
}
