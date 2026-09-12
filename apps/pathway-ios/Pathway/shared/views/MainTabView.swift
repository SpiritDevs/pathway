import SwiftUI

// The adaptive shell keeps its rail, context sidebar, destination routing, and settings
// together because they share navigation state across iPadOS and visionOS.
// swiftlint:disable file_length

enum MainTabSheet: String, Identifiable {
    case agentOrchestrator
    case newAgentThread
    case settings
    case systemRequest
    case sharedDrafts
    case storage

    var id: Self { self }
}

struct MainTabView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(PathwayAppModel.self) private var appModel
    @State private var selectedDestination: AppDestination? = .agentThreads
    @State private var presentedSheet: MainTabSheet?
    @State private var systemRequest: PathwaySystemRequest?

    init(initialDestination: AppDestination = .agentThreads) {
        _selectedDestination = State(initialValue: initialDestination)
    }

    private var layout: AppShellLayout {
        AppShellLayout.resolve(
            usesRegularWidth: horizontalSizeClass == .regular,
            isVisionOS: isVisionOS
        )
    }

    private var isVisionOS: Bool {
        #if os(visionOS)
            true
        #else
            false
        #endif
    }

    var body: some View {
        Group {
            switch layout {
            case .compact:
                #if os(visionOS)
                    FloatingAppShell(
                        selectedDestination: $selectedDestination,
                        presentedSheet: $presentedSheet,
                        layout: .spatial
                    )
                #else
                    CompactAppShell(
                        selectedDestination: $selectedDestination,
                        presentedSheet: $presentedSheet
                    )
                #endif
            case .sidebar, .spatial:
                FloatingAppShell(
                    selectedDestination: $selectedDestination,
                    presentedSheet: $presentedSheet,
                    layout: layout
                )
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                PathwayWorkspaceCleanupNotice()
                PathwayStorageStatusNotice()
            }
        }
        .sheet(item: $presentedSheet) { sheet in
            switch sheet {
            case .agentOrchestrator:
                AgentOrchestratorView()
                    .presentationDetents([.large])
                    .presentationDragIndicator(.hidden)
                    .presentationCornerRadius(36)
            case .newAgentThread:
                NewAgentThreadView()
                    .presentationDetents([.large])
                    .presentationDragIndicator(.hidden)
                    .presentationCornerRadius(36)
            case .sharedDrafts:
                PathwaySharedDraftsDestination()
            case .systemRequest:
                if let request = systemRequest {
                    if request.destination == .compose {
                        NewAgentThreadView(onClose: { presentedSheet = nil }, initialPrompt: request.prompt).id(request.id)
                    } else {
                        NavigationStack {
                            AgentThreadsView(newThreadAction: { presentedSheet = .newAgentThread },
                                initialFilter: request.destination == .running ? .running : .needsAttention)
                                .id(request.id)
                                .toolbar { ToolbarItem(placement: .cancellationAction) {
                                    Button("Done") { presentedSheet = nil }
                                } }
                        }
                    }
                }
            case .storage:
                NavigationStack {
                    PathwayEnvironmentStorageView()
                        .toolbar { ToolbarItem(placement: .cancellationAction) {
                            Button("Close") { presentedSheet = nil }
                        } }
                }
            case .settings:
                NavigationStack {
                    PathwaySettingsView()
                }
            }
        }
        .onChange(of: PathwayGeneralPreferences.shared.autoSettleDays) { _, _ in appModel.cloud.refreshThreadPartition() }
        .onChange(of: PathwayKeyboardPreferences.shared.pendingAction, initial: true) { _, request in
            guard let request else { return }
            PathwayKeyboardPreferences.shared.pendingAction = nil
            switch request.action {
            case .newThread: presentedSheet = .newAgentThread
            case .running, .attention:
                systemRequest = .init(destination: request.action == .running ? .running : .attention, prompt: "")
                presentedSheet = .systemRequest
            case .sharedDrafts: presentedSheet = .sharedDrafts
            case .settings: presentedSheet = .settings
            }
        }
        .onChange(of: PathwaySystemEntry.shared.request, initial: true) { _, request in
            guard let request else { return }
            systemRequest = request
            PathwaySystemEntry.shared.request = nil
            presentedSheet = .systemRequest
        }
        .onChange(of: appModel.pendingStorageNotification, initial: true) { _, destination in
            guard let destination else { return }
            appModel.pendingStorageNotification = nil
            guard destination.account == appModel.localStorageDirectory?.lastPathComponent else { return }
            presentedSheet = .storage
        }
        .onChange(of: appModel.pendingThreadRoute) { _, route in
            guard route != nil else { return }
            presentedSheet = nil
            selectedDestination = .agentThreads
        }
        .onChange(of: appModel.pendingProductLink) { _, link in
            if link != nil { presentedSheet = nil; selectedDestination = .agentThreads }
        }
    }
}

