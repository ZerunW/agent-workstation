import Foundation
import Testing
@testable import WorkstationCore

/// Fake `SF_DATALESS` flags: the listed paths (relative to `root`) are cloud-only placeholders.
final class FakeCloud: @unchecked Sendable {
    private let lock = NSLock()
    private var paths: Set<String> = []
    let root: URL
    init(root: URL, _ paths: Set<String> = []) { self.root = root.resolvingSymlinksInPath(); self.paths = paths }
    func set(_ p: Set<String>) { lock.withLock { paths = p } }
    var probe: CloudProbe {
        CloudProbe { [self] url in
            let full = url.resolvingSymlinksInPath().path
            let base = root.path + "/"
            guard full.hasPrefix(base) else { return false }
            return lock.withLock { paths.contains(String(full.dropFirst(base.count))) }
        }
    }
}

/// Records every file whose content is hashed (read).
final class ReaderSpy: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var read: [String] = []
    var hasher: @Sendable (URL) throws -> String {
        { [self] url in lock.withLock { read.append(url.lastPathComponent) }; return try FileHasher.sha256(fileAt: url) }
    }
    var names: [String] { lock.withLock { read } }
}

@Suite("Sync selection: decisions")
struct SyncDecisionTests {
    func rec(_ d: SyncDecision, _ kind: SyncKind = .folder) -> SyncRecord { SyncRecord(kind: kind, decision: d, source: .you) }

    @Test func newItemsSyncUnlessTheirFolderHasSomethingUnchecked() {
        let big: Int64 = 200 * 1024 * 1024
        let s = SyncSelection(records: [
            "src": rec(.sync), "data": rec(.sync), "data/raw": rec(.skip), "README.md": rec(.sync, .file), "cache": rec(.skip),
        ])
        // The root has something unchecked (cache/): new root items wait.
        #expect(s.effective("new.txt", kind: .file).decision == nil)
        #expect(s.effective("newdir", kind: .folder).decision == nil)
        #expect(s.effective("newdir/inner/x.c", kind: .file).decision == nil, "a new folder that waits holds everything in it")
        // src/ has nothing unchecked: new items in it sync on their own, at any depth.
        #expect(s.effective("src/new.c", kind: .file).decision == .sync)
        #expect(s.effective("src/a/b/new.c", kind: .file).decision == .sync)
        // data/ has raw/ unchecked: new items directly in it wait; an existing subfolder is transparent.
        #expect(s.effective("data/new.csv", kind: .file).decision == nil)
        #expect(s.effective("data/2024/x.csv", kind: .file, established: ["data/2024"]).decision == .sync)
        #expect(s.effective("data/2025/x.csv", kind: .file).decision == nil, "a new folder in data/ waits")
        // Inside an unchecked folder: never, and never asks.
        #expect(s.effective("data/raw/x.bin", kind: .file).decision == .skip)
        #expect(s.effective("cache/deep/x", kind: .file).decision == .skip)
        // .git never; large files wait for the person's own decision.
        #expect(s.effective(".git/HEAD", kind: .file).decision == .skip)
        let e = s.effective("src/weights.bin", kind: .file, size: big)
        #expect(e.decision == nil && e.large)
        #expect(e.reason == "\(Formatters.bytes(big)) large file: each synced version is kept on the server", "\(e.reason ?? "nil")")
        // With nothing unchecked anywhere, everything new syncs.
        let clean = SyncSelection(records: ["src": rec(.sync)])
        #expect(clean.effective("anything/new.txt", kind: .file).decision == .sync && clean.effective("x.txt", kind: .file).decision == .sync)
        #expect(s.isMixed("data") && !s.isMixed("src") && s.isMixed(""))
    }

    @Test func applyingTheDecisions() {
        var s = SyncSelection(records: ["new/tmp": rec(.skip), "new/a.txt": rec(.sync, .file)],
                              pending: ["new": SyncPendingItem(path: "new", kind: .folder, bytes: 3, files: 2),
                                        "x.bin": SyncPendingItem(path: "x.bin", kind: .file, bytes: 200 * 1024 * 1024, large: true)])
        // Deciding a folder decides everything inside it.
        s.apply([SyncDecisionInput(path: "new", kind: .folder, decision: .sync)])
        #expect(s.records["new"]?.decision == .sync && s.records.keys.filter { $0.hasPrefix("new/") }.isEmpty)
        #expect(s.pending["new"] == nil && s.pending["x.bin"] != nil)
        s.apply([SyncDecisionInput(path: "x.bin", kind: .file, decision: .sync)])
        #expect(s.pending.isEmpty && s.records["x.bin"]?.decision == .sync)
        s.apply([SyncDecisionInput(path: "x.bin", kind: .file, decision: nil)])
        #expect(s.records["x.bin"] == nil)
    }

