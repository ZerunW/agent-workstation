import Foundation
import Testing
@testable import WorkstationCore

@Suite("Hashing, scanner, manifest, baseline archive")
struct ScannerTests {
    @Test func sha256KnownVectors() throws {
        #expect(FileHasher.sha256(Data()) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        #expect(FileHasher.sha256(Data("hello\n".utf8)) == "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03")
        let t = TempDir()
        let u = t.write("f.txt", "hello\n")
        #expect(try FileHasher.sha256(fileAt: u) == FileHasher.sha256(Data("hello\n".utf8)))
    }

    @Test func manifestOfFixtureTree() {
        let t = makeFixtureTree()
        let scan = LocalScanner.scan(root: t.url)
        let paths = scan.files.map(\.path)
        #expect(paths == [".gitignore", "README.md", "keep.log", "src/a.js", "src/dup1.txt", "src/dup2.txt", "src/nested/b.ts"])
        #expect(scan.skipped.map(\.path) == ["link-to-readme"])
        #expect(scan.skipped.first?.reason == .symlink)
        let readme = scan.manifest.first { $0.path == "README.md" }!
        #expect(readme.hash == FileHasher.sha256(Data("hello\n".utf8)))
        #expect(readme.size == 6)
        #expect(readme.mode == 0o644)
        #expect(scan.hashes["src/dup1.txt"] == scan.hashes["src/dup2.txt"])
    }

    @Test func manifestPreservesExecutableBit() throws {
        let t = TempDir()
        let u = t.write("run.sh", "#!/bin/sh\n")
        chmod(u.path, 0o755)
        let scan = LocalScanner.scan(root: t.url)
        #expect(scan.manifest.first?.mode == 0o755)
    }

    @Test func tooLargeFilesAreSkippedVisibly() {
        let t = TempDir()
        t.write("big.bin", String(repeating: "x", count: 2048))
        t.write("small.txt", "ok")
        let scan = LocalScanner.scan(root: t.url, maxFileBytes: 1024)
        #expect(scan.files.map(\.path) == ["small.txt"])
        #expect(scan.skipped.first?.path == "big.bin")
        if case .tooLarge(let n) = scan.skipped.first?.reason { #expect(n == 2048) } else { Issue.record("expected tooLarge") }
    }

    @Test func extraPatternsAndHashCache() throws {
        let t = makeFixtureTree()
        let cache = HashCache()
        let scan = LocalScanner.scan(root: t.url, extraPatterns: ["src/nested/"], cache: cache)
        #expect(!scan.files.contains { $0.path.hasPrefix("src/nested") })
        // Same size+mtime → cached hash is reused (even if we lie about the URL).
        let a = t.url.appendingPathComponent("README.md")
        guard case let .file(size, _, mtime) = LocalEntry.stat(a) else { Issue.record("stat"); return }
        let h1 = try cache.hash(path: "README.md", url: a, size: size, mtime: mtime)
        let h2 = try cache.hash(path: "README.md", url: t.url.appendingPathComponent("nope"), size: size, mtime: mtime)
        #expect(h1 == h2)
    }

    @Test func baselineArchiveContainsExactlyTheScannedFiles() throws {
        let t = makeFixtureTree()
        let scan = LocalScanner.scan(root: t.url)
        let out = TempDir()
        let archive = out.url.appendingPathComponent("baseline")
        let enc = try BaselineArchiver.create(root: t.url, paths: scan.files.map(\.path), output: archive)
        if BaselineArchiver.findZstd() != nil {
            #expect(enc == .tarZstd)
            #expect(BaselineArchiver.isZstd(archive))
        } else {
            #expect(enc == .tar)
        }
        let members = try BaselineArchiver.list(archive)
        #expect(members.sorted() == scan.files.map(\.path).sorted())
        #expect(!members.contains { $0.contains("._") }, "no AppleDouble files")
    }

    @Test func baselineFallsBackToPlainTarWithoutZstd() throws {
        let t = TempDir()
        t.write("a.txt", "a")
        let archive = t.url.appendingPathComponent("../baseline-\(UUID().uuidString).tar").standardizedFileURL
        defer { try? FileManager.default.removeItem(at: archive) }
        let enc = try BaselineArchiver.create(root: t.url, paths: ["a.txt"], output: archive, zstdPath: nil)
        #expect(enc == .tar)
        #expect(!BaselineArchiver.isZstd(archive))
        #expect(try BaselineArchiver.list(archive, zstdPath: nil) == ["a.txt"])
        #expect(enc.contentType == "application/x-tar")
        #expect(BaselineEncoding.tarZstd.contentType == "application/zstd")
    }

    @Test func localEntryStat() {
        let t = makeFixtureTree()
        #expect(LocalEntry.stat(t.url.appendingPathComponent("src")) == .directory)
        #expect(LocalEntry.stat(t.url.appendingPathComponent("link-to-readme")) == .symlink)
        #expect(LocalEntry.stat(t.url.appendingPathComponent("missing")) == .absent)
    }
}
