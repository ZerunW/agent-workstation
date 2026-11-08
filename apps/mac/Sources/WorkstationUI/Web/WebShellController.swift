import AppKit
import WorkstationCore
import SwiftUI
import WebKit

/// What `ShellModel` needs from the web view. `WebShellController` implements it with WebKit;
/// tests use a fake that records loads and scripts and answers evaluations.
@MainActor
public protocol WebPage: AnyObject {
    var currentURL: URL? { get }
    var pageZoom: Double { get set }
    func load(_ url: URL)
    /// Evaluates `js` in the main frame; nil on error or a `null` / `undefined` result.
    func evaluate(_ js: String) async -> Any?
    func reload()
    func goBack()
    func goForward()
    /// The window the page is shown in (sheets attach to it).
    var hostWindow: NSWindow? { get }
}

public extension WebPage {
    var hostWindow: NSWindow? { nil }
}

/// Events from the web view back to the shell.
@MainActor
public protocol WebPageDelegate: AnyObject {
    func webPage(didReceive message: JSONValue)
    func webPageDidFinishLoad()
    func webPage(didFailLoad message: String)
    func webPage(stateChanged title: String, canGoBack: Bool, canGoForward: Bool)
    func webPage(downloadFinished url: URL)
    func webPage(downloadFailed name: String, error: String)
    func webPage(open url: URL)
    /// Folders dropped on the web view (taken by the shell; the page never sees them).
    func webPage(droppedFolders: [URL])
    /// `window.__workstationShell.sync.*` from the web Sync tab (answered as the promise's value).
    func webPage(syncRequest: JSONValue) async -> Result<JSONValue, SyncBridgeError>
}

public extension WebPageDelegate {
    func webPage(droppedFolders: [URL]) {}
    func webPage(syncRequest: JSONValue) async -> Result<JSONValue, SyncBridgeError> { .failure(.notLinked) }
}

