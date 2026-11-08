import Foundation

/// A call from the web Sync tab through `window.__workstationShell.sync` (handler `workstationSync`, with
/// reply). Everything in it is untrusted page input: checked here before anything runs.
public enum SyncBridgeRequest: Equatable, Sendable {
    case status(projectId: String)
    case pending(projectId: String)
    case list(projectId: String, dir: String)
    case decide(projectId: String, decisions: [SyncDecisionInput])
    case recheck(projectId: String, dir: String)

    public static let handlerName = "workstationSync"
    public static let maxDecisions = 10_000

    public var projectId: String {
        switch self {
        case .status(let p), .pending(let p), .list(let p, _), .decide(let p, _), .recheck(let p, _): return p
        }
    }

    /// - Parameter isLinked: the project is linked on this Mac (only those are served).
    public static func parse(_ v: JSONValue, isLinked: (String) -> Bool) -> Result<SyncBridgeRequest, SyncBridgeError> {
        guard let op = v["op"]?.stringValue else { return .failure(.invalid("op")) }
        guard let pid = v["projectId"]?.stringValue, pid.count <= 64, !pid.isEmpty,
              pid.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }) else { return .failure(.invalid("projectId")) }
        if op == "status" { return .success(.status(projectId: pid)) }
        guard isLinked(pid) else { return .failure(.notLinked) }
        func dir() -> String? {
            switch v["dir"] {
            case nil, .null?: return ""
            case .string(let d)?:
                let t = d.hasSuffix("/") ? String(d.dropLast()) : d
                return t.isEmpty || AcceptedReport.isSafeRelativePath(t) ? t : nil
            default: return nil
            }
        }
        switch op {
        case "pending": return .success(.pending(projectId: pid))
        case "list":
            guard let d = dir() else { return .failure(.invalid("dir")) }
            return .success(.list(projectId: pid, dir: d))
        case "recheck":
            guard let d = dir() else { return .failure(.invalid("dir")) }
            return .success(.recheck(projectId: pid, dir: d))
        case "decide":
            guard let list = v["decisions"]?.arrayValue, list.count <= maxDecisions else { return .failure(.invalid("decisions")) }
            var out: [SyncDecisionInput] = []
            for item in list {
                guard let path = item["path"]?.stringValue, AcceptedReport.isSafeRelativePath(path),
                      let kind = item["kind"]?.stringValue.flatMap(SyncKind.init(rawValue:)) else { return .failure(.invalid("decisions")) }
                let decision: SyncDecision?
                switch item["decision"] {
                case .null?: decision = nil
                case .string(let s)?:
                    guard let d = SyncDecision(rawValue: s) else { return .failure(.invalid("decisions")) }
                    decision = d
                default: return .failure(.invalid("decisions"))
                }
                out.append(SyncDecisionInput(path: path, kind: kind, decision: decision))
            }
            return .success(.decide(projectId: pid, decisions: out))
        default:
            return .failure(.invalid("op"))
        }
    }
}

public enum SyncBridgeError: Error, Equatable, LocalizedError {
    case invalid(String)
    case notLinked
    public var errorDescription: String? {
        switch self {
        case .invalid(let f): return "invalid \(f)"
        case .notLinked: return "not linked on this Mac"
        }
    }
}

extension JSONValue {
    /// Foundation objects for WebKit replies.
    public var foundationValue: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let n): return n
        case .string(let s): return s
        case .array(let a): return a.map(\.foundationValue)
        case .object(let o): return o.mapValues(\.foundationValue)
        }
    }
}
