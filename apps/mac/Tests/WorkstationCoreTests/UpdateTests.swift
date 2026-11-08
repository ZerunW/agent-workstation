import CryptoKit
import Foundation
@testable import WorkstationCore
import Testing

@Suite("Check for Updates (versions, releases, signatures, downloads)")
struct UpdateTests {
    static let key = Curve25519.Signing.PrivateKey()
    static var publicKey: Data { key.publicKey.rawRepresentation }

    static func release(build: String = "202611010900", version: String = "0.2.0", data: Data = Data("dmg bytes".utf8),
                        signedBy key: Curve25519.Signing.PrivateKey? = UpdateTests.key) -> AppRelease {
        var r = AppRelease(version: version, build: build, sizeBytes: Int64(data.count), sha256: FileHasher.sha256(data),
                           publishedAt: "2026-11-01T09:00:00Z")
        if let key { r.signature = try! ReleaseSignature.sign(r, privateKey: key.rawRepresentation) }
        return r
    }

    @Test func buildComparisonIsNumeric() {
        #expect(AppBuild.isNewer("202611010900", than: "202610312359"))
        #expect(!AppBuild.isNewer("202610312359", than: "202611010900"))
        #expect(!AppBuild.isNewer("202611010900", than: "202611010900"))
        #expect(AppBuild.isNewer("10", than: "9"), "numeric, not lexicographic")
        #expect(!AppBuild.isNewer("0009", than: "10"))
        #expect(AppBuild.isNewer("99999999999999999999", than: "9999999999999999999"), "beyond Int64")
        #expect(AppBuild.isNewer("1", than: nil) && AppBuild.isNewer("1", than: "dev"), "unknown running build = 0")
        #expect(!AppBuild.isNewer("1.2", than: "0") && !AppBuild.isNewer("", than: "0"))
    }

