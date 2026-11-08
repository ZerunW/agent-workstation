import AppKit
import Foundation
import WorkstationCore

/// The alerts of Check for Updates. Tests record them.
@MainActor
public protocol UpdateAlerting: AnyObject {
    /// `Agent Workstation <version> is available`: true = Download, false = Later.
    func offer(_ release: AppRelease) async -> Bool
    func upToDate() async
    func failed(_ line: String) async
}

/// App-modal NSAlerts.
@MainActor
public final class SystemUpdateAlerts: UpdateAlerting {
    nonisolated public init() {}

    public func offer(_ release: AppRelease) async -> Bool {
        let a = NSAlert()
        a.messageText = "Agent Workstation \(release.version) is available"
        a.addButton(withTitle: "Download")
        a.addButton(withTitle: "Later")
        NSApp.activate()
        return a.runModal() == .alertFirstButtonReturn
    }

    public func upToDate() async {
        let a = NSAlert()
        a.messageText = "Agent Workstation is up to date"
        a.addButton(withTitle: "OK")
        a.runModal()
    }

    public func failed(_ line: String) async {
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = line
        a.addButton(withTitle: "OK")
        a.runModal()
    }
}

/// A dmg on its way to ~/Downloads.
public struct UpdateDownloadState: Equatable {
    public var version: String
    public var fraction: Double
}

/// Check for Updates: on the first connection after launch, every `interval` while running, and
/// from the app menu. A release is offered only when its Ed25519 signature checks out against the
/// public key built into the app and its build is newer than the running one. Download streams the
/// dmg to a temp file, checks size and SHA-256 against the signed release, saves it as
/// `~/Downloads/Agent Workstation-<version>-<build>.dmg` and reveals it in Finder. Nothing is opened, mounted
/// or installed.
@MainActor
public final class UpdateModel: ObservableObject {
    public struct Config {
        public var settings: AppSettings
        public var urlSession: URLSession?
        public var hubURL: @MainActor () -> URL?
        public var currentBuild: String?
        /// This build's update channel (`WorkstationPlatform`, `mac` when missing).
        public var platform: String
        public var publicKey: Data?
        public var downloadsDirectory: URL
        public var reveal: (URL) -> Void
        public var alerts: UpdateAlerting
        /// Seconds between automatic checks (0 = only at launch).
        public var interval: TimeInterval

        public init(settings: AppSettings, urlSession: URLSession? = nil, hubURL: @escaping @MainActor () -> URL?,
                    currentBuild: String? = AppBuild.running, platform: String = AppPlatform.running,
                    publicKey: Data? = ReleaseSignature.bundledPublicKey,
                    downloadsDirectory: URL = DownloadPlanner.downloadsDirectory, reveal: @escaping (URL) -> Void,
                    alerts: UpdateAlerting, interval: TimeInterval = 24 * 3600) {
            self.settings = settings; self.urlSession = urlSession; self.hubURL = hubURL; self.currentBuild = currentBuild
            self.platform = platform; self.publicKey = publicKey; self.downloadsDirectory = downloadsDirectory; self.reveal = reveal
            self.alerts = alerts; self.interval = interval
        }
    }

    public let config: Config
    @Published public private(set) var download: UpdateDownloadState?
    /// A check or its alert is in progress (automatic checks skip meanwhile).
    public private(set) var busy = false
    private var launchChecked = false
    private var timer: Timer?

    public init(config: Config) { self.config = config }

    /// The hub answered: the launch check (once), then the periodic timer.
    public func hubConnected() {
        guard !launchChecked else { return }
        launchChecked = true
        Task { await check(manual: false) }
        guard config.interval > 0 else { return }
        timer = Timer.scheduledTimer(withTimeInterval: config.interval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.check(manual: false) }
        }
    }

    /// App menu → Check for Updates….
    public func checkManually() { Task { await check(manual: true) } }

    public func check(manual: Bool) async {
        guard !busy, download == nil else { return }
        guard let base = config.hubURL() else {
            if manual { await config.alerts.failed("No hub address.") }
            return
        }
        busy = true
        defer { busy = false }
        var release: AppRelease?
        var failure: String?
        do { release = try await HubClient(baseURL: base, user: nil, session: config.urlSession).latestAppRelease(platform: config.platform) } catch {
            failure = Self.oneLine(error)
        }
        let prompt = UpdatePolicy.prompt(release: release, error: failure, currentBuild: config.currentBuild, publicKey: config.publicKey,
                                         skippedBuild: config.settings.skippedUpdateBuild, manual: manual, platform: config.platform)
        switch prompt {
        case .available(let r)?:
            if await config.alerts.offer(r) {
                busy = false
                await downloadRelease(r)
            } else {
                config.settings.skippedUpdateBuild = r.build
            }
        case .upToDate?:
            await config.alerts.upToDate()
        case .failed(let line)?:
            await config.alerts.failed(line)
        case nil:
            break
        }
    }

    /// Download → verify against the signed release → ~/Downloads → reveal in Finder.
    public func downloadRelease(_ r: AppRelease) async {
        guard download == nil else { return }
        guard ReleaseSignature.isValid(r, publicKey: config.publicKey) else {
            await config.alerts.failed(UpdatePrompt.invalidSignature)
            return
        }
        guard r.platform == config.platform else {
            await config.alerts.failed(UpdatePrompt.wrongPlatform)
            return
        }
        guard let base = config.hubURL() else { return }
        download = UpdateDownloadState(version: r.version, fraction: 0)
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent("workstation-update-\(UUID().uuidString).dmg")
        let total = Double(r.sizeBytes)
        do {
            let client = HubClient(baseURL: base, user: nil, session: config.urlSession)
            try await client.downloadApp(platform: config.platform, to: temp, maxBytes: r.sizeBytes) { [weak self] n in
                Task { @MainActor in
                    guard let self, self.download != nil else { return }
                    self.download?.fraction = min(1, Double(n) / total)
                }
            }
            let saved = try UpdateDownload.verifyAndSave(temp, release: r, directory: config.downloadsDirectory)
            download = nil
            config.reveal(saved)
        } catch {
            try? FileManager.default.removeItem(at: temp)
            download = nil
            await config.alerts.failed(Self.oneLine(error))
        }
    }

    static func oneLine(_ error: Error) -> String {
        error.localizedDescription.split(whereSeparator: \.isNewline).first.map(String.init) ?? "Update failed."
    }
}
