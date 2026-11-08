import Foundation

/// protocol `LargeFileUploadResponse`. On completion `result` is the sync write's outcome, as a
/// `SyncResult` entry would report it (a conflict is a 200 with status `conflict`; 409 only means
/// an offset mismatch), and `localCommit` the server's `local` commit after it.
public struct LargeFileUploadResponse: Codable, Equatable, Sendable {
    public struct Result: Codable, Equatable, Sendable {
        public var status: SyncResultStatus
        public var reason: String?
        public init(status: SyncResultStatus, reason: String? = nil) { self.status = status; self.reason = reason }
    }
    public var path: String
    public var received: Int64
    public var complete: Bool
    public var result: Result?
    public var localCommit: String?
    public init(path: String, received: Int64, complete: Bool, result: Result? = nil, localCommit: String? = nil) {
        self.path = path; self.received = received; self.complete = complete; self.result = result; self.localCommit = localCommit
    }
}

/// A file > `MAX_SYNC_FILE_BYTES` decided `sync`: uploaded whole, in order, in
/// `LARGE_FILE_CHUNK_BYTES` chunks (ROUTES.projectLargeFile), never through the git path.
public struct LargeFile: Equatable, Sendable {
    public var path: String
    public var sha256: String
    public var size: Int64
    public var mode: Int
    /// The real sha256 of the version this Mac last saw on the server (nil = a new file).
    public var baseHash: String?
    /// "Keep mine" after a conflict.
    public var force = false
    public init(path: String, sha256: String, size: Int64, mode: Int, baseHash: String? = nil, force: Bool = false) {
        self.path = path; self.sha256 = sha256; self.size = size; self.mode = mode; self.baseHash = baseHash; self.force = force
    }
    public var manifestEntry: ManifestEntry { ManifestEntry(path: path, hash: sha256, size: size, mode: mode) }
}

public enum LargeFileUploader {
    /// protocol `LARGE_FILE_CHUNK_BYTES`.
    public static let chunkBytes: Int64 = 16 * 1024 * 1024

    /// The chunk ranges from `offset` on.
    public static func chunks(size: Int64, from offset: Int64 = 0, chunk: Int64 = chunkBytes) -> [Range<Int64>] {
        var out: [Range<Int64>] = []
        var o = max(0, offset)
        while o < size {
            let end = min(size, o + chunk)
            out.append(o..<end)
            o = end
        }
        return out
    }

    /// Reads one chunk (never the whole file).
    static func read(_ url: URL, _ range: Range<Int64>) throws -> Data {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        try h.seek(toOffset: UInt64(range.lowerBound))
        return try h.read(upToCount: Int(range.count)) ?? Data()
    }

    /// Uploads `file` from `root`: asks the hub how much it already holds, then sends the rest
    /// chunk by chunk; a 409 resumes from the hub's `received`. The file must still have the
    /// size it had when hashed (else `changed`). Cancellable between chunks. Returns the
    /// completing response (its `result` is the sync write's outcome).
    @discardableResult
    public static func upload(_ file: LargeFile, root: URL, projectId: String, transport: SyncTransport,
                              chunk: Int64 = chunkBytes, progress: @escaping @Sendable (Int64) -> Void = { _ in }) async throws -> LargeFileUploadResponse {
        let url = root.appendingPathComponent(file.path)
        var offset = (try? await transport.largeFileProgress(projectId: projectId, file: file))?.received ?? 0
        if offset > file.size { offset = 0 }
        progress(offset)
        var attempts = 0
        while offset < file.size {
            try Task.checkCancellation()
            guard case .file(let size, _, _) = LocalEntry.stat(url), size == file.size else { throw LargeFileError.changed(file.path) }
            let range = offset..<min(file.size, offset + chunk)
            let data = try await offloadBlocking { try read(url, range) }
            let r = try await transport.uploadLargeChunk(projectId: projectId, file: file, offset: offset, data: data)
            if r.complete { progress(file.size); return r }
            if r.received == offset + Int64(data.count) {
                offset = r.received
                attempts = 0
            } else {
                // The hub holds something else (409): continue from what it has.
                attempts += 1
                guard attempts <= 3 else { throw LargeFileError.failed(file.path) }
                offset = min(r.received, file.size)
            }
            progress(offset)
        }
        // Nothing left to send (the hub held it all already): the completing write happens with an empty chunk.
        let r = try await transport.uploadLargeChunk(projectId: projectId, file: file, offset: file.size, data: Data())
        guard r.complete else { throw LargeFileError.failed(file.path) }
        progress(file.size)
        return r
    }
}

