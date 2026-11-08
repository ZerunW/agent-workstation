import CryptoKit
import Foundation
@testable import WorkstationCore
@testable import WorkstationUI
import Testing

/// Records the update alerts and answers the offer.
@MainActor
final class FakeUpdateAlerts: UpdateAlerting {
    enum Shown: Equatable { case offer(String, String), upToDate, failed(String) }
    var shown: [Shown] = []
    var download = false
    nonisolated init() {}
    func offer(_ release: AppRelease) async -> Bool { shown.append(.offer(release.version, release.build)); return download }
    func upToDate() async { shown.append(.upToDate) }
    func failed(_ line: String) async { shown.append(.failed(line)) }
}

/// Check for Updates against the mock hub: launch / periodic / manual checks, Later, signature
/// refusal, download verification and the saved file. Nothing is opened, mounted or installed.
/// Nested in the serialized shell-flow suite: both drive the one shared MockHub.
extension ShellFlowTests {
@MainActor
@Suite("Check for Updates against a mock hub")
struct UpdateFlowTests {
    let key = Curve25519.Signing.PrivateKey()

    struct Rig {
        let updates: UpdateModel
        let alerts: FakeUpdateAlerts
        let settings: AppSettings
        let downloads: TempFolder
        let revealed: Box
    }

    final class Box { var urls: [URL] = [] }

    func makeRig(current: String = "202610310000", hub: URL? = MockHub.baseURL, platform: String = AppPlatform.appleSilicon) -> Rig {
        MockHub.shared.reset()
        let settings = AppSettings(defaults: TestDefaults.make("workstation-update"), environment: [:])
        let alerts = FakeUpdateAlerts()
        let downloads = TempFolder("workstation-downloads")
        let box = Box()
        let updates = UpdateModel(config: .init(settings: settings, urlSession: MockHub.session(), hubURL: { hub }, currentBuild: current,
                                                platform: platform, publicKey: key.publicKey.rawRepresentation, downloadsDirectory: downloads.url,
                                                reveal: { box.urls.append($0) }, alerts: alerts, interval: 0))
        return Rig(updates: updates, alerts: alerts, settings: settings, downloads: downloads, revealed: box)
    }

    @discardableResult
    func publish(build: String, version: String = "0.2.0", bytes: Data = Data((0..<200_000).map { UInt8($0 % 253) }),
                 signedBy signer: Curve25519.Signing.PrivateKey? = nil, platform: String = AppPlatform.appleSilicon,
                 channel: String? = nil) -> AppRelease {
        var r = AppRelease(platform: platform, version: version, build: build, sizeBytes: Int64(bytes.count), sha256: FileHasher.sha256(bytes),
                           publishedAt: "2026-11-01T09:00:00Z")
        r.signature = try! ReleaseSignature.sign(r, privateKey: (signer ?? key).rawRepresentation)
        MockHub.shared.with { $0.appReleases[channel ?? platform] = r; $0.appDmgs[channel ?? platform] = bytes }
        return r
    }

    func files(_ r: Rig) -> [String] { ((try? FileManager.default.contentsOfDirectory(atPath: r.downloads.url.path)) ?? []).sorted() }

    @Test func manualCheckOutcomes() async throws {
        let r = makeRig()
        // Nothing on the server → up to date.
        await r.updates.check(manual: true)
        #expect(r.alerts.shown == [.upToDate])
        #expect(!MockHub.shared.with { $0.userHeaders }.contains { !$0.isEmpty }, "no user header needed")
        // An older build → up to date.
        publish(build: "202610300000")
        await r.updates.check(manual: true)
        #expect(r.alerts.shown.last == .upToDate)
        // A newer build → offered; Later remembers that build.
        publish(build: "202611010900")
        await r.updates.check(manual: true)
        #expect(r.alerts.shown.last == .offer("0.2.0", "202611010900"))
        #expect(r.settings.skippedUpdateBuild == "202611010900")
        #expect(files(r).isEmpty)
        // Signed by another key → rejected in one line.
        publish(build: "202611020900", signedBy: Curve25519.Signing.PrivateKey())
        await r.updates.check(manual: true)
        #expect(r.alerts.shown.last == .failed("Update rejected: invalid signature"))
        // The hub is down → one line.
        MockHub.shared.with { $0.healthy = false }
        await r.updates.check(manual: true)
        guard case .failed(let line)? = r.alerts.shown.last else { Issue.record("expected an error, got \(r.alerts.shown)"); return }
        #expect(!line.contains("\n") && !line.isEmpty)
        #expect(r.alerts.shown.count == 5)
    }

