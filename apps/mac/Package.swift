// swift-tools-version: 5.9
//
// Agent Workstation: thin native macOS shell around the Agent Workstation web app.
//
// Build without Xcode (Command Line Tools only):
//   ./scripts/swiftpm.sh build -c release
//   ./scripts/swiftpm.sh test
// The wrapper adds `--build-system native` and the Swift Testing framework search
// paths that a CLT-only toolchain needs. With Xcode installed, plain `swift build`
// / `swift test` work, and `open Package.swift` opens the package in Xcode.
import PackageDescription

let package = Package(
    name: "AgentWorkstation",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "AgentWorkstation", targets: ["AgentWorkstation"]),
        .executable(name: "WorkstationWriter", targets: ["WorkstationWriter"]),
        .library(name: "WorkstationCore", targets: ["WorkstationCore"]),
        .library(name: "WorkstationUI", targets: ["WorkstationUI"]),
    ],
    targets: [
        // Networking, protocol models, WebSocket client, folder sync engine, settings, shell logic
        // (link policy, menu → route map, downloads, injected JavaScript).
        // Foundation / CryptoKit / CoreServices only: no AppKit, no SwiftUI.
        .target(
            name: "WorkstationCore",
            path: "Sources/WorkstationCore"
        ),
        // Main window (WKWebView + titlebar strip), first run, Settings, Linked Folders, notifications.
        .target(
            name: "WorkstationUI",
            dependencies: ["WorkstationCore"],
            path: "Sources/WorkstationUI"
        ),
        // The XPC service that alone writes into linked folders (approved batches only).
        // Bundled as Contents/XPCServices/WorkstationWriter.xpc by the packaging script.
        .executableTarget(
            name: "WorkstationWriter",
            dependencies: ["WorkstationCore"],
            path: "Sources/WorkstationWriter"
        ),
        // The app entry point (@main): kept tiny so everything else is testable.
        .executableTarget(
            name: "AgentWorkstation",
            dependencies: ["WorkstationCore", "WorkstationUI"],
            path: "Sources/AgentWorkstation"
        ),
        .testTarget(
            name: "WorkstationCoreTests",
            dependencies: ["WorkstationCore"],
            path: "Tests/WorkstationCoreTests",
            resources: [.copy("Fixtures")]
        ),
        // Offscreen snapshots of the native screens + shell flows against an in-process mock hub.
        .testTarget(
            name: "WorkstationUITests",
            dependencies: ["WorkstationCore", "WorkstationUI"],
            path: "Tests/WorkstationUITests"
        ),
    ]
)
