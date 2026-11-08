import Darwin
import Foundation
@testable import WorkstationCore
import Testing

/// Runs the real `WorkstationWriter` binary as a child process and checks what the OS lets it do once
/// it has sandboxed itself to one folder.
@Suite("Writer sandbox (real WorkstationWriter child process)", .serialized)
struct WriterSandboxTests {
    /// `.build/<config>/WorkstationWriter`, next to this test target's resource bundle.
    var writerBinary: URL { Bundle.module.bundleURL.deletingLastPathComponent().appendingPathComponent("WorkstationWriter") }

    func requireBinary() throws -> URL {
        let w = writerBinary
        try #require(FileManager.default.isExecutableFile(atPath: w.path), "WorkstationWriter not built at \(w.path)")
        return w
    }

    func h(_ s: String) -> String { FileHasher.sha256(Data(s.utf8)) }

    func probe(_ root: URL, outside: URL, port: UInt16, trash: URL? = nil) throws -> [String: Int32] {
        let p = Process()
        p.executableURL = try requireBinary()
        p.arguments = [WriterSandbox.probeArgument, root.path, outside.path, String(port)] + (trash.map { [$0.path] } ?? [])
        p.environment = [:]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return try JSONDecoder().decode([String: Int32].self, from: data)
    }

    /// A local TCP listener (127.0.0.1:<port>), to show the denial is the sandbox and not a closed port.
    func listener() -> (fd: Int32, port: UInt16) {
        let s = socket(AF_INET, SOCK_STREAM, 0)
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        listen(s, 4)
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(s, $0, &len) } }
        return (s, UInt16(bigEndian: addr.sin_port))
    }

    func connectWorks(_ port: UInt16) -> Bool {
        let s = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(s) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        return withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } } == 0
    }

    @Test func profileIsExactlyTheReviewedOne() {
        #expect(WriterSandbox.profile == """
        (version 1)
        (deny default)
        (allow file-read*)
        (allow file-write* (subpath (param "ROOT")))
        (allow file-write* (subpath (param "TRASH")))
        (allow sysctl-read)
        (deny network*)
        """)
        #expect(WriterSandbox.trashDirectory(for: URL(fileURLWithPath: NSTemporaryDirectory()))?.path.hasSuffix(".Trash") == true,
                "the boot volume's Trash is ~/.Trash")
    }

    /// (a) writes inside ROOT succeed through the real child.
    @Test func childAppliesTheBatchInsideItsFolder() async throws {
        let w = try requireBinary()
        let root = TempDir("sandbox-root")
        root.write("a.txt", "old\n")
        let batch = WriteBatch(root: root.url.path, items: [.write("a.txt", data: Data("new\n".utf8), expected: h("old\n")),
                                                             .write("deep/er/b.txt", data: Data("b\n".utf8), expected: nil)])
        let (r, status) = try ChildProcessWriter.run(w, batch, [:])
        #expect(status == 0)
        #expect(r.applied == ["a.txt", "deep/er/b.txt"] && r.refused.isEmpty)
        #expect(root.read("a.txt") == "new\n" && root.read("deep/er/b.txt") == "b\n")
        // The async LocalWriting path the app uses.
        let viaApp = try await ChildProcessWriter(executable: w).apply(WriteBatch(root: root.url.path, items: [.write("c.txt", data: Data("c".utf8), expected: nil)]))
        #expect(viaApp.applied == ["c.txt"])
        // The writer's own checks still apply inside the sandbox.
        let stale = try ChildProcessWriter.run(w, WriteBatch(root: root.url.path, items: [.write("a.txt", data: Data("x".utf8), expected: h("old\n"))]), [:]).result
        #expect(stale.applied.isEmpty && root.read("a.txt") == "new\n")
    }

    /// (b) a write outside ROOT fails with EPERM; (c) network is denied; the Trash rule allows moves into TRASH only.
    @Test func osDeniesWritesOutsideTheFolderAndNetwork() throws {
        let root = TempDir("sandbox-root"), outside = TempDir("sandbox-outside"), trash = TempDir("sandbox-trash")
        let (fd, port) = listener()
        defer { close(fd) }
        #expect(connectWorks(port), "control: the port accepts connections outside the sandbox")
        let r = try probe(root.url, outside: outside.url.appendingPathComponent("escape.txt"), port: port, trash: trash.url)
        #expect(r["sandbox"] == 0)
        #expect(r["insideWrite"] == 0, "inside ROOT: allowed")
        #expect(r["outsideWrite"] == EPERM, "outside ROOT: \(r)")
        #expect(!outside.exists("escape.txt"))
        #expect(r["network"] == EPERM, "network: \(r)")
        #expect(r["trashMove"] == 0, "moving into the Trash: allowed")
        #expect(trash.exists("probe-trash.txt") && !root.exists("probe-trash.txt"))
        // Without a Trash allowance for that folder, the same move is denied.
        let r2 = try probe(root.url, outside: outside.url.appendingPathComponent("escape2.txt"), port: port)
        #expect(r2["outsideWrite"] == EPERM)
    }

    /// (d) when the sandbox can't be applied, the batch is refused and nothing is written.
    @Test func sandboxFailureRefusesTheBatch() throws {
        let w = try requireBinary()
        let root = TempDir("sandbox-root")
        let batch = WriteBatch(root: root.url.path, items: [.write("a.txt", data: Data("x".utf8), expected: nil)])
        let (r, status) = try ChildProcessWriter.run(w, batch, [WriterSandbox.breakProfileVariable: "1"])
        #expect(status == WriterSandbox.sandboxFailureStatus)
        #expect(r.applied.isEmpty && r.refused.first?.reason.contains("could not restrict itself") == true)
        #expect(!root.exists("a.txt"))
    }

    @Test func rootsThatWouldDefeatTheSandboxAreRefused() throws {
        let w = try requireBinary()
        for root in ["/", NSHomeDirectory(), "/usr/local", "/private/var"] {
            let (r, status) = try ChildProcessWriter.run(w, WriteBatch(root: root, items: [.write("x.txt", data: Data("x".utf8), expected: nil)]), [:])
            #expect(status != 0 && r.applied.isEmpty, "\(root) must be refused")
        }
        #expect(WriterSandbox.isAcceptableRoot("/Users/me/code/sample-app"))
        #expect(WriterSandbox.isAcceptableRoot("/Volumes/Data/projects"))
        #expect(!WriterSandbox.isAcceptableRoot("/Users"))
    }

    @Test func trashMovesKeepBothFiles() throws {
        let root = TempDir("trash-root"), trash = TempDir("trash-dir")
        root.write("a.txt", "one")
        root.write("sub/a.txt", "two")
        trash.write("a.txt", "already in the trash")
        let r = WriteBatchExecutor.execute(WriteBatch(root: root.url.path, items: [.delete("a.txt", expected: h("one")), .delete("sub/a.txt", expected: h("two"))]),
                                           deleteMode: .trashDirectory(trash.url))
        #expect(r.applied == ["a.txt", "sub/a.txt"])
        #expect(trash.read("a.txt") == "already in the trash" && trash.read("a 2.txt") == "one" && trash.read("a 3.txt") == "two")
        let none = WriteBatchExecutor.execute(WriteBatch(root: root.url.path, items: [.write("b.txt", data: Data("b".utf8), expected: nil)]), deleteMode: .refuse)
        #expect(none.applied == ["b.txt"], "writes still work without a Trash")
        let refused = WriteBatchExecutor.execute(WriteBatch(root: root.url.path, items: [.delete("b.txt", expected: h("b"))]), deleteMode: .refuse)
        #expect(refused.applied.isEmpty && root.exists("b.txt"))
    }
}
