import WorkstationCore
import SwiftUI

/// Hub address field + Connect / Apply. Used by the first-run sheet, Settings and the offline view.
struct HubAddressForm: View {
    @ObservedObject var shell: ShellModel
    var buttonTitle = "Connect"
    @ViewState private var address: String
    @ViewState private var busy = false
    @ViewState private var error: String?

    init(shell: ShellModel, buttonTitle: String = "Connect", address: String? = nil, error: String? = nil) {
        self.shell = shell
        self.buttonTitle = buttonTitle
        _address = ViewState(wrappedValue: address ?? shell.settings.hubURLString)
        _error = ViewState(wrappedValue: error)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                TextField("Hub address", text: $address, prompt: Text(AppSettings.defaultHubURL))
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(connect)
                    .accessibilityIdentifier("hubURL")
                Button(busy ? "Connecting…" : buttonTitle, action: connect)
                    .disabled(busy || address.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("hubURLConnect")
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .lineLimit(3)
            }
        }
    }

    func connect() {
        busy = true
        error = nil
        Task {
            do {
                try await shell.setHubURL(address)
            } catch let e as HubError {
                if case .invalidURL = e { self.error = "Enter an address like https://workstation.example-tailnet.ts.net" }
                else { self.error = e.localizedDescription }
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

/// First launch: where the hub is. The username is entered on the web app's own login page next.
public struct FirstRunView: View {
    @ObservedObject var shell: ShellModel
    let error: String?
    @ViewState private var tailscale: TailscaleStatus? = nil

    public init(shell: ShellModel, error: String? = nil) {
        self.shell = shell
        self.error = error
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                AppGlyph().frame(width: 44, height: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Welcome to Agent Workstation").font(.title2.weight(.semibold))
                    Text("Your remote coding workstation").foregroundStyle(.secondary)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Hub address").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                HubAddressForm(shell: shell, buttonTitle: "Connect", error: error)
                Text("The address of your server, for example https://workstation.example-tailnet.ts.net. You sign in on the next screen.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let tailscale {
                    Label(tailscale.summary, systemImage: "network").font(.caption).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(28)
        .frame(width: 480)
        .task { if tailscale == nil { tailscale = await TailscaleProbe.probe() } }
    }
}

/// Settings (⌘,): General (hub, notifications, login item) and Folders (linked folders).
public struct SettingsView: View {
    @ObservedObject var shell: ShellModel
    public init(shell: ShellModel) { self.shell = shell }

    public var body: some View {
        TabView {
            GeneralSettingsView(shell: shell)
                .tabItem { Label("General", systemImage: "gearshape") }
            LinkedFoldersView(shell: shell, projects: shell.projects, compact: true)
                .frame(minHeight: 420)
                .tabItem { Label("Folders", systemImage: "folder") }
        }
        .frame(width: 580)
    }
}

struct GeneralSettingsView: View {
    @ObservedObject var shell: ShellModel
    @ViewState private var notifications = true
    @ViewState private var launchAtLogin = false
    @ViewState private var loginError: String? = nil
    @ViewState private var loaded = false

    var body: some View {
        Form {
            Section("Hub") {
                HubAddressForm(shell: shell, buttonTitle: "Apply")
                LabeledContent("Status") { ConnectionLine(phase: shell.phase, username: shell.username) }
            }
            Section {
                Toggle("Notifications", isOn: $notifications)
                    .onChange(of: notifications) { _, v in if loaded { shell.settings.notificationsEnabled = v } }
                    .accessibilityIdentifier("notifications")
                Toggle("Open Agent Workstation at login", isOn: $launchAtLogin)
                    .disabled(!shell.deps.launchAtLogin.isAvailable)
                    .onChange(of: launchAtLogin) { _, v in setLaunchAtLogin(v) }
                    .accessibilityIdentifier("launchAtLogin")
                if let loginError { Text(loginError).font(.caption).foregroundStyle(Theme.danger) }
            } header: {
                Text("General")
            } footer: {
                Text("Notifications cover permission requests, finished turns, server storage and sync conflicts. Sign in, switch user and everything else live in the main window.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section {
                LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")
                LabeledContent("Protocol", value: "v\(WorkstationProtocol.protocolVersion)")
            }
        }
        .formStyle(.grouped)
        .onAppear {
            notifications = shell.settings.notificationsEnabled
            launchAtLogin = shell.deps.launchAtLogin.isEnabled
            loaded = true
        }
    }

    func setLaunchAtLogin(_ on: Bool) {
        guard loaded, on != shell.deps.launchAtLogin.isEnabled else { return }
        do {
            try shell.deps.launchAtLogin.setEnabled(on)
            loginError = nil
        } catch {
            loginError = error.localizedDescription
            launchAtLogin = shell.deps.launchAtLogin.isEnabled
        }
    }
}

struct ConnectionLine: View {
    let phase: ShellModel.Phase
    let username: String?

    var body: some View {
        switch phase {
        case .online:
            Label(username.map { "Connected · signed in as \($0)" } ?? "Connected · not signed in", systemImage: "checkmark.circle.fill")
                .foregroundStyle(Theme.success)
        case .connecting:
            Label("Connecting…", systemImage: "ellipsis.circle").foregroundStyle(.secondary)
        case .offline(let e):
            Label(e, systemImage: "xmark.circle.fill").foregroundStyle(Theme.danger).lineLimit(2)
        case .needsHubURL:
            Label("No hub address yet", systemImage: "info.circle").foregroundStyle(.secondary)
        }
    }
}
