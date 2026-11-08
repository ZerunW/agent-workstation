import Foundation
import ServiceManagement

/// "Open at login" (Settings → General), behind a protocol so snapshots and tests never touch
/// the system's login items.
@MainActor
public protocol LaunchAtLoginControlling: AnyObject {
    /// Only a real `.app` bundle can be registered as a login item.
    var isAvailable: Bool { get }
    var isEnabled: Bool { get }
    func setEnabled(_ on: Bool) throws
}

/// `SMAppService.mainApp` (macOS 13+).
@MainActor
public final class SystemLaunchAtLogin: LaunchAtLoginControlling {
    public init() {}
    public var isAvailable: Bool { Bundle.main.bundleURL.pathExtension == "app" }
    public var isEnabled: Bool { isAvailable && SMAppService.mainApp.status == .enabled }
    public func setEnabled(_ on: Bool) throws {
        guard isAvailable else { return }
        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }
}

/// In-memory stand-in (tests, snapshots).
@MainActor
public final class StaticLaunchAtLogin: LaunchAtLoginControlling {
    public var isAvailable: Bool
    public private(set) var isEnabled: Bool
    public init(available: Bool = true, enabled: Bool = false) { isAvailable = available; isEnabled = enabled }
    public func setEnabled(_ on: Bool) throws { isEnabled = on }
}
