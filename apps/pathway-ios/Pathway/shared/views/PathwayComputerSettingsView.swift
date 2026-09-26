import SwiftUI

/// Settings → Computer: this device's Computer control default, and each environment's desktop.
struct PathwayComputerSettingsSection: View {
    let environments: [PathwayCompanyEnvironment]
    let client: (PathwayCompanyEnvironment) -> PathwayAdministrationClient
    @AppStorage(PathwayAgentThreadModel.computerControlDefaultsKey) private var controlEnabled = false

    var body: some View {
        Section {
            Toggle("Let the agent use the desktop in any chat", isOn: $controlEnabled)
            ForEach(environments) { environment in
                NavigationLink(environment.environment.label) { PathwayComputerSettingsView(client: client(environment)) }
            }
        } header: {
            Text("Computer")
        } footer: {
            Text("Enable Computer by default in any chat you send from this device. Leave this off and use /computer-use for one request without adding Computer tools to ordinary turns.")
        }
    }
}

/// One environment's desktop: its status, who may use it and how much it asks first.
/// Grants, the pointer and the preview size live on the host.
struct PathwayComputerSettingsView: View {
    let client: PathwayAdministrationClient
    @Environment(PathwayAppModel.self) private var appModel
    @State private var status: String?
    @State private var supported: Bool?
    @State private var policyReadable = false
    @State private var canWrite = false
    @State private var accessPolicy = "any-operator"
    @State private var autonomy = "per-task"
    @State private var error: String?
    @State private var busy = false
    /// The newest load or save; an older load's reads never land over it.
    @State private var loadID = 0

    var body: some View {
        Form {
            if let error { Text(error).foregroundStyle(.red) }
            if supported == false {
                Text("Computer control needs an environment running on macOS, or a Wayland desktop on Linux.").foregroundStyle(.secondary)
            } else if supported == true {
                Section("Status") {
                    LabeledContent("Desktop", value: status ?? "Unknown")
                }
                Section {
                    policyPicker("Who can use this computer", selection: $accessPolicy, options: PathwayComputerPolicy.accessPolicies, key: "accessPolicy")
                    policyPicker("Computer autonomy", selection: $autonomy, options: PathwayComputerPolicy.autonomies, key: "autonomy")
                } header: {
                    Text("Access and oversight")
                } footer: {
                    Text(policyFooter)
                }
                Section {
                    Text("Screen Recording and Accessibility are granted on the host itself, as are the agent pointer, the preview size and the action history. Physical Escape on the host stops input at once; from here, use Stop.")
                        .foregroundStyle(.secondary)
                } header: { Text("On the host") }
            }
        }
        .navigationTitle("Computer")
        .overlay { if busy { ProgressView() } }
        .refreshable { await load() }
        .task { await load() }
    }

    private var policyFooter: String {
        var lines = [
            PathwayComputerPolicy.accessPolicies.first { $0.id == accessPolicy }?.detail,
            PathwayComputerPolicy.autonomies.first { $0.id == autonomy }?.detail,
            "Anyone who can operate a thread can watch the preview, answer approvals and press Stop."
        ].compactMap(\.self)
        if !policyReadable { lines.insert("Update this environment's Pathway server to change these settings.", at: 0) }
        else if !canWrite { lines.insert("Only an admin connection (access:write) can change these settings.", at: 0) }
        return lines.joined(separator: " ")
    }

    private func policyPicker(_ title: String, selection: Binding<String>, options: [PathwayComputerPolicy.Option], key: String) -> some View {
        Picker(title, selection: Binding(get: { selection.wrappedValue }, set: { value in
            let previous = selection.wrappedValue
            selection.wrappedValue = value
            Task { await save(key, value, revert: { selection.wrappedValue = previous }) }
        })) {
            ForEach(options) { Text($0.label).tag($0.id) }
        }
        .disabled(!policyReadable || !canWrite || busy)
    }

    private func load() async {
        loadID += 1
        let id = loadID
        busy = true; defer { if id == loadID { busy = false } }
        do {
            let config = try await client.run("server.getConfig").objectValue ?? [:]
            let supports = PathwayComputerAccess.supportsComputer(serverConfig: config)
            var settings: JSONValue?, status: String?, canWrite = false
            if supports {
                settings = try await client.run("server.getSettings")
                if PathwayComputerAccess.servesComputer(serverConfig: config) {
                    status = (try? await client.run("computer.getStatus")).map(PathwayComputerPolicy.summary)
                }
                canWrite = (try? await appModel.connect?.prepare(environment: client.environment))?.scopes.contains("access:write") == true
            }
            guard id == loadID, !Task.isCancelled else { return }
            supported = supports
            policyReadable = PathwayComputerAccess.servesComputer(serverConfig: config)
            if let settings { apply(settings) }
            self.status = status
            self.canWrite = canWrite
            error = nil
        } catch is CancellationError {} catch { if id == loadID { self.error = error.localizedDescription } }
    }

    private func save(_ key: String, _ value: String, revert: () -> Void) async {
        loadID += 1
        busy = true; defer { busy = false }
        do {
            apply(try await client.run("server.updateSettings", ["patch": .object(["computer": .object([key: .string(value)])])]))
            error = nil
        } catch { revert(); self.error = error.localizedDescription }
    }

    private func apply(_ settings: JSONValue) {
        let computer = settings.objectValue?["computer"]?.objectValue
        accessPolicy = computer?["accessPolicy"]?.stringValue ?? accessPolicy
        autonomy = computer?["autonomy"]?.stringValue ?? autonomy
    }
}
