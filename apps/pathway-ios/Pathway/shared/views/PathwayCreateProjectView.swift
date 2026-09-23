import SwiftUI

/// Creates one company project across one or more environments, from folders, a cloned
/// repository, or a new GitHub repository.
struct PathwayCreateProjectView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var ownedFocuses = PathwayFocusModel()
    @State private var draft = PathwayProjectCreationDraft()
    @State private var focusChoice: String?
    @State private var owners: [PathwayRepositoryOwners.Owner] = []
    @State private var folders: [UUID: [PathwayDirectoryListing.Entry]] = [:]
    @State private var progress: String?
    @State private var errorMessage: String?
    @State private var initialized = false
    private let providedFocuses: PathwayFocusModel?
    private var focuses: PathwayFocusModel { providedFocuses ?? ownedFocuses }

    init(focuses: PathwayFocusModel? = nil) {
        providedFocuses = focuses
    }

    private var environments: [PathwayCompanyEnvironment] {
        appModel.cloud.environments.filter { $0.companyId == draft.companyID && $0.environment.state == "active" }
    }

    private var focusID: String {
        focusChoice ?? (focuses.focuses.contains { $0.id == focuses.selectedID } ? focuses.selectedID : "")
    }

    private var ownerLookupKey: String {
        draft.source == .newRepository ? "\(draft.companyID):\(draft.rows.first?.environmentID ?? "")" : ""
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Project") {
                    TextField("Project name", text: Binding(get: { draft.name }, set: { draft.customName = $0 }))
                    PathwayProjectIconFields(icon: $draft.icon)
                    Picker("Focus", selection: Binding(get: { focusID }, set: { focusChoice = $0 })) {
                        Text("None").tag("")
                        ForEach(focuses.focuses) { focus in
                            Label(focus.name, image: PathwayFocusIconCatalog.assetName(for: focus.iconName)).tag(focus.id)
                        }
                    }
                    Picker("Owned by", selection: $draft.companyID) {
                        ForEach(appModel.cloud.companies) { Text($0.name).tag($0.id) }
                    }
                }
                Section {
                    Picker("Source", selection: $draft.source) {
                        ForEach(PathwayProjectCreationDraft.Source.allCases) { Text($0.title).tag($0) }
                    }
                    sourceFields
                } footer: { Text(sourceFooter) }
                ForEach($draft.rows) { $row in
                    Section {
                        Picker("Environment", selection: $row.environmentID) {
                            ForEach(environments) { Text($0.environment.label).tag($0.environment.environmentId) }
                            if environment(row.environmentID) == nil { Text("Choose environment").tag(row.environmentID) }
                        }
                        HStack {
                            TextField("Folder path", text: $row.path)
                                .autocorrectionDisabled().textInputAutocapitalization(.never)
                            Button("Browse") { Task { await browse(row) } }
                                .buttonStyle(.borderless)
                                .disabled(environment(row.environmentID) == nil)
                        }
                        ForEach(folders[row.id] ?? []) { folder in
                            Button(folder.fullPath) { setPath(folder.fullPath, for: row.id) }
                        }
                        if draft.rows.count > 1 || draft.source == .folders {
                            Button("Remove environment", role: .destructive) {
                                draft.rows.removeAll { $0.id == row.id }
                            }
                        }
                    } header: {
                        Text("Environment \((draft.rows.firstIndex(where: { $0.id == row.id }) ?? 0) + 1)")
                    }
                }
                Section {
                    Button("Add environment", systemImage: "plus") {
                        draft.rows.append(.init(environmentID: environments.first?.environment.environmentId ?? ""))
                    }
                    .disabled(environments.isEmpty)
                } footer: {
                    if environments.isEmpty {
                        Text("Connect an environment to this company to add project folders.")
                    } else if draft.rows.isEmpty && draft.source == .folders {
                        Text("Without a folder, the project is created on \(environment(draft.defaultEnvironmentID)?.environment.label ?? "the first environment").")
                    }
                }
                if let progress {
                    Section { Label { Text(progress) } icon: { ProgressView() } }
                }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            }
            .disabled(progress != nil)
            .navigationTitle("New Project")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(progress != nil) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }.disabled(progress != nil || !draft.canCreate)
                }
            }
            .interactiveDismissDisabled(progress != nil)
            .task {
                guard !initialized else { return }
                initialized = true
                let companies = appModel.cloud.companies
                draft.companyID = companies.first { company in
                    appModel.cloud.environments.contains { $0.companyId == company.id && $0.environment.state == "active" }
                }?.id ?? companies.first?.id ?? ""
                draft.defaultEnvironmentID = environments.first?.environment.environmentId ?? ""
                draft.rows = [.init(environmentID: draft.defaultEnvironmentID)]
            }
            .task(id: appModel.localStorageDirectory) {
                if providedFocuses == nil { await ownedFocuses.observe(cloud: appModel.cloud, storageDirectory: appModel.localStorageDirectory) }
            }
            .task(id: ownerLookupKey) { await loadOwners() }
            .onChange(of: draft.companyID) {
                // Environments belong to the owning company, so a new owner resets the choices.
                let first = environments.first?.environment.environmentId ?? ""
                draft.defaultEnvironmentID = first
                for index in draft.rows.indices where environment(draft.rows[index].environmentID) == nil {
                    draft.rows[index].environmentID = first
                }
                folders = [:]
            }
        }
    }

    @ViewBuilder private var sourceFields: some View {
        switch draft.source {
        case .folders:
            EmptyView()
        case .clone:
            TextField("owner/name or git URL", text: $draft.repository)
                .autocorrectionDisabled().textInputAutocapitalization(.never).keyboardType(.URL)
        case .newRepository:
            if owners.isEmpty {
                TextField("GitHub owner", text: $draft.repositoryOwner)
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
            } else {
                Picker("GitHub owner", selection: $draft.repositoryOwner) {
                    ForEach(owners) { Text($0.login).tag($0.login) }
                }
            }
            TextField("Repository name", text: Binding(get: { draft.repositoryName }, set: { draft.customRepositoryName = $0 }))
                .autocorrectionDisabled().textInputAutocapitalization(.never)
            Picker("Visibility", selection: $draft.visibility) {
                Text("Private").tag("private")
                Text("Public").tag("public")
            }
        }
    }

    private var sourceFooter: String {
        switch draft.source {
        case .folders: "Links existing folders, or creates empty ones that are missing. Remove every environment for a project without a folder."
        case .clone: "Clones the repository into each folder. Enter owner/name for GitHub, or any git URL."
        case .newRepository: "Creates the repository from the first environment's folder, then clones it into the others."
        }
    }

    private func environment(_ environmentID: String) -> PathwayCompanyEnvironment? {
        environments.first { $0.environment.environmentId == environmentID }
    }

    private func setPath(_ path: String, for rowID: UUID) {
        guard let index = draft.rows.firstIndex(where: { $0.id == rowID }) else { return }
        draft.rows[index].path = path
        folders[rowID] = nil
    }

    private func browse(_ row: PathwayProjectCreationDraft.Row) async {
        guard let environment = environment(row.environmentID) else { return }
        let path = row.path.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let result = try await appModel.cloud.environmentRequest(environment: environment, method: "filesystem.browse",
                payload: .object(["partialPath": .string(path.isEmpty ? "~/" : path)]))
            folders[row.id] = try decodePathwayPayload(PathwayDirectoryListing.self, from: result).entries
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    /// Owners come from the first environment's GitHub account; an empty list falls back to typing.
    private func loadOwners() async {
        owners = []
        guard draft.source == .newRepository, let environment = environment(draft.rows.first?.environmentID ?? "") else { return }
        do {
            let result = try await appModel.cloud.environmentRequest(environment: environment,
                method: "sourceControl.listRepositoryOwners", payload: .object(["provider": .string("github")]))
            let loaded = try decodePathwayPayload(PathwayRepositoryOwners.self, from: result).owners
            owners = loaded
            if !loaded.contains(where: { $0.login == draft.repositoryOwner }) { draft.repositoryOwner = loaded.first?.login ?? draft.repositoryOwner }
        } catch {
            owners = []
        }
    }

    private func create() async {
        errorMessage = nil
        progress = "Creating…"
        defer { progress = nil }
        var request = draft
        request.focusID = focuses.focuses.contains { $0.id == focusID } ? focusID : ""
        let companyID = request.companyID
        let creator = PathwayProjectCreator(
            environmentRequest: { environmentID, method, payload, timeout in
                guard let environment = appModel.cloud.environments.first(where: {
                    $0.companyId == companyID && $0.environment.environmentId == environmentID
                }) else { throw PathwayProjectCreationError.environmentUnavailable }
                return try await appModel.cloud.environmentOperation(environment: environment, method: method, payload: payload, timeout: timeout)
            },
            cloudMutation: { name, arguments in
                try await appModel.cloud.request(kind: "mutation", name: name, arguments: arguments)
            },
            progress: { progress = $0 }
        )
        do {
            _ = try await creator.create(request)
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }
}

/// Library icon and color for a project; no icon keeps the favicon detected from its folder.
struct PathwayProjectIconFields: View {
    @Binding var icon: PathwayProjectIcon?

    var body: some View {
        Picker("Icon", selection: Binding(get: { icon?.name ?? "" }, set: { name in
            icon = name.isEmpty ? nil : PathwayProjectIcon(name: name, color: icon?.color ?? PathwayFocusIcon.colors[0].hex)
        })) {
            Label("Use detected icon", systemImage: "photo").tag("")
            ForEach(PathwayFocusIconCatalog.options) { option in
                Label(option.label, image: PathwayFocusIconCatalog.assetName(for: option.name)).tag(option.name)
            }
            if let name = icon?.name, !PathwayFocusIconCatalog.options.contains(where: { $0.name == name }) {
                Label("Current icon", image: PathwayFocusIconCatalog.assetName(for: name)).tag(name)
            }
        }
        if let icon {
            Picker("Color", selection: Binding(get: { icon.color }, set: { self.icon = PathwayProjectIcon(name: icon.name, color: $0) })) {
                ForEach(PathwayFocusIcon.colors, id: \.hex) { Text($0.label).tag($0.hex) }
                if !PathwayFocusIcon.colors.contains(where: { $0.hex == icon.color }) { Text("Current color").tag(icon.color) }
            }
        }
    }
}

/// Project settings row that opens the synced icon editor for a linked local project.
struct PathwayProjectIconSettingsRow: View {
    @Environment(PathwayAppModel.self) private var appModel
    let environment: PathwayCompanyEnvironment
    let localProjectID: String

    private var binding: PathwayCompanyEnvironmentBinding? {
        appModel.cloud.environmentBindings.first {
            $0.companyId == environment.companyId && $0.binding.environmentId == environment.environment.environmentId
                && $0.binding.localProjectId == localProjectID
        }
    }

    var body: some View {
        if let binding {
            let icon = appModel.cloud.projectIcon(companyId: binding.companyId, projectId: binding.binding.cloudProjectId)
            Section {
                NavigationLink {
                    PathwayProjectIconEditor(companyID: binding.companyId, cloudProjectID: binding.binding.cloudProjectId)
                } label: {
                    LabeledContent("Icon") {
                        if let icon {
                            PathwayFocusIcon(name: icon.name).foregroundStyle(PathwayFocusIcon.color(icon.color))
                        } else {
                            Text("Detected")
                        }
                    }
                }
            } footer: { Text("Shown for this project on every device and environment.") }
        }
    }
}

struct PathwayProjectIconEditor: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    let companyID: String
    let cloudProjectID: String
    @State private var icon: PathwayProjectIcon?
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var initialized = false

    var body: some View {
        Form {
            Section { PathwayProjectIconFields(icon: $icon) }
            if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
        }
        .navigationTitle("Project icon")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await save() } }
                    .disabled(saving || icon == appModel.cloud.projectIcon(companyId: companyID, projectId: cloudProjectID))
            }
        }
        .task {
            guard !initialized else { return }
            initialized = true
            icon = appModel.cloud.projectIcon(companyId: companyID, projectId: cloudProjectID)
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            _ = try await appModel.cloud.request(kind: "mutation", name: "cloudProjects:setCompanyProjectIcon",
                arguments: PathwayProjectCreation.iconArguments(companyID: companyID, cloudProjectID: cloudProjectID, icon: icon))
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }
}