/// The main window's WKWebView: the hub's full web app, a persistent website data store (the
/// web login's `localStorage["workstation.user"]` survives relaunches), the observer script
/// (`WebScripts.bootstrap`), link policy, downloads to ~/Downloads, file pickers and JS dialogs.
/// Drags carrying a folder are taken natively (`FolderDropWebView`); plain files reach the page.
@MainActor
public final class WebShellController: NSObject, WebPage, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    public weak var delegate: WebPageDelegate?
    /// The hub origin (read on every navigation, so a changed hub address applies at once);
    /// links elsewhere open in the default browser.
    public var hubURLProvider: @MainActor () -> URL? = { nil }
    var hubURL: URL? { hubURLProvider() }
    public private(set) lazy var webView: WKWebView = makeWebView()

    /// Every script-message handler the page can post to. `workstationShell` reports identity, route
    /// and titlebar colours, asks for the native folder picker and reports accepts (see
    /// `ShellMessage`); `workstationSync` answers the Sync tab (`SyncBridgeRequest`: decisions about
    /// what goes to the server: never a write on this Mac).
    public static let messageHandlerNames = [WebScripts.handlerName]
    public static let replyHandlerNames = [SyncBridgeRequest.handlerName]
    /// Every user script injected into the page.
    public static let userScriptSources = [WebScripts.bootstrap]

    private var observations: [NSKeyValueObservation] = []
    private var downloadNames: [ObjectIdentifier: String] = [:]
    private var crashReloads = 0

    private let persistent: Bool

    /// - Parameter persistent: false only for tests (a throw-away website data store).
    public init(persistent: Bool = true) {
        self.persistent = persistent
        super.init()
    }

    private func makeWebView() -> WKWebView {
        let cfg = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        for name in Self.messageHandlerNames { ucc.add(WeakMessageHandler(self), name: name) }
        for name in Self.replyHandlerNames { ucc.addScriptMessageHandler(WeakReplyHandler(self), contentWorld: .page, name: name) }
        for source in Self.userScriptSources {
            ucc.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        cfg.userContentController = ucc
        // Persistent store: cookies and localStorage (the web login) survive relaunches.
        cfg.websiteDataStore = persistent ? .default() : .nonPersistent()
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        // Feature-detectable by the web app (`navigator.userAgent.includes("WorkstationMac/")`); Safari token kept for UA sniffers.
        cfg.applicationNameForUserAgent = "Version/18.0 Safari/605.1.15 WorkstationMac/\(version)"
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        let wv = FolderDropWebView(frame: .zero, configuration: cfg)
        wv.onFolderDrop = { [weak self] folders in self?.delegate?.webPage(droppedFolders: folders) }
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = true
        wv.allowsMagnification = false
        if #available(macOS 13.3, *) { wv.isInspectable = true }
        wv.setValue(false, forKey: "drawsBackground")
        let report: (WKWebView) -> Void = { [weak self] v in
            let title = v.title ?? ""
            let back = v.canGoBack, fwd = v.canGoForward
            Task { @MainActor in self?.delegate?.webPage(stateChanged: title, canGoBack: back, canGoForward: fwd) }
        }
        observations = [
            wv.observe(\.title, options: [.new]) { v, _ in report(v) },
            wv.observe(\.canGoBack, options: [.new]) { v, _ in report(v) },
            wv.observe(\.canGoForward, options: [.new]) { v, _ in report(v) },
            wv.observe(\.effectiveAppearance, options: [.new]) { v, _ in
                Task { @MainActor in _ = try? await v.evaluateJavaScript(WebScripts.refreshChrome) }
            },
        ]
        return wv
    }

    // MARK: WebPage

    public var currentURL: URL? { webView.url }
    public var hostWindow: NSWindow? { webView.window }

    public var pageZoom: Double {
        get { Double(webView.pageZoom) }
        set { webView.pageZoom = CGFloat(newValue) }
    }

    public func load(_ url: URL) {
        crashReloads = 0
        webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 20))
    }

    public func evaluate(_ js: String) async -> Any? {
        await withCheckedContinuation { cont in
            webView.evaluateJavaScript(js) { result, _ in cont.resume(returning: result) }
        }
    }

    public func reload() { webView.reload() }
    public func goBack() { webView.goBack() }
    public func goForward() { webView.goForward() }

    // MARK: Messages

    fileprivate func received(_ body: Any) {
        delegate?.webPage(didReceive: JSONValue.from(any: body))
    }

    fileprivate func syncRequest(_ body: Any) async -> (Any?, String?) {
        guard let delegate else { return (nil, "unavailable") }
        switch await delegate.webPage(syncRequest: JSONValue.from(any: body)) {
        case .success(let v): return (v.foundationValue, nil)
        case .failure(let e): return (nil, e.localizedDescription)
        }
    }

    // MARK: WKNavigationDelegate

    public func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let hub = hubURL else { decisionHandler(.allow); return }
        let decision = NavigationPolicy.decide(url: action.request.url, hub: hub,
                                               isMainFrame: action.targetFrame?.isMainFrame ?? true,
                                               opensNewWindow: action.targetFrame == nil,
                                               shouldDownload: action.shouldPerformDownload)
        switch decision {
        case .allow: decisionHandler(.allow)
        case .download: decisionHandler(.download)
        case .cancel: decisionHandler(.cancel)
        case .openExternally(let url):
            delegate?.webPage(open: url)
            decisionHandler(.cancel)
        case .loadInMainFrame(let url):
            decisionHandler(.cancel)
            webView.load(URLRequest(url: url))
        }
    }

    public func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                        decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        let http = response.response as? HTTPURLResponse
        let disposition = http?.value(forHTTPHeaderField: "Content-Disposition")
        if NavigationPolicy.shouldDownload(response: response.response.mimeType, canShowMIMEType: response.canShowMIMEType,
                                           contentDisposition: disposition) {
            decisionHandler(.download)
            return
        }
        if response.isForMainFrame, let http, http.statusCode >= 500 {
            decisionHandler(.cancel)
            delegate?.webPage(didFailLoad: "The hub answered HTTP \(http.statusCode).")
            return
        }
        decisionHandler(.allow)
    }

    public func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    public func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        crashReloads = 0
        delegate?.webPageDidFinishLoad()
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }

    private func fail(_ error: Error) {
        let ns = error as NSError
        // Cancelled by us (policy, a newer load) or turned into a download.
        if ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && (ns.code == 102 || ns.code == 101) { return }
        delegate?.webPage(didFailLoad: error.localizedDescription)
    }

    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The page crashed (memory pressure, WebKit bug): reload once, then show the offline state.
        if crashReloads < 1 {
            crashReloads += 1
            webView.reload()
        } else {
            delegate?.webPage(didFailLoad: "The page stopped responding.")
        }
    }

    // MARK: WKUIDelegate

    /// `window.open` / `target=_blank`: inside the hub origin → this window; elsewhere → default browser.
    public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url, let hub = hubURL else { return nil }
        switch NavigationPolicy.decide(url: url, hub: hub, isMainFrame: true, opensNewWindow: true, shouldDownload: false) {
        case .loadInMainFrame(let u): webView.load(URLRequest(url: u))
        case .openExternally(let u): delegate?.webPage(open: u)
        default: break
        }
        return nil
    }

    /// `<input type="file">` (the composer's attach button).
    public func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                        completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        if let window = webView.window {
            panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
        } else {
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
        }
    }

    public func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                        completionHandler: @escaping @MainActor () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    public func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                        completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    public func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    // MARK: WKDownloadDelegate

    public func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                         completionHandler: @escaping @MainActor (URL?) -> Void) {
        let dir = DownloadPlanner.downloadsDirectory
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = DownloadPlanner.destination(suggested: suggestedFilename, in: dir)
        downloadNames[ObjectIdentifier(download)] = dest.path
        completionHandler(dest)
    }

    public func downloadDidFinish(_ download: WKDownload) {
        guard let path = downloadNames.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let url = URL(fileURLWithPath: path)
        // Bounces the Downloads stack in the Dock, like Safari.
        DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: path)
        delegate?.webPage(downloadFinished: url)
    }

    public func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let path = downloadNames.removeValue(forKey: ObjectIdentifier(download))
        delegate?.webPage(downloadFailed: path.map { ($0 as NSString).lastPathComponent } ?? "download", error: error.localizedDescription)
    }
}

