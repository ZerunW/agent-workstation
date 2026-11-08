import Darwin
import Foundation

/// Is the hub reached over Tailscale? Agent Workstation does not embed Tailscale: when such a hub is
/// unreachable, the offline state offers to open the official Tailscale app. Nothing here talks
/// to Tailscale (no CLI, no socket); it only looks at the address.
public enum TailnetHost {
    /// 100.64.0.0/10 (Tailscale's CGNAT range) or fd7a:115c:a1e0::/48 (its IPv6 range).
    public static func isTailnetAddress(_ ip: String) -> Bool {
        var v4 = in_addr()
        if inet_pton(AF_INET, ip, &v4) == 1 {
            let a = UInt32(bigEndian: v4.s_addr)
            return a & 0xFFC0_0000 == 0x6440_0000
        }
        var v6 = in6_addr()
        if inet_pton(AF_INET6, ip, &v6) == 1 {
            let b = withUnsafeBytes(of: v6) { Array($0) }
            return b[0...5] == [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0]
        }
        return false
    }

    /// An IP literal in a Tailscale range, a `*.ts.net` name, or a name that resolves to a
    /// Tailscale address (`resolve` = getaddrinfo; tests pass a fake).
    public static func isTailnet(host raw: String, resolve: (String) -> [String] = resolve) -> Bool {
        var host = raw.trimmingCharacters(in: .whitespaces).lowercased()
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        while host.hasSuffix(".") { host.removeLast() }
        guard !host.isEmpty else { return false }
        if isIPLiteral(host) { return isTailnetAddress(host) }
        if host == "ts.net" || host.hasSuffix(".ts.net") { return true }
        return resolve(host).contains(where: isTailnetAddress)
    }

    static func isIPLiteral(_ s: String) -> Bool {
        var v4 = in_addr(), v6 = in6_addr()
        return inet_pton(AF_INET, s, &v4) == 1 || inet_pton(AF_INET6, s, &v6) == 1
    }

    /// The numeric addresses of `host` from the system resolver (blocking; call off the main thread).
    public static func resolve(_ host: String) -> [String] {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, nil, &hints, &res) == 0, let first = res else { return [] }
        defer { freeaddrinfo(first) }
        var out: [String] = []
        var p: UnsafeMutablePointer<addrinfo>? = first
        while let ai = p {
            var buf = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(ai.pointee.ai_addr, ai.pointee.ai_addrlen, &buf, socklen_t(buf.count), nil, 0, NI_NUMERICHOST) == 0 {
                let s = String(cString: buf)
                // Drop an IPv6 zone ("fe80::1%en0").
                out.append(s.split(separator: "%").first.map(String.init) ?? s)
            }
            p = ai.pointee.ai_next
        }
        return out
    }
}

/// The official Tailscale app: open it if installed, else its download page.
public enum TailscaleApp {
    /// Standalone (Developer ID) build first, then the Mac App Store build.
    public static let bundleIdentifiers = ["io.tailscale.ipn.macsys", "io.tailscale.ipn.macos"]
    public static let downloadURL = URL(string: "https://tailscale.com/download")!

    public enum Target: Equatable, Sendable {
        case app(URL)
        case download

        public var buttonTitle: String {
            switch self {
            case .app: return "Open Tailscale"
            case .download: return "Get Tailscale"
            }
        }
    }

    /// `lookup` = NSWorkspace's application URL for a bundle identifier (tests pass a fake).
    public static func target(lookup: (String) -> URL?) -> Target {
        for id in bundleIdentifiers { if let url = lookup(id) { return .app(url) } }
        return .download
    }
}
