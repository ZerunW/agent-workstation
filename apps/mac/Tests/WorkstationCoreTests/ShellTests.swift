import Foundation
@testable import WorkstationCore
import Testing

@Suite("Shell URLs and link policy")
struct ShellURLTests {
    let hub = URL(string: "http://192.168.1.50:9000")!

    @Test func appAndRouteURLs() {
        #expect(ShellURLs.app(base: hub).absoluteString == "http://192.168.1.50:9000/")
        #expect(ShellURLs.app(base: URL(string: "https://workstation.example.run/")!).absoluteString == "https://workstation.example.run/")
        #expect(ShellURLs.url(for: "/usage", base: hub).absoluteString == "http://192.168.1.50:9000/usage")
        #expect(ShellURLs.url(for: "memory", base: hub).absoluteString == "http://192.168.1.50:9000/memory")
        #expect(ShellURLs.sessionRoute("7b8c9d0e-1f2a") == "/s/7b8c9d0e-1f2a")
        #expect(ShellURLs.sessionRoute("a b/c") == "/s/a%20b%2Fc")
        #expect(ShellURLs.route(of: URL(string: "http://h:9000/s/x?embed=1#top")!) == "/s/x?embed=1")
        #expect(ShellURLs.route(of: URL(string: "http://h:9000")!) == "/")
    }

    @Test func syncPanelRoutes() {
        #expect(ShellURLs.syncPanelRoute(latestSession: "7b8c9d0e-1f2a", projectPath: "projects/sample-app") == "/s/7b8c9d0e-1f2a?panel=sync")
        #expect(ShellURLs.syncPanelRoute(latestSession: nil, projectPath: "projects/My App") == "/?new=code&cwd=projects/My%20App&panel=sync")
    }

    /// The page a linked folder opens: a new Code session draft working in its server directory.
    @Test func newCodeSessionURL() {
        #expect(ShellURLs.newCodeSessionRoute(cwd: "projects/sample-app") == "/?new=code&cwd=projects/sample-app")
        #expect(ShellURLs.newCodeSession(cwd: "projects/sample-app", base: hub).absoluteString == "http://192.168.1.50:9000/?new=code&cwd=projects/sample-app")
        #expect(ShellURLs.newCodeSession(cwd: "projects/sample-app", base: URL(string: "https://h.example/")!).absoluteString
                == "https://h.example/?new=code&cwd=projects/sample-app")
        #expect(ShellURLs.newCodeSessionRoute(cwd: "projects/My Project") == "/?new=code&cwd=projects/My%20Project")
        #expect(ShellURLs.newCodeSessionRoute(cwd: "projects/Café/文档") == "/?new=code&cwd=projects/Caf%C3%A9/%E6%96%87%E6%A1%A3")
        #expect(ShellURLs.newCodeSessionRoute(cwd: "projects/a+b&c=d#e?f%") == "/?new=code&cwd=projects/a%2Bb%26c%3Dd%23e%3Ff%25")
        let url = ShellURLs.newCodeSession(cwd: "projects/My Café", base: hub)
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(items == [URLQueryItem(name: "new", value: "code"), URLQueryItem(name: "cwd", value: "projects/My Café")])
    }

    @Test func hubOriginComparesSchemeHostAndPort() {
        #expect(ShellURLs.isHubOrigin(URL(string: "http://192.168.1.50:9000/usage"), base: hub))
        #expect(ShellURLs.isHubOrigin(URL(string: "HTTP://192.168.1.50:9000"), base: hub))
        #expect(!ShellURLs.isHubOrigin(URL(string: "http://192.168.1.50:9001/"), base: hub))
        #expect(!ShellURLs.isHubOrigin(URL(string: "https://192.168.1.50:9000/"), base: hub))
        #expect(!ShellURLs.isHubOrigin(URL(string: "http://example.com/"), base: hub))
        #expect(ShellURLs.isHubOrigin(URL(string: "https://workstation.example.run:443/x"), base: URL(string: "https://workstation.example.run")!))
        #expect(!ShellURLs.isHubOrigin(nil, base: hub))
    }

    @Test func navigationPolicy() {
        func d(_ s: String, main: Bool = true, newWindow: Bool = false, download: Bool = false) -> NavigationDecision {
            NavigationPolicy.decide(url: URL(string: s), hub: hub, isMainFrame: main, opensNewWindow: newWindow, shouldDownload: download)
        }
        #expect(d("http://192.168.1.50:9000/projects") == .allow)
        #expect(d("http://192.168.1.50:9000/s/abc", newWindow: true) == .loadInMainFrame(URL(string: "http://192.168.1.50:9000/s/abc")!),
                "target=_blank inside the hub opens in the same window")
        #expect(d("https://docs.anthropic.com/x") == .openExternally(URL(string: "https://docs.anthropic.com/x")!), "external links → default browser")
        #expect(d("https://github.com/", newWindow: true) == .openExternally(URL(string: "https://github.com/")!))
        #expect(d("https://www.youtube.com/embed/x", main: false) == .allow, "third-party iframes load in place")
        #expect(d("mailto:me@example.com") == .openExternally(URL(string: "mailto:me@example.com")!))
        #expect(d("blob:http://192.168.1.50:9000/1234", download: true) == .download, "<a download> blob saves")
        #expect(d("http://192.168.1.50:9000/api/files/download?path=a", download: true) == .download)
        #expect(d("about:blank") == .allow)
        #expect(d("file:///Users/me/Desktop/a.png") == .cancel, "a dropped file never replaces the app")
        #expect(d("javascript:alert(1)") == .cancel)
        #expect(NavigationPolicy.decide(url: nil, hub: hub, isMainFrame: true, opensNewWindow: false, shouldDownload: false) == .cancel)
    }

    @Test func responsesThatBecomeDownloads() {
        #expect(NavigationPolicy.shouldDownload(response: "application/zip", canShowMIMEType: false, contentDisposition: nil))
        #expect(NavigationPolicy.shouldDownload(response: "text/plain", canShowMIMEType: true, contentDisposition: "attachment; filename=\"a.txt\""))
        #expect(NavigationPolicy.shouldDownload(response: "text/plain", canShowMIMEType: true, contentDisposition: " Attachment"))
        #expect(!NavigationPolicy.shouldDownload(response: "text/html", canShowMIMEType: true, contentDisposition: nil))
        #expect(!NavigationPolicy.shouldDownload(response: "image/png", canShowMIMEType: true, contentDisposition: "inline; filename=a.png"))
    }
}

