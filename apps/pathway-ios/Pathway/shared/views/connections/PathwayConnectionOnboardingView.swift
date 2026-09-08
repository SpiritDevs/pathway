import SwiftUI

struct PathwayConnectionOnboardingView: View {
    @Bindable var model: PathwayConnectionOnboardingModel
    let accountKey: String
    let companies: [PathwayCompany]
    var environments: [PathwayCompanyEnvironment] = []
    @State private var placementPreferences = PathwayEnvironmentPlacementPreferences.shared
    var roles: [String: [JSONValue]] = [:]
    var registrations: [String: [JSONValue]] = [:]
    @State private var address = ""
    @State private var pairingToken = ""
    @State private var companyID = ""
    @State private var selectedProjects: Set<String> = []
    @State private var managed = true
    @State private var removing: PathwayAccountEnvironment?
    @State private var unlinkServer = false
    @State private var confirmRegistration = false

    var body: some View {
        Form {
            if accountKey.isEmpty {
                ContentUnavailableView("Sign in to connect", systemImage: "person.crop.circle", description: Text("Connections are saved separately for each account."))
            } else {
                pairingSection
                if !model.directConnections.isEmpty { directSection }
                if let selected = model.selected { setupSection(selected) }
                accountSection
                placementSection
            }
            if model.busy {
                Section { ProgressView(model.progress ?? "Working") }
            }
            if let error = model.errorMessage {
                Section { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            }
            if let completed = model.completionMessage {
                Section { Label(completed, systemImage: "checkmark.circle").foregroundStyle(.green) }
            }
        }
        .navigationTitle("Connect a server")
        .disabled(model.busy)
        .task(id: accountKey) {
            address = ""
            pairingToken = ""
            selectedProjects = []
            await model.load(accountKey: accountKey)
            if companyID.isEmpty || !companies.contains(where: { $0.id == companyID }) { companyID = companies.first?.id ?? "" }
        }
        .onChange(of: model.selected?.id) { _, _ in selectedProjects = [] }
        .refreshable { await model.load(accountKey: accountKey) }
        .confirmationDialog("Remove from Pathway Connect?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            Button("Remove account connection", role: .destructive) {
                guard let target = removing else { return }
                removing = nil
                Task { await model.removeFromAccount(target) }
            }
        } message: {
            Text("This revokes the account link and managed tunnel. The server's local account configuration stays until you unlink it on the server.")
        }
        .confirmationDialog("Unlink this server?", isPresented: $unlinkServer) {
            Button("Unlink server and account", role: .destructive) { Task { await model.unlinkSelectedServer() } }
        } message: {
            Text("Stops the server's cloud publishing and tunnel for every device. Workspace projects and history remain in the workspace.")
        }
        .confirmationDialog("Register server with \(companyName)?", isPresented: $confirmRegistration) {
            Button("Register and add \(selectedProjects.count) projects") {
                Task { await model.finish(companyID: companyID, projectIDs: selectedProjects, roles: roles[companyID] ?? [], registrations: registrations[companyID] ?? [], managed: managed) }
            }
        } message: {
            Text("Selected projects and their synced history become available to this workspace under its permissions. Projects with a matching repository join the existing workspace project.")
        }
    }

    private var companyName: String { companies.first { $0.id == companyID }?.name ?? "workspace" }

    private var placementSection: some View {
        Section {
            Toggle("Auto balance new threads", isOn: $placementPreferences.enabled)
            if placementPreferences.enabled {
                ForEach(placementEnvironments) { environment in
                    Picker(environment.environment.label, selection: Binding(
                        get: { placementPreferences.weight(for: environment.environment.environmentId) },
                        set: { placementPreferences.setWeight($0, for: environment.environment.environmentId) }
                    )) {
                        ForEach(PathwayEnvironmentPlacementPreferences.weights, id: \.self) { weight in
                            Text(PathwayEnvironmentPlacementPreferences.label(weight)).tag(weight)
                        }
                    }
                }
            }
        } header: {
            Text("Load balancing")
        } footer: {
            Text("Auto chooses an available environment with a registered copy of the project before you compose. Existing threads stay where they started. These preferences apply to this device.")
        }
    }

