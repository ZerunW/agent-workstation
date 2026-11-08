import Foundation

/// Loop prevention for files the app itself writes (review accept, "keep Claude's",
/// restore). Before writing, the engine records `expected[path] = hash` (or `.deleted`);
/// when the watcher later reports that path, the event is dropped if the on-disk state
/// matches. A mismatch means the user changed the file afterwards, so the event is kept.
public final class EchoSuppressor: @unchecked Sendable {
    public enum Expectation: Equatable, Sendable {
        case content(String)
        case deleted
    }

    private var expected: [String: (Expectation, Date)] = [:]
    private let lock = NSLock()
    public var ttl: TimeInterval

    public init(ttl: TimeInterval = 120) { self.ttl = ttl }

    /// `hash == nil` means "we are about to delete this path".
    public func expect(_ path: String, hash: String?, now: Date = Date()) {
        lock.lock(); defer { lock.unlock() }
        expected[path] = (hash.map { .content($0) } ?? .deleted, now)
    }

    public func pending(_ path: String) -> Expectation? {
        lock.lock(); defer { lock.unlock() }
        return expected[path]?.0
    }

    public var count: Int { lock.lock(); defer { lock.unlock() }; return expected.count }

    /// True when the observed state (`observedHash == nil` → file absent) is exactly what
    /// we wrote; the expectation is consumed. Expired expectations never suppress.
    public func shouldSuppress(_ path: String, observedHash: String?, now: Date = Date()) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let (exp, at) = expected[path] else { return false }
        if now.timeIntervalSince(at) > ttl {
            expected.removeValue(forKey: path)
            return false
        }
        let observed: Expectation = observedHash.map { .content($0) } ?? .deleted
        if observed == exp {
            expected.removeValue(forKey: path)
            return true
        }
        return false
    }

    public func cancel(_ path: String) {
        lock.lock(); defer { lock.unlock() }
        expected.removeValue(forKey: path)
    }

    public func purgeExpired(now: Date = Date()) {
        lock.lock(); defer { lock.unlock() }
        expected = expected.filter { now.timeIntervalSince($0.value.1) <= ttl }
    }
}
