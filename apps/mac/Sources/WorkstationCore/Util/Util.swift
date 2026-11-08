import Foundation
import os

public let workstationLog = Logger(subsystem: "io.github.agentworkstation", category: "app")

/// Exponential backoff with an upper bound and optional jitter (0…1 fraction of the delay).
public struct Backoff: Sendable, Equatable {
    public var base: TimeInterval
    public var factor: Double
    public var maximum: TimeInterval

    public init(base: TimeInterval = 1, factor: Double = 2, maximum: TimeInterval = 30) {
        self.base = base; self.factor = factor; self.maximum = maximum
    }

    /// Delay before retry number `attempt` (0-based). `jitter` in 0…1 shortens the delay by up to that fraction.
    public func delay(attempt: Int, jitter: Double = 0) -> TimeInterval {
        let raw = base * pow(factor, Double(max(0, min(attempt, 30))))
        let capped = min(maximum, raw)
        return capped * (1 - min(1, max(0, jitter)) * 0.5)
    }
}

/// Runs an executable synchronously with a timeout; returns (status, stdout, stderr).
public enum ProcessRunner {
    public struct Output: Sendable { public var status: Int32; public var stdout: Data; public var stderr: String }

    public static func run(_ executable: String, _ args: [String], environment: [String: String]? = nil,
                           currentDirectory: URL? = nil, timeout: TimeInterval = 60) throws -> Output {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = args
        if let environment { p.environment = environment }
        if let currentDirectory { p.currentDirectoryURL = currentDirectory }
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        try p.run()
        // The child has its own copies; close ours or the readers below never see EOF.
        try? out.fileHandleForWriting.close()
        try? err.fileHandleForWriting.close()
        // Drain pipes concurrently so a chatty child cannot block on a full pipe.
        var outData = Data(), errData = Data()
        let group = DispatchGroup()
        group.enter(); DispatchQueue.global().async { outData = out.fileHandleForReading.readDataToEndOfFile(); group.leave() }
        group.enter(); DispatchQueue.global().async { errData = err.fileHandleForReading.readDataToEndOfFile(); group.leave() }
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { usleep(20_000) }
        if p.isRunning { p.terminate(); throw HubError.transport("\(executable) timed out") }
        group.wait()
        return Output(status: p.terminationStatus, stdout: outData, stderr: String(decoding: errData, as: UTF8.self))
    }
}

/// Runs blocking work (hashing a tree, tar) on a GCD thread instead of the Swift
/// concurrency cooperative pool, which must never be blocked for long.
public func offloadBlocking<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { cont in
        DispatchQueue.global(qos: .utility).async {
            do { cont.resume(returning: try work()) } catch { cont.resume(throwing: error) }
        }
    }
}

public enum Formatters {
    public static func bytes(_ n: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: n, countStyle: .file)
    }

    public static func parseISO(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withFullDate]
        return f.date(from: s)
    }

    public static func iso(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }

    /// "in 2 h 14 min" / "in 3 d 4 h" / "now".
    public static func countdown(to date: Date, now: Date = Date()) -> String {
        let s = Int(date.timeIntervalSince(now))
        if s <= 0 { return "now" }
        let d = s / 86_400, h = (s % 86_400) / 3600, m = (s % 3600) / 60
        if d > 0 { return "in \(d) d \(h) h" }
        if h > 0 { return "in \(h) h \(m) min" }
        return "in \(max(1, m)) min"
    }

    /// Compact countdown for limit rows: "in 37m" / "in 2h 14m" / "in 3d 4h" / "now".
    public static func shortCountdown(to date: Date, now: Date = Date()) -> String {
        let s = Int(date.timeIntervalSince(now))
        if s <= 0 { return "now" }
        let d = s / 86_400, h = (s % 86_400) / 3600, m = (s % 3600) / 60
        if d > 0 { return "in \(d)d \(h)h" }
        if h > 0 { return "in \(h)h \(m)m" }
        return "in \(max(1, m))m"
    }

    /// The one meta line under a limit bar: "Resets in 37m · Oct 31, 03:20 PM".
    public static func resetLine(_ date: Date?, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        guard let date else { return "Reset time unknown" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "MMM d, hh:mm a"
        let when = shortCountdown(to: date, now: now)
        return when == "now" ? "Resets now · \(f.string(from: date))" : "Resets \(when) · \(f.string(from: date))"
    }

    public static func tokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
        return String(n)
    }

    /// Like `tokens` without a trailing ".0": "262.7k", "200k", "1M", "1.5M", "812".
    public static func compactTokens(_ n: Int) -> String {
        func trim(_ v: Double, _ unit: String) -> String {
            var s = String(format: "%.1f", v)
            if s.hasSuffix(".0") { s.removeLast(2) }
            return s + unit
        }
        if n >= 1_000_000 { return trim(Double(n) / 1_000_000, "M") }
        if n >= 1_000 { return trim(Double(n) / 1_000, "k") }
        return String(n)
    }

    /// "just now", "5 min ago", "3 h ago", "2 d ago", or "Oct 3".
    public static func ago(_ date: Date, now: Date = Date()) -> String {
        let s = Int(now.timeIntervalSince(date).rounded())
        if s < 60 { return "just now" }
        if s < 3600 { return "\(s / 60) min ago" }
        if s < 86_400 { return "\(s / 3600) h ago" }
        if s < 7 * 86_400 { return "\(s / 86_400) d ago" }
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f.string(from: date)
    }
}
