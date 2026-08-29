import SwiftUI

enum MainTabSheet: String, Identifiable {
    case agentOrchestrator
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
                    SidebarAppShell(
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
                SidebarAppShell(
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
            case .settings:
                NavigationStack {
                    PathwaySettingsView()
                }
            }
        }
    }
}

private struct SidebarAppShell: View {
    @Environment(\.openWindow) private var openWindow
    @Binding var selectedDestination: AppDestination?
    @Binding var presentedSheet: MainTabSheet?
    let layout: AppShellLayout

    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            List(selection: $selectedDestination) {
                ForEach(AppDestination.sidebarSections) { section in
                    Section(section.title) {
                        ForEach(section.destinations) { destination in
                            Label(destination.title, systemImage: destination.systemImage)
                                .tag(destination)
                        }
                    }
                }

                Section("Actions") {
                    Button(
                        "New agent thread",
                        systemImage: "bubble.left.and.bubble.right",
                        action: presentAgentOrchestrator
                    )
                    Button("Settings", systemImage: "gearshape", action: presentSettings)
                }
            }
            .navigationTitle("Pathway")
            .navigationSplitViewColumnWidth(min: 220, ideal: 270, max: 340)
        } detail: {
            NavigationStack {
                PathwayFeaturePlaceholder(destination: activeDestination)
                    .toolbar {
                        ToolbarItemGroup(placement: .primaryAction) {
                            Button(
                                "New agent thread",
                                systemImage: "bubble.left.and.bubble.right",
                                action: presentAgentOrchestrator
                            )
                            Button("Settings", systemImage: "gearshape", action: presentSettings)
                        }
                    }
            }
        }
        .navigationSplitViewStyle(.balanced)
    }

    private var activeDestination: AppDestination {
        selectedDestination ?? .dashboard
    }

    private func presentAgentOrchestrator() {
        if layout == .spatial {
            openWindow(id: PathwayWindow.agentOrchestrator.rawValue)
        } else {
            presentedSheet = .agentOrchestrator
        }
    }

    private func presentSettings() {
        if layout == .spatial {
            openWindow(id: PathwayWindow.settings.rawValue)
        } else {
            presentedSheet = .settings
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
