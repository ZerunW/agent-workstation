// Release signing for scripts/make-app.sh (CryptoKit Ed25519). The private key is read from
// stdin (base64 of the raw 32 bytes) and never written anywhere by this tool.
//
//   release-sign genkey                               → a new private key (base64) on stdout, for the Keychain
//   release-sign pubkey                               → the public key (base64) of the key on stdin
//   release-sign release <dmg> <version> <build> <out.json> [platform]
//                                                     → writes the signed AppRelease JSON for <dmg>
//                                                       (platform: mac = Apple Silicon (default), mac-intel)
import CryptoKit
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("release-sign: \(message)\n".utf8))
    exit(1)
}

func readKey() -> Curve25519.Signing.PrivateKey {
    let input = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard let raw = Data(base64Encoded: input), raw.count == 32,
          let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw) else { fail("no valid private key on stdin") }
    return key
}

func sha256(of url: URL) -> (String, Int64) {
    guard let h = try? FileHandle(forReadingFrom: url) else { fail("can't read \(url.path)") }
    defer { try? h.close() }
    var hasher = SHA256()
    var size: Int64 = 0
    while let chunk = try? h.read(upToCount: 1 << 20), !chunk.isEmpty {
        hasher.update(data: chunk)
        size += Int64(chunk.count)
    }
    return (hasher.finalize().map { String(format: "%02x", $0) }.joined(), size)
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "genkey":
    print(Curve25519.Signing.PrivateKey().rawRepresentation.base64EncodedString())
case "pubkey":
    print(readKey().publicKey.rawRepresentation.base64EncodedString())
case "release":
    guard args.count == 5 || args.count == 6 else { fail("usage: release <dmg> <version> <build> <out.json> [mac|mac-intel]") }
    let platform = args.count == 6 ? args[5] : "mac"
    guard platform == "mac" || platform == "mac-intel" else { fail("platform must be mac or mac-intel") }
    let key = readKey()
    let dmg = URL(fileURLWithPath: args[1]), version = args[2], build = args[3], out = URL(fileURLWithPath: args[4])
    guard !version.isEmpty, !version.contains("|") else { fail("bad version") }
    guard (1...20).contains(build.count), build.allSatisfy({ ("0"..."9").contains($0) }) else { fail("build must be digits") }
    let (sha, size) = sha256(of: dmg)
    guard size > 0 else { fail("empty dmg") }
    let message = "workstation-release-v1|\(platform)|\(version)|\(build)|\(size)|\(sha)"
    guard let sig = try? key.signature(for: Data(message.utf8)) else { fail("signing failed") }
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime]
    fmt.timeZone = TimeZone(identifier: "UTC")
    let release: [String: Any] = [
        "platform": platform, "version": version, "build": build, "sizeBytes": size, "sha256": sha,
        "publishedAt": fmt.string(from: Date()), "signature": sig.base64EncodedString(),
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: release, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
          (try? (data + Data("\n".utf8)).write(to: out, options: .atomic)) != nil else { fail("can't write \(out.path)") }
default:
    fail("usage: genkey | pubkey | release <dmg> <version> <build> <out.json> [mac|mac-intel]")
}