    @Test func waitingItemsAreTheTopmostNewPaths() {
        let t = TempDir("waiting")
        t.write("src/a.c", "a"); t.write("src/new.c", "n")
        t.write("data/kept.csv", "k"); t.write("data/raw/x.bin", "x"); t.write("data/new.csv", "n")
        t.write("dataset/2024/a.csv", "1"); t.write("dataset/2024/b.csv", "2")
        t.write("top.txt", "t")
        t.write(".git/HEAD", "ref")
        let s = SyncSelection(records: ["src": rec(.sync), "data": rec(.sync), "data/kept.csv": rec(.sync, .file), "data/raw": rec(.skip),
                                        "cache": rec(.skip)])
        let scan = SelectionScanner.scan(root: t.url, selection: s, knownHashes: ["data/kept.csv": "h"])
        #expect(Set(scan.files.map(\.path)) == ["src/a.c", "src/new.c", "data/kept.csv"])
        #expect(scan.undecided.map(\.path) == ["data/new.csv", "dataset", "top.txt"])
        #expect(scan.undecided.first { $0.path == "dataset" }?.files == 2)
    }

    @Test func migrationOfALinkFromBeforeSyncSelection() {
        let t = TempDir("migrate")
        t.write("src/a.c", "a"); t.write("src/node_modules/x.js", "x")
        t.write("docs/readme.md", "r"); t.write("README.md", "hi")
        t.write(".gitignore", "*.log\n"); t.write("run.log", "l")
        t.write("never/synced.txt", "n")
        let known = ["src/a.c": "h1", "docs/readme.md": "h2", "README.md": "h3", ".gitignore": "h4"]
        let s = SelectionDefaults.selection(root: t.url, extraIgnore: [], known: known)
        #expect(s.records["src"]?.decision == .sync && s.records["docs"]?.decision == .sync && s.records["README.md"]?.decision == .sync)
        #expect(s.records["src/node_modules"]?.decision == .skip && s.records["run.log"]?.reason == SelectionDefaults.excludedBeforeReason,
                "what the old list left out stays out: no surprise uploads")
        #expect(s.records["never"] == nil)
        #expect(SelectionDefaults.selection(root: t.url, extraIgnore: [], known: [:]).records.isEmpty, "a new link without a window: nothing unchecked")
    }
}

@Suite("Cloud-only files")
struct CloudFileTests {
    @Test func providerNamesAndFinderCommands() {
        let home = "/Users/me"
        func p(_ path: String, resolve: @escaping (String) -> String = { $0 }) -> CloudProvider {
            CloudProvider.detect(URL(fileURLWithPath: path), home: home, resolve: resolve)
        }
        #expect(p("/Users/me/Library/CloudStorage/OneDrive-Example/Documents/x") == CloudProvider(name: "OneDrive", finderCommand: "Always Keep on This Device"))
        #expect(p("/Users/me/Library/CloudStorage/OneDrive-Personal") == CloudProvider(name: "OneDrive", finderCommand: "Always Keep on This Device"))
        #expect(p("/Users/me/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/a") == CloudProvider(name: "Google Drive", finderCommand: "Available offline"))
        #expect(p("/Users/me/Library/CloudStorage/Dropbox/x") == CloudProvider(name: "Dropbox", finderCommand: "Make available offline"))
        #expect(p("/Users/me/Library/CloudStorage/Box-Box/x") == CloudProvider(name: "Box", finderCommand: "Make available offline"))
        #expect(p("/Users/me/Library/CloudStorage/pCloud-me/x") == CloudProvider(name: "pCloud", finderCommand: nil), "first word")
        #expect(p("/Users/me/Library/Mobile Documents/com~apple~CloudDocs/a") == CloudProvider(name: "iCloud Drive", finderCommand: "Keep Downloaded"))
        let desktop = p("/Users/me/Desktop/proj") { _ in "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Desktop/proj" }
        #expect(desktop.name == "iCloud Drive", "Desktop synced to iCloud resolves there")
        #expect(p("/Users/me/code/sample-app") == .generic)
        #expect(CloudProvider(name: "OneDrive", finderCommand: "Always Keep on This Device").message(220)
                == "220 files are only in OneDrive. In Finder, choose “Always Keep on This Device” for this folder.")
        #expect(CloudProvider.generic.message(1) == "1 file is only in the cloud. In Finder, keep this folder downloaded.")
        #expect(CloudProvider(name: "Dropbox", finderCommand: "Make available offline").shortLine(3) == "3 files only in Dropbox")
    }

    @Test func theSystemProbeReadsOnlyFlags() {
        let t = TempDir("flags")
        t.write("a.txt", "a")
        #expect(!CloudProbe.system.isDataless(t.url.appendingPathComponent("a.txt")))
        #expect(!CloudProbe.system.isDataless(t.url.appendingPathComponent("missing")))
        #expect(CloudProbe.datalessFlag == 0x4000_0000)
    }

    @Test func scannersNeverReadACloudOnlyFile() throws {
        let t = TempDir("cloud-scan")
        t.write("src/a.c", "a"); t.write("src/b.c", "b"); t.write("src/c.c", "c")
        let cloud = FakeCloud(root: t.url, ["src/b.c", "src/c.c"])
        let spy = ReaderSpy()
        let cache = HashCache(probe: cloud.probe, hasher: spy.hasher)
        let scan = SelectionScanner.scan(root: t.url, selection: SyncSelection(), knownHashes: ["src/c.c": "known-c"], cache: cache)
        #expect(spy.names == ["a.c"], "only the local file was read")
        #expect(scan.cloudOnly == ["src/b.c"], "new and cloud-only: waits until local")
        #expect(scan.evicted == ["src/c.c"] && scan.files.first { $0.path == "src/c.c" }?.hash == "known-c", "evicted: its known version stands")
        #expect(throws: CloudFileError.cloudOnly("src/b.c")) { try cache.hash(path: "src/b.c", url: t.url.appendingPathComponent("src/b.c"), size: 1, mtime: 0) }
        // The tree for the window flags them without reading anything.
        let top = SyncTreeScanner.scan(root: t.url, cloud: cloud.probe)
        #expect(top.node(at: "src/b.c")?.cloudOnly == true && top.node(at: "src/a.c")?.cloudOnly == false)
        let old = LocalScanner.scan(root: t.url, probe: cloud.probe)
        #expect(old.skipped.map(\.path) == ["src/b.c", "src/c.c"] && old.skipped.first?.reason == .cloudOnly)
    }
}