@Suite("Downloads destination")
struct DownloadPlannerTests {
    @Test func sanitizesSuggestedNames() {
        #expect(DownloadPlanner.sanitize("report.pdf") == "report.pdf")
        #expect(DownloadPlanner.sanitize("../../etc/passwd") == "passwd")
        #expect(DownloadPlanner.sanitize("dir\\win.txt") == "win.txt")
        #expect(DownloadPlanner.sanitize(".hidden") == "hidden")
        #expect(DownloadPlanner.sanitize("a:b.txt") == "a-b.txt")
        #expect(DownloadPlanner.sanitize("line\nbreak.txt") == "linebreak.txt")
        #expect(DownloadPlanner.sanitize("") == "download")
        #expect(DownloadPlanner.sanitize(nil) == "download")
        #expect(DownloadPlanner.sanitize("报告 (final).md") == "报告 (final).md")
        let long = DownloadPlanner.sanitize(String(repeating: "x", count: 300) + ".zip")
        #expect(long.count == 200 && long.hasSuffix(".zip"))
    }

    @Test func neverOverwrites() {
        let dir = URL(fileURLWithPath: "/tmp/dl", isDirectory: true)
        var taken: Set<String> = []
        let exists: (URL) -> Bool = { taken.contains($0.lastPathComponent) }
        #expect(DownloadPlanner.destination(suggested: "workstation.zip", in: dir, exists: exists).path == "/tmp/dl/workstation.zip")
        taken = ["workstation.zip"]
        #expect(DownloadPlanner.destination(suggested: "workstation.zip", in: dir, exists: exists).lastPathComponent == "workstation (1).zip")
        taken = ["workstation.zip", "workstation (1).zip"]
        #expect(DownloadPlanner.destination(suggested: "workstation.zip", in: dir, exists: exists).lastPathComponent == "workstation (2).zip")
        taken = ["logs.tar.gz"]
        #expect(DownloadPlanner.destination(suggested: "logs.tar.gz", in: dir, exists: exists).lastPathComponent == "logs (1).tar.gz")
        taken = ["Makefile"]
        #expect(DownloadPlanner.destination(suggested: "Makefile", in: dir, exists: exists).lastPathComponent == "Makefile (1)")
    }