    @Test func automaticChecksAreQuietAndRespectLater() async throws {
        let r = makeRig()
        // Launch check (once per launch): nothing → silent.
        r.updates.hubConnected()
        try await Task.sleep(nanoseconds: 300_000_000)
        r.updates.hubConnected()
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(MockHub.shared.with { $0.requests }.filter { $0 == "GET /api/app/mac/latest" }.count == 1)
        #expect(r.alerts.shown.isEmpty)
        // Errors and bad signatures stay silent.
        publish(build: "202611010900", signedBy: Curve25519.Signing.PrivateKey())
        await r.updates.check(manual: false)
        MockHub.shared.with { $0.healthy = false }
        await r.updates.check(manual: false)
        #expect(r.alerts.shown.isEmpty)
        MockHub.shared.with { $0.healthy = true }
        // A newer build → offered; Later → not offered again automatically, still offered manually.
        publish(build: "202611010900")
        await r.updates.check(manual: false)
        #expect(r.alerts.shown == [.offer("0.2.0", "202611010900")])
        await r.updates.check(manual: false)
        #expect(r.alerts.shown.count == 1)
        await r.updates.check(manual: true)
        #expect(r.alerts.shown.count == 2)
        // A newer build again → offered automatically.
        publish(build: "202611020900", version: "0.2.1")
        await r.updates.check(manual: false)
        #expect(r.alerts.shown.last == .offer("0.2.1", "202611020900"))
    }

    @Test func downloadIsVerifiedSavedAndRevealed() async throws {
        let r = makeRig()
        let rel = publish(build: "202611010900")
        r.alerts.download = true
        await r.updates.check(manual: true)
        #expect(r.updates.download == nil)
        #expect(files(r) == ["Agent Workstation-0.2.0-202611010900.dmg"])
        let saved = r.downloads.url.appendingPathComponent("Agent Workstation-0.2.0-202611010900.dmg")
        #expect(try FileHasher.sha256(fileAt: saved) == rel.sha256)
        #expect(r.revealed.urls.map(\.lastPathComponent) == ["Agent Workstation-0.2.0-202611010900.dmg"])
        #expect(r.alerts.shown == [.offer("0.2.0", "202611010900")], "no extra alert on success")

        // Again: a second copy, never overwriting.
        await r.updates.check(manual: true)
        #expect(files(r) == ["Agent Workstation-0.2.0-202611010900 (1).dmg", "Agent Workstation-0.2.0-202611010900.dmg"])
    }