@Suite("Sync selection: the web bridge")
struct SyncBridgeTests {
    let pid = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e"
    func parse(_ v: JSONValue) -> Result<SyncBridgeRequest, SyncBridgeError> { SyncBridgeRequest.parse(v, isLinked: { $0 == pid }) }

    @Test func validatesEveryArgument() {
        #expect(parse(["op": "status", "projectId": .string(pid)]) == .success(.status(projectId: pid)))
        #expect(parse(["op": "status", "projectId": "other"]) == .success(.status(projectId: "other")), "status answers null itself")
        #expect(parse(["op": "pending", "projectId": "other"]) == .failure(.notLinked))
        #expect(parse(["op": "list", "projectId": .string(pid), "dir": "src/"]) == .success(.list(projectId: pid, dir: "src")))
        #expect(parse(["op": "list", "projectId": .string(pid)]) == .success(.list(projectId: pid, dir: "")))
        #expect(parse(["op": "recheck", "projectId": .string(pid), "dir": nil]) == .success(.recheck(projectId: pid, dir: "")))
        for dir: JSONValue in ["../x", "/etc", "a//b", "a/../b", 3] {
            #expect(parse(["op": "list", "projectId": .string(pid), "dir": dir]) == .failure(.invalid("dir")), "\(dir)")
        }
        #expect(parse(["op": "decide", "projectId": .string(pid), "decisions": [["path": "src", "kind": "folder", "decision": "sync"],
                                                                                 ["path": "a.txt", "kind": "file", "decision": nil]]])
                == .success(.decide(projectId: pid, decisions: [SyncDecisionInput(path: "src", kind: .folder, decision: .sync),
                                                                SyncDecisionInput(path: "a.txt", kind: .file, decision: nil)])))
        let bad: [JSONValue] = [
            ["op": "decide", "projectId": .string(pid), "decisions": [["path": "../x", "kind": "file", "decision": "sync"]]],
            ["op": "decide", "projectId": .string(pid), "decisions": [["path": "a", "kind": "dir", "decision": "sync"]]],
            ["op": "decide", "projectId": .string(pid), "decisions": [["path": "a", "kind": "file", "decision": "maybe"]]],
            ["op": "decide", "projectId": .string(pid), "decisions": [["path": "a", "kind": "file"]]],
            ["op": "decide", "projectId": .string(pid), "decisions": "all"],
            ["op": "decide", "projectId": .string(pid), "decisions": .array(Array(repeating: ["path": "a", "kind": "file", "decision": nil], count: 10_001))],
        ]
        for b in bad { #expect(parse(b) == .failure(.invalid("decisions"))) }
        #expect(parse(["op": "delete", "projectId": .string(pid)]) == .failure(.invalid("op")))
        #expect(parse(["projectId": .string(pid)]) == .failure(.invalid("op")))
        #expect(parse(["op": "status", "projectId": "a/b"]) == .failure(.invalid("projectId")))
        #expect(parse(["op": "status"]) == .failure(.invalid("projectId")))
    }
}