    @Test func realDirectory() throws {
        let t = TempDir("workstation-dl")
        t.write("a.txt", "x")
        #expect(DownloadPlanner.destination(suggested: "a.txt", in: t.url).lastPathComponent == "a (1).txt")
        #expect(DownloadPlanner.downloadsDirectory.lastPathComponent == "Downloads")
    }
}

@Suite("Menu commands → web routes and actions")
struct ShellCommandTests {
    @Test func routes() {
        let expected: [ShellCommand: String] = [.home: "/", .usage: "/usage", .instructions: "/instructions", .memory: "/memory",
                                                .projects: "/projects", .skills: "/skills", .browserSites: "/browser-sites", .admin: "/admin",
                                                .docs: "/readme"]
        for (c, path) in expected { #expect(ShellCommandMap.action(for: c, zoom: 1) == .navigate(path), "\(c)") }
    }

    @Test func webShortcutsWithFallbacks() {
        // ⌘N: the web app's own shortcut on the workbench; any other page → "/".
        #expect(ShellCommandMap.action(for: .newSession, zoom: 1) == .shortcut(WebShortcut(key: "n", code: "KeyN", fallback: "/")))
        // ⌘K: the command palette lives on the workbench → go there, then open it.
        #expect(ShellCommandMap.action(for: .commandPalette, zoom: 1)
                == .shortcut(WebShortcut(key: "k", code: "KeyK", fallback: "/", retryAfterFallback: true)))
        // ⌘F: the page's own handler (find bar in a session, session search elsewhere); never navigates away.
        #expect(ShellCommandMap.action(for: .find, zoom: 1) == .shortcut(WebShortcut(key: "f", code: "KeyF")))
        #expect(ShellCommandMap.action(for: .toggleSidebar, zoom: 1) == .shortcut(ShellCommandMap.toggleSidebar))
        // ⌘⇧. matches `code:Period` + shift in useHotkeys.
        #expect(ShellCommandMap.stop.code == "Period" && ShellCommandMap.stop.shift && ShellCommandMap.stop.fallback == nil)
        #expect(ShellCommandMap.action(for: .reload, zoom: 1) == .reload)
        #expect(ShellCommandMap.action(for: .back, zoom: 1) == .goBack)
        #expect(ShellCommandMap.action(for: .forward, zoom: 1) == .goForward)
    }

    @Test func zoomSteps() {
        #expect(ShellCommandMap.action(for: .zoomIn, zoom: 1) == .zoom(1.1))
        #expect(ShellCommandMap.action(for: .zoomOut, zoom: 1) == .zoom(0.9))
        #expect(ShellCommandMap.action(for: .actualSize, zoom: 1.75) == .zoom(1))
        #expect(ZoomSteps.next(after: 3) == 3 && ZoomSteps.previous(before: 0.5) == 0.5, "clamped at the ends")
        #expect(ZoomSteps.next(after: 1.17) == 1.25, "off-grid values snap to the next step")
        #expect(ZoomSteps.previous(before: 1.17) == 1.1)
        #expect(ZoomSteps.clamp(9) == 3 && ZoomSteps.clamp(0.1) == 0.5 && ZoomSteps.clamp(.nan) == 1)
        var z = 1.0
        for _ in 0..<20 { z = ZoomSteps.next(after: z) }
        #expect(z == 3)
    }
}

@Suite("Messages from the web app")
struct ShellMessageTests {
    @Test func user() {
        #expect(ShellMessage.parse(["type": "user", "user": "alice"]) == .user("alice"))
        #expect(ShellMessage.parse(["type": "user", "user": nil]) == .user(nil), "logged out")
        #expect(ShellMessage.parse(["type": "user", "user": "Not Valid!"]) == .user(nil))
        #expect(ShellMessage.parse(["type": "user"]) == .user(nil))
    }

    @Test func routeAndUnknown() {
        #expect(ShellMessage.parse(["type": "route", "path": "/s/abc"]) == .route("/s/abc"))
        #expect(ShellMessage.parse(["type": "route", "path": "https://evil"]) == .unknown("route"))
        #expect(ShellMessage.parse(["type": "ready"]) == .unknown("ready"))
        #expect(ShellMessage.parse("not an object") == .unknown(""))
    }

