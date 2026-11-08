import Foundation

/// Splits a file into `UPLOAD_CHUNK_BYTES` pieces. An empty file is one empty chunk
/// (so the hub still receives `X-Chunk-Total: 1` and creates the file).
public enum ChunkPlan {
    public static func ranges(totalBytes: Int64, chunkSize: Int = WorkstationProtocol.uploadChunkBytes) -> [Range<Int64>] {
        precondition(chunkSize > 0)
        if totalBytes <= 0 { return [0..<0] }
        var out: [Range<Int64>] = []
        var start: Int64 = 0
        let size = Int64(chunkSize)
        while start < totalBytes {
            let end = min(start + size, totalBytes)
            out.append(start..<end)
            start = end
        }
        return out
    }

    /// Headers for chunk `index` of an upload (see `UPLOAD_HEADERS`). The path is
    /// percent-encoded like JavaScript's `encodeURIComponent` so non-ASCII names survive.
    public static func headers(uploadId: String, path: String, index: Int, total: Int, totalBytes: Int64) -> [String: String] {
        [
            UploadHeaders.uploadId: uploadId,
            UploadHeaders.path: encodeURIComponent(path),
            UploadHeaders.chunkIndex: String(index),
            UploadHeaders.chunkTotal: String(total),
            UploadHeaders.totalBytes: String(totalBytes),
        ]
    }
}

/// JavaScript `encodeURIComponent`: escapes everything except A–Z a–z 0–9 - _ . ! ~ * ' ( ).
public func encodeURIComponent(_ s: String) -> String {
    var allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
    allowed.insert(charactersIn: "-_.!~*'()")
    return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
}

public extension HubClient {
    /// Chunked upload (`PUT /api/files/upload`) of a local file to `destPath` in the
    /// user's workspace (e.g. `inbox/report.pdf`). Returns the path the hub stored it at.
    func uploadFile(_ fileURL: URL, to destPath: String, progress: (@Sendable (Double) -> Void)? = nil) async throws -> String {
        let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let total = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        let ranges = ChunkPlan.ranges(totalBytes: total)
        let uploadId = UUID().uuidString.lowercased()
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        var finalPath = destPath
        for (i, r) in ranges.enumerated() {
            try handle.seek(toOffset: UInt64(r.lowerBound))
            let chunk = r.isEmpty ? Data() : (try handle.read(upToCount: Int(r.count)) ?? Data())
            var req = makeRequest(Routes.filesUpload(), body: chunk, contentType: "application/octet-stream",
                                  headers: ChunkPlan.headers(uploadId: uploadId, path: destPath, index: i, total: ranges.count, totalBytes: total),
                                  timeout: 300)
            if chunk.isEmpty { req.httpBody = Data() }
            let (data, _) = try await perform(req)
            if let resp = try? JSONDecoder().decode(UploadChunkResponse.self, from: data), let p = resp.path, resp.complete {
                finalPath = p
            }
            progress?(Double(i + 1) / Double(ranges.count))
        }
        return finalPath
    }
}
