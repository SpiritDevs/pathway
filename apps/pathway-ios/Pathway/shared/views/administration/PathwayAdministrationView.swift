import SwiftUI

struct PathwayAdministrationView: View {
    let environments: [PathwayCompanyEnvironment]
    let request: PathwayAdministrationRequest
    let http: PathwayAdministrationHTTP
    var cloudMutation: PathwayAdministrationCloudMutation?
    var body: some View {
        List {
            if environments.isEmpty {
                ContentUnavailableView("No environments connected", systemImage: "network", description: Text("Link a Pathway environment to your company to manage its projects, providers and scheduled work."))
            }
            ForEach(environments) { environment in
                NavigationLink {
                    PathwayAdministrationEnvironmentView(client: .init(environment: environment, request: request, http: http, cloudMutation: cloudMutation))
                } label: {
                    VStack(alignment: .leading) {
                        Text(environment.environment.label)
                        Text(environment.environment.managedEndpointAvailable ? "Available through Pathway Connect" : "Direct connection required").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }.navigationTitle("Environments & settings")
    }
}

struct PathwayAdministrationEnvironmentView: View {
    let client: PathwayAdministrationClient
    var body: some View {
        List {
            NavigationLink { PathwayAdministrationSettingsView(client: client) } label: { Label("Environment preferences", systemImage: "slider.horizontal.3") }
            NavigationLink { PathwayAdministrationSettingsView(client: client, sourceControl: true) } label: { Label("Source control settings", systemImage: "arrow.triangle.branch") }
            NavigationLink { PathwayAdministrationProjectsView(client: client) } label: { Label("Projects", systemImage: "folder") }
            NavigationLink { PathwayAdministrationProvidersView(client: client) } label: { Label("Providers", systemImage: "cpu") }
            NavigationLink { PathwayAdministrationSchedulesView(client: client) } label: { Label("Scheduled tasks", systemImage: "clock") }
            NavigationLink { PathwayAdministrationUsageView(client: client) } label: { Label("Usage & limits", systemImage: "chart.bar") }
            NavigationLink { PathwayAdministrationConnectionView(client: client) } label: { Label("Connection & diagnostics", systemImage: "network") }
        }.navigationTitle(client.environment.environment.label)
    }
}

struct PathwayAdministrationConnectionView: View {
    let client: PathwayAdministrationClient
    @State private var name = ""
    @State private var result: String?
    @State private var error: String?
    @State private var busy = false
    @State private var revoke = false
    @State private var serverVersion: String?
    var body: some View {
        Form {
            Section("Connection") {
                LabeledContent("Relay", value: client.environment.environment.relayLinkState)
                LabeledContent("Registration", value: client.environment.environment.state)
                LabeledContent("Version", value: serverVersion ?? client.environment.environment.descriptor.serverVersion)
                Button("Reconnect and test environment") { Task { await probe() } }.disabled(busy)
            }
            Section("Environment name") {
                TextField("Name", text: $name)
                Button("Save name") { Task { await rename() } }.disabled(busy)
            }
            if let result { Text(result).foregroundStyle(.secondary) }
            if let error { Text(error).foregroundStyle(.red) }
            Section("Diagnostics") {
                NavigationLink("Server diagnostics") { PathwayAdministrationDiagnosticsView(client: client) }
                Text("Environment ID: \(client.environment.environment.environmentId)").font(.caption.monospaced()).textSelection(.enabled)
                Text("Company: \(client.environment.companyId)").font(.caption.monospaced()).textSelection(.enabled)
                Text("Connection tests use this environment's authenticated Pathway Connect endpoint. Keep the host running and linked to this company.")
            }
            if client.cloudMutation != nil {
                Section {
                    Button("Revoke this company's environment access", role: .destructive) { revoke = true }.disabled(busy)
                } footer: { Text("This revokes the registration in this company. It does not unlink the machine from its owner's Pathway Connect account.") }
            }
        }.navigationTitle("Connection")
            .task { name = client.environment.environment.label; await probe() }
            .confirmationDialog("Revoke company access to this environment?", isPresented: $revoke) {
                Button("Revoke access", role: .destructive) { Task { await deactivate() } }
                Button("Cancel", role: .cancel) { }
            } message: { Text("Members of this company may lose access to projects and running work on this environment.") }
    }
    private func probe() async {
        busy = true; defer { busy = false }
        do {
            let config: PathwayAdministrationConfig = try await client.call("server.getConfig")
            serverVersion = config.environment.serverVersion
            result = "Connected. \(config.providers.count) provider instances reported."; error = nil
        } catch { self.error = error.localizedDescription; result = nil }
    }
    private func rename() async {
        busy = true; defer { busy = false }
        do { _ = try await client.run("server.updateSettings", ["patch": .object(["environmentName": .string(name)])]); result = "Name saved"; error = nil }
        catch { self.error = error.localizedDescription }
    }
    private func deactivate() async {
        guard let mutate = client.cloudMutation else { return }
        busy = true; defer { busy = false }
        do {
            _ = try await mutate("environments:deactivate", ["companyId": .string(client.environment.companyId), "environmentId": .string(client.environment.environment.environmentId)])
            result = "Company access revoked"; error = nil
        } catch { self.error = error.localizedDescription }
    }
}
