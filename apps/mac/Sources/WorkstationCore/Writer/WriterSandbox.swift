import Darwin
import Foundation

/// The OS restriction of the writer: every approved batch runs in a fresh `WorkstationWriter --apply`
/// process that, before touching any file, sandboxes itself to the batch's one linked folder.
///
///     (version 1)
///     (deny default)
///     (allow file-read*)
///     (allow file-write* (subpath (param "ROOT")))
///     (allow file-write* (subpath (param "TRASH")))
///     (allow sysctl-read)
///     (deny network*)
///
/// `ROOT` = the real path of the linked folder (temp files for atomic renames live inside it),
/// `TRASH` = the user's Trash for the folder's volume (`~/.Trash`, or `.Trashes/<uid>` on another
/// volume): the only place outside ROOT it may write, so deletions can be moved there. If the
/// sandbox can't be applied the batch is refused; there is no unrestricted fallback.
public enum WriterSandbox {
    public static let profile = """
    (version 1)
    (deny default)
    (allow file-read*)
    (allow file-write* (subpath (param "ROOT")))
    (allow file-write* (subpath (param "TRASH")))
    (allow sysctl-read)
    (deny network*)
    """

    /// Test-only: makes the profile unparsable so the failure path can be exercised. It can only
    /// break the sandbox, never loosen it, and the XPC service starts the child with an empty
    /// environment, so it can't be set in the app.
    public static let breakProfileVariable = "WORKSTATION_WRITER_TEST_BREAK_PROFILE"
    public static let applyArgument = "--apply"
    public static let probeArgument = "--probe"
    /// Exit status of `--apply` when the sandbox could not be applied (the batch is refused).
    public static let sandboxFailureStatus: Int32 = 3

    /// The user's Trash for the volume holding `root` (resolved, created if needed).
    public static func trashDirectory(for root: URL) -> URL? {
        guard let t = try? FileManager.default.url(for: .trashDirectory, in: .userDomainMask, appropriateFor: root, create: true) else { return nil }
        return URL(fileURLWithPath: WriteBatchExecutor.realPath(t.path), isDirectory: true)
    }

    /// Roots that would make the sandbox meaningless are refused outright: `/`, top-level folders
    /// and the home folder itself.
    public static func isAcceptableRoot(_ realRoot: String) -> Bool {
        let comps = realRoot.split(separator: "/")
        guard comps.count >= 2 else { return false }
        let home = WriteBatchExecutor.realPath(NSHomeDirectory())
        if realRoot == home { return false }
        let system = ["System", "usr", "bin", "sbin", "Library", "Applications", "private", "cores", "dev", "opt"]
        if comps.count == 2 && system.contains(String(comps[0])) { return false }
        if ["System", "usr", "bin", "sbin", "dev"].contains(String(comps[0])) { return false }
        return true
    }

