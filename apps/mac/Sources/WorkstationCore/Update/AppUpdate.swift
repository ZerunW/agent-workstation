import CryptoKit
import Foundation

/// Update channels (protocol `AppPlatform`): `mac` = Apple Silicon,
/// `mac-intel` = x86_64. Each build carries its own in Info.plist (`WorkstationPlatform`).
public enum AppPlatform {
    public static let appleSilicon = "mac"
    public static let intel = "mac-intel"
    public static let all = [appleSilicon, intel]
    public static let infoKey = "WorkstationPlatform"

    /// This build's channel; a missing or unknown value means `mac`.
    public static var running: String { from(infoValue: Bundle.main.object(forInfoDictionaryKey: infoKey)) }

    public static func from(infoValue: Any?) -> String {
        guard let s = infoValue as? String, all.contains(s) else { return appleSilicon }
        return s
    }
}

/// `GET /api/app/<platform>/latest`: the newest AgentWorkstation.app the server offers (protocol `AppRelease`).
/// The server only relays it: `signature` is made on the maintainer's Mac by scripts/make-app.sh and is
/// checked with the public key built into this app before anything is offered.
public struct AppRelease: Codable, Equatable, Sendable {
    public var platform: String
    public var version: String
    /// CFBundleVersion of that build (digits).
    public var build: String
    public var sizeBytes: Int64
    /// Lowercase hex SHA-256 of the dmg.
    public var sha256: String
    public var publishedAt: String
    /// Base64 Ed25519 signature over `signedMessage`; nil when the server sent none.
    public var signature: String?

    public init(platform: String = "mac", version: String, build: String, sizeBytes: Int64, sha256: String,
                publishedAt: String, signature: String? = nil) {
        self.platform = platform; self.version = version; self.build = build; self.sizeBytes = sizeBytes
        self.sha256 = sha256; self.publishedAt = publishedAt; self.signature = signature
    }

    enum CodingKeys: String, CodingKey { case platform, version, build, sizeBytes, sha256, publishedAt, signature }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        platform = try c.decode(String.self, forKey: .platform)
        version = try c.decode(String.self, forKey: .version)
        build = try c.decode(String.self, forKey: .build)
        sizeBytes = try c.decode(Int64.self, forKey: .sizeBytes)
        sha256 = try c.decode(String.self, forKey: .sha256)
        publishedAt = try c.decode(String.self, forKey: .publishedAt)
        signature = try c.decodeIfPresent(String.self, forKey: .signature)
        func bad(_ what: String) -> DecodingError {
            .dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "AppRelease: invalid \(what)"))
        }
        guard AppPlatform.all.contains(platform) else { throw bad("platform") }
        guard AppBuild.isDigits(build) else { throw bad("build") }
        guard sizeBytes > 0 else { throw bad("sizeBytes") }
        guard sha256.count == 64, sha256.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) }) else { throw bad("sha256") }
    }

    /// What the signature covers (protocol: `workstation-release-v1|<platform>|<version>|<build>|<sizeBytes>|<sha256>`).
    public var signedMessage: String { "workstation-release-v1|\(platform)|\(version)|\(build)|\(sizeBytes)|\(sha256)" }

    /// `Agent Workstation-<version>-<build>.dmg`, safe as a file name.
    public var fileName: String { DownloadPlanner.sanitize("Agent Workstation-\(version)-\(build).dmg") }
}

/// Ed25519 release signatures (CryptoKit Curve25519).
public enum ReleaseSignature {
    /// `WorkstationReleasePublicKey` in Info.plist: base64 of the raw 32-byte public key, written by make-app.sh.
    public static let infoKey = "WorkstationReleasePublicKey"

    public static var bundledPublicKey: Data? {
        (Bundle.main.object(forInfoDictionaryKey: infoKey) as? String).flatMap { Data(base64Encoded: $0) }
    }

    /// True only for a well-formed signature by `publicKey` over `release.signedMessage`.
    public static func isValid(_ release: AppRelease, publicKey: Data?) -> Bool {
        guard let publicKey, let sig = release.signature, let sigData = Data(base64Encoded: sig), sigData.count == 64,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else { return false }
        return key.isValidSignature(sigData, for: Data(release.signedMessage.utf8))
    }

