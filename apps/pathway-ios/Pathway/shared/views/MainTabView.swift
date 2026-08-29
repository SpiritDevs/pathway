import SwiftUI

// The adaptive shell keeps its rail, context sidebar, destination routing, and settings
// together because they share navigation state across iPadOS and visionOS.
// swiftlint:disable file_length

enum MainTabSheet: String, Identifiable {
    case agentOrchestrator
    case newAgentThread
    case settings

    var id: Self { self }
}

struct MainTabView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var selectedDestination: AppDestination? = .dashboard
    @State private var presentedSheet: MainTabSheet?

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
            case .settings:
                NavigationStack {
                    PathwaySettingsView()
                }
            }
        }
    }
}

private struct FloatingAppShell: View {
    @Environment(\.openWindow) private var openWindow
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
                .navigationSplitViewColumnWidth(min: 210, ideal: 250, max: 310)
            } detail: {
                NavigationStack {
                    PathwayContextDestinationView(
                        destination: activeDestination,
                        contextDestination: activeContextDestination,
                        newThreadAction: presentNewAgentThread
                    )
                    .toolbar {
                        ToolbarItemGroup(placement: .primaryAction) {
                            Button(
                                "New agent thread",
                                systemImage: "bubble.left.and.bubble.right",
                                action: presentNewAgentThread
                            )
                            Button("Settings", systemImage: "gearshape", action: presentSettings)
                        }
                    }
                }
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
    let destination: AppDestination
    @Binding var selectedContextDestination: AppContextDestination?

    var body: some View {
        List(selection: $selectedContextDestination) {
            Section {
                ForEach(destination.contextDestinations) { contextDestination in
                    Label(contextDestination.title, systemImage: contextDestination.systemImage)
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
    let destination: AppDestination
    let contextDestination: AppContextDestination
    let newThreadAction: () -> Void

    @ViewBuilder
    var body: some View {
        if contextDestination == destination.defaultContextDestination {
            PathwayFeatureDestinationView(
                destination: destination,
                newThreadAction: newThreadAction
            )
        } else {
            ScrollView {
                ContentUnavailableView {
                    Label(contextDestination.title, systemImage: contextDestination.systemImage)
                } description: {
                    Text("This \(destination.title.lowercased()) view is ready for its content.")
                }
                .frame(maxWidth: 720, minHeight: 420)
                .frame(maxWidth: .infinity)
                .padding(24)
            }
            .navigationTitle(contextDestination.title)
            .navigationBarTitleDisplayMode(.large)
            .accessibilityIdentifier(
                "context-destination-\(destination.rawValue)-\(contextDestination.id)"
            )
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
    let destination: AppDestination
    let newThreadAction: () -> Void

    @ViewBuilder
    var body: some View {
        if destination == .agentThreads {
            AgentThreadsView(newThreadAction: newThreadAction)
        } else {
            PathwayFeaturePlaceholder(destination: destination)
        }
    }
}

struct PathwaySettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(PathwayAppModel.self) private var appModel

    var body: some View {
        Form {
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
            dismissWindow(id: PathwayWindow.settings.rawValue)
        #else
            dismiss()
        #endif
    }
}

#if os(visionOS)
    #Preview("Spatial app shell") {
        MainTabView()
    }
#else
    #Preview("Compact app shell", traits: .fixedLayout(width: 430, height: 932)) {
        MainTabView()
    }

    #Preview("Regular app shell", traits: .fixedLayout(width: 1180, height: 820)) {
        MainTabView()
            .environment(\.horizontalSizeClass, .regular)
    }
#endif

// swiftlint:enable file_length
