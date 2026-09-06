import SwiftUI

struct PathwayAdministrationProvidersView: View {
    let client: PathwayAdministrationClient
    @State private var providers: [PathwayAdministrationProvider] = []
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            ForEach(providers) { provider in
                NavigationLink {
                    PathwayAdministrationProviderView(client: client, initialProvider: provider)
                } label: {
                    VStack(alignment: .leading) {
                        Text(provider.name)
                        Text("\(provider.status) · \(provider.auth.status) · \(provider.version ?? "not installed")").font(.caption).foregroundStyle(.secondary)
                        if let message = provider.unavailableReason ?? provider.message { Text(message).font(.caption).foregroundStyle(.orange) }
                    }
                }
            }
            if busy { ProgressView("Refreshing providers…") }
            Button("Refresh availability and sign-in status") { Task { await load(refresh: true) } }.disabled(busy)
        }.navigationTitle("Providers").task { await load(refresh: false) }.refreshable { await load(refresh: true) }
            .toolbar { NavigationLink { PathwayAdministrationProviderConfiguration(client: client) } label: { Image(systemName: "plus") }.accessibilityLabel("Add provider instance") }
    }
    private func load(refresh: Bool) async {
        busy = true; defer { busy = false }
        do {
            if refresh { _ = try await client.run("server.refreshProviders") }
            let config: PathwayAdministrationConfig = try await client.call("server.getConfig"); providers = config.providers; error = nil
        } catch { self.error = error.localizedDescription }
    }
}

struct PathwayAdministrationProviderView: View {
    let client: PathwayAdministrationClient
    let initialProvider: PathwayAdministrationProvider
    @State private var refreshedProvider: PathwayAdministrationProvider?
    @State private var flow: PathwayAdministrationAuthFlow?
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?
    @State private var confirmUpdate = false
    private var provider: PathwayAdministrationProvider { refreshedProvider ?? initialProvider }
    private var payload: [String: JSONValue] { ["provider": .string(provider.driver), "instanceId": .string(provider.instanceId)] }
    var body: some View {
        Form {
            Section("Status") {
                LabeledContent("Instance", value: provider.instanceId)
                LabeledContent("Availability", value: provider.availability ?? "available")
                LabeledContent("Status", value: provider.status)
                LabeledContent("Authentication", value: provider.auth.status)
                if let email = provider.auth.email { LabeledContent("Account", value: email) }
                if let message = provider.message ?? provider.unavailableReason { Text(message).foregroundStyle(.orange) }
                Button("Refresh") { Task { await refresh() } }
                NavigationLink("Instance settings") { PathwayAdministrationProviderConfiguration(client: client, provider: provider) }
            }
            if let error { Text(error).foregroundStyle(.red) }
            if let notice { Text(notice).foregroundStyle(.secondary) }
            if let flow {
                Section("Sign in") {
                    if let url = URL(string: flow.authorizationUrl), ["http", "https"].contains(url.scheme ?? "") { Link("Continue in browser", destination: url) }
                    if let userCode = flow.userCode { Text(userCode).font(.title.monospaced()).textSelection(.enabled) }
                    if flow.completion != "browser" { SecureField("Authorization code", text: $code).textInputAutocapitalization(.never).autocorrectionDisabled() }
                    Button(flow.completion == "browser" ? "I've completed sign-in" : "Complete sign-in") { Task { await complete() } }.disabled(flow.completion != "browser" && code.isEmpty)
                    Button("Cancel sign-in", role: .cancel) { Task { await cancel() } }
                }
            } else if provider.auth.supportsLogin == true && provider.availability != "unavailable" {
                Button("Sign in to provider") { Task { await start() } }
            }
            if provider.versionAdvisory?.canUpdate == true {
                Section("Provider update") {
                    if let message = provider.versionAdvisory?.message { Text(message) }
                    Button("Update provider on environment") { confirmUpdate = true }
                }
            } else if let command = provider.versionAdvisory?.updateCommand {
                Section("Host setup") { Text(command).font(.caption.monospaced()).textSelection(.enabled) }
            }
            Section("Available models") { ForEach(provider.models) { Text($0.name) } }
        }.navigationTitle(provider.name).disabled(busy)
            .confirmationDialog("Update this provider on the environment?", isPresented: $confirmUpdate) {
                Button("Update provider") { Task { await update() } }; Button("Cancel", role: .cancel) { }
            }
    }
    private func refresh() async {
        busy = true; defer { busy = false }
        do { _ = try await client.run("server.refreshProviders", ["instanceId": .string(provider.instanceId)]); let config: PathwayAdministrationConfig = try await client.call("server.getConfig"); refreshedProvider = config.providers.first { $0.id == initialProvider.id }; error = nil }
        catch { self.error = error.localizedDescription }
    }
    private func start() async {
        busy = true; defer { busy = false }
        do { flow = try await client.call("server.startProviderAuthentication", payload); error = nil }
        catch { self.error = error.localizedDescription }
    }
    private func complete() async {
        guard let flow else { return }; busy = true
        do {
            var values = payload; values["flowId"] = .string(flow.flowId)
            if flow.completion != "browser" { values["authorizationCode"] = .string(code) }
            _ = try await client.run("server.completeProviderAuthentication", values)
            self.flow = nil; code = ""; notice = "Sign-in completed"; error = nil
        } catch { self.error = error.localizedDescription }
        let actionError = error
        busy = false; await refresh()
        if let actionError { error = actionError }
    }
    private func cancel() async {
        guard let flow else { return }; busy = true; defer { busy = false }
        do { var values = payload; values["flowId"] = .string(flow.flowId); _ = try await client.run("server.cancelProviderAuthentication", values); self.flow = nil; code = "" }
        catch { self.error = error.localizedDescription }
    }
    private func update() async {
        busy = true
        do { _ = try await client.run("server.updateProvider", payload); notice = "Provider update requested"; error = nil }
        catch { self.error = error.localizedDescription }
        let actionError = error
        busy = false; await refresh()
        if let actionError { error = actionError }
    }
}