    /// Signs with a raw 32-byte private key (what scripts/release-sign.swift does; used by tests).
    public static func sign(_ release: AppRelease, privateKey: Data) throws -> String {
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: privateKey)
        return try key.signature(for: Data(release.signedMessage.utf8)).base64EncodedString()
    }
}

/// CFBundleVersion comparison: digit strings compared numerically, any length.
public enum AppBuild {
    public static var running: String? { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String }

    static func isDigits(_ s: String) -> Bool { (1...20).contains(s.count) && s.allSatisfy { ("0"..."9").contains($0) } }

    /// `candidate` > `current`. A missing or non-numeric current build counts as 0; a non-numeric
    /// candidate is never newer.
    public static func isNewer(_ candidate: String, than current: String?) -> Bool {
        guard isDigits(candidate) else { return false }
        func norm(_ s: String) -> String { let t = s.drop { $0 == "0" }; return t.isEmpty ? "0" : String(t) }
        let a = norm(candidate)
        let b = current.flatMap { isDigits($0) ? norm($0) : nil } ?? "0"
        return a.count != b.count ? a.count > b.count : a > b
    }
}

/// What a check shows the person.
public enum UpdatePrompt: Equatable, Sendable {
    case available(AppRelease)
    case upToDate
    case failed(String)

    public static let invalidSignature = "Update rejected: invalid signature"
    public static let wrongPlatform = "Update rejected: wrong platform"
}

public enum UpdatePolicy {
    /// - Parameters:
    ///   - release: the server's answer (nil = it has none, 404).
    ///   - error: the check failed (one line).
    ///   - manual: Check for Updates… (always answers); automatic checks stay silent unless a
    ///     newer, validly signed build is there that the person has not put off with Later.
    ///   - platform: this build's channel; a release for another one is never offered.
    public static func prompt(release: AppRelease?, error: String?, currentBuild: String?, publicKey: Data?,
                              skippedBuild: String?, manual: Bool, platform: String = AppPlatform.appleSilicon) -> UpdatePrompt? {
        if let error { return manual ? .failed(error) : nil }
        guard let release else { return manual ? .upToDate : nil }
        guard ReleaseSignature.isValid(release, publicKey: publicKey) else { return manual ? .failed(UpdatePrompt.invalidSignature) : nil }
        guard release.platform == platform else { return manual ? .failed(UpdatePrompt.wrongPlatform) : nil }
        guard AppBuild.isNewer(release.build, than: currentBuild) else { return manual ? .upToDate : nil }
        if !manual && skippedBuild == release.build { return nil }
        return .available(release)
    }
}

public enum UpdateDownloadError: Error, LocalizedError, Equatable {
    case mismatch
    case tooLarge

    public var errorDescription: String? {
        switch self {
        case .mismatch: return "The download doesn't match the release."
        case .tooLarge: return "The download is larger than the release."
        }
    }
}

/// Checks a downloaded dmg against the signed release and saves it in Downloads.
public enum UpdateDownload {
    /// Size and SHA-256 must match `release` (whose signature was checked). On a mismatch the temp
    /// file is deleted. Otherwise it is moved to `<directory>/Agent Workstation-<version>-<build>.dmg`
    /// (never overwriting: `… (1).dmg`) and that URL is returned. Nothing is opened or mounted.
    public static func verifyAndSave(_ temp: URL, release: AppRelease, directory: URL) throws -> URL {
        let fm = FileManager.default
        do {
            let size = (try fm.attributesOfItem(atPath: temp.path)[.size] as? NSNumber)?.int64Value ?? -1
            guard size == release.sizeBytes, try FileHasher.sha256(fileAt: temp) == release.sha256 else { throw UpdateDownloadError.mismatch }
        } catch {
            try? fm.removeItem(at: temp)
            throw error is UpdateDownloadError ? error : UpdateDownloadError.mismatch
        }
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let dest = DownloadPlanner.destination(suggested: release.fileName, in: directory)
        try fm.moveItem(at: temp, to: dest)
        return dest
    }
}
