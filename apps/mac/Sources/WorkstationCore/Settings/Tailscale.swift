import Foundation

/// Tailscale detection for the Settings / onboarding screens. The hub is normally reached
/// over Tailscale, but "not installed" is informational and never blocks anything.
public enum TailscaleStatus: Equatable, Sendable {
    case notInstalled
    case stopped(String)
    case running(peer: TailscalePeer?)
    case error(String)

    public var summary: String {
        switch self {
        case .notInstalled: return "Tailscale not installed: LAN mode"
        case .stopped(let s): return "Tailscale is \(s.lowercased()): LAN mode"
        case .running(let peer?):
            return "\(peer.hostName) is \(peer.online ? "online" : "offline") on your tailnet" + (peer.ip.map { " (\($0))" } ?? "")
        case .running(nil): return "Tailscale running: server not found on the tailnet"
        case .error(let e): return "Tailscale status unavailable: \(e)"
        }
    }

    public var serverOnline: Bool? {
        if case .running(let p?) = self { return p.online }
        return nil
    }
}

public struct TailscalePeer: Equatable, Sendable {
    public var hostName: String
    public var dnsName: String
    public var online: Bool
    public var ip: String?
}

public enum TailscaleProbe {
    public static let cliPath = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"

    public static func probe(hint: String = "workstation", cliPath: String = cliPath) async -> TailscaleStatus {
        guard FileManager.default.isExecutableFile(atPath: cliPath) else { return .notInstalled }
        return await Task.detached {
            do {
                let out = try ProcessRunner.run(cliPath, ["status", "--json"], timeout: 8)
                if out.stdout.isEmpty { return .error(out.stderr.isEmpty ? "no output" : out.stderr) }
                return parse(out.stdout, hint: hint)
            } catch {
                return .error(error.localizedDescription)
            }
        }.value
    }

    /// Parses `tailscale status --json`; the server is the first peer whose HostName or
    /// DNSName contains `hint` (case-insensitive).
    public static func parse(_ data: Data, hint: String) -> TailscaleStatus {
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: data) else { return .error("unreadable status JSON") }
        let backend = json["BackendState"]?.stringValue ?? "Unknown"
        guard backend == "Running" else { return .stopped(backend) }
        let needle = hint.lowercased()
        for (_, peer) in (json["Peer"]?.objectValue ?? [:]).sorted(by: { $0.key < $1.key }) {
            let host = peer["HostName"]?.stringValue ?? ""
            let dns = peer["DNSName"]?.stringValue ?? ""
            if host.lowercased().contains(needle) || dns.lowercased().contains(needle) {
                return .running(peer: TailscalePeer(hostName: host, dnsName: dns, online: peer["Online"]?.boolValue ?? false,
                                                    ip: peer["TailscaleIPs"]?[0]?.stringValue))
            }
        }
        return .running(peer: nil)
    }
}