    /// Messages a page could craft to reach folder sync are not understood at all.
    @Test func nothingFromThePageCanQueueOrApproveWrites() {
        let crafted: [JSONValue] = [
            ["type": "accepted", "projectId": "p1", "response": ["localCommit": "c", "files": [["path": "a", "contentBase64": "aGk=", "deleted": false]]]],
            ["type": "apply", "projectId": "p1", "paths": ["a"]],
            ["type": "applyIncoming", "projectId": "p1"],
            ["type": "sync", "projectId": "p1"],
            ["type": "syncToServer", "projectId": "p1"],
            ["type": "write", "path": "/etc/hosts"],
            ["type": "link", "path": "/"],
            ["type": "restore", "projectId": "p1"],
            ["type": "pullBack", "projectId": "p1"],
        ]
        for m in crafted {
            if case .unknown = ShellMessage.parse(m) {} else { Issue.record("\(m.jsonString()) was understood") }
        }
    }

    /// The folder button: the message carries nothing; whatever else the page adds is ignored.
    @Test func pickFolder() {
        #expect(ShellMessage.parse(["type": "pick_folder"]) == .pickFolder)
        #expect(ShellMessage.parse(["type": "pick_folder", "path": "/etc", "cwd": "projects/x", "folder": "/Users"]) == .pickFolder)
        #expect(ShellMessage.parse(["type": "pickFolder"]) == .unknown("pickFolder"))
        #expect(ShellMessage.parse(["type": "PICK_FOLDER"]) == .unknown("PICK_FOLDER"))
    }