/// The main window's web view. A drag that carries at least one folder belongs to the shell: it is
/// never forwarded to WebKit, so the page sees no dragenter / dragover / drop for it, and the
/// folders (only the folders, in a mixed drag) go to `onFolderDrop`. Drags of plain files —
/// packages such as `.app` included: and anything else go to WebKit unchanged (web upload).
final class FolderDropWebView: WKWebView {
    var onFolderDrop: (([URL]) -> Void)?
    /// The drag in progress is the shell's (decided once per drag, on entry).
    private var ownsDrag = false

    static func folders(on pasteboard: NSPasteboard) -> [URL] {
        let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        return FolderDrop.folders(in: urls)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        ownsDrag = !Self.folders(on: sender.draggingPasteboard).isEmpty
        return ownsDrag ? .copy : super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        ownsDrag ? .copy : super.draggingUpdated(sender)
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        if ownsDrag { ownsDrag = false; return }
        super.draggingExited(sender)
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        ownsDrag ? true : super.prepareForDragOperation(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard ownsDrag else { return super.performDragOperation(sender) }
        let folders = Self.folders(on: sender.draggingPasteboard)
        guard !folders.isEmpty else { return false }
        onFolderDrop?(folders)
        return true
    }

    override func concludeDragOperation(_ sender: NSDraggingInfo?) {
        if ownsDrag { return }
        super.concludeDragOperation(sender)
    }

    override func draggingEnded(_ sender: NSDraggingInfo) {
        if ownsDrag { ownsDrag = false; return }
        super.draggingEnded(sender)
    }
}

/// Breaks the WKUserContentController → handler retain cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WebShellController?
    init(_ target: WebShellController) { self.target = target }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the main frame of the hub origin may talk to the shell.
        guard message.frameInfo.isMainFrame else { return }
        let body = message.body
        MainActor.assumeIsolated { target?.received(body) }
    }
}

/// The Sync tab's calls (promise replies). Main frame only, like the other handler.
private final class WeakReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: WebShellController?
    init(_ target: WebShellController) { self.target = target }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame else { replyHandler(nil, "not allowed"); return }
        let body = message.body
        MainActor.assumeIsolated {
            guard let target else { replyHandler(nil, "unavailable"); return }
            Task { @MainActor in
                let (value, error) = await target.syncRequest(body)
                replyHandler(value, error)
            }
        }
    }
}

/// SwiftUI wrapper; the controller (and its web view) outlives view updates and window closes.
public struct ShellWebView: NSViewRepresentable {
    let controller: WebShellController

    public init(controller: WebShellController) { self.controller = controller }

    public func makeNSView(context: Context) -> WKWebView { controller.webView }
    public func updateNSView(_ nsView: WKWebView, context: Context) {}
}
