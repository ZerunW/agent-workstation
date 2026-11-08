import Foundation
import JavaScriptCore
@testable import WorkstationCore
import Testing

/// Runs the scripts the shell injects into the web app in JavaScriptCore, against small fakes
/// of the browser APIs they touch (localStorage, history, fetch, KeyboardEvent, focus). No WebKit,
/// no window: this checks the observers' logic headlessly; the live test checks them on the real page.
@Suite("Injected JavaScript (JavaScriptCore)", .serialized)
struct WebScriptTests {
    /// Browser-ish globals shared by the tests.
    static let environment = #"""
    var window = this;
    var posted = [];
    var assigned = [];
    var listeners = {};
    window.addEventListener = function (t, f) { (listeners[t] = listeners[t] || []).push(f); };
    window.dispatchEvent = function (e) { (listeners[e.type] || []).forEach(function (f) { f(e); }); return true; };
    function Storage() { this._d = {}; }
    Storage.prototype.getItem = function (k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; };
    Storage.prototype.setItem = function (k, v) { this._d[k] = String(v); };
    Storage.prototype.removeItem = function (k) { delete this._d[k]; };
    Storage.prototype.clear = function () { this._d = {}; };
    window.Storage = Storage;
    window.localStorage = new Storage();
    window.sessionStorage = new Storage();
    window.location = { pathname: "/login", search: "", assign: function (u) { assigned.push(u); } };
    function setURL(u) { var q = u.indexOf("?"); location.pathname = q < 0 ? u : u.slice(0, q); location.search = q < 0 ? "" : u.slice(q); }
    window.history = {
      state: { usr: null, key: "default", idx: 0 },
      pushState: function (s, t, u) { this.state = s; setURL(u); },
      replaceState: function (s, t, u) { this.state = s; setURL(u); }
    };
    function PopStateEvent(type, init) { this.type = type; this.state = init && init.state; }
    var fetchCalls = 0;
    window.fetch = function (input, init) {
      fetchCalls++;
      var ok = String(input).indexOf("fail") < 0;
      var res = { ok: ok, clone: function () { return res; },
                  json: function () { return Promise.resolve({ localCommit: "c9", files: [{ path: "a.txt", contentBase64: "aGk=", deleted: false }] }); } };
      return Promise.resolve(res);
    };
    """#

    static let handler = #"""
    window.webkit = { messageHandlers: { workstationShell: { postMessage: function (m) { posted.push(JSON.parse(JSON.stringify(m))); } } } };
    """#

    final class Page {
        let ctx = JSContext()!
        var exception: String?

        init(_ scripts: String...) {
            ctx.exceptionHandler = { [weak self] _, e in self?.exception = e?.toString() }
            for s in scripts { ctx.evaluateScript(s) }
        }

        @discardableResult func run(_ js: String) -> JSValue? { ctx.evaluateScript(js) }

        /// Messages posted to the `workstationShell` handler so far, as JSONValue.
        var posted: [JSONValue] {
            guard let json = run("JSON.stringify(posted)")?.toString(), let data = json.data(using: .utf8),
                  let v = try? JSONDecoder().decode([JSONValue].self, from: data) else { return [] }
            return v
        }

        func messages(_ type: String) -> [JSONValue] { posted.filter { $0["type"]?.stringValue == type } }
    }

    @Test func bootstrapReportsUserAndRoute() {
        let p = Page(Self.environment, Self.handler, WebScripts.bootstrap)
        #expect(p.exception == nil)
        #expect(p.messages("user") == [["type": "user", "user": nil]], "nobody signed in yet")
        #expect(p.messages("route") == [["type": "route", "path": "/login"]])

        // The web login page stores the name (safeStorage.set → localStorage.setItem).
        p.run(#"localStorage.setItem("workstation.user", "alice")"#)
        #expect(p.messages("user").last == ["type": "user", "user": "alice"])
        p.run(#"localStorage.setItem("workstation.user", "alice"); localStorage.setItem("workstation.theme", "dark"); sessionStorage.setItem("workstation.user", "x")"#)
        #expect(p.messages("user").count == 2, "same value, other keys and sessionStorage are not reported")
        #expect(p.run(#"localStorage.getItem("workstation.theme")"#)?.toString() == "dark", "storage still works")

        // SPA navigation.
        p.run(#"history.pushState({ idx: 1 }, "", "/s/abc?x=1")"#)
        #expect(p.messages("route").last == ["type": "route", "path": "/s/abc?x=1"])
        p.run(#"history.replaceState({ idx: 1 }, "", "/s/abc?x=1")"#)
        #expect(p.messages("route").count == 2, "unchanged route not re-posted")
        p.run(#"setURL("/usage"); window.dispatchEvent({ type: "popstate" })"#)
        #expect(p.messages("route").last == ["type": "route", "path": "/usage"], "back / forward")

        // Logout / switch user.
        p.run(#"localStorage.removeItem("workstation.user")"#)
        #expect(p.messages("user").last == ["type": "user", "user": nil])
        p.run(#"localStorage.setItem("workstation.user", "bob"); localStorage.clear()"#)
        #expect(p.messages("user").suffix(2) == [["type": "user", "user": "bob"], ["type": "user", "user": nil]])
        // Another tab of the same origin.
        p.run(#"localStorage._d["workstation.user"] = "carol"; window.dispatchEvent({ type: "storage", key: "workstation.user" })"#)
        #expect(p.messages("user").last == ["type": "user", "user": "carol"])
        #expect(p.exception == nil)
    }

    /// Nothing the page does reaches folder sync: fetch is not wrapped, and an accept made by the
    /// page produces no message (the native side learns about it from the hub's WebSocket).
    @Test func bootstrapDoesNotObserveFetchOrForwardAccepts() {
        let p = Page(Self.environment, Self.handler)
        p.run("var originalFetch = window.fetch;")
        p.run(WebScripts.bootstrap)
        #expect(p.run("window.fetch === originalFetch")?.toBool() == true)
        p.run(#"fetch("http://hub:9000/api/projects/p1/review/accept", { method: "POST", body: "{}" })"#)
        p.run("0")
        #expect(Set(p.posted.compactMap { $0["type"]?.stringValue }) == ["user", "route"])
        #expect(!WebScripts.bootstrap.contains("fetch"))
        #expect(p.exception == nil)
    }

    /// The folder button posts `{type:"pick_folder"}` and nothing else, whatever it is called with.
    @Test func pickFolderPostsNoPath() {
        let p = Page(Self.environment, Self.handler, WebScripts.bootstrap)
        #expect(p.run("typeof window.__workstationShell.pickFolder")?.toString() == "function")
        p.run(#"window.__workstationShell.pickFolder(); window.__workstationShell.pickFolder("/etc", { path: "/Users" })"#)
        #expect(p.messages("pick_folder") == [["type": "pick_folder"], ["type": "pick_folder"]])
        #expect(p.exception == nil)
    }

    /// `__workstationShell.sync.*` returns the reply handler's promise with exactly the documented arguments.
    @Test func syncCallsGoThroughTheReplyHandler() {
        let replying = #"""
        var syncCalls = [];
        window.webkit.messageHandlers.workstationSync = { postMessage: function (m) { syncCalls.push(JSON.parse(JSON.stringify(m))); return { then: function () {} }; } };
        """#
        let p = Page(Self.environment, Self.handler, replying, WebScripts.bootstrap)
        p.run(#"var s = window.__workstationShell.sync; s.status("p1"); s.pending("p1"); s.list("p1"); s.list("p1", "src"); s.decide("p1", [{ path: "src", kind: "folder", decision: "sync" }]); s.recheck("p1");"#)
        let calls = p.run("JSON.stringify(syncCalls)")?.toString() ?? ""
        let v = (try? JSONDecoder().decode([JSONValue].self, from: Data(calls.utf8))) ?? []
        #expect(v.map { $0["op"]?.stringValue ?? "" } == ["status", "pending", "list", "list", "decide", "recheck"])
        #expect(v[2]["dir"]?.stringValue == "" && v[3]["dir"]?.stringValue == "src")
        #expect(v[4]["decisions"]?[0]?["path"]?.stringValue == "src")
        #expect(p.exception == nil)
        // Without the reply handler (a plain browser or an older shell) there is no `sync`.
        let plain = Page(Self.environment, Self.handler, WebScripts.bootstrap)
        #expect(plain.run("typeof window.__workstationShell.sync")?.toString() == "undefined")
    }

    /// `notify` posts a clean message for a valid request and nothing otherwise.
    @Test func notifyChecksTheShape() {
        let p = Page(Self.environment, Self.handler, WebScripts.bootstrap)
        let sid = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e"
        #expect(p.run(#"window.__workstationShell.notify({ id: "done-1", title: "Done", body: "12 min", sessionId: "\#(sid)", icon: "x" })"#)?.toBool() == true)
        #expect(p.run(#"window.__workstationShell.notify({ id: "wait-1", title: "Waiting", body: "" })"#)?.toBool() == true)
        #expect(p.messages("notify") == [["type": "notify", "id": "done-1", "title": "Done", "body": "12 min", "sessionId": .string(sid)],
                                          ["type": "notify", "id": "wait-1", "title": "Waiting", "body": ""]])
        for b in [#"{ id: "", title: "t", body: "" }"#, #"{ id: "a", title: "", body: "" }"#, #"{ id: "a", title: "t" }"#,
                  #"{ id: "a", title: "t", body: "", sessionId: "nope" }"#, #"{ id: "a", title: new Array(122).join("t"), body: "" }"#,
                  #"{ id: "a", title: "t", body: new Array(302).join("b") }"#, #"{ id: new Array(202).join("i"), title: "t", body: "" }"#, "null"] {
            #expect(p.run("window.__workstationShell.notify(\(b))")?.toBool() == false, "\(b)")
        }
        #expect(p.messages("notify").count == 2)
        #expect(p.exception == nil)
    }

    /// A notification click opens the session through the web app's own function when it has one.
    @Test func openSessionUsesThePagesFunction() {
        let p = Page(Self.environment)
        #expect(p.run(WebScripts.openSession("abc"))?.toBool() == false, "no function → the shell navigates")
        p.run("var opened = []; window.__workstationOpenSession = function (id) { opened.push(id); };")
        #expect(p.run(WebScripts.openSession("7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e"))?.toBool() == true)
        #expect(p.run("opened.join(',')")?.toString() == "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e")
        #expect(p.run(WebScripts.openSession(#"x"); evil("#))?.toBool() == true, "the id is a JSON string, never code")
        #expect(p.run("opened[1]")?.toString() == #"x"); evil("#)
        #expect(p.exception == nil)
    }

    /// `reportAccepted` posts a clean `accepted` message for a well-formed report and nothing otherwise.
    @Test func reportAcceptedChecksTheShape() {
        let p = Page(Self.environment, Self.handler, WebScripts.bootstrap)
        let sha = String(repeating: "0f", count: 32)
        let pid = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e"
        let good = p.run(#"window.__workstationShell.reportAccepted({ projectId: "\#(pid)", localCommit: "c0ffee12", junk: 1, files: [{ path: "src/a.py", sha256: "\#(sha)", contentBase64: "aGk=" }, { path: "old.txt", sha256: null }] })"#)
        #expect(good?.toBool() == true)
        #expect(p.messages("accepted") == [["type": "accepted", "projectId": .string(pid), "localCommit": "c0ffee12",
                                            "files": [["path": "src/a.py", "sha256": .string(sha)], ["path": "old.txt", "sha256": nil]]]])
        let bad = [
            #"{ projectId: "p1", localCommit: "c0ffee12", files: [] }"#,
            #"{ projectId: "\#(pid)", localCommit: "zz", files: [] }"#,
            #"{ projectId: "\#(pid)", localCommit: "c0ffee12", files: "x" }"#,
            #"{ projectId: "\#(pid)", localCommit: "c0ffee12", files: [{ path: "../x", sha256: null }] }"#,
            #"{ projectId: "\#(pid)", localCommit: "c0ffee12", files: [{ path: "/x", sha256: null }] }"#,
            #"{ projectId: "\#(pid)", localCommit: "c0ffee12", files: [{ path: "a", sha256: "ABC" }] }"#,
            #"{ projectId: "\#(pid)", localCommit: "c0ffee12", files: [{ path: "a" }] }"#,
            #"{ projectId: "\#(pid)", localCommit: "c0ffee12", files: new Array(2001).fill({ path: "a", sha256: null }) }"#,
            "null",
        ]
        for b in bad { #expect(p.run("window.__workstationShell.reportAccepted(\(b))")?.toBool() == false, "\(b)") }
        #expect(p.messages("accepted").count == 1)
        #expect(p.exception == nil)
    }

    @Test func bootstrapIsIdempotentAndInertWithoutTheShell() {
        let twice = Page(Self.environment, Self.handler, WebScripts.bootstrap, WebScripts.bootstrap)
        twice.run(#"localStorage.setItem("workstation.user", "alice")"#)
        #expect(twice.messages("user").count == 2, "installed once")
        #expect(twice.messages("route").count == 1)

        // In a plain browser (no webkit handler) the script changes nothing.
        let browser = Page(Self.environment, WebScripts.bootstrap)
        #expect(browser.exception == nil)
        #expect(browser.run("typeof window.__workstationShell")?.toString() == "undefined")
        #expect(browser.run("Storage.prototype.setItem.toString().indexOf('reportUser') < 0")?.toBool() == true)
    }

    @Test func readUser() {
        let p = Page(Self.environment)
        #expect(p.run(WebScripts.readUser)?.toString() == "")
        p.run(#"localStorage.setItem("workstation.user", "alice")"#)
        #expect(p.run(WebScripts.readUser)?.toString() == "alice")
        p.run(#"Object.defineProperty(window, "localStorage", { get: function () { throw new Error("blocked"); } })"#)
        #expect(p.run(WebScripts.readUser)?.toString() == "", "blocked storage → signed out, no exception")
        #expect(p.exception == nil)
    }

    @Test func navigatePushesARouterEntry() {
        let p = Page(Self.environment, Self.handler, WebScripts.bootstrap)
        p.run(#"var pops = 0; window.addEventListener("popstate", function () { pops++; });"#)
        #expect(p.run(WebScripts.navigate("/usage"))?.toBool() == true)
        #expect(p.run("location.pathname")?.toString() == "/usage")
        #expect(p.run("history.state.idx")?.toInt32() == 1, "React Router's index advances")
        #expect(p.run("typeof history.state.key")?.toString() == "string")
        #expect(p.run("pops")?.toInt32() == 1, "the router hears a popstate")
        #expect(p.messages("route").last == ["type": "route", "path": "/usage"])
        #expect(p.run(WebScripts.navigate("/usage"))?.toBool() == true)
        #expect(p.run("pops")?.toInt32() == 1, "same route: nothing to do")
        #expect(p.run(WebScripts.navigate(#"/s/a"b"#))?.toBool() == true, "paths are JSON-escaped")
        #expect(p.run("location.pathname")?.toString() == #"/s/a"b"#)
        // No history API → full load.
        p.run("history.pushState = function () { throw new Error('nope'); }")
        #expect(p.run(WebScripts.navigate("/memory"))?.toBool() == false)
        #expect(p.run("assigned[0]")?.toString() == "/memory")
        #expect(p.exception == nil)
    }

    static let dom = #"""
    var dispatched = [];
    var pageHandler = null;
    function KeyboardEvent(type, init) { this.type = type; for (var k in init) this[k] = init[k]; this.defaultPrevented = false; }
    KeyboardEvent.prototype.preventDefault = function () { this.defaultPrevented = true; };
    var body = { dispatchEvent: function (e) { dispatched.push(e); if (pageHandler) pageHandler(e); return !e.defaultPrevented; } };
    var document = { activeElement: null, body: body, documentElement: body, fields: [],
                     querySelectorAll: function (sel) { this.lastSelector = sel; return this.fields; } };
    var timers = [];
    function setTimeout(f) { timers.push(f); return timers.length; }
    function field(w, h, disabled) {
      return { focused: false, selected: false, disabled: !!disabled,
               getBoundingClientRect: function () { return { width: w, height: h }; },
               focus: function () { this.focused = true; document.activeElement = this; }, select: function () { this.selected = true; } };
    }
    """#

    @Test func shortcutsUseThePagesHandlerFirst() {
        let p = Page(Self.environment, Self.dom)
        // Workbench mounted: its useHotkeys handler takes ⌘N.
        p.run(#"pageHandler = function (e) { if (e.metaKey && e.key === "n" && !e.shiftKey) e.preventDefault(); };"#)
        #expect(p.run(WebScripts.shortcut(ShellCommandMap.newSession))?.toString() == "handled")
        #expect(p.run("location.pathname")?.toString() == "/login", "no navigation when the page handled it")
        #expect(p.run("dispatched[0].metaKey && dispatched[0].code === 'KeyN' && dispatched[0].bubbles && dispatched[0].cancelable")?.toBool() == true)

        // Another page (/usage): nobody handles ⌘N → go to "/".
        p.run("pageHandler = null; setURL('/usage')")
        #expect(p.run(WebScripts.shortcut(ShellCommandMap.newSession))?.toString() == "fallback")
        #expect(p.run("location.pathname")?.toString() == "/")
        #expect(p.run("timers.length")?.toInt32() == 0, "⌘N does not retry")

        // ⌘K: go to the workbench, then open the palette once it is there.
        p.run("setURL('/memory')")
        #expect(p.run(WebScripts.shortcut(ShellCommandMap.commandPalette))?.toString() == "fallback")
        #expect(p.run("location.pathname")?.toString() == "/")
        #expect(p.run("timers.length")?.toInt32() == 1)
        p.run(#"pageHandler = function (e) { if (e.key === "k") { e.preventDefault(); window.paletteOpened = true; } }; timers[0]();"#)
        #expect(p.run("window.paletteOpened === true")?.toBool() == true)

        // ⌘⇧. (stop) has no fallback.
        p.run("pageHandler = null")
        #expect(p.run(WebScripts.shortcut(ShellCommandMap.stop))?.toString() == "unhandled")
        #expect(p.run("dispatched[dispatched.length - 1].shiftKey && dispatched[dispatched.length - 1].code === 'Period'")?.toBool() == true)
        #expect(p.exception == nil)
    }
}