    @Test func swappedPackageIsRejected() async throws {
        let r = makeRig()
        let bytes = Data((0..<50_000).map { UInt8($0 % 241) })
        publish(build: "202611010900", bytes: bytes)
        // The server serves other bytes of the same size than the signed release describes.
        var swapped = bytes; swapped[123] ^= 0x5a
        MockHub.shared.with { $0.appDmg = swapped }
        r.alerts.download = true
        await r.updates.check(manual: true)
        #expect(r.alerts.shown.last == .failed("The download doesn't match the release."))
        #expect(files(r).isEmpty)
        #expect(r.revealed.urls.isEmpty)
        // Larger than the signed size → stopped.
        MockHub.shared.with { $0.appDmg = bytes + Data(count: 70_000) }
        await r.updates.check(manual: true)
        #expect(r.alerts.shown.last == .failed("The download is larger than the release."))
        #expect(files(r).isEmpty)
        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: FileManager.default.temporaryDirectory.path))?
            .filter { $0.hasPrefix("workstation-update-") && $0.hasSuffix(".dmg") } ?? []
        #expect(leftovers.isEmpty, "temp files are deleted")
    }

    /// An Intel build asks its own channel (`/api/app/mac-intel/...`), checks the signature with that
    /// platform and never takes a build for the other architecture.
    @Test func intelBuildUsesItsOwnChannel() async throws {
        let r = makeRig(platform: AppPlatform.intel)
        publish(build: "202611010900", version: "0.2.0")                       // Apple Silicon channel
        let intel = publish(build: "202611010901", version: "0.2.0", bytes: Data((0..<90_000).map { UInt8($0 % 239) }), platform: AppPlatform.intel)
        r.alerts.download = true
        await r.updates.check(manual: true)
        let requests = MockHub.shared.with { $0.requests }
        #expect(requests.contains("GET /api/app/mac-intel/latest") && requests.contains("GET /api/app/mac-intel/download"))
        #expect(!requests.contains("GET /api/app/mac/latest") && !requests.contains("GET /api/app/mac/download"))
        #expect(r.alerts.shown == [.offer("0.2.0", "202611010901")])
        #expect(files(r) == ["Agent Workstation-0.2.0-202611010901.dmg"])
        #expect(try FileHasher.sha256(fileAt: r.downloads.url.appendingPathComponent("Agent Workstation-0.2.0-202611010901.dmg")) == intel.sha256)

        // A validly signed Apple Silicon release served on the Intel channel → refused.
        publish(build: "202611020900", platform: AppPlatform.appleSilicon, channel: AppPlatform.intel)
        await r.updates.check(manual: true)
        #expect(r.alerts.shown.last == .failed("Update rejected: wrong platform"))
        await r.updates.check(manual: false)
        #expect(r.alerts.shown.count == 2, "automatic checks stay silent")
        #expect(files(r).count == 1)
        // A release relabelled as mac-intel after signing as mac → invalid signature.
        var relabelled = publish(build: "202611030900", platform: AppPlatform.appleSilicon, channel: AppPlatform.intel)
        relabelled.platform = AppPlatform.intel
        MockHub.shared.with { $0.appReleases[AppPlatform.intel] = relabelled }
        await r.updates.check(manual: true)
        #expect(r.alerts.shown.last == .failed("Update rejected: invalid signature"))
    }

    /// The default channel stays `mac` (Apple Silicon builds and builds without a channel).
    @Test func appleSiliconBuildUsesTheMacChannel() async throws {
        let r = makeRig()
        publish(build: "202611010900")
        await r.updates.check(manual: true)
        #expect(MockHub.shared.with { $0.requests }.contains("GET /api/app/mac/latest"))
        #expect(r.alerts.shown == [.offer("0.2.0", "202611010900")])
    }

    /// The shell wires it: connecting runs the launch check; the menu item runs a manual check.
    @Test func shellRunsTheLaunchCheck() async throws {
        MockHub.shared.reset()
        let alerts = FakeUpdateAlerts()
        let settings = AppSettings(defaults: TestDefaults.make("workstation-update-shell"), environment: [:])
        settings.hubURLString = MockHub.baseURL.absoluteString
        let store = TempFolder("workstation-update-store")
        let deps = ShellModel.Dependencies(settings: settings, urlSession: MockHub.session(), store: LinkedProjectStore(directory: store.url),
                                           makeEventSource: { _, _ in FakeEventSource() }, notifier: RecordingNotifier(),
                                           launchAtLogin: StaticLaunchAtLogin(), writer: CountingWriter(), syncUsesWatcher: false,
                                           openURL: { _ in }, reveal: { _ in }, offlineRetryInterval: 0,
                                           updateAlerts: alerts, currentBuild: "1", releasePublicKey: key.publicKey.rawRepresentation,
                                           downloadsDirectory: store.url, updateCheckInterval: 0)
        let shell = ShellModel(deps: deps)
        publish(build: "2")
        await shell.connect()
        #expect(await until { alerts.shown == [.offer("0.2.0", "2")] })
        shell.updates.checkManually()
        #expect(await until { alerts.shown.count == 2 })
    }
}
}
