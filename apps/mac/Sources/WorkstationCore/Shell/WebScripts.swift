import Foundation

/// JavaScript the shell runs in the hub's web app. The web app knows nothing about the shell:
/// everything here only *observes* it (localStorage, history, computed colours) or uses what any
/// browser user can do (keyboard shortcuts, links, focus). Messages go to the `workstationShell`
/// script-message handler and are parsed by `ShellMessage`.
///
/// Nothing the page can post reaches folder sync: there is no message, script function or URL
/// scheme that can queue, approve or execute a change to a linked folder. Approvals are clicks
/// in native windows only; server changes are learned from the hub over the native connection.
/// The page may only ask for the folder picker (`pickFolder()`); it cannot pass a path, and a
/// folder is linked only after the person picks it in the native panel. `reportAccepted()` says
/// which files the person just accepted in this window's Changes tab; it writes nothing itself: it
/// only lets matching server changes (same path, same content hash, within 5 minutes) be applied
/// without the native "Apply to Mac" sheet.
public enum WebScripts {
    public static let handlerName = "workstationShell"
    /// `STORAGE_KEYS.user` in `packages/web/src/lib/storage.ts`.
    public static let userStorageKey = "workstation.user"

    /// Injected at document start in the main frame. Posts:
    /// * `{type:"user", user}`: `localStorage["workstation.user"]` now and whenever it changes (login page, "switch user", logout);
    /// * `{type:"route", path}`: SPA navigations (pushState / replaceState / back-forward);
    /// * `{type:"chrome", overlay, sidebarWidth, sidebar, main, divider}`: the colours painted along the
    ///   page's top edge, so the native titlebar strip continues the page (sRGB `[r, g, b, a]`);
    /// * `{type:"pick_folder"}`: `window.__workstationShell.pickFolder()` (the composer's folder button):
    ///   the shell opens a native folder picker. Nothing else is sent; the page never names a path;
    /// * `{type:"accepted", projectId, localCommit, files:[{path, sha256|null}]}` —
    ///   `window.__workstationShell.reportAccepted(r)` after a successful accept in the Changes tab (shape
    ///   checked here and again in `ShellMessage`; anything malformed is dropped);
    /// * `{type:"notify", id, title, body, sessionId?}`: `window.__workstationShell.notify(n)`: the web app
    ///   decided a system notification is due (a long session finished, an answer is awaited).
    public static let bootstrap = #"""
    (function () {
      "use strict";
      var handlers = window.webkit && window.webkit.messageHandlers;
      var handler = handlers && handlers.workstationShell;
      if (!handler || window.__workstationShell) return;
      function post(msg) { try { handler.postMessage(msg); } catch (e) {} }
      var shell = { version: 1 };
      window.__workstationShell = shell;

      // 0. Folder button: the shell opens a native folder picker (the page never passes a path).
      shell.pickFolder = function () { post({ type: "pick_folder" }); };

      // 0b. Accepted in the Changes tab: which files, with which content (the shell re-checks everything).
      var UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      var HEX_RE = /^[0-9a-f]{4,64}$/, SHA_RE = /^[0-9a-f]{64}$/;
      function goodPath(p) {
        if (typeof p !== "string" || !p || p.length > 4096 || p.charAt(0) === "/" || p.indexOf("\0") >= 0 || p.indexOf("\\") >= 0) return false;
        var parts = p.split("/");
        for (var i = 0; i < parts.length; i++) if (parts[i] === "" || parts[i] === "." || parts[i] === "..") return false;
        return true;
      }
      // 0c. System notifications the web app asks for (it decides when; the shell displays).
      shell.notify = function (n) {
        try {
          if (!n || typeof n.id !== "string" || !n.id || n.id.length > 200) return false;
          if (typeof n.title !== "string" || !n.title || n.title.length > 120) return false;
          if (typeof n.body !== "string" || n.body.length > 300) return false;
          var sid = n.sessionId;
          if (sid !== undefined && sid !== null && (typeof sid !== "string" || !UUID_RE.test(sid))) return false;
          var msg = { type: "notify", id: n.id, title: n.title, body: n.body };
          if (typeof sid === "string") msg.sessionId = sid;
          post(msg);
          return true;
        } catch (e) { return false; }
      };

      // 0d. The web Sync tab (projects linked on this Mac): promise-returning calls answered natively.
      var syncHandler = handlers.workstationSync;
      if (syncHandler) {
        var call = function (op, args) {
          try { args.op = op; return syncHandler.postMessage(args); } catch (e) { return Promise.reject(e); }
        };
        shell.sync = {
          status: function (id) { return call("status", { projectId: id }); },
          pending: function (id) { return call("pending", { projectId: id }); },
          list: function (id, dir) { return call("list", { projectId: id, dir: dir || "" }); },
          decide: function (id, decisions) { return call("decide", { projectId: id, decisions: decisions }); },
          recheck: function (id, dir) { return call("recheck", { projectId: id, dir: dir || "" }); }
        };
      }

      shell.reportAccepted = function (r) {
        try {
          if (!r || typeof r.projectId !== "string" || !UUID_RE.test(r.projectId)) return false;
          if (typeof r.localCommit !== "string" || !HEX_RE.test(r.localCommit)) return false;
          if (!Array.isArray(r.files) || r.files.length > 2000) return false;
          var files = [];
          for (var i = 0; i < r.files.length; i++) {
            var f = r.files[i];
            if (!f || !goodPath(f.path)) return false;
            if (f.sha256 !== null && (typeof f.sha256 !== "string" || !SHA_RE.test(f.sha256))) return false;
            files.push({ path: f.path, sha256: f.sha256 });
          }
          post({ type: "accepted", projectId: r.projectId, localCommit: r.localCommit, files: files });
          return true;
        } catch (e) { return false; }
      };

      // 1. Identity: the web app keeps the username in localStorage["workstation.user"].
      var USER_KEY = "workstation.user";
      var lastUser;
      function readUser() {
        try {
          return window.localStorage.getItem(USER_KEY);
        } catch (e) { return null; }
      }
      function reportUser() {
        var u = readUser();
        if (u !== lastUser) { lastUser = u; post({ type: "user", user: u }); }
      }
      shell.reportUser = reportUser;
      try {
        var proto = window.Storage && window.Storage.prototype;
        if (proto) {
          ["setItem", "removeItem", "clear"].forEach(function (name) {
            var original = proto[name];
            if (typeof original !== "function") return;
            proto[name] = function () {
              var result = original.apply(this, arguments);
              try {
                if (this === window.localStorage && (name === "clear" || arguments[0] === USER_KEY)) reportUser();
              } catch (e) {}
              return result;
            };
          });
        }
      } catch (e) {}
      try { window.addEventListener("storage", function (e) { if (!e.key || e.key === USER_KEY) reportUser(); }); } catch (e) {}
      reportUser();

      // 2. Route: SPA navigations.
      var lastRoute;
      function reportRoute() {
        var r = location.pathname + location.search;
        if (r !== lastRoute) { lastRoute = r; post({ type: "route", path: r }); }
      }
      ["pushState", "replaceState"].forEach(function (name) {
        var original = history[name];
        if (typeof original !== "function") return;
        history[name] = function () {
          var result = original.apply(this, arguments);
          try { reportRoute(); } catch (e) {}
          return result;
        };
      });
      try {
        window.addEventListener("popstate", reportRoute);
        window.addEventListener("hashchange", reportRoute);
      } catch (e) {}
      reportRoute();

      // 3. Titlebar strip: the colours the page paints along its top edge.
      if (typeof document === "undefined" || !document.addEventListener) return;
      var ctx = null;
      function rgba(color) {
        if (!color) return null;
        try {
          if (!ctx) {
            var canvas = document.createElement("canvas");
            canvas.width = 1; canvas.height = 1;
            ctx = canvas.getContext("2d", { willReadFrequently: true });
          }
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = "rgba(0, 0, 0, 0)";
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          var d = ctx.getImageData(0, 0, 1, 1).data;
          return [d[0], d[1], d[2], Math.round((d[3] / 255) * 1000) / 1000];
        } catch (e) { return null; }
      }
      function paintAt(x, y) {
        var el = document.elementFromPoint(x, y);
        while (el && el.nodeType === 1) {
          var c = rgba(getComputedStyle(el).backgroundColor);
          if (c && c[3] > 0.5) return c;
          el = el.parentElement;
        }
        return rgba(getComputedStyle(document.body || document.documentElement).backgroundColor);
      }
      var timer = null, last = "";
      function reportChrome() {
        timer = null;
        try {
          var w = window.innerWidth;
          var aside = null, asides = document.querySelectorAll("aside");
          for (var i = 0; i < asides.length; i++) {
            var r = asides[i].getBoundingClientRect();
            if (r.left <= 1 && r.top <= 1 && r.width > 0 && r.width < w) { aside = { el: asides[i], rect: r }; break; }
          }
          var divider = null;
          if (aside) {
            var cs = getComputedStyle(aside.el);
            if (parseFloat(cs.borderRightWidth) > 0) divider = rgba(cs.borderRightColor);
          }
          var msg = {
            type: "chrome",
            overlay: !!document.querySelector('meta[name="workstation-shell-titlebar"][content="overlay"]'),
            sidebarWidth: aside ? Math.round(aside.rect.right) : 0,
            sidebar: aside ? paintAt(Math.max(1, Math.min(8, aside.rect.right / 2)), 1) : null,
            main: paintAt(Math.max(1, w - 8), 1),
            divider: divider
          };
          var key = JSON.stringify(msg);
          if (key !== last) { last = key; post(msg); }
        } catch (e) {}
      }
      function schedule() { if (timer === null) timer = setTimeout(reportChrome, 150); }
      shell.refresh = function () { last = ""; schedule(); };
      function observe() {
        schedule();
        try {
          var mo = new MutationObserver(schedule);
          mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
          if (document.body) mo.observe(document.body, { childList: true, subtree: true });
        } catch (e) {}
        window.addEventListener("resize", schedule);
        try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", schedule); } catch (e) {}
      }
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observe); else observe();
    })();
    """#

    /// Reads the signed-in user. Always evaluates to a string ("" = nobody signed in), because
    /// `evaluateJavaScript` cannot return `null` reliably.
    public static let readUser = #"(function(){try{var u=window.localStorage.getItem("workstation.user");return u===null?"":String(u)}catch(e){return ""}})()"#

    /// Opens a session in place through the web app's `window.__workstationOpenSession(id)`. Evaluates to
    /// `true` when the page has that function (else the shell navigates to `/s/<id>`).
    public static func openSession(_ id: String) -> String {
        #"(function(id){try{if(typeof window.__workstationOpenSession==="function"){window.__workstationOpenSession(id);return true}}catch(e){}return false})("# + JSONValue.string(id).jsonString() + ")"
    }

    /// Tells the page that sync selection changed for a project (pending items or decisions).
    public static func syncChanged(_ projectId: String) -> String {
        #"(function(id){try{if(typeof window.__workstationSyncChanged==="function"){window.__workstationSyncChanged(id);return true}}catch(e){}return false})("# + JSONValue.string(projectId).jsonString() + ")"
    }

    /// Re-posts the titlebar colours (appearance changed natively).
    public static let refreshChrome = "window.__workstationShell && window.__workstationShell.refresh && window.__workstationShell.refresh(); true"

    /// Client-side navigation to `path` (React Router's BrowserRouter follows `popstate`), falling
    /// back to a full load. Evaluates to `true` when handled in place.
    public static func navigate(_ path: String) -> String {
        "(\(navigateFunction))(\(JSONValue.string(path).jsonString()))"
    }

    static let navigateFunction = #"""
    function (path) {
      try {
        if (location.pathname + location.search === path) return true;
        var st = history.state;
        var idx = st && typeof st.idx === "number" ? st.idx + 1 : 0;
        history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx: idx }, "", path);
        window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
        return true;
      } catch (e) {
        location.assign(path);
        return false;
      }
    }
    """#

    /// Synthesises ⌘<key> on the focused element. Evaluates to "handled", "fallback" or "unhandled".
    public static func shortcut(_ s: WebShortcut) -> String {
        var o: [String: JSONValue] = ["key": .string(s.key), "code": .string(s.code), "shift": .bool(s.shift),
                                      "retry": .bool(s.retryAfterFallback)]
        if let f = s.fallback { o["fallback"] = .string(f) }
        return #"""
        (function (o, navigate) {
          function fire() {
            var target = document.activeElement || document.body || document.documentElement;
            var ev = new KeyboardEvent("keydown", { key: o.key, code: o.code, metaKey: true, shiftKey: !!o.shift,
              bubbles: true, cancelable: true, composed: true });
            return !target.dispatchEvent(ev);
          }
          if (fire()) return "handled";
          if (!o.fallback) return "unhandled";
          navigate(o.fallback);
          if (o.retry) setTimeout(fire, 400);
          return "fallback";
        })(\#(JSONValue.object(o).jsonString()), \#(navigateFunction))
        """#
    }
}

/// sRGB colour reported by the page (0–255 channels, alpha 0–1).
public struct RGBA: Equatable, Sendable {
    public var r: Double, g: Double, b: Double, a: Double
    public init(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) { self.r = r; self.g = g; self.b = b; self.a = a }

    init?(_ v: JSONValue?) {
        guard let a = v?.arrayValue, a.count >= 3, let r = a[0].doubleValue, let g = a[1].doubleValue, let b = a[2].doubleValue else { return nil }
        let alpha = a.count > 3 ? (a[3].doubleValue ?? 1) : 1
        func c(_ x: Double) -> Double { min(255, max(0, x)) }
        self.init(c(r), c(g), c(b), min(1, max(0, alpha)))
    }

    /// Relative luminance-ish brightness (0–1) to pick light/dark contrast.
    public var isDark: Bool { (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5 }
}

/// What the native titlebar strip paints: the page's sidebar colour up to `sidebarWidth`, a
/// divider, and the main colour after it. `overlay` = the page reserves the titlebar itself
/// (`<meta name="workstation-shell-titlebar" content="overlay">`), so the web view fills the window.
public struct TitlebarChrome: Equatable, Sendable {
    public var overlay: Bool
    public var sidebarWidth: Double
    public var sidebar: RGBA?
    public var main: RGBA?
    public var divider: RGBA?

    public init(overlay: Bool = false, sidebarWidth: Double = 0, sidebar: RGBA? = nil, main: RGBA? = nil, divider: RGBA? = nil) {
        self.overlay = overlay; self.sidebarWidth = sidebarWidth; self.sidebar = sidebar; self.main = main; self.divider = divider
    }

    /// Before the page reports anything: the window background shows through.
    public static let unknown = TitlebarChrome()
}

/// Messages posted by `WebScripts.bootstrap`.
public enum ShellMessage: Equatable, Sendable {
    case user(String?)
    case route(String)
    case chrome(TitlebarChrome)
    /// Open the native folder picker. Carries nothing: any other field the page adds is ignored.
    case pickFolder
    /// Files the person accepted in this window's Changes tab (validated).
    case accepted(AcceptedReport)
    /// A system notification the web app asks for (validated).
    case notify(WebNotification)
    case unknown(String)

    public static func parse(_ v: JSONValue) -> ShellMessage {
        let type = v["type"]?.stringValue ?? ""
        switch type {
        case "user":
            return .user(UserIdentity.normalize(v["user"]?.stringValue))
        case "route":
            guard let p = v["path"]?.stringValue, p.hasPrefix("/") else { return .unknown(type) }
            return .route(p)
        case "chrome":
            return .chrome(TitlebarChrome(overlay: v["overlay"]?.boolValue ?? false,
                                          sidebarWidth: max(0, v["sidebarWidth"]?.doubleValue ?? 0),
                                          sidebar: RGBA(v["sidebar"]), main: RGBA(v["main"]), divider: RGBA(v["divider"])))
        case "pick_folder":
            return .pickFolder
        case "accepted":
            return AcceptedReport(v).map(ShellMessage.accepted) ?? .unknown(type)
        case "notify":
            return WebNotification(v).map(ShellMessage.notify) ?? .unknown(type)
        default:
            return .unknown(type)
        }
    }
}

/// The username the web app signed in with.
public enum UserIdentity {
    /// Anything `evaluateJavaScript` or a script message may return → a valid username or nil.
    public static func normalize(_ raw: Any?) -> String? {
        guard let s = raw as? String else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return AppSettings.isValidUsername(t) ? t : nil
    }
}

/// `{type:"accepted"}` from the page: what the person accepted in the Changes tab of this window.
/// Validated strictly; one bad field drops the whole report.
public struct AcceptedReport: Equatable, Sendable {
    public struct File: Equatable, Sendable, Hashable {
        public var path: String
        /// Hex SHA-256 of the accepted content; nil = deleted.
        public var sha256: String?
        public init(path: String, sha256: String?) { self.path = path; self.sha256 = sha256 }
    }

    public static let maxFiles = 2000

    /// Lowercased UUID.
    public var projectId: String
    public var localCommit: String
    public var files: [File]

    public init(projectId: String, localCommit: String, files: [File]) {
        self.projectId = projectId.lowercased(); self.localCommit = localCommit; self.files = files
    }

    init?(_ v: JSONValue) {
        guard let pid = v["projectId"]?.stringValue, pid.count == 36, UUID(uuidString: pid) != nil,
              let commit = v["localCommit"]?.stringValue, (4...64).contains(commit.count), commit.allSatisfy(Self.isLowerHex),
              let list = v["files"]?.arrayValue, list.count <= Self.maxFiles else { return nil }
        var files: [File] = []
        for f in list {
            guard let path = f["path"]?.stringValue, Self.isSafeRelativePath(path) else { return nil }
            let sha: String?
            switch f["sha256"] {
            case .null?: sha = nil
            case .string(let s)?: guard s.count == 64, s.allSatisfy(Self.isLowerHex) else { return nil }; sha = s
            default: return nil
            }
            files.append(File(path: path, sha256: sha))
        }
        self.init(projectId: pid, localCommit: commit, files: files)
    }

    static func isLowerHex(_ c: Character) -> Bool { ("0"..."9").contains(c) || ("a"..."f").contains(c) }

    /// Project-relative: not empty, no leading "/", no "", "." or ".." segment, no backslash or NUL.
    public static func isSafeRelativePath(_ p: String) -> Bool {
        guard !p.isEmpty, p.utf8.count <= 4096, !p.hasPrefix("/"), !p.contains("\\"), !p.contains("\0") else { return false }
        return !p.split(separator: "/", omittingEmptySubsequences: false).contains { $0.isEmpty || $0 == "." || $0 == ".." }
    }
}

/// `{type:"notify"}` from the page. Lengths are UTF-16 units, as JavaScript counts them.
public struct WebNotification: Equatable, Sendable {
    public static let maxID = 200, maxTitle = 120, maxBody = 300

    public var id: String
    public var title: String
    public var body: String
    /// Lowercased UUID of the session a click opens; nil = none.
    public var sessionId: String?

    public init(id: String, title: String, body: String, sessionId: String? = nil) {
        self.id = id; self.title = title; self.body = body; self.sessionId = sessionId?.lowercased()
    }

    init?(_ v: JSONValue) {
        guard let id = v["id"]?.stringValue, (1...Self.maxID).contains(id.utf16.count),
              let title = v["title"]?.stringValue, (1...Self.maxTitle).contains(title.utf16.count),
              let body = v["body"]?.stringValue, body.utf16.count <= Self.maxBody else { return nil }
        var sid: String?
        switch v["sessionId"] {
        case nil, .null?: sid = nil
        case .string(let s)?: guard s.count == 36, UUID(uuidString: s) != nil else { return nil }; sid = s
        default: return nil
        }
        self.init(id: id, title: title, body: body, sessionId: sid)
    }

    /// The system notification identifier: a repeat of `id` replaces the earlier one; the prefix
    /// keeps page ids apart from the shell's own (`perm-…`, `done-…`).
    public var identifier: String { "web." + id }
}
