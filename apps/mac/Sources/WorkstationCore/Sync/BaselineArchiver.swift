import Foundation

/// `X-Baseline-Encoding` values (protocol `BASELINE_ENCODING_HEADER`): absent or
/// `tar.zst` = zstd-compressed tar (default), `tar` = uncompressed tar.
public enum BaselineEncoding: String, Sendable {
    case tarZstd = "tar.zst"
    case tar = "tar"

    public var contentType: String { self == .tarZstd ? "application/zstd" : "application/x-tar" }
    public var fileExtension: String { self == .tarZstd ? "tar.zst" : "tar" }
}

/// Builds the baseline archive for `POST /api/projects/:id/baseline`.
///
/// macOS `/usr/bin/tar` is bsdtar 3.5 (libarchive 3.7). Its `--zstd` does **not** link
/// libzstd: it shells out to an external `zstd`, which macOS does not ship. So:
///   1. find a `zstd` binary (Homebrew / MacPorts locations) and run `tar --zstd` with
///      that directory on PATH → `tar.zst`;
///   2. otherwise create a plain tar → `tar` (sent with `X-Baseline-Encoding: tar`).
/// AppleDouble/xattr/ACL metadata is suppressed so the server never sees `._*` files.
public enum BaselineArchiver {
    public static let zstdCandidates = ["/opt/homebrew/bin/zstd", "/usr/local/bin/zstd", "/opt/local/bin/zstd", "/usr/bin/zstd"]

    public static func findZstd(candidates: [String] = zstdCandidates) -> String? {
        candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Writes `output` (extension is not changed) and returns the encoding used.
    public static func create(root: URL, paths: [String], output: URL, preferZstd: Bool = true,
                              zstdPath: String? = findZstd()) throws -> BaselineEncoding {
        let list = output.deletingLastPathComponent().appendingPathComponent(".workstation-baseline-\(UUID().uuidString).list")
        var listData = Data()
        for p in paths { listData.append(contentsOf: Array(p.utf8)); listData.append(0) }
        try listData.write(to: list)
        defer { try? FileManager.default.removeItem(at: list) }

        let common = ["--no-mac-metadata", "--no-xattrs", "--no-acls", "--no-fflags", "--format", "pax",
                      "-C", root.path, "--null", "-n", "-T", list.path]
        var env = ["COPYFILE_DISABLE": "1", "LC_ALL": "en_US.UTF-8", "PATH": "/usr/bin:/bin"]

        if preferZstd, let zstd = zstdPath {
            env["PATH"] = (zstd as NSString).deletingLastPathComponent + ":/usr/bin:/bin"
            try? FileManager.default.removeItem(at: output)
            if let out = try? ProcessRunner.run("/usr/bin/tar", ["--zstd", "-c", "-f", output.path] + common, environment: env, timeout: 3600),
               out.status == 0, isZstd(output) {
                return .tarZstd
            }
            env["PATH"] = "/usr/bin:/bin"
        }
        try? FileManager.default.removeItem(at: output)
        let out = try ProcessRunner.run("/usr/bin/tar", ["-c", "-f", output.path] + common, environment: env, timeout: 3600)
        guard out.status == 0 else { throw HubError.transport("tar failed: \(out.stderr.prefix(300))") }
        return .tar
    }

    /// zstd frame magic 28 B5 2F FD.
    public static func isZstd(_ url: URL) -> Bool {
        guard let h = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? h.close() }
        let head = (try? h.read(upToCount: 4)) ?? Data()
        return head == Data([0x28, 0xB5, 0x2F, 0xFD])
    }

    /// Lists archive members (used by tests and diagnostics).
    public static func list(_ archive: URL, zstdPath: String? = findZstd()) throws -> [String] {
        var env = ["PATH": "/usr/bin:/bin"]
        if let z = zstdPath { env["PATH"] = (z as NSString).deletingLastPathComponent + ":/usr/bin:/bin" }
        let out = try ProcessRunner.run("/usr/bin/tar", ["-t", "-f", archive.path], environment: env)
        guard out.status == 0 else { throw HubError.transport("tar -t failed: \(out.stderr)") }
        return String(decoding: out.stdout, as: UTF8.self).split(separator: "\n").map(String.init)
    }
}