@Suite("Large files: chunks, resume, hash, Range downloads")
struct LargeFileTests {
    @Test func chunkRanges() {
        #expect(LargeFileUploader.chunks(size: 10, chunk: 4) == [0..<4, 4..<8, 8..<10])
        #expect(LargeFileUploader.chunks(size: 10, from: 8, chunk: 4) == [8..<10])
        #expect(LargeFileUploader.chunks(size: 0, chunk: 4).isEmpty)
        #expect(LargeFileUploader.chunkBytes == 16 * 1024 * 1024)
    }

    func file(_ t: TempDir, _ size: Int) throws -> LargeFile {
        let data = Data((0..<size).map { UInt8(($0 * 31) % 251) })
        t.write("big.bin", "")
        try data.write(to: t.url.appendingPathComponent("big.bin"))
        return LargeFile(path: "big.bin", sha256: FileHasher.sha256(data), size: Int64(size), mode: 0o644)
    }

    @Test func uploadsInOrderedChunksAndResumes() async throws {
        let t = TempDir("large"), hub = FakeTransport()
        let f = try file(t, 10_000)
        // Hashing streams the file (the same hash as the bytes).
        #expect(try FileHasher.sha256(fileAt: t.url.appendingPathComponent("big.bin")) == f.sha256)
        // The hub loses the partial upload after the 2nd chunk: the next chunk gets 409 → resume from 0.
        hub.dropPartialAfterChunks["big.bin"] = 2
        let seen = Locked<[Int64]>([])
        try await LargeFileUploader.upload(f, root: t.url, projectId: "p", transport: hub, chunk: 3_000) { n in seen.mutate { $0.append(n) } }
        #expect(hub.large["big.bin"] == f.sha256)
        let offsets = hub.chunkCalls.map(\.offset)
        #expect(offsets.prefix(3) == [0, 3_000, 6_000], "in order; the 3rd chunk meets an empty hub")
        #expect(offsets.suffix(4) == [0, 3_000, 6_000, 9_000], "resumed from what the hub holds")
        #expect(seen.value.last == 10_000)

        #expect(hub.largeWrites.last?.baseHash == nil && hub.largeWrites.last?.force == false)
        // Already held by the server's store: no bytes again, one empty completing write.
        let before = hub.chunkCalls.count
        let again = try await LargeFileUploader.upload(f, root: t.url, projectId: "p", transport: hub, chunk: 3_000)
        #expect(hub.chunkCalls.count == before, "no chunk with bytes")
        #expect(again.complete && again.result?.status == .noop)

        // A partial upload from an earlier run is resumed where the hub stands.
        let t2 = TempDir("large2"), hub2 = FakeTransport()
        let f2 = try file(t2, 7_000)
        hub2.partial["big.bin"] = try Data(contentsOf: t2.url.appendingPathComponent("big.bin")).prefix(3_000)
        try await LargeFileUploader.upload(f2, root: t2.url, projectId: "p", transport: hub2, chunk: 3_000)
        #expect(hub2.chunkCalls.map(\.offset) == [3_000, 6_000])
        #expect(hub2.large["big.bin"] == f2.sha256)
    }

    @Test func aChangedFileOrWrongHashIsRefused() async throws {
        let t = TempDir("large3"), hub = FakeTransport()
        var f = try file(t, 5_000)
        f.sha256 = String(repeating: "0", count: 64)
        await #expect(throws: HubError.self) { try await LargeFileUploader.upload(f, root: t.url, projectId: "p", transport: hub, chunk: 2_000) }
        #expect(hub.large.isEmpty)
        f = try file(t, 5_000)
        f.size = 6_000
        await #expect(throws: LargeFileError.changed("big.bin")) { try await LargeFileUploader.upload(f, root: t.url, projectId: "p", transport: hub, chunk: 2_000) }
    }

    @Test func cancellable() async throws {
        let t = TempDir("large4"), hub = FakeTransport()
        let f = try file(t, 9_000)
        let task = Task { try await LargeFileUploader.upload(f, root: t.url, projectId: "p", transport: hub, chunk: 1_000) }
        task.cancel()
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(hub.large.isEmpty)
    }

