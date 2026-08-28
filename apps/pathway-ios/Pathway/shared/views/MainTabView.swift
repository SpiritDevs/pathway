import SwiftUI

private let tabBarSpring = Animation.spring(duration: 0.48, bounce: 0.22)
private let tabSelectionSpring = Animation.spring(duration: 0.36, bounce: 0.14)
private let compactTabBarHeight: CGFloat = 58

private enum AppDestination: String, CaseIterable, Identifiable, Hashable {
    case agents
    case issues
    case threads
    case environments
    case settings

    var id: Self { self }

    var title: String {
        switch self {
        case .agents: "Agents"
        case .issues: "Issues"
        case .threads: "Threads"
        case .environments: "Environments"
        case .settings: "Settings"
        }
    }

    var systemImage: String {
        switch self {
        case .agents: "cpu"
        case .issues: "checklist"
        case .threads: "bubble.left.and.bubble.right"
        case .environments: "server.rack"
        case .settings: "gearshape"
        }
    }

    var description: String {
        switch self {
        case .agents: "Your active agents and delegated work will appear here."
        case .issues: "Track work that needs attention across your environments."
        case .threads: "Continue conversations with your Pathway agents."
        case .environments: "Connect to the machines and workspaces running Pathway."
        case .settings: "Manage your Pathway account and native app preferences."
        }
    }

    var isCompactDestination: Bool {
        self == .agents || self == .issues || self == .threads
    }
}

private enum MainTabSheet: String, Identifiable {
    case agentOrchestrator

    var id: Self { self }
}

struct MainTabView: View {
    @State private var selectedDestination: AppDestination = .agents
    @State private var isMoreMenuPresented = false
    @State private var presentedSheet: MainTabSheet?

    var body: some View {
        ZStack(alignment: .bottom) {
            selectedContent

            if isMoreMenuPresented {
                Color.clear
                    .contentShape(Rectangle())
                    .ignoresSafeArea()
                    .onTapGesture(perform: dismissMoreMenu)
            }

            PathwayTabBar(
                selectedDestination: $selectedDestination,
                isMoreMenuPresented: $isMoreMenuPresented,
                showAgentOrchestrator: presentAgentOrchestrator
            )
            .frame(maxWidth: 520)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .sheet(item: $presentedSheet) { sheet in
            switch sheet {
            case .agentOrchestrator:
                AgentOrchestratorView()
                    .presentationDetents([.large])
                    .presentationDragIndicator(.hidden)
                    .presentationCornerRadius(36)
            }
        }
    }

    @ViewBuilder
    private var selectedContent: some View {
        NavigationStack {
            if selectedDestination == .settings {
                PathwaySettingsView()
            } else {
                PathwayFeaturePlaceholder(destination: selectedDestination)
            }
        }
    }

    private func presentAgentOrchestrator() {
        dismissMoreMenu()
        presentedSheet = .agentOrchestrator
    }

    private func dismissMoreMenu() {
        withAnimation(tabBarSpring) {
            isMoreMenuPresented = false
        }
    }
}

private struct PathwayTabBar: View {
    @Binding var selectedDestination: AppDestination
    @Binding var isMoreMenuPresented: Bool
    let showAgentOrchestrator: () -> Void