    @Test func decodesAndValidatesReleases() throws {
        let json = #"{"platform":"mac","version":"0.2.0","build":"202611010900","sizeBytes":3133200,"sha256":"\#(String(repeating: "ab", count: 32))","publishedAt":"2026-11-01T09:00:00Z","signature":"\#(String(repeating: "A", count: 86))=="}"#
        let r = try JSONDecoder().decode(AppRelease.self, from: Data(json.utf8))
        #expect(r.version == "0.2.0" && r.build == "202611010900" && r.sizeBytes == 3_133_200 && r.signature?.count == 88)
        #expect(r.fileName == "Agent Workstation-0.2.0-202611010900.dmg")
        #expect(r.signedMessage == "workstation-release-v1|mac|0.2.0|202611010900|3133200|\(String(repeating: "ab", count: 32))")
        let unsigned = try JSONDecoder().decode(AppRelease.self, from: Data(json.replacingOccurrences(of: #","signature":"\#(String(repeating: "A", count: 86))==""#, with: "").utf8))
        #expect(unsigned.signature == nil)
        for (from, to) in [("\"mac\"", "\"win\""), ("\"202611010900\"", "\"20261101a\""), ("3133200", "0"), ("\"abab", "\"ABAB")] {
            #expect(throws: DecodingError.self) { try JSONDecoder().decode(AppRelease.self, from: Data(json.replacingOccurrences(of: from, with: to).utf8)) }
        }
        #expect(AppRelease(version: "1/../x", build: "1", sizeBytes: 1, sha256: "", publishedAt: "").fileName == "x-1.dmg")
    }

    /// Channels: `mac` (Apple Silicon, also the default) and `mac-intel`.
    @Test func platformsRoutesAndSignedMessage() throws {
        #expect(AppPlatform.from(infoValue: "mac-intel") == "mac-intel")
        #expect(AppPlatform.from(infoValue: "mac") == "mac")
        #expect(AppPlatform.from(infoValue: nil) == "mac", "no channel in Info.plist means mac")
        #expect(AppPlatform.from(infoValue: "windows") == "mac" && AppPlatform.from(infoValue: 3) == "mac")
        #expect(Routes.appLatest().url(base: URL(string: "https://h")!).absoluteString == "https://h/api/app/mac/latest")
        #expect(Routes.appLatest("mac-intel").url(base: URL(string: "https://h")!).absoluteString == "https://h/api/app/mac-intel/latest")
        #expect(Routes.appDownload("mac-intel").url(base: URL(string: "https://h")!).absoluteString == "https://h/api/app/mac-intel/download")
        #expect(Routes.appDownload().url(base: URL(string: "https://h")!).absoluteString == "https://h/api/app/mac/download")

        let mac = AppRelease(version: "0.3.0", build: "202611011200", sizeBytes: 10, sha256: String(repeating: "a", count: 64), publishedAt: "")
        #expect(mac.signedMessage == "workstation-release-v1|mac|0.3.0|202611011200|10|\(String(repeating: "a", count: 64))", "unchanged for mac")
        var intel = mac
        intel.platform = "mac-intel"
        #expect(intel.signedMessage == "workstation-release-v1|mac-intel|0.3.0|202611011200|10|\(String(repeating: "a", count: 64))")
        intel.signature = try ReleaseSignature.sign(intel, privateKey: Self.key.rawRepresentation)
        #expect(ReleaseSignature.isValid(intel, publicKey: Self.publicKey))
        var swapped = intel
        swapped.platform = "mac"
        #expect(!ReleaseSignature.isValid(swapped, publicKey: Self.publicKey), "the platform is signed")

        let json = try JSONEncoder().encode(intel)
        #expect(try JSONDecoder().decode(AppRelease.self, from: json) == intel)

        // The prompt only offers a release for this build's own channel.
        func prompt(_ r: AppRelease, _ platform: String, manual: Bool = true) -> UpdatePrompt? {
            UpdatePolicy.prompt(release: r, error: nil, currentBuild: "1", publicKey: Self.publicKey, skippedBuild: nil, manual: manual, platform: platform)
        }
        #expect(prompt(intel, "mac-intel") == .available(intel))
        #expect(prompt(intel, "mac") == .failed("Update rejected: wrong platform"))
        #expect(prompt(intel, "mac", manual: false) == nil)
        let macSigned = Self.release(build: "200")
        #expect(prompt(macSigned, "mac") == .available(macSigned))
        #expect(prompt(macSigned, "mac-intel") == .failed(UpdatePrompt.wrongPlatform))
    }

    @Test func signatureVerification() {
        let r = Self.release()
        #expect(ReleaseSignature.isValid(r, publicKey: Self.publicKey))
        // Any signed field changed → invalid.
        var t = r; t.version = "9.9.9"; #expect(!ReleaseSignature.isValid(t, publicKey: Self.publicKey))
        t = r; t.build = "299911010900"; #expect(!ReleaseSignature.isValid(t, publicKey: Self.publicKey))
        t = r; t.sizeBytes += 1; #expect(!ReleaseSignature.isValid(t, publicKey: Self.publicKey))
        t = r; t.sha256 = String(repeating: "0", count: 64); #expect(!ReleaseSignature.isValid(t, publicKey: Self.publicKey))
        // Wrong key, missing / garbage signature, missing public key.
        #expect(!ReleaseSignature.isValid(r, publicKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation))
        #expect(!ReleaseSignature.isValid(Self.release(signedBy: Curve25519.Signing.PrivateKey()), publicKey: Self.publicKey))
        #expect(!ReleaseSignature.isValid(Self.release(signedBy: nil), publicKey: Self.publicKey))
        t = r; t.signature = "not base64!"; #expect(!ReleaseSignature.isValid(t, publicKey: Self.publicKey))
        t = r; t.signature = Data(count: 64).base64EncodedString(); #expect(!ReleaseSignature.isValid(t, publicKey: Self.publicKey))
        #expect(!ReleaseSignature.isValid(r, publicKey: nil))
        #expect(!ReleaseSignature.isValid(r, publicKey: Data([1, 2, 3])))
    }

    @Test func promptPolicyAndLater() {
        let r = Self.release(build: "200")
        func prompt(_ rel: AppRelease?, error: String? = nil, current: String = "100", skipped: String? = nil, manual: Bool) -> UpdatePrompt? {
            UpdatePolicy.prompt(release: rel, error: error, currentBuild: current, publicKey: Self.publicKey, skippedBuild: skipped, manual: manual)
        }
        #expect(prompt(r, manual: false) == .available(r))
        #expect(prompt(r, manual: true) == .available(r))
        // Later on build 200: no automatic prompt for it, the manual check still shows it; a newer build prompts again.
        #expect(prompt(r, skipped: "200", manual: false) == nil)
        #expect(prompt(r, skipped: "200", manual: true) == .available(r))
        let r2 = Self.release(build: "201")
        #expect(prompt(r2, skipped: "200", manual: false) == .available(r2))
        // Nothing newer / nothing on the server.
        #expect(prompt(r, current: "200", manual: false) == nil)
        #expect(prompt(r, current: "300", manual: true) == .upToDate)
        #expect(prompt(nil, manual: false) == nil)
        #expect(prompt(nil, manual: true) == .upToDate)
        // Errors only on a manual check.
        #expect(prompt(nil, error: "The hub did not answer in time.", manual: false) == nil)
        #expect(prompt(nil, error: "The hub did not answer in time.", manual: true) == .failed("The hub did not answer in time."))
        // Invalid or missing signature: no update; one line on a manual check.
        var bad = r; bad.version = "6.6.6"
        #expect(prompt(bad, manual: false) == nil)
        #expect(prompt(bad, manual: true) == .failed("Update rejected: invalid signature"))
        #expect(prompt(Self.release(build: "200", signedBy: nil), manual: true) == .failed(UpdatePrompt.invalidSignature))
    }

    func tempDir() throws -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("workstation-update-\(UUID().uuidString.prefix(6))", isDirectory: true)
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    @Test func verifiesAndSavesTheDownload() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let downloads = dir.appendingPathComponent("Downloads", isDirectory: true)
        let data = Data((0..<5000).map { UInt8($0 % 251) })
        let r = Self.release(data: data)

        // Wrong bytes (same size) → rejected, temp file deleted, nothing saved.
        let bad = dir.appendingPathComponent("bad.dmg")
        var tampered = data; tampered[10] ^= 0xff
        try tampered.write(to: bad)
        #expect(throws: UpdateDownloadError.mismatch) { try UpdateDownload.verifyAndSave(bad, release: r, directory: downloads) }
        #expect(!FileManager.default.fileExists(atPath: bad.path))
        // Wrong size → rejected.
        let short = dir.appendingPathComponent("short.dmg")
        try data.prefix(100).write(to: short)
        #expect(throws: UpdateDownloadError.mismatch) { try UpdateDownload.verifyAndSave(short, release: r, directory: downloads) }
        #expect(!FileManager.default.fileExists(atPath: short.path))
        #expect((try? FileManager.default.contentsOfDirectory(atPath: downloads.path))?.isEmpty ?? true)

        // Matching → Agent Workstation-<version>-<build>.dmg; a second copy does not clobber the first.
        for _ in 0..<2 {
            let ok = dir.appendingPathComponent("ok-\(UUID().uuidString).dmg")
            try data.write(to: ok)
            _ = try UpdateDownload.verifyAndSave(ok, release: r, directory: downloads)
            #expect(!FileManager.default.fileExists(atPath: ok.path), "moved, not copied")
        }
        let names = try FileManager.default.contentsOfDirectory(atPath: downloads.path).sorted()
        #expect(names == ["Agent Workstation-0.2.0-202611010900 (1).dmg", "Agent Workstation-0.2.0-202611010900.dmg"])
        #expect(try Data(contentsOf: downloads.appendingPathComponent("Agent Workstation-0.2.0-202611010900.dmg")) == data)
    }

    /// scripts/make-app.sh signs release.json with the key it is given (a throwaway key file here;
    /// the real Keychain item is never touched) and the app's verifier accepts the result.
    @Test(.timeLimit(.minutes(5))) func makeAppSigningRoundTrip() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let script = repo.appendingPathComponent("scripts/make-app.sh")
        let throwaway = Curve25519.Signing.PrivateKey()
        let keyFile = dir.appendingPathComponent("key.txt")
        try Data(throwaway.rawRepresentation.base64EncodedString().utf8).write(to: keyFile)
        let dmg = dir.appendingPathComponent("AgentWorkstation.dmg")
        let bytes = Data((0..<70_000).map { UInt8(($0 * 7) % 256) })
        try bytes.write(to: dmg)

        func run(_ env: [String: String]) throws -> (Int32, String) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = [script.path]
            var e = ProcessInfo.processInfo.environment
            for (k, v) in env { e[k] = v }
            p.environment = e
            let out = Pipe()
            p.standardOutput = out
            p.standardError = out
            p.standardInput = FileHandle.nullDevice
            try p.run()
            let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            p.waitUntilExit()
            return (p.terminationStatus, text)
        }

        let (status, output) = try run(["WORKSTATION_RELEASE_KEY_FILE": keyFile.path, "WORKSTATION_RELEASE_ONLY": dmg.path,
                                        "WORKSTATION_VERSION": "0.3.0", "WORKSTATION_BUILD": "202611011200"])
        #expect(status == 0, "\(output)")
        #expect(!output.contains(throwaway.rawRepresentation.base64EncodedString()), "the private key is never printed")
        let pubLine = try #require(output.split(separator: "\n").first { $0.hasPrefix("public key: ") })
        let pub = try #require(Data(base64Encoded: String(pubLine.dropFirst("public key: ".count))))
        #expect(pub == throwaway.publicKey.rawRepresentation)
        let release = try JSONDecoder().decode(AppRelease.self, from: Data(contentsOf: dir.appendingPathComponent("release.json")))
        #expect(release.version == "0.3.0" && release.build == "202611011200")
        #expect(release.platform == "mac", "default channel")
        #expect(release.sizeBytes == Int64(bytes.count) && release.sha256 == FileHasher.sha256(bytes))
        #expect(release.publishedAt.hasSuffix("Z"))
        #expect(ReleaseSignature.isValid(release, publicKey: pub))
        #expect(!ReleaseSignature.isValid(release, publicKey: Self.publicKey), "another key does not verify it")

        // The Intel channel: same key, platform "mac-intel" in the file and in the signed string.
        try FileManager.default.removeItem(at: dir.appendingPathComponent("release.json"))
        let (intelStatus, intelOut) = try run(["WORKSTATION_RELEASE_KEY_FILE": keyFile.path, "WORKSTATION_RELEASE_ONLY": dmg.path,
                                               "WORKSTATION_RELEASE_PLATFORM": "mac-intel", "WORKSTATION_VERSION": "0.3.0", "WORKSTATION_BUILD": "202611011200"])
        #expect(intelStatus == 0, "\(intelOut)")
        let intel = try JSONDecoder().decode(AppRelease.self, from: Data(contentsOf: dir.appendingPathComponent("release.json")))
        #expect(intel.platform == "mac-intel" && intel.build == release.build && intel.sha256 == release.sha256)
        #expect(intel.signedMessage.hasPrefix("workstation-release-v1|mac-intel|0.3.0|202611011200|"))
        #expect(ReleaseSignature.isValid(intel, publicKey: pub))
        #expect(intel.signature != release.signature)
        // An unknown channel is refused.
        try FileManager.default.removeItem(at: dir.appendingPathComponent("release.json"))
        let (badPlatform, badText) = try run(["WORKSTATION_RELEASE_KEY_FILE": keyFile.path, "WORKSTATION_RELEASE_ONLY": dmg.path, "WORKSTATION_RELEASE_PLATFORM": "win"])
        #expect(badPlatform != 0 && badText.contains("platform must be mac or mac-intel"))
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("release.json").path))
        try Data().write(to: dir.appendingPathComponent("release.json"))

        // No key → one clear line, no release.json.
        try FileManager.default.removeItem(at: dir.appendingPathComponent("release.json"))
        let (missing, text) = try run(["WORKSTATION_RELEASE_KEY_FILE": dir.appendingPathComponent("none.txt").path, "WORKSTATION_RELEASE_ONLY": dmg.path])
        #expect(missing != 0)
        #expect(text.contains("no release signing key"))
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("release.json").path))
    }
}
