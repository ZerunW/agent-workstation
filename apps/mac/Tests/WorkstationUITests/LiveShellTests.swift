import AppKit
import Foundation
@testable import WorkstationCore
@testable import WorkstationUI
import Testing
import WebKit

/// Opt-in: loads the hub's real web app (`<hub>/`) in the shell's WKWebView, hosted in an
/// offscreen window that is never shown, with a throw-away website data store. Read-only: it
/// only GETs pages (nobody signs in, nothing is created on the hub). Checks that the observer
/// script works against the real React bundle: route reports (the router's redirect to /login),
/// the localStorage hook, client-side navigation and the titlebar colours.
///
///     WORKSTATION_LIVE_HUB=http://192.168.1.50:9000 ./scripts/swiftpm.sh test --filter LiveShell
@MainActor
@Suite("Live web app in the shell (WORKSTATION_LIVE_HUB)", .enabled(if: ProcessInfo.processInfo.environment["WORKSTATION_LIVE_HUB"] != nil), .serialized)
struct LiveShellTests {
    let base = URL(string: ProcessInfo.processInfo.environment["WORKSTATION_LIVE_HUB"] ?? "http://localhost:9000")!

    final class Recorder: WebPageDelegate {
        var messages: [JSONValue] = []
        var finished = 0
        var failures: [String] = []
        func webPage(didReceive message: JSONValue) { messages.append(message) }
        func webPageDidFinishLoad() { finished += 1 }
        func webPage(didFailLoad message: String) { failures.append(message) }
        func webPage(stateChanged title: String, canGoBack: Bool, canGoForward: Bool) {}
        func webPage(downloadFinished url: URL) {}
        func webPage(downloadFailed name: String, error: String) {}
        func webPage(open url: URL) {}
        func last(_ type: String) -> JSONValue? { messages.last { $0["type"]?.stringValue == type } }
    }

    @Test func webAppTalksToTheShell() async throws {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let web = WebShellController(persistent: false)
        let rec = Recorder()
        web.delegate = rec
        web.hubURLProvider = { base }
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: 1100, height: 700), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = web.webView
        web.load(ShellURLs.app(base: base))

        #expect(await until(30) { rec.finished > 0 || !rec.failures.isEmpty }, "page load")
        #expect(rec.failures.isEmpty, "\(rec.failures)")
        // Nobody is signed in in a fresh store: the user report is null and the router redirects to /login.
        #expect(await until(10) { rec.last("route")?["path"]?.stringValue == "/login" }, "routes: \(rec.messages)")
        #expect(rec.messages.contains { $0["type"]?.stringValue == "user" && $0["user"]?.isNull == true })
        #expect(await until(10) { rec.last("chrome") != nil }, "titlebar colours reported")
        print("chrome on /login: \(rec.last("chrome")?.jsonString() ?? "nil")")
        if case .chrome(let c) = ShellMessage.parse(rec.last("chrome") ?? nil) { #expect(c.main != nil) }

        // The localStorage hook on the real page (what the login form does via safeStorage.set).
        _ = await web.evaluate(#"localStorage.setItem("workstation.user", "macsmoke"); true"#)
        #expect(await until(5) { rec.last("user")?["user"]?.stringValue == "macsmoke" })
        let read = await web.evaluate(WebScripts.readUser) as? String
        #expect(UserIdentity.normalize(read) == "macsmoke")
        _ = await web.evaluate(#"localStorage.removeItem("workstation.user"); true"#)
        #expect(await until(5) { rec.last("user")?["user"]?.isNull == true })

        // Client-side navigation reaches React Router: /usage needs a user → redirected to /login again.
        let before = rec.messages.filter { $0["type"]?.stringValue == "route" }.count
        let handled = await web.evaluate(WebScripts.navigate("/usage")) as? Bool
        #expect(handled == true)
        #expect(await until(5) { rec.messages.filter { $0["type"]?.stringValue == "route" }.count >= before + 2 })
        #expect(rec.last("route")?["path"]?.stringValue == "/login", "the router handled the popstate")
        #expect(rec.finished == 1, "no full reload")
        #expect(!window.isVisible)

        // The real login page rendered inside the shell's web view. (WebKit does not paint a page whose
        // window is never shown: visibilityState is "hidden": so the DOM is checked instead of pixels.)
        let state = await web.evaluate("document.visibilityState + ' ' + document.querySelectorAll('#login-username').length") as? String ?? ""
        let text = await web.evaluate("document.body.innerText") as? String ?? ""
        print("login page: \(text.prefix(80).replacingOccurrences(of: "\n", with: " | ")) · \(state)")
        #expect(state.hasSuffix(" 1"), "the login form is in the DOM")
        window.contentView = nil
        window.close()
    }
}