    func client(_ host: String, _ h: @escaping StubProtocol.Handler) -> HubClient {
        StubProtocol.register(host, h)
        return HubClient(baseURL: URL(string: "http://\(host):9000")!, user: "alice", session: StubProtocol.session())
    }

    @Test func hubClientChunksRangesAndConflicts() async throws {
        let content = Data((0..<10_000).map { UInt8($0 % 256) })
        let ranges = Locked<[String]>([])
        let queries = Locked<[String]>([])
        let c = client("large.test") { req, body in
            if req.url!.path.hasSuffix("/raw") {
                let r = req.value(forHTTPHeaderField: "Range") ?? ""
                ranges.mutate { $0.append(r) }
                let parts = r.dropFirst("bytes=".count).split(separator: "-").compactMap { Int($0) }
                let lo = parts[0], hi = min(parts[1], content.count - 1)
                return (206, ["Content-Range": "bytes \(lo)-\(hi)/\(content.count)"], content.subdata(in: lo..<(hi + 1)))
            }
            let q = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!.queryItems!
            func v(_ n: String) -> String? { q.first { $0.name == n }?.value }
            queries.mutate { $0.append("\(req.httpMethod!) offset=\(v("offset") ?? "-") base=\(v("baseHash") ?? "-") force=\(v("force") ?? "-")") }
            let offset = v("offset")
            if req.httpMethod == "PUT", offset == "2" { return (409, [:], Data(#"{"path":"big.bin","received":4,"complete":false}"#.utf8)) }
            if req.httpMethod == "PUT", offset == "4" {
                return (200, [:], Data(#"{"path":"big.bin","received":8,"complete":true,"result":{"status":"conflict","reason":"both sides changed"},"localCommit":null}"#.utf8))
            }
            if req.httpMethod == "PUT" { return (200, [:], Data(#"{"path":"big.bin","received":\#(Int(offset!)! + body.count),"complete":false}"#.utf8)) }
            return (200, [:], Data(#"{"path":"big.bin","received":0,"complete":false}"#.utf8))
        }
        let dl = TempDir("dl")
        let out = dl.url.appendingPathComponent("x")
        #expect(try await c.downloadRaw(projectId: "p", path: "big.bin", ref: "local", to: out, chunk: 4_000))
        #expect(try Data(contentsOf: out) == content)
        #expect(ranges.value == ["bytes=0-3999", "bytes=4000-7999", "bytes=8000-11999"])
        var f = LargeFile(path: "big.bin", sha256: String(repeating: "a", count: 64), size: 8, mode: 0o644)
        #expect(try await c.uploadLargeChunk(projectId: "p", file: f, offset: 0, data: Data([1, 2, 3, 4])).received == 4)
        // 409 = offset mismatch only: the answer says where to resume.
        let mismatch = try await c.uploadLargeChunk(projectId: "p", file: f, offset: 2, data: Data([3, 4]))
        #expect(mismatch.received == 4 && !mismatch.complete)
        // Completion carries the sync write's result; a conflict is a 200.
        f.baseHash = String(repeating: "b", count: 64)
        f.force = true
        let done = try await c.uploadLargeChunk(projectId: "p", file: f, offset: 4, data: Data([5, 6, 7, 8]))
        #expect(done.complete && done.result == .init(status: .conflict, reason: "both sides changed"))
        #expect(queries.value.first == "PUT offset=0 base= force=-", "baseHash empty for a new file")
        #expect(queries.value.last == "PUT offset=4 base=\(String(repeating: "b", count: 64)) force=true")
    }

    @Test func theWriterCopiesAVerifiedStoreFile() throws {
        let root = TempDir("writer-large"), store = TempDir("store")
        let content = Data((0..<5_000).map { UInt8($0 % 200) })
        let src = store.url.appendingPathComponent("hash")
        try content.write(to: src)
        var item = WriteItem.write("models/big.bin", file: src, hash: FileHasher.sha256(content), expected: nil)
        var r = WriteBatchExecutor.execute(WriteBatch(root: root.url.path, items: [item]), deleteMode: .removeForTests)
        #expect(r.applied == ["models/big.bin"])
        #expect(try Data(contentsOf: root.url.appendingPathComponent("models/big.bin")) == content)
        #expect(item.contentBase64 == nil, "never carried in the batch")
        // A store file that does not match its hash is refused.
        item = WriteItem.write("models/other.bin", file: src, hash: String(repeating: "0", count: 64), expected: nil)
        r = WriteBatchExecutor.execute(WriteBatch(root: root.url.path, items: [item]), deleteMode: .removeForTests)
        #expect(r.applied.isEmpty && r.refused.first?.reason == "content does not match its hash")
    }
}