    private typealias InitWithParameters = @convention(c) (UnsafePointer<CChar>, UInt64, UnsafePointer<UnsafePointer<CChar>?>,
                                                           UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Int32
    private typealias FreeError = @convention(c) (UnsafeMutablePointer<CChar>?) -> Void

    /// Applies the profile to the calling process. nil = restricted now; otherwise why not.
    public static func apply(root: String, trash: String, profile: String = WriterSandbox.profile) -> String? {
        let RTLD_DEFAULT = UnsafeMutableRawPointer(bitPattern: -2)
        guard let sym = dlsym(RTLD_DEFAULT, "sandbox_init_with_parameters") else { return "sandbox_init_with_parameters is unavailable" }
        let initFn = unsafeBitCast(sym, to: InitWithParameters.self)
        let freeFn = dlsym(RTLD_DEFAULT, "sandbox_free_error").map { unsafeBitCast($0, to: FreeError.self) }
        // Types spelled out: older Swift compilers cannot infer them through strdup's C signature.
        let keysAndValues: [String] = ["ROOT", root, "TRASH", trash]
        let strings: [UnsafeMutablePointer<CChar>?] = keysAndValues.map { (s: String) -> UnsafeMutablePointer<CChar>? in strdup(s) }
        defer { strings.forEach { free($0) } }
        var params: [UnsafePointer<CChar>?] = strings.map { (p: UnsafeMutablePointer<CChar>?) -> UnsafePointer<CChar>? in p.map { UnsafePointer($0) } }
        params.append(nil)
        var err: UnsafeMutablePointer<CChar>?
        let rc = params.withUnsafeBufferPointer { buf in
            profile.withCString { initFn($0, 0, buf.baseAddress!, &err) }
        }
        if rc == 0 { return nil }
        let message = err.map { String(cString: $0) } ?? "error \(rc)"
        if let err { freeFn?(err) }
        return message
    }

    /// `WorkstationWriter --apply`: batch JSON on stdin → restrict to its root → execute → result JSON.
    public static func runApply(input: Data, environment: [String: String]) -> (result: WriteBatchResult, status: Int32) {
        guard let batch = try? JSONDecoder().decode(WriteBatch.self, from: input) else {
            return (WriteBatchResult(refused: [WriteRefusal(path: "", reason: "malformed batch")]), 2)
        }
        func refuseAll(_ reason: String) -> WriteBatchResult {
            WriteBatchResult(refused: batch.items.map { WriteRefusal(path: $0.path, reason: reason) })
        }
        let checked = WriteBatchExecutor.validateRoot(batch.root)
        guard let root = checked.url else { return (refuseAll(checked.problem ?? "invalid folder"), 2) }
        guard isAcceptableRoot(root.path) else { return (refuseAll("the writer does not write into \(root.path)"), 2) }
        let trash = trashDirectory(for: root)
        let profile = environment[breakProfileVariable] == "1" ? "(version 1) (this is not a profile" : Self.profile
        // A Trash path that does not exist when there is no Trash: deletions are then refused.
        if let problem = apply(root: root.path, trash: trash?.path ?? root.appendingPathComponent(".workstation-no-trash").path, profile: profile) {
            return (refuseAll("the writer could not restrict itself to this folder (\(problem)): nothing was written"), sandboxFailureStatus)
        }
        let mode: WriteBatchExecutor.DeleteMode = trash.map { .trashDirectory($0) } ?? .refuse
        return (WriteBatchExecutor.execute(batch, deleteMode: mode), 0)
    }

    /// Self-test (`WorkstationWriter --probe ROOT OUTSIDE PORT [TRASH]`): applies the same sandbox for
    /// ROOT, then tries a write inside ROOT, a write to OUTSIDE, a TCP connection to
    /// 127.0.0.1:PORT and: with TRASH (a stand-in for the Trash, so tests never touch the real
    /// one): moving a file from ROOT into TRASH. Values are 0 (succeeded) or the errno.
    /// `--apply` never takes a Trash path: it always uses the real Trash for the folder's volume.
    public static func runProbe(root: String, outside: String, port: UInt16, trash trashOverride: String? = nil) -> [String: Int32] {
        var out: [String: Int32] = [:]
        let realRoot = WriteBatchExecutor.realPath(root)
        let trash = trashOverride.map(WriteBatchExecutor.realPath) ?? trashDirectory(for: URL(fileURLWithPath: realRoot))?.path ?? realRoot + "/.workstation-no-trash"
        if let problem = apply(root: realRoot, trash: trash) {
            FileHandle.standardError.write(Data("sandbox: \(problem)\n".utf8))
            out["sandbox"] = 1
            return out
        }
        out["sandbox"] = 0
        func tryWrite(_ path: String) -> Int32 {
            let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
            if fd < 0 { return errno }
            _ = "probe".withCString { write(fd, $0, 5) }
            close(fd)
            return 0
        }
        out["insideWrite"] = tryWrite(realRoot + "/probe-inside.txt")
        out["outsideWrite"] = tryWrite(outside)
        let s = socket(AF_INET, SOCK_STREAM, 0)
        if s < 0 {
            out["network"] = errno
        } else {
            var addr = sockaddr_in()
            addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = port.bigEndian
            addr.sin_addr.s_addr = inet_addr("127.0.0.1")
            let rc = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
            out["network"] = rc == 0 ? 0 : errno
            close(s)
        }
        if trashOverride != nil {
            let src = realRoot + "/probe-trash.txt"
            out["trashMove"] = tryWrite(src) == 0 ? (rename(src, trash + "/probe-trash.txt") == 0 ? 0 : errno) : -1
        }
        return out
    }
}

/// Runs each approved batch in a fresh `WorkstationWriter --apply` child (stdin: batch, stdout:
/// result) that restricts itself to the batch's folder. Used by the XPC service inside the app,
/// by `swift run` builds (the writer binary next to the app binary), and by tests.
public struct ChildProcessWriter: LocalWriting {
    public let executable: URL
    /// The child's whole environment (empty in the app).
    public var environment: [String: String]

    public init(executable: URL, environment: [String: String] = [:]) {
        self.executable = executable
        self.environment = environment
    }

    /// `WorkstationWriter` next to the running executable (a `swift run` / `.build` layout).
    public static func sibling(of executable: URL? = Bundle.main.executableURL) -> ChildProcessWriter? {
        guard let dir = executable?.deletingLastPathComponent() else { return nil }
        let w = dir.appendingPathComponent("WorkstationWriter")
        return FileManager.default.isExecutableFile(atPath: w.path) ? ChildProcessWriter(executable: w) : nil
    }

    public func apply(_ batch: WriteBatch) async throws -> WriteBatchResult {
        let exe = executable, env = environment
        return try await offloadBlocking { try Self.run(exe, batch, env).result }
    }

    /// Synchronous run; also returns the exit status (tests).
    public static func run(_ executable: URL, _ batch: WriteBatch, _ environment: [String: String]) throws -> (result: WriteBatchResult, status: Int32) {
        let p = Process()
        p.executableURL = executable
        p.arguments = [WriterSandbox.applyArgument]
        p.environment = environment
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        p.standardInput = stdin
        p.standardOutput = stdout
        p.standardError = stderr
        try p.run()
        let payload = try JSONEncoder().encode(batch)
        let writer = Thread {
            try? stdin.fileHandleForWriting.write(contentsOf: payload)
            try? stdin.fileHandleForWriting.close()
        }
        writer.start()
        let out = stdout.fileHandleForReading.readDataToEndOfFile()
        let err = stderr.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard let result = try? JSONDecoder().decode(WriteBatchResult.self, from: out) else {
            let why = String(decoding: err, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw HubError.blocked("the writer failed (exit \(p.terminationStatus))\(why.isEmpty ? "" : ": \(why)"): nothing was written")
        }
        return (result, p.terminationStatus)
    }
}