    /// `notify` from the web app: strings within their limits, sessionId a UUID or absent.
    @Test func webNotifications() {
        let sid = "7B8C9D0E-1F2A-4B3C-8D4E-5F6A7B8C9D0E"
        #expect(ShellMessage.parse(["type": "notify", "id": "done-1", "title": "Refactor finished", "body": "12 min", "sessionId": .string(sid), "x": 1])
                == .notify(WebNotification(id: "done-1", title: "Refactor finished", body: "12 min", sessionId: sid.lowercased())))
        #expect(ShellMessage.parse(["type": "notify", "id": "a", "title": "t", "body": ""]) == .notify(WebNotification(id: "a", title: "t", body: "")))
        #expect(ShellMessage.parse(["type": "notify", "id": "a", "title": "t", "body": "b", "sessionId": nil]) == .notify(WebNotification(id: "a", title: "t", body: "b")))
        #expect(WebNotification(id: "x", title: "t", body: "").identifier == "web.x")
        let ok = ShellMessage.parse(["type": "notify", "id": .string(String(repeating: "i", count: 200)), "title": .string(String(repeating: "t", count: 120)),
                                     "body": .string(String(repeating: "b", count: 300))])
        if case .notify = ok {} else { Issue.record("limits are inclusive") }
        let bad: [JSONValue] = [
            ["type": "notify", "id": "", "title": "t", "body": "b"],
            ["type": "notify", "id": .string(String(repeating: "i", count: 201)), "title": "t", "body": "b"],
            ["type": "notify", "id": "a", "title": "", "body": "b"],
            ["type": "notify", "id": "a", "title": .string(String(repeating: "t", count: 121)), "body": "b"],
            ["type": "notify", "id": "a", "title": .string(String(repeating: "😀", count: 61)), "body": "b"],   // 122 UTF-16 units
            ["type": "notify", "id": "a", "title": "t", "body": .string(String(repeating: "b", count: 301))],
            ["type": "notify", "id": "a", "title": "t"],
            ["type": "notify", "id": 5, "title": "t", "body": "b"],
            ["type": "notify", "id": "a", "title": ["t"], "body": "b"],
            ["type": "notify", "id": "a", "title": "t", "body": "b", "sessionId": "not-a-uuid"],
            ["type": "notify", "id": "a", "title": "t", "body": "b", "sessionId": 7],
        ]
        for m in bad {
            if case .unknown("notify") = ShellMessage.parse(m) {} else { Issue.record("\(m.jsonString()) was accepted") }
        }
    }

    /// `reportAccepted` from the Changes tab: strict shape, one bad field drops the report.
    @Test func acceptedReports() {
        let pid = "7B8C9D0E-1F2A-4B3C-8D4E-5F6A7B8C9D0E"
        let sha = String(repeating: "ab", count: 32)
        func msg(pid: JSONValue = .string(pid), commit: JSONValue = "c0ffee12", files: JSONValue) -> JSONValue {
            ["type": "accepted", "projectId": pid, "localCommit": commit, "files": files]
        }
        let ok = ShellMessage.parse(msg(files: [["path": "src/a.py", "sha256": .string(sha), "extra": 1], ["path": "old.txt", "sha256": nil]]))
        #expect(ok == .accepted(AcceptedReport(projectId: pid.lowercased(), localCommit: "c0ffee12",
                                               files: [.init(path: "src/a.py", sha256: sha), .init(path: "old.txt", sha256: nil)])))
        #expect(ShellMessage.parse(msg(files: [])) == .accepted(AcceptedReport(projectId: pid, localCommit: "c0ffee12", files: [])))
        let bad: [JSONValue] = [
            msg(pid: "p1", files: []), msg(pid: "7b8c9d0e1f2a4b3c8d4e5f6a7b8c9d0e", files: []), msg(pid: 5, files: []),
            msg(commit: "xyz", files: []), msg(commit: "C0FFEE", files: []), msg(commit: "abc", files: []), msg(commit: .string(String(repeating: "a", count: 65)), files: []),
            msg(files: "nope"), msg(files: .array(Array(repeating: ["path": "a", "sha256": nil], count: 2001))),
            msg(files: [["path": "../etc/passwd", "sha256": nil]]), msg(files: [["path": "/abs", "sha256": nil]]),
            msg(files: [["path": "a//b", "sha256": nil]]), msg(files: [["path": "a/./b", "sha256": nil]]), msg(files: [["path": "a/..", "sha256": nil]]),
            msg(files: [["path": "a\\b", "sha256": nil]]), msg(files: [["path": "", "sha256": nil]]), msg(files: [["path": 7, "sha256": nil]]),
            msg(files: [["path": "a", "sha256": .string(sha.uppercased())]]), msg(files: [["path": "a", "sha256": "abc"]]),
            msg(files: [["path": "a"]]), msg(files: [["path": "a", "sha256": 1]]),
            msg(files: [["path": "ok", "sha256": .string(sha)], ["path": "../bad", "sha256": .string(sha)]]),
            ["type": "accepted", "projectId": .string(pid), "files": []],
        ]
        for m in bad {
            if case .unknown("accepted") = ShellMessage.parse(m) {} else { Issue.record("\(m.jsonString()) was accepted") }
        }
        #expect(ShellMessage.parse(msg(files: .array(Array(repeating: ["path": "a", "sha256": nil], count: 2000)))) != .unknown("accepted"))
    }

    /// No message names a folder to link: only `pick_folder` reaches the folder flow, and it has no payload.
    @Test func noMessageLinksAPath() {
        let crafted: [JSONValue] = [
            ["type": "link_folder", "path": "/Users/me/code"], ["type": "linkFolder", "path": "/"],
            ["type": "open_folder", "path": "/"], ["type": "folder", "path": "/"], ["type": "drop", "paths": ["/"]],
            ["type": "new_session", "cwd": "/Users/me"], ["type": "session_folder", "url": "file:///"],
        ]
        for m in crafted {
            if case .unknown = ShellMessage.parse(m) {} else { Issue.record("\(m.jsonString()) was understood") }
        }
    }

    @Test func chrome() {
        let c = ShellMessage.parse(["type": "chrome", "overlay": false, "sidebarWidth": 272,
                                    "sidebar": [240, 238, 230, 1], "main": [250, 249, 245, 1], "divider": [229, 226, 217, 1]])
        #expect(c == .chrome(TitlebarChrome(overlay: false, sidebarWidth: 272, sidebar: RGBA(240, 238, 230), main: RGBA(250, 249, 245),
                                            divider: RGBA(229, 226, 217))))
        let bare = ShellMessage.parse(["type": "chrome", "overlay": true, "sidebarWidth": -3, "sidebar": nil, "main": [400, -1, 20, 7]])
        #expect(bare == .chrome(TitlebarChrome(overlay: true, sidebarWidth: 0, sidebar: nil, main: RGBA(255, 0, 20, 1), divider: nil)))
        #expect(RGBA(38, 38, 36).isDark && !RGBA(250, 249, 245).isDark)
    }

    @Test func usernameFromEvaluatorResults() {
        #expect(UserIdentity.normalize("alice") == "alice")
        #expect(UserIdentity.normalize(" alice\n") == "alice")
        #expect(UserIdentity.normalize("") == nil)
        #expect(UserIdentity.normalize(NSNull()) == nil)
        #expect(UserIdentity.normalize(nil) == nil)
        #expect(UserIdentity.normalize(42) == nil)
        #expect(UserIdentity.normalize("Bob") == nil)
        #expect(UserIdentity.normalize(String(repeating: "a", count: 33)) == nil)
    }
}

