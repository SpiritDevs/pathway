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
    @State private var updates: PathwayEnvironmentUpdateModel
    @State private var showingNotes = false
    @State private var confirmingUpdate = false

    init(client: PathwayAdministrationClient) {
        self.client = client
        _updates = State(initialValue: PathwayEnvironmentUpdateModel(client: client))
    }

    var body: some View {
        List {
            versionSection
            Section {
                NavigationLink { PathwayAdministrationSettingsView(client: client) } label: { Label("Environment preferences", systemImage: "slider.horizontal.3") }
                NavigationLink { PathwayAdministrationSettingsView(client: client, sourceControl: true) } label: { Label("Source control settings", systemImage: "arrow.triangle.branch") }
                NavigationLink { PathwayAdministrationProjectsView(client: client) } label: { Label("Projects", systemImage: "folder") }
                NavigationLink { PathwayAdministrationProvidersView(client: client) } label: { Label("Providers", systemImage: "cpu") }
                NavigationLink { PathwayAdministrationSchedulesView(client: client) } label: { Label("Scheduled tasks", systemImage: "clock") }
                NavigationLink { PathwayAdministrationUsageView(client: client) } label: { Label("Usage & limits", systemImage: "chart.bar") }
                NavigationLink { PathwayAdministrationConnectionView(client: client) } label: { Label("Connection & diagnostics", systemImage: "network") }
            }
        }
        .navigationTitle(client.environment.environment.label)
        .task { await updates.refresh() }
        .sheet(isPresented: $showingNotes) {
            PathwayReleaseNotesSheet(version: updates.availableVersion ?? updates.version,
                                     notes: updates.check?.releaseNotes ?? [])
        }
        .confirmationDialog("Update \(client.environment.environment.label)?", isPresented: $confirmingUpdate, titleVisibility: .visible) {
            Button("Update to \(updates.availableVersion ?? "")") { Task { await updates.update() } }
            Button("Cancel", role: .cancel) { }
        } message: { Text("The environment restarts to finish the update. Running agent turns may be interrupted.") }
    }

    private var versionSection: some View {
        Section {
            LabeledContent("Version", value: updates.version)
            HStack {
                versionStatus
                Spacer()
                Button("Check now") { Task { await updates.checkNow() } }
                    .buttonStyle(.borderless)
                    .disabled(updates.phase != .idle)
            }
            if updates.availableVersion != nil {
                HStack(spacing: 12) {
                    if updates.canUpdate {
                        Button { confirmingUpdate = true } label: { Label("Update", systemImage: "arrow.down.circle") }
                            .buttonStyle(.borderedProminent)
                            .disabled(updates.phase != .idle)
                    }
                    Button { showingNotes = true } label: { Label("Notes", systemImage: "doc.text") }
                        .buttonStyle(.bordered)
                }
            }
        } header: {
            Text("Version")
        } footer: {
            if let error = updates.error { Text(error).foregroundStyle(.red) }
            else if let hint = updates.updateHint { Text(hint) }
        }
    }

    @ViewBuilder private var versionStatus: some View {
        switch updates.phase {
        case .checking: Label { Text("Checking for updates") } icon: { ProgressView() }
        case .updating: Label { Text("Updating to \(updates.availableVersion ?? "")") } icon: { ProgressView() }
        case .idle:
            if let available = updates.availableVersion {
                Text("Version \(available) available").foregroundStyle(.tint)
            } else {
                Text(updates.message ?? "Check for a newer version").foregroundStyle(.secondary)
            }
        }
    }
}

private struct PathwayReleaseNotesSheet: View {
    let version: String
    let notes: [PathwayServerUpdateCheck.ReleaseNote]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if notes.isEmpty {
                    ContentUnavailableView("No release notes", systemImage: "doc.text",
                        description: Text("No notes were published for version \(version)."))
                }
                ForEach(notes) { note in
                    Section(note.version) {
                        ForEach(Array(note.items.enumerated()), id: \.offset) { _, item in
                            Text(item).textSelection(.enabled)
                        }
                    }
                }
            }
            .navigationTitle("Release notes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
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
