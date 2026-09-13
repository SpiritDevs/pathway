import SwiftUI

struct PathwaySettingsView: View {
    var isSeparateWindow = false
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(PathwayAppModel.self) private var appModel

    var body: some View {
        Form {
            Section("Workspaces") {
                NavigationLink("Connect a server") { PathwayConnectionsDestination() }
                NavigationLink("Companies, people & roles") {
                    PathwayCompanyAdministrationView(companies: appModel.cloud.companies,
                        request: { kind, name, arguments in try await appModel.cloud.request(kind: kind, name: name, arguments: .object(arguments)) },
                        entities: { kind, companyID in appModel.cloud.entities(kind: kind, companyID: companyID) })
                }
                NavigationLink("Environments & providers") {
                    PathwayAdministrationView(
                        environments: appModel.cloud.environments,
                        request: environmentRequest,
                        http: environmentHTTP,
                        cloudMutation: cloudMutation
                    )
                }
            }
            Section("App") {
                NavigationLink("General") { PathwayGeneralSettingsView() }
                NavigationLink("Appearance") { PathwayAppearanceSettingsView() }
                NavigationLink("Storage & cleanup") { PathwayEnvironmentStorageView() }
                NavigationLink("Keyboard Shortcuts") { PathwayKeyboardSettingsView() }
            }
            Section("Agent Threads") {
                NavigationLink("Focus Views") { PathwayFocusSettingsView() }
                NavigationLink("Favourite models") { PathwayModelFavouritesEnvironments() }
                NavigationLink("Agent notifications") { PathwayNotificationsSettingsView() }
                NavigationLink("Shared Drafts") { PathwaySharedDraftsDestination() }
            }
            Section("Tasks") {
                ForEach(appModel.cloud.companies) { company in
                    NavigationLink(company.name) {
                        PathwayIssueSettingsView(model: appModel.cloud.issues, companyID: company.id)
                    }
                }
                companyEmptyState
            }
            Section("Email") {
                ForEach(appModel.cloud.companies) { company in
                    NavigationLink(company.name) {
                        PathwayEmailSettingsDestination(companyID: company.id)
                    }
                }
                companyEmptyState
            }
            Section("Source Control") {
                ForEach(appModel.cloud.environments) { environment in
                    NavigationLink {
                        PathwayAdministrationSettingsView(client: client(for: environment), sourceControl: true)
                    } label: {
                        environmentLabel(environment)
                    }
                }
                environmentEmptyState
            }
            Section("Calendar") {
                ForEach(appModel.cloud.companies) { company in
                    NavigationLink(company.name) {
                        PathwayCalendarSettingsView(model: appModel.cloud.calendar, companyID: company.id)
                    }
                }
                companyEmptyState
            }
            Section("Projects") {
                ForEach(appModel.cloud.environments) { environment in
                    NavigationLink {
                        PathwayAdministrationProjectsView(client: client(for: environment))
                    } label: {
                        environmentLabel(environment)
                    }
                }
                environmentEmptyState
            }
            Section("Account") {
                Button("Sign out", role: .destructive) {
                    Task {
                        await appModel.signOut()
                    }
                }

                if let issue = appModel.authenticationIssue {
                    PathwayAuthenticationIssueView(issue: issue)
                }
            }

            Section {
                Text("Manage your Pathway account and native app preferences.")
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
        .toolbarVisibility(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            if isSeparateWindow {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismissWindow(id: PathwayWindow.settings.rawValue) }
                }
            }
        }
        .frame(minWidth: 320, minHeight: 360)
        .accessibilityIdentifier("pathway-settings")
    }

    @ViewBuilder private var companyEmptyState: some View {
        if appModel.cloud.companies.isEmpty {
            Text("No workspaces available.").foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var environmentEmptyState: some View {
        if appModel.cloud.environments.isEmpty {
            Text("No environments connected.").foregroundStyle(.secondary)
        }
    }

    private func environmentLabel(_ environment: PathwayCompanyEnvironment) -> some View {
        VStack(alignment: .leading) {
            Text(environment.environment.label)
            if let company = appModel.cloud.companies.first(where: { $0.id == environment.companyId }) {
                Text(company.name).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var environmentRequest: PathwayAdministrationRequest {
        { environment, method, payload in
            try await appModel.cloud.environmentRequest(environment: environment, method: method, payload: payload)
        }
    }

    private var environmentHTTP: PathwayAdministrationHTTP {
        { environment, method, path, payload in
            guard let connect = appModel.connect else { throw URLError(.notConnectedToInternet) }
            return try await PathwayEnvironmentHTTP.request(
                environment: environment, connect: connect, method: method, path: path, payload: payload
            )
        }
    }

    private var cloudMutation: PathwayAdministrationCloudMutation {
        { name, arguments in
            try await appModel.cloud.request(kind: "mutation", name: name, arguments: .object(arguments))
        }
    }

    private func client(for environment: PathwayCompanyEnvironment) -> PathwayAdministrationClient {
        .init(environment: environment, request: environmentRequest, http: environmentHTTP, cloudMutation: cloudMutation)
    }
}

private struct PathwayEmailSettingsDestination: View {
    @Environment(PathwayAppModel.self) private var appModel
    let companyID: String

    var body: some View {
        List {
            NavigationLink("Connected accounts, sender rules & analysis") {
                PathwayMailSettingsDestination(companyID: companyID)
            }
            NavigationLink("SMTP capture, tags & trusted senders") {
                PathwayEmailSettingsView(
                    model: appModel.cloud.email, companyID: companyID,
                    environments: appModel.cloud.environments.filter { $0.companyId == companyID }
                )
            }
        }
        .navigationTitle("Email settings")
    }
}

private struct PathwayMailSettingsDestination: View {
    @Environment(PathwayAppModel.self) private var appModel
    let companyID: String
    @State private var model: PathwayConnectedMailModel?

    var body: some View {
        Group {
            if let model {
                PathwayConnectedMailSettings(
                    model: model, companyID: companyID,
                    environments: appModel.cloud.environments.filter { $0.companyId == companyID }
                )
            } else {
                ProgressView("Loading mail settings")
            }
        }
        .task(id: companyID) {
            // Settings observes accounts independently so changing workspace cannot reset the inbox.
            let settingsModel = appModel.cloud.makeConnectedMailModel()
            model = settingsModel
            await settingsModel.observeAccounts(companyID: companyID)
        }
    }
}