@Suite("Notification click routing")
struct NotificationRouteTests {
    @Test func destinations() {
        #expect(NotificationRoute.destination(for: NotificationRoute.session("abc")) == .web("/s/abc"))
        #expect(NotificationRoute.destination(for: NotificationRoute.web("/projects")) == .web("/projects"))
        #expect(NotificationRoute.destination(for: NotificationRoute.linkedFolders) == .linkedFolders)
        #expect(NotificationRoute.destination(for: NotificationRoute.reveal("/Users/me/Downloads/a.zip")) == .reveal("/Users/me/Downloads/a.zip"))
        #expect(NotificationRoute.destination(for: NotificationRoute.review("p1", incoming: true)) == .review(projectId: "p1", incoming: true))
        #expect(NotificationRoute.destination(for: NotificationRoute.review("p1", incoming: false)) == .review(projectId: "p1", incoming: false))
        #expect(NotificationRoute.destination(for: ["route": "https://evil.example"]) == .none)
        #expect(NotificationRoute.destination(for: [:]) == .none)
        #expect(NotificationRoute.destination(for: ["sessionId": "", "route": "/usage"]) == .web("/usage"))
    }
}

@Suite("Native settings")
struct ShellSettingsTests {
    @Test func hubURLAndZoomPersist() {
        let suite = "workstation-shell-\(UUID().uuidString)"
        let d = TestDefaults.named(suite)
        let s = AppSettings(defaults: d, environment: [:])
        #expect(!s.hasHubURL && s.hubURLString == AppSettings.defaultHubURL && s.pageZoom == 1)
        s.hubURLString = "http://10.0.0.5:9000"
        s.pageZoom = 1.25
        let again = AppSettings(defaults: TestDefaults.named(suite), environment: [:])
        #expect(again.hasHubURL)
        #expect(again.hubURL?.absoluteString == "http://10.0.0.5:9000")
        #expect(again.pageZoom == 1.25)
        again.pageZoom = 12
        #expect(again.pageZoom == 3, "clamped")
        d.set("garbage", forKey: "pageZoom")
        #expect(again.pageZoom == 1)
    }
}

@Suite("Drops on the main window")
struct FolderDropTests {
    func temp() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("workstation-drop-\(UUID().uuidString.prefix(6))", isDirectory: true)
        let fm = FileManager.default
        try fm.createDirectory(at: dir.appendingPathComponent("code/src"), withIntermediateDirectories: true)
        try fm.createDirectory(at: dir.appendingPathComponent("My Folder ü"), withIntermediateDirectories: true)
        try fm.createDirectory(at: dir.appendingPathComponent("Tool.app/Contents"), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: dir.appendingPathComponent("notes.md"))
        try Data("y".utf8).write(to: dir.appendingPathComponent("photo.png"))
        try fm.createSymbolicLink(at: dir.appendingPathComponent("link"), withDestinationURL: dir.appendingPathComponent("code"))
        return dir
    }

    @Test func classifiesFoldersFilesPackagesAndMixedDrops() throws {
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        func u(_ p: String) -> URL { dir.appendingPathComponent(p) }
        // A folder (with or without the trailing slash) → the shell's.
        #expect(FolderDrop.folders(in: [u("code")]) == [u("code")])
        #expect(FolderDrop.folders(in: [URL(fileURLWithPath: u("My Folder ü").path)]).count == 1)
        // Plain files → the page's.
        #expect(FolderDrop.folders(in: [u("notes.md"), u("photo.png")]).isEmpty)
        // A package counts as a file; a symbolic link is not followed.
        #expect(FolderDrop.folders(in: [u("Tool.app")]).isEmpty)
        #expect(FolderDrop.folders(in: [u("link")]).isEmpty)
        // Mixed: only the folders, in drop order.
        #expect(FolderDrop.folders(in: [u("notes.md"), u("code"), u("Tool.app"), u("code/src")]) == [u("code"), u("code/src")])
        // Not files at all.
        #expect(FolderDrop.folders(in: [URL(string: "https://example.com/dir/")!]).isEmpty)
        #expect(FolderDrop.folders(in: []).isEmpty)
    }
}
