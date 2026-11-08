import Foundation

/// One parsed `.gitignore` line.
public struct IgnoreRule: Hashable, Sendable {
    public let source: String
    public let negated: Bool
    public let dirOnly: Bool
    /// Directory (relative to the sync root) of the `.gitignore` that defined it; "" = root.
    public let base: String
    public let regex: String

    public static func == (a: IgnoreRule, b: IgnoreRule) -> Bool { a.source == b.source && a.base == b.base }
    public func hash(into h: inout Hasher) { h.combine(source); h.combine(base) }
}

/// `.gitignore`-style matcher: `*`, `**`, `?`, `[...]`, `!` negation, trailing `/` for
/// directories, leading or middle `/` anchoring, nested `.gitignore` files (rules scoped to
/// their directory), last matching rule wins, and: as in git: a file inside an ignored
/// directory cannot be re-included. Any path component named `.git` is always ignored.
public struct IgnoreMatcher: Sendable {
    public static let defaultPatterns = [".git", "node_modules", "build", "dist", ".DS_Store", "__pycache__", ".venv", "target"]

    public private(set) var rules: [IgnoreRule] = []
    private var compiled: [NSRegularExpressionBox] = []

    public init(patterns: [String] = IgnoreMatcher.defaultPatterns) {
        add(patterns: patterns, base: "")
    }

    public mutating func add(gitignore text: String, base: String) {
        add(patterns: text.components(separatedBy: "\n"), base: base)
    }

    public mutating func add(patterns: [String], base: String) {
        for line in patterns {
            guard let rule = Self.parse(line, base: base) else { continue }
            guard let re = try? NSRegularExpression(pattern: rule.regex) else { continue }
            rules.append(rule)
            compiled.append(NSRegularExpressionBox(re))
        }
    }

    public static func isAlwaysExcluded(_ path: String) -> Bool {
        path.split(separator: "/").contains(".git")
    }

    /// `path` is relative to the sync root, `/`-separated, no leading slash.
    public func isIgnored(_ path: String, isDirectory: Bool) -> Bool {
        if Self.isAlwaysExcluded(path) { return true }
        let comps = path.split(separator: "/").map(String.init)
        var prefix = ""
        for (i, c) in comps.enumerated() {
            prefix = prefix.isEmpty ? c : prefix + "/" + c
            let last = i == comps.count - 1
            if matchSelf(prefix, isDirectory: last ? isDirectory : true) == true { return true }
        }
        return false
    }

    /// Evaluates rules against exactly this path (no ancestor check). nil = no rule matched.
    public func matchSelf(_ path: String, isDirectory: Bool) -> Bool? {
        var result: Bool?
        for (i, rule) in rules.enumerated() {
            if rule.dirOnly && !isDirectory { continue }
            let rel: String
            if rule.base.isEmpty {
                rel = path
            } else if path.hasPrefix(rule.base + "/") {
                rel = String(path.dropFirst(rule.base.count + 1))
            } else {
                continue
            }
            let range = NSRange(rel.startIndex..., in: rel)
            if compiled[i].re.firstMatch(in: rel, options: [.anchored], range: range) != nil {
                result = !rule.negated
            }
        }
        return result
    }

    // MARK: Parsing

    public static func parse(_ rawLine: String, base: String) -> IgnoreRule? {
        var line = rawLine
        if line.hasSuffix("\r") { line.removeLast() }
        // Trailing spaces are ignored unless escaped with a backslash.
        while line.hasSuffix(" ") && !line.hasSuffix("\\ ") { line.removeLast() }
        if line.hasSuffix("\\ ") { line = String(line.dropLast(2)) + " " }
        if line.isEmpty || line.hasPrefix("#") { return nil }
        let source = line
        var negated = false
        if line.hasPrefix("!") { negated = true; line.removeFirst() }
        else if line.hasPrefix("\\!") || line.hasPrefix("\\#") { line.removeFirst() }
        var dirOnly = false
        if line.hasSuffix("/") { dirOnly = true; while line.hasSuffix("/") { line.removeLast() } }
        if line.isEmpty { return nil }
        let anchored = line.contains("/")
        if line.hasPrefix("/") { line.removeFirst() }
        if line.isEmpty { return nil }
        let body = globToRegex(line)
        let regex = anchored ? "^" + body + "$" : "^(?:.*/)?" + body + "$"
        return IgnoreRule(source: source, negated: negated, dirOnly: dirOnly, base: base, regex: regex)
    }

    public static func globToRegex(_ glob: String) -> String {
        let chars = Array(glob)
        var out = ""
        var i = 0
        while i < chars.count {
            let c = chars[i]
            switch c {
            case "*":
                if i + 1 < chars.count && chars[i + 1] == "*" {
                    let atStart = i == 0 || chars[i - 1] == "/"
                    let j = i + 2
                    let atEnd = j == chars.count
                    let slashAfter = j < chars.count && chars[j] == "/"
                    if atStart && slashAfter { out += "(?:.*/)?"; i = j + 1; continue }   // "**/"
                    if atStart && atEnd { out += ".*"; i = j; continue }                 // "/**" or "**"
                    out += "[^/]*"; i = j; continue                                      // "a**b" ≈ "*"
                }
                out += "[^/]*"
            case "?":
                out += "[^/]"
            case "[":
                if let close = chars[(i + 1)...].firstIndex(of: "]"), close > i + 1 {
                    var cls = String(chars[(i + 1)..<close])
                    if cls.hasPrefix("!") { cls = "^" + cls.dropFirst() }
                    cls = cls.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "[", with: "\\[")
                    out += "[" + cls + "]"
                    i = close
                } else {
                    out += "\\["
                }
            case "\\":
                if i + 1 < chars.count {
                    out += NSRegularExpression.escapedPattern(for: String(chars[i + 1]))
                    i += 1
                }
            default:
                out += NSRegularExpression.escapedPattern(for: String(c))
            }
            i += 1
        }
        return out
    }
}

/// NSRegularExpression is thread-safe for matching; the box makes that explicit for Sendable.
struct NSRegularExpressionBox: @unchecked Sendable {
    let re: NSRegularExpression
    init(_ re: NSRegularExpression) { self.re = re }
}
