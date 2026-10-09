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
                NavigationLink("Xcode") { PathwayXcodeSettingsView() }
            }
            Section("App") {
                NavigationLink("Report a bug") { PathwayBugReportSettingsView() }
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
            PathwayComputerSettingsSection(environments: appModel.cloud.environments, client: client(for:))
            Section("Orchestrators") {
                ForEach(PathwayOrchestratorSettingsPage.allCases) { page in
                    NavigationLink(page.rawValue) { PathwayOrchestratorSettingsView(page: page) }
                }
            }
            Section("Tasks") {
                ForEach(appModel.cloud.companies) { company in
                    NavigationLink(company.name) {
                        PathwayIssueSettingsView(model: appModel.cloud.issues, companyID: company.id)
                    }
                }
                companyEmptyState
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