    private var placementEnvironments: [PathwayCompanyEnvironment] {
        var seen = Set<String>()
        return environments.filter { seen.insert($0.environment.environmentId).inserted }
            .sorted { $0.environment.label.localizedStandardCompare($1.environment.label) == .orderedAscending }
    }

    private var pairingSection: some View {
        Section {
            TextField("Pairing link or server address", text: $address)
                .textContentType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            SecureField("Pairing token (for a manual address)", text: $pairingToken)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Pair with server", systemImage: "link") {
                let inputAddress = address
                let token = pairingToken
                address = ""
                pairingToken = ""
                Task { await model.pair(address: inputAddress, token: token) }
            }
            .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } header: { Text("Add a server") }
        footer: {
            Text("Paste a pairing link from Pathway on your computer, or enter its LAN address and token. Account linking requires an administrator pairing link. The server must be reachable from this device.")
        }
    }

    private var directSection: some View {
        Section("Paired on this device") {
            ForEach(model.directConnections) { connection in
                Button {
                    Task { await model.select(connection) }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(connection.label)
                            if model.selected?.id == connection.id { Image(systemName: "checkmark") }
                        }
                        Text(connection.baseURL.absoluteString).font(.caption).foregroundStyle(.secondary)
                        Text(connection.expiresAt < Date() ? "Session expired — pair again" : connection.useForConnections ? "Using direct access" : "Using Pathway Connect")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func setupSection(_ connection: PathwayDirectConnectionSummary) -> some View {
        Section {
            LabeledContent("Server", value: connection.label)
            if model.linkState?.objectValue?["linked"]?.boolValue == true {
                Label("Server linked to an account", systemImage: "link")
                if model.linkState?.objectValue?["managedTunnelActive"]?.boolValue == true {
                    Button(connection.useForConnections ? "Use Pathway Connect on this device" : "Use direct access on this device") {
                        Task { await model.useDirect(!connection.useForConnections, connection: connection) }
                    }
                }
                if connection.canManageLink {
                    Button("Unlink server", role: .destructive) { unlinkServer = true }
                }
            } else {
                Toggle("Connect from anywhere", isOn: $managed)
                Text(managed ? "Installs the server's verified tunnel client and enables Pathway Connect." : "Uses this device's saved direct address. Keep the server reachable on your network.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Picker("Workspace", selection: $companyID) {
                Text("Choose workspace").tag("")
                ForEach(companies) { Text($0.name).tag($0.id) }
            }
            if model.localProjects.isEmpty {
                Text("No local projects to add. You can register the server and create projects later.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(model.localProjects.compactMap(PathwayOnboardingProject.init)) { project in
                Toggle(isOn: Binding(get: { selectedProjects.contains(project.id) }, set: { enabled in
                    if enabled { selectedProjects.insert(project.id) } else { selectedProjects.remove(project.id) }
                })) {
                    VStack(alignment: .leading) {
                        Text(project.title)
                        if let root = project.root { Text(root).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
            Button("Register server and add selected projects") { confirmRegistration = true }
                .disabled(companyID.isEmpty || model.linkState == nil)
            Button("Remove saved direct session", role: .destructive) {
                Task { await model.forget(connection) }
            }
        } header: { Text("Finish workspace setup") }
        footer: {
            Text("Pairing alone does not publish local projects. Select only the projects you want this workspace to share. Removing a saved session affects this device only.")
        }
    }

    private var accountSection: some View {
        Section("Pathway Connect account") {
            if model.environments.isEmpty {
                Text("No linked servers").foregroundStyle(.secondary)
            }
            ForEach(model.environments) { environment in
                VStack(alignment: .leading, spacing: 6) {
                    Text(environment.label)
                    Text(environment.providerKind == "manual" ? "Direct access · activity publishing" : "Managed tunnel")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Remove from account", role: .destructive) { removing = environment }
                        .font(.callout)
                }
            }
        }
    }
}

private struct PathwayOnboardingProject: Identifiable {
    let id: String
    let title: String
    let root: String?
    init?(_ value: JSONValue) {
        guard let fields = value.objectValue, let id = fields["id"]?.stringValue else { return nil }
        self.id = id
        title = fields["title"]?.stringValue ?? id
        root = fields["workspaceRoot"]?.stringValue
    }
}