    @Namespace private var glassNamespace
    @Namespace private var selectionNamespace

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(alignment: .bottom, spacing: 12) {
                mainSurface

                Button(action: showAgentOrchestrator) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 23, weight: .medium))
                        .frame(width: compactTabBarHeight, height: compactTabBarHeight)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.primary)
                .glassEffect(.regular.interactive(), in: .circle)
                .glassEffectID("agent-orchestrator", in: glassNamespace)
                .accessibilityLabel("Open agent orchestrator")
                .accessibilityIdentifier("agent-orchestrator-button")
            }
        }
    }

    @ViewBuilder
    private var mainSurface: some View {
        if isMoreMenuPresented {
            destinationList
                .frame(maxWidth: .infinity)
                .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 32))
                .glassEffectID("expanded-view-menu", in: glassNamespace)
                .glassEffectTransition(.matchedGeometry)
                .transition(.blurReplace)
        } else {
            tabButtons
                .frame(maxWidth: .infinity)
                .glassEffect(
                    .regular.interactive(),
                    in: .rect(cornerRadius: compactTabBarHeight / 2)
                )
                .glassEffectID("compact-tab-bar", in: glassNamespace)
                .glassEffectTransition(.matchedGeometry)
                .transition(.blurReplace)
        }
    }

    private var destinationList: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Pathway")
                .font(.headline)
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 8)

            Divider()
                .padding(.horizontal, 14)

            ForEach(AppDestination.allCases) { destination in
                destinationButton(destination)
            }
        }
        .padding(.bottom, 10)
    }

    private func destinationButton(_ destination: AppDestination) -> some View {
        Button {
            select(destination)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: destination.systemImage)
                    .font(.body.weight(.semibold))
                    .frame(width: 24)

                Text(destination.title)
                    .font(.body.weight(.medium))

                Spacer()
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 12)
            .frame(height: 44)
            .background {
                if selectedDestination == destination {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.primary.opacity(0.07))
                }
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 6)
        .accessibilityAddTraits(selectedDestination == destination ? .isSelected : [])
    }

    private var tabButtons: some View {
        HStack(spacing: 0) {
            compactButton(.agents)
            compactButton(.issues)
            compactButton(.threads)

            Button(action: toggleMoreMenu) {
                ZStack {
                    if !selectedDestination.isCompactDestination {
                        HStack(spacing: 4) {
                            Image(systemName: selectedDestination.systemImage)

                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 10, weight: .semibold))
                                .opacity(0.45)
                        }
                        .font(.system(size: 22, weight: .semibold))
                    } else {
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 18, weight: .semibold))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
                .background {
                    if !selectedDestination.isCompactDestination {
                        Capsule()
                            .fill(Color.primary.opacity(0.08))
                            .padding(5)
                            .matchedGeometryEffect(
                                id: "selected-tab-background",
                                in: selectionNamespace
                            )
                    }
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(
                selectedDestination.isCompactDestination ? Color.primary : Color.accentColor
            )
            .accessibilityLabel(moreAccessibilityLabel)
            .accessibilityValue(isMoreMenuPresented ? "Expanded" : "Collapsed")
        }
        .frame(height: compactTabBarHeight)
    }

    private func compactButton(_ destination: AppDestination) -> some View {
        TabBarIconButton(
            systemImage: destination.systemImage,
            accessibilityLabel: destination.title,
            isSelected: selectedDestination == destination,
            selectionNamespace: selectionNamespace
        ) {
            select(destination)
        }
    }

    private var moreAccessibilityLabel: String {
        if !selectedDestination.isCompactDestination {
            return "\(selectedDestination.title), choose another view"
        }
        return "Choose another view"
    }

    private func select(_ destination: AppDestination) {
        let animation = destination.isCompactDestination ? tabSelectionSpring : tabBarSpring
        withAnimation(animation) {
            selectedDestination = destination
            isMoreMenuPresented = false
        }
    }

    private func toggleMoreMenu() {
        withAnimation(tabBarSpring) {
            isMoreMenuPresented.toggle()
        }
    }
}

private struct TabBarIconButton: View {
    let systemImage: String
    let accessibilityLabel: String
    let isSelected: Bool
    let selectionNamespace: Namespace.ID
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 22, weight: .semibold))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
                .background {
                    if isSelected {
                        Capsule()
                            .fill(Color.primary.opacity(0.08))
                            .padding(5)
                            .matchedGeometryEffect(
                                id: "selected-tab-background",
                                in: selectionNamespace
                            )
                    }
                }
        }
        .buttonStyle(.plain)
        .foregroundStyle(isSelected ? Color.accentColor : Color.primary)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private struct PathwayFeaturePlaceholder: View {
    let destination: AppDestination

    var body: some View {
        ContentUnavailableView {
            Label(destination.title, systemImage: destination.systemImage)
        } description: {
            Text(destination.description)
        }
        .navigationTitle(destination.title)
        .navigationBarTitleDisplayMode(.large)
    }
}

private struct PathwaySettingsView: View {
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
                Text(AppDestination.settings.description)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
    }
}
