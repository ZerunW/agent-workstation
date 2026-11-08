import Foundation
@testable import WorkstationCore
import Testing

@Suite("Tailscale hint (host classification, app target)")
struct TailnetTests {
    @Test func tailnetAddresses() {
        for ip in ["100.64.0.0", "100.64.0.10", "100.127.255.255", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0:ab12::5"] {
            #expect(TailnetHost.isTailnetAddress(ip), "\(ip)")
        }
        for ip in ["100.63.255.255", "100.128.0.0", "192.168.1.50", "10.0.0.1", "127.0.0.1", "fd7a:115c:a1e1::1", "::1", "fe80::1", "nope", ""] {
            #expect(!TailnetHost.isTailnetAddress(ip), "\(ip)")
        }
    }

    @Test func hostClassification() {
        var asked: [String] = []
        let fake: (String) -> [String] = { h in
            asked.append(h)
            switch h {
            case "workstation.example.com": return ["100.64.0.10"]
            case "dual.example": return ["203.0.113.5", "fd7a:115c:a1e0::9"]
            case "nas.local": return ["192.168.1.20"]
            default: return []
            }
        }
        // IP literals: no lookup.
        #expect(TailnetHost.isTailnet(host: "100.64.0.10", resolve: fake))
        #expect(TailnetHost.isTailnet(host: "[fd7a:115c:a1e0::1]", resolve: fake))
        #expect(TailnetHost.isTailnet(host: "fd7a:115c:a1e0::1", resolve: fake))
        #expect(!TailnetHost.isTailnet(host: "192.168.1.50", resolve: fake), "LAN address → no hint")
        // *.ts.net: no lookup (MagicDNS names only resolve while Tailscale is up).
        #expect(TailnetHost.isTailnet(host: "workstation.tailnet-name.ts.net", resolve: fake))
        #expect(TailnetHost.isTailnet(host: "WORKSTATION.TAIL1234AB.TS.NET.", resolve: fake))
        #expect(asked.isEmpty)
        // Names: resolved.
        #expect(TailnetHost.isTailnet(host: "workstation.example.com", resolve: fake))
        #expect(TailnetHost.isTailnet(host: "dual.example", resolve: fake))
        #expect(!TailnetHost.isTailnet(host: "nas.local", resolve: fake), "LAN host → no hint")
        #expect(!TailnetHost.isTailnet(host: "unknown.example", resolve: fake))
        #expect(!TailnetHost.isTailnet(host: "notts.net.example", resolve: fake))
        #expect(!TailnetHost.isTailnet(host: "", resolve: fake))
        #expect(asked == ["workstation.example.com", "dual.example", "nas.local", "unknown.example", "notts.net.example"])
    }

    @Test func systemResolverReturnsNumericAddresses() {
        // Literals go through getaddrinfo without the network.
        #expect(TailnetHost.resolve("100.64.0.10") == ["100.64.0.10"])
        #expect(TailnetHost.resolve("::1").contains("::1"))
        #expect(TailnetHost.resolve("localhost").contains { $0 == "127.0.0.1" || $0 == "::1" })
    }

    @Test func buttonTarget() {
        let standalone = URL(fileURLWithPath: "/Applications/Tailscale.app")
        let store = URL(fileURLWithPath: "/Applications/Tailscale (Store).app")
        #expect(TailscaleApp.target { $0 == "io.tailscale.ipn.macsys" ? standalone : ($0 == "io.tailscale.ipn.macos" ? store : nil) } == .app(standalone))
        #expect(TailscaleApp.target { $0 == "io.tailscale.ipn.macos" ? store : nil } == .app(store))
        #expect(TailscaleApp.target { _ in nil } == .download)
        #expect(TailscaleApp.Target.app(store).buttonTitle == "Open Tailscale")
        #expect(TailscaleApp.Target.download.buttonTitle == "Get Tailscale")
        #expect(TailscaleApp.downloadURL.absoluteString == "https://tailscale.com/download")
    }
}