private struct FloatingAppShell: View {
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Binding var selectedDestination: AppDestination?
    @Binding var presentedSheet: MainTabSheet?
    let layout: AppShellLayout

    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var selectedContextDestination: AppContextDestination? =
        AppDestination.dashboard.defaultContextDestination

    var body: some View {
        HStack(spacing: 12) {
            PathwayNavigationRail(
                selectedDestination: $selectedDestination,
                agentOrchestratorAction: presentAgentOrchestrator,
                settingsAction: presentSettings
            )

            NavigationSplitView(columnVisibility: $columnVisibility) {
                PathwayContextSidebar(
                    destination: activeDestination,
                    selectedContextDestination: $selectedContextDestination
                )
                .navigationSplitViewColumnWidth(
                    min: dynamicTypeSize.isAccessibilitySize ? 300 : 210,
                    ideal: dynamicTypeSize.isAccessibilitySize ? 340 : 250,
                    max: dynamicTypeSize.isAccessibilitySize ? 400 : 310
                )
            } detail: {
                NavigationStack {
                    PathwayContextDestinationView(
                        destination: activeDestination,
                        contextDestination: activeContextDestination,
                        newThreadAction: presentNewAgentThread
                    )
                    .toolbar {
                        ToolbarItemGroup(placement: .primaryAction) {
                            if activeDestination != .issues {
                                Button(
                                    "New agent thread",
                                    systemImage: "bubble.left.and.bubble.right",
                                    action: presentNewAgentThread
                                )
                                if activeDestination != .agentThreads {
                                    Button("Settings", systemImage: "gearshape", action: presentSettings)
                                }
                            }
                        }
                    }
                }
                .id(activeDestination)
            }
            .navigationSplitViewStyle(.balanced)
        }
        .padding(12)
        .onChange(of: activeDestination) { _, destination in
            selectedContextDestination = destination.defaultContextDestination
        }
    }

    private var activeDestination: AppDestination {
        selectedDestination ?? .dashboard
    }

    private var activeContextDestination: AppContextDestination {
        guard let selectedContextDestination,
              activeDestination.contextDestinations.contains(selectedContextDestination)
        else {
            return activeDestination.defaultContextDestination
        }
        return selectedContextDestination
    }

    private func presentAgentOrchestrator() {
        if layout == .spatial {
            openWindow(id: PathwayWindow.agentOrchestrator.rawValue)
        } else {
            presentedSheet = .agentOrchestrator
        }
    }

    private func presentNewAgentThread() {
        presentedSheet = .newAgentThread
    }

    private func presentSettings() {
        if layout == .spatial {
            openWindow(id: PathwayWindow.settings.rawValue)
        } else {
            presentedSheet = .settings
        }
    }
}

private struct PathwayNavigationRail: View {
    @Binding var selectedDestination: AppDestination?
    let agentOrchestratorAction: () -> Void
    let settingsAction: () -> Void

    var body: some View {
        #if os(visionOS)
            railContent
                .background(.regularMaterial, in: Capsule())
        #else
            GlassEffectContainer {
                railContent
                    .glassEffect(.regular, in: .capsule)
            }
        #endif
    }

    private var railContent: some View {
        VStack(spacing: 8) {
            Text("P")
                .font(.title2.weight(.bold))
                .frame(width: 48, height: 48)
                .accessibilityLabel("Pathway")

            Divider()
                .padding(.horizontal, 12)

            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(Array(AppDestination.sidebarSections.enumerated()), id: \.element.id) { entry in
                        let (index, section) = entry
                        if index > 0 {
                            Divider()
                                .padding(.horizontal, 12)
                                .padding(.vertical, 2)
                        }

                        ForEach(section.destinations) { destination in
                            destinationButton(destination)
                        }
                    }
                }
            }
            .scrollIndicators(.hidden)

            Divider()
                .padding(.horizontal, 12)