struct PathwayAdministrationProviderConfiguration: View {
    let client: PathwayAdministrationClient
    var provider: PathwayAdministrationProvider?
    @Environment(\.dismiss) private var dismiss
    @State private var instanceID = ""
    @State private var name = ""
    @State private var driver = "codex"
    @State private var binaryPath = ""
    @State private var enabled = true
    @State private var loaded = false
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Form {
            if let error { Text(error).foregroundStyle(.red) }
            TextField("Instance ID", text: $instanceID).autocorrectionDisabled().textInputAutocapitalization(.never).disabled(provider != nil)
            TextField("Display name", text: $name)
            Picker("Provider", selection: $driver) { ForEach(["codex", "claudeAgent", "cursor", "grok", "opencode"], id: \.self) { Text($0).tag($0) } }.disabled(provider != nil)
            Toggle("Enabled", isOn: $enabled)
            TextField("Binary path on environment (optional)", text: $binaryPath).autocorrectionDisabled().textInputAutocapitalization(.never)
            Text("Paths refer to the connected environment. Existing instance options and secret environment values are preserved.").font(.caption).foregroundStyle(.secondary)
            Button("Save instance") { Task { await save() } }.disabled(!loaded || instanceID.range(of: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$", options: .regularExpression) == nil)
        }.navigationTitle(provider == nil ? "Add provider" : "Instance settings").disabled(busy)
            .task {
                guard !loaded else { return }
                if let provider { instanceID = provider.instanceId; driver = provider.driver; name = provider.name; enabled = provider.enabled }
                do {
                    let value = try await client.run("server.getSettings")
                    binaryPath = value.objectValue?["providerInstances"]?.objectValue?[instanceID]?.objectValue?["config"]?.objectValue?["binaryPath"]?.stringValue ?? ""
                    loaded = true
                } catch { self.error = error.localizedDescription }
            }
    }
    private func save() async {
        busy = true; defer { busy = false }
        do {
            let current = try await client.run("server.getSettings")
            var instances = current.objectValue?["providerInstances"]?.objectValue ?? [:]
            if provider == nil && instances[instanceID] != nil { throw PathwayRPCError.remote("This instance ID already exists. Choose another ID.") }
            var instance = instances[instanceID]?.objectValue ?? ["driver": .string(driver)]
            // A missing legacy default must be edited on a host that has migrated it; creating an empty envelope would reset its options.
            if provider != nil && instances[instanceID] == nil { throw PathwayRPCError.remote("This environment has not migrated the provider's instance settings. Update the environment before editing this instance.") }
            instance["enabled"] = .bool(enabled)
            if !name.isEmpty { instance["displayName"] = .string(name) } else { instance.removeValue(forKey: "displayName") }
            var config = instance["config"]?.objectValue ?? [:]; config["binaryPath"] = .string(binaryPath); instance["config"] = .object(config)
            instances[instanceID] = .object(instance)
            _ = try await client.run("server.updateSettings", ["patch": .object(["providerInstances": .object(instances)])]); dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
