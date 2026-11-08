import Foundation

/// One line of a unified diff.
public struct DiffLine: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable { case context, added, removed }
    public var kind: Kind
    public var oldNumber: Int?
    public var newNumber: Int?
    public var text: String
    public var id: String { "\(oldNumber ?? 0):\(newNumber ?? 0):\(kind)" }
}

public struct DiffHunk: Equatable, Sendable, Identifiable {
    public var oldStart: Int, oldCount: Int, newStart: Int, newCount: Int
    public var lines: [DiffLine]
    public var header: String { "@@ -\(oldStart),\(oldCount) +\(newStart),\(newCount) @@" }
    public var id: String { header }
}

/// What the review window shows for one file: a git-style unified diff, or: for binary or
/// very large files: only the size / hash change.
public struct DiffDocument: Equatable, Sendable {
    public var path: String
    public var oldSize: Int64?
    public var newSize: Int64?
    public var oldHash: String?
    public var newHash: String?
    public var isBinary: Bool
    public var tooLarge: Bool
    public var hunks: [DiffHunk]

    public var additions: Int { hunks.reduce(0) { $0 + $1.lines.filter { $0.kind == .added }.count } }
    public var deletions: Int { hunks.reduce(0) { $0 + $1.lines.filter { $0.kind == .removed }.count } }
    public var identical: Bool { oldHash == newHash }

    public init(path: String, oldSize: Int64?, newSize: Int64?, oldHash: String?, newHash: String?, isBinary: Bool, tooLarge: Bool, hunks: [DiffHunk]) {
        self.path = path; self.oldSize = oldSize; self.newSize = newSize; self.oldHash = oldHash; self.newHash = newHash
        self.isBinary = isBinary; self.tooLarge = tooLarge; self.hunks = hunks
    }
}

/// Myers line diff with 3 lines of context (prefix/suffix trimmed first).
public enum LineDiff {
    public static let maxLines = 50_000
    public static let maxEdits = 6_000

    /// `old` / `new` nil = the file does not exist on that side.
    public static func document(path: String, old: Data?, new: Data?, context: Int = 3) -> DiffDocument {
        var doc = DiffDocument(path: path, oldSize: old.map { Int64($0.count) }, newSize: new.map { Int64($0.count) },
                               oldHash: old.map(FileHasher.sha256), newHash: new.map(FileHasher.sha256),
                               isBinary: false, tooLarge: false, hunks: [])
        guard doc.oldHash != doc.newHash else { return doc }
        guard let a = text(old), let b = text(new) else { doc.isBinary = true; return doc }
        let la = lines(a), lb = lines(b)
        guard la.count <= maxLines, lb.count <= maxLines, let hunks = hunks(la, lb, context: context) else { doc.tooLarge = true; return doc }
        doc.hunks = hunks
        return doc
    }

    static func text(_ d: Data?) -> String? {
        guard let d else { return "" }
        if d.prefix(8000).contains(0) { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func lines(_ s: String) -> [String] {
        if s.isEmpty { return [] }
        var out = s.components(separatedBy: "\n")
        if out.last == "" { out.removeLast() }
        return out
    }

    enum Op: Equatable { case equal, insert, delete }

    /// Hunks for line arrays; nil when the edit distance is too large to show usefully.
    public static func hunks(_ a: [String], _ b: [String], context: Int = 3) -> [DiffHunk]? {
        guard let ops = script(a, b) else { return nil }
        // ops: sequence of (op, oldIndex, newIndex)
        var rows: [(Op, Int, Int)] = []
        var i = 0, j = 0
        for op in ops {
            rows.append((op, i, j))
            switch op {
            case .equal: i += 1; j += 1
            case .delete: i += 1
            case .insert: j += 1
            }
        }
        var hunks: [DiffHunk] = []
        var k = 0
        while k < rows.count {
            guard rows[k].0 != .equal else { k += 1; continue }
            let start = max(0, k - context)
            var end = k
            // Extend while changes are within 2*context of each other.
            var last = k
            while end < rows.count {
                if rows[end].0 != .equal { last = end }
                if end - last > 2 * context { break }
                end += 1
            }
            end = min(rows.count, last + context + 1)
            var lines: [DiffLine] = []
            for r in rows[start..<end] {
                switch r.0 {
                case .equal: lines.append(DiffLine(kind: .context, oldNumber: r.1 + 1, newNumber: r.2 + 1, text: a[r.1]))
                case .delete: lines.append(DiffLine(kind: .removed, oldNumber: r.1 + 1, newNumber: nil, text: a[r.1]))
                case .insert: lines.append(DiffLine(kind: .added, oldNumber: nil, newNumber: r.2 + 1, text: b[r.2]))
                }
            }
            let first = rows[start]
            let oldCount = lines.filter { $0.kind != .added }.count
            let newCount = lines.filter { $0.kind != .removed }.count
            hunks.append(DiffHunk(oldStart: oldCount == 0 ? first.1 : first.1 + 1, oldCount: oldCount,
                                  newStart: newCount == 0 ? first.2 : first.2 + 1, newCount: newCount, lines: lines))
            k = end
        }
        return hunks
    }

    /// Edit script via Myers' O(ND) algorithm on interned lines.
    static func script(_ a: [String], _ b: [String]) -> [Op]? {
        var prefix = 0
        while prefix < a.count && prefix < b.count && a[prefix] == b[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < a.count - prefix && suffix < b.count - prefix && a[a.count - 1 - suffix] == b[b.count - 1 - suffix] { suffix += 1 }
        var table: [String: Int] = [:]
        func intern(_ s: String) -> Int { if let v = table[s] { return v }; let v = table.count; table[s] = v; return v }
        let x = a[prefix..<(a.count - suffix)].map(intern)
        let y = b[prefix..<(b.count - suffix)].map(intern)
        guard let middle = myers(x, y) else { return nil }
        return Array(repeating: .equal, count: prefix) + middle + Array(repeating: .equal, count: suffix)
    }

    static func myers(_ a: [Int], _ b: [Int]) -> [Op]? {
        let n = a.count, m = b.count
        if n == 0 { return Array(repeating: .insert, count: m) }
        if m == 0 { return Array(repeating: .delete, count: n) }
        let maxD = min(n + m, maxEdits)
        let offset = maxD + 1
        var v = [Int](repeating: 0, count: 2 * maxD + 3)
        var trace: [[Int]] = []
        var found = false
        outer: for d in 0...maxD {
            trace.append(v)
            for k in stride(from: -d, through: d, by: 2) {
                var x: Int
                if k == -d || (k != d && v[offset + k - 1] < v[offset + k + 1]) { x = v[offset + k + 1] } else { x = v[offset + k - 1] + 1 }
                var y = x - k
                while x < n && y < m && a[x] == b[y] { x += 1; y += 1 }
                v[offset + k] = x
                if x >= n && y >= m { found = true; break outer }
            }
        }
        guard found else { return nil }
        // Backtrack.
        var ops: [Op] = []
        var x = n, y = m
        for d in stride(from: trace.count - 1, through: 0, by: -1) {
            let vd = trace[d]
            let k = x - y
            let prevK: Int
            if k == -d || (k != d && vd[offset + k - 1] < vd[offset + k + 1]) { prevK = k + 1 } else { prevK = k - 1 }
            let prevX = vd[offset + prevK]
            let prevY = prevX - prevK
            while x > prevX && y > prevY { ops.append(.equal); x -= 1; y -= 1 }
            if d > 0 {
                if x == prevX { ops.append(.insert); y -= 1 } else { ops.append(.delete); x -= 1 }
            }
        }
        return ops.reversed()
    }
}