            railActionButton(
                title: "Open agent orchestrator",
                systemImage: "bubble.left.and.bubble.right",
                action: agentOrchestratorAction
            )
            railActionButton(title: "Settings", systemImage: "gearshape", action: settingsAction)
        }
        .padding(.vertical, 8)
        .frame(width: 64)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Main navigation")
    }

    private func destinationButton(_ destination: AppDestination) -> some View {
        let isSelected = activeDestination == destination

        return Button {
            withAnimation(.snappy(duration: 0.24)) {
                selectedDestination = destination
            }
        } label: {
            Image(systemName: destination.systemImage)
                .font(.system(size: 20, weight: .semibold))
                .frame(width: 48, height: 48)
                .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .background {
                    if isSelected {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(Color.accentColor.opacity(0.18))
                    }
                }
        }
        .buttonStyle(.plain)
        .foregroundStyle(isSelected ? Color.accentColor : Color.primary)
        .hoverEffect()
        .help(destination.title)
        .accessibilityLabel(destination.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("rail-destination-\(destination.rawValue)")
    }

    private func railActionButton(
        title: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 19, weight: .semibold))
                .frame(width: 48, height: 48)
                .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .hoverEffect()
        .help(title)
        .accessibilityLabel(title)
    }

    private var activeDestination: AppDestination {
        selectedDestination ?? .dashboard
    }
}

private struct PathwayContextSidebar: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let destination: AppDestination
    @Binding var selectedContextDestination: AppContextDestination?

    var body: some View {
        List(selection: $selectedContextDestination) {
            Section {
                ForEach(destination.contextDestinations) { contextDestination in
                    Group {
                        if dynamicTypeSize.isAccessibilitySize {
                            Text(contextDestination.title)
                        } else {
                            Label(contextDestination.title, systemImage: contextDestination.systemImage)
                        }
                    }
                    .tag(contextDestination)
                }
            } footer: {
                Text(destination.description)
            }
        }
        .navigationTitle(destination.title)
        .id(destination)
        .accessibilityIdentifier("context-sidebar-\(destination.rawValue)")
    }
}

private struct PathwayContextDestinationView: View {
    @Environment(PathwayAppModel.self) private var appModel
    let destination: AppDestination
    let contextDestination: AppContextDestination
    let newThreadAction: () -> Void

    @ViewBuilder
    var body: some View {
        if destination == .issues {
            PathwayIssuesDestinationView(initialTab: contextDestination.id)
                .id(contextDestination.id)
        } else if destination == .agentThreads {
            AgentThreadsView(newThreadAction: newThreadAction,
                initialFilter: contextDestination.id == "running" ? .running : contextDestination.id == "needs-attention" ? .needsAttention : .all)
                .id(contextDestination.id)
        } else if destination == .dashboard {
            PathwayDashboardView(newThreadAction: newThreadAction, activityOnly: contextDestination.id == "activity")
        } else if destination == .calendar {
            PathwayCalendarView(model: appModel.cloud.calendar, companies: appModel.cloud.companies, initialMode: contextDestination.id).id(contextDestination.id)
        } else if destination == .email {
            PathwayEmailHubView(capture: appModel.cloud.email, mail: appModel.cloud.connectedMail, companies: appModel.cloud.companies, environments: appModel.cloud.environments, initialFilter: contextDestination.id).id(contextDestination.id)
        } else if destination == .contacts {
            PathwayContactsView(model: appModel.cloud.contacts, companies: appModel.cloud.companies, initialFilter: contextDestination.id).id(contextDestination.id)
        } else if destination == .timeTracker {
            PathwayTimeView(model: appModel.cloud.time, accountID: appModel.accountID ?? "", projects: appModel.cloud.projects, initialFilter: contextDestination.id).id(contextDestination.id)
        } else if destination == .sourceControl {
            PathwaySourceControlDestination(initialSection: contextDestination.id).id(contextDestination.id)
        } else if destination == .projects {
            PathwayProjectsDestination(initialFilter: contextDestination.id).id(contextDestination.id)
        } else {
            PathwayFeatureDestinationView(destination: destination, newThreadAction: newThreadAction)
        }
    }
}

struct PathwayFeaturePlaceholder: View {
    let destination: AppDestination

    var body: some View {
        ScrollView {
            ContentUnavailableView {
                Label(destination.title, systemImage: destination.systemImage)
            } description: {
                Text(destination.description)
            }
            .frame(maxWidth: 720, minHeight: 420)
            .frame(maxWidth: .infinity)
            .padding(24)
        }
        .navigationTitle(destination.title)
        .navigationBarTitleDisplayMode(.large)
        .accessibilityIdentifier("destination-\(destination.rawValue)")
    }
}

