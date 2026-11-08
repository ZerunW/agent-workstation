import AppKit
import Foundation
import UserNotifications

/// System notifications + Dock badge, behind a protocol so tests can record calls.
@MainActor
public protocol Notifier: AnyObject {
    var appIsActive: Bool { get }
    /// Asks for alert + sound permission (the shell calls it once, on the first launch).
    func requestAuthorization()
    func post(id: String, title: String, body: String, userInfo: [String: String])
    /// Removes a delivered notification (a permission request answered in the web app).
    func withdraw(id: String)
    func setBadge(_ count: Int)
}

/// Live implementation. `UNUserNotificationCenter` aborts when the process has no bundle
/// identifier (e.g. `swift run`), so it is only used inside a real `.app` bundle.
@MainActor
public final class SystemNotifier: NSObject, Notifier, UNUserNotificationCenterDelegate {
    public var onActivate: ((_ userInfo: [String: String]) -> Void)?
    public var enabled: () -> Bool = { true }

    private var center: UNUserNotificationCenter? {
        guard Bundle.main.bundleIdentifier != nil, Bundle.main.bundleURL.pathExtension == "app" else { return nil }
        return UNUserNotificationCenter.current()
    }

    public var appIsActive: Bool { NSApp?.isActive ?? false }

    /// Receives clicks (every launch; asking for permission is separate).
    public func attach() {
        center?.delegate = self
    }

    public func requestAuthorization() {
        guard let center else { return }
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    public func post(id: String, title: String, body: String, userInfo: [String: String]) {
        guard enabled(), let center else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.userInfo = userInfo
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    public func withdraw(id: String) {
        center?.removeDeliveredNotifications(withIdentifiers: [id])
    }

    public func setBadge(_ count: Int) {
        NSApp?.dockTile.badgeLabel = count > 0 ? String(count) : nil
    }

    nonisolated public func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                                   withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo.reduce(into: [String: String]()) { acc, kv in
            if let k = kv.key as? String, let v = kv.value as? String { acc[k] = v }
        }
        Task { @MainActor in
            NSApp.activate(ignoringOtherApps: true)
            self.onActivate?(info)
        }
        completionHandler()
    }

    nonisolated public func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                                   withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}

/// Records notifications instead of showing them (tests, snapshots).
@MainActor
public final class RecordingNotifier: Notifier {
    public struct Posted: Equatable {
        public var id: String
        public var title: String
        public var body: String
        public var userInfo: [String: String]
    }
    public private(set) var posted: [Posted] = []
    public private(set) var withdrawn: [String] = []
    public private(set) var badge = 0
    public private(set) var authorizationRequests = 0
    public var appIsActive = false

    public init() {}
    public func requestAuthorization() { authorizationRequests += 1 }
    public func post(id: String, title: String, body: String, userInfo: [String: String]) {
        posted.append(Posted(id: id, title: title, body: body, userInfo: userInfo))
    }
    public func withdraw(id: String) { withdrawn.append(id) }
    public func setBadge(_ count: Int) { badge = count }
}
