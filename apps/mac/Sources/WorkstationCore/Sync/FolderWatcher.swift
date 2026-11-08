import CoreServices
import Foundation

/// FSEvents watcher for one folder: file-level events, 0.5 s stream latency, plus a
/// trailing debounce (default 500 ms, flushed at the latest after `maxWait`). Delivers
/// relative paths; `rescan == true` when FSEvents says events were coalesced/dropped
/// (MustScanSubDirs, root changed) and a full reconcile is needed.
public final class FolderWatcher: @unchecked Sendable {
    public typealias Handler = @Sendable (_ paths: Set<String>, _ rescan: Bool) -> Void

    public let root: URL
    private let rootPaths: [String]
    private let latency: CFTimeInterval
    private let debounce: TimeInterval
    private let maxWait: TimeInterval
    private let queue = DispatchQueue(label: "io.github.agentworkstation.fsevents")
    private let handler: Handler
    private var stream: FSEventStreamRef?
    private var pending = Set<String>()
    private var pendingRescan = false
    private var firstPendingAt: Date?
    private var flushItem: DispatchWorkItem?

    public init(root: URL, latency: TimeInterval = 0.5, debounce: TimeInterval = 0.5, maxWait: TimeInterval = 3, handler: @escaping Handler) {
        self.root = root
        // FSEvents reports real paths (/private/var/... for /var/...), while Foundation's
        // resolvingSymlinksInPath() strips "/private". Match every spelling.
        let real = Self.realPath(root.path)
        var paths = [real, root.standardizedFileURL.path, root.resolvingSymlinksInPath().path]
        for p in paths where p.hasPrefix("/private/") { paths.append(String(p.dropFirst("/private".count))) }
        for p in paths where !p.hasPrefix("/private/") && ["/var/", "/tmp/", "/etc/"].contains(where: { p.hasPrefix($0) }) { paths.append("/private" + p) }
        self.rootPaths = Array(Set(paths)).sorted { $0.count > $1.count }
        self.latency = latency
        self.debounce = debounce
        self.maxWait = maxWait
        self.handler = handler
    }

    deinit { stop() }

    static func realPath(_ p: String) -> String {
        guard let r = realpath(p, nil) else { return p }
        defer { free(r) }
        return String(cString: r)
    }

    @discardableResult
    public func start() -> Bool {
        guard stream == nil else { return true }
        var ctx = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
        let flags = UInt32(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes |
                           kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagWatchRoot)
        let callback: FSEventStreamCallback = { _, info, count, eventPaths, eventFlags, _ in
            guard let info else { return }
            let me = Unmanaged<FolderWatcher>.fromOpaque(info).takeUnretainedValue()
            let paths = unsafeBitCast(eventPaths, to: NSArray.self) as? [String] ?? []
            var flags: [FSEventStreamEventFlags] = []
            for i in 0..<count { flags.append(eventFlags[i]) }
            me.received(paths: paths, flags: flags)
        }
        let watched = Self.realPath(root.path)
        guard let s = FSEventStreamCreate(kCFAllocatorDefault, callback, &ctx, [watched] as CFArray,
                                          FSEventStreamEventId(kFSEventStreamEventIdSinceNow), latency, flags) else { return false }
        FSEventStreamSetDispatchQueue(s, queue)
        guard FSEventStreamStart(s) else { FSEventStreamInvalidate(s); FSEventStreamRelease(s); return false }
        stream = s
        return true
    }

    public func stop() {
        guard let s = stream else { return }
        FSEventStreamStop(s)
        FSEventStreamInvalidate(s)
        FSEventStreamRelease(s)
        stream = nil
        // Pending flush items hold `self` weakly; cancelling here is enough (no queue.sync,
        // which would deadlock if stop() were ever reached from the watcher queue).
        flushItem?.cancel()
    }

    /// Converts an absolute path reported by FSEvents to a root-relative one ("" = root).
    public func relativePath(_ absolute: String) -> String? {
        for r in rootPaths {
            if absolute == r { return "" }
            if absolute.hasPrefix(r + "/") { return String(absolute.dropFirst(r.count + 1)) }
        }
        return nil
    }

    // Called on `queue`.
    private func received(paths: [String], flags: [FSEventStreamEventFlags]) {
        for (i, p) in paths.enumerated() {
            let f = i < flags.count ? Int(flags[i]) : 0
            if f & (kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagRootChanged |
                    kFSEventStreamEventFlagUserDropped | kFSEventStreamEventFlagKernelDropped) != 0 {
                pendingRescan = true
            }
            guard let rel = relativePath(p) else { continue }
            if rel.isEmpty { continue }
            if IgnoreMatcher.isAlwaysExcluded(rel) { continue }
            pending.insert(rel)
        }
        scheduleFlush()
    }

    private func scheduleFlush() {
        guard !pending.isEmpty || pendingRescan else { return }
        if firstPendingAt == nil { firstPendingAt = Date() }
        flushItem?.cancel()
        let waited = Date().timeIntervalSince(firstPendingAt ?? Date())
        let delay = waited >= maxWait ? 0 : debounce
        let item = DispatchWorkItem { [weak self] in self?.flush() }
        flushItem = item
        queue.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private func flush() {
        let paths = pending, rescan = pendingRescan
        pending.removeAll(); pendingRescan = false; firstPendingAt = nil; flushItem = nil
        if paths.isEmpty && !rescan { return }
        handler(paths, rescan)
    }
}