struct PathwayFeatureDestinationView: View {
    @Environment(PathwayAppModel.self) private var appModel
    let destination: AppDestination
    let newThreadAction: () -> Void

    @ViewBuilder
    var body: some View {
        if destination == .agentThreads {
            AgentThreadsView(newThreadAction: newThreadAction)
        } else if destination == .issues {
            PathwayIssuesDestinationView()
        } else if destination == .calendar {
            PathwayCalendarView(model: appModel.cloud.calendar, companies: appModel.cloud.companies)
        } else if destination == .email {
            PathwayEmailHubView(capture: appModel.cloud.email, mail: appModel.cloud.connectedMail, companies: appModel.cloud.companies, environments: appModel.cloud.environments)
        } else if destination == .sourceControl {
            PathwaySourceControlDestination()
        } else if destination == .projects {
            PathwayProjectsDestination()
        } else if destination == .dashboard {
            PathwayDashboardView(newThreadAction: newThreadAction)
        } else if destination == .contacts {
            PathwayContactsView(model: appModel.cloud.contacts, companies: appModel.cloud.companies)
        } else if destination == .timeTracker {
            PathwayTimeView(model: appModel.cloud.time, accountID: appModel.accountID ?? "", projects: appModel.cloud.projects)
        } else {
            PathwayFeaturePlaceholder(destination: destination)
        }
    }
}

struct PathwaySettingsView: View {
    var isSeparateWindow = false
    var focusModel: PathwayFocusModel? = nil
    @Environment(\.dismiss) private var dismiss
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
                NavigationLink("Environments, projects & providers") {
                    PathwayAdministrationView(
                        environments: appModel.cloud.environments,
                        request: { environment, method, payload in
                            try await appModel.cloud.environmentRequest(environment: environment, method: method, payload: payload)
                        },
                        http: { environment, method, path, payload in
                            guard let connect = appModel.connect else { throw URLError(.notConnectedToInternet) }
                            return try await PathwayEnvironmentHTTP.request(environment: environment, connect: connect, method: method, path: path, payload: payload)
                        },
                        cloudMutation: { name, arguments in
                            try await appModel.cloud.request(kind: "mutation", name: name, arguments: .object(arguments))
                        }
                    )
                }
            }
            Section("Capture") {
                NavigationLink("Shared Drafts") { PathwaySharedDraftsDestination() }
            }
            Section("Agent Threads") {
                NavigationLink { PathwayFocusSettingsView(model: focusModel) } label: {
                    Label("Focus Views", systemImage: "target")
                }
            }
            Section("Models") {
                NavigationLink("Favourite models") {
                    PathwayModelFavouritesEnvironments()
                }
            }
            Section("Notifications") {
                NavigationLink("Agent notifications") { PathwayNotificationsSettingsView() }
            }
            Section("Appearance") {
                NavigationLink("General") { PathwayGeneralSettingsView() }
                NavigationLink("Appearance") { PathwayAppearanceSettingsView() }
                NavigationLink("Storage & cleanup") { PathwayEnvironmentStorageView() }
                NavigationLink("Keyboard Shortcuts") { PathwayKeyboardSettingsView() }
            }
            Section("Account") {
                Button("Sign out", role: .destructive) {
                    Task {
                        await appModel.signOut()
                    }
                }

                if let message = appModel.authenticationErrorMessage {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }

            Section {
                Text("Manage your Pathway account and native app preferences.")
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done", action: close)
            }
        }
        .frame(minWidth: 320, minHeight: 360)
    }

    private func close() {
        #if os(visionOS)
            if isSeparateWindow { dismissWindow(id: PathwayWindow.settings.rawValue) } else { dismiss() }
        #else
            dismiss()
        #endif
    }
}

#if os(visionOS)
    #Preview("Spatial app shell") {
        MainTabView()
            .environment(PathwayAppModel())
    }
#else
    #Preview("Compact app shell", traits: .fixedLayout(width: 430, height: 932)) {
        MainTabView()
            .environment(PathwayAppModel())
    }

    #Preview("Regular app shell", traits: .fixedLayout(width: 1180, height: 820)) {
        MainTabView()
            .environment(\.horizontalSizeClass, .regular)
            .environment(PathwayAppModel())
    }
#endif

// swiftlint:enable file_length