public enum LargeFileError: Error, Equatable, LocalizedError {
    case changed(String)
    case failed(String)
    public var errorDescription: String? {
        switch self {
        case .changed(let p): return "\(p) changed while it was uploading"
        case .failed(let p): return "\(p) could not be uploaded"
        }
    }
}

extension HubClient {
    func largeFileQuery(_ file: LargeFile, offset: Int64?) -> [(String, String)] {
        var q = [("path", file.path), ("sha256", file.sha256), ("size", String(file.size))]
        if let offset {
            q += [("mode", String(file.mode)), ("offset", String(offset)), ("baseHash", file.baseHash ?? "")]
            if file.force { q.append(("force", "true")) }
        }
        return q
    }

    public func largeFileProgress(projectId: String, file: LargeFile) async throws -> LargeFileUploadResponse {
        let (data, http) = try await perform(makeRequest(Routes.projectLargeFile(projectId, method: .GET, query: largeFileQuery(file, offset: nil))), accept: [404])
        if http.statusCode == 404 { return LargeFileUploadResponse(path: file.path, received: 0, complete: false) }
        do { return try JSONDecoder().decode(LargeFileUploadResponse.self, from: data) } catch { throw HubError.decoding("LargeFileUploadResponse") }
    }

    /// One chunk; a 409 answer (offset mismatch) is returned like a normal response.
    public func uploadLargeChunk(projectId: String, file: LargeFile, offset: Int64, data: Data) async throws -> LargeFileUploadResponse {
        let req = makeRequest(Routes.projectLargeFile(projectId, method: .PUT, query: largeFileQuery(file, offset: offset)),
                              body: data, contentType: "application/octet-stream", timeout: 600)
        let (body, _) = try await perform(req, accept: [409])   // 409: offset mismatch, resume from `received`
        do { return try JSONDecoder().decode(LargeFileUploadResponse.self, from: body) } catch { throw HubError.decoding("LargeFileUploadResponse") }
    }
}

extension HubClient {
    /// `GET raw` in HTTP Range chunks, streamed to `file` (never the whole body in memory).
    /// false = the server has no such file (404). A hub that ignores Range (200) is read in one go.
    public func downloadRaw(projectId: String, path: String, ref: String?, to file: URL, chunk: Int64 = LargeFileUploader.chunkBytes) async throws -> Bool {
        guard FileManager.default.createFile(atPath: file.path, contents: nil) else { throw HubError.transport("can't write \(file.lastPathComponent)") }
        let out = try FileHandle(forWritingTo: file)
        defer { try? out.close() }
        var offset: Int64 = 0
        var total: Int64?
        while total == nil || offset < total! {
            try Task.checkCancellation()
            var req = makeRequest(Routes.projectFileRaw(projectId, path: path, ref: ref), timeout: 300)
            req.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
            req.setValue("bytes=\(offset)-\(offset + chunk - 1)", forHTTPHeaderField: "Range")
            let (data, http) = try await perform(req, accept: [404, 416])
            switch http.statusCode {
            case 404: return false
            case 416: return true
            case 206:
                if let range = http.value(forHTTPHeaderField: "Content-Range"), let slash = range.lastIndex(of: "/"),
                   let t = Int64(range[range.index(after: slash)...]) { total = t }
                try out.write(contentsOf: data)
                offset += Int64(data.count)
                if total == nil || data.isEmpty { return true }
            default:
                try out.truncate(atOffset: 0)
                try out.write(contentsOf: data)
                return true
            }
        }
        return true
    }
}
