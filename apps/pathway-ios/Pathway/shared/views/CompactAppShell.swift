#if !os(visionOS)
    import SwiftUI

    private let tabBarSpring = Animation.spring(duration: 0.48, bounce: 0.22)
    private let tabSelectionSpring = Animation.spring(duration: 0.36, bounce: 0.14)
    private let compactTabBarHeight: CGFloat = 58

    struct CompactAppShell: View {
        @Binding var selectedDestination: AppDestination?
        @Binding var presentedSheet: MainTabSheet?
        @State private var isMoreMenuPresented = false

        var body: some View {
            ZStack(alignment: .bottom) {
                NavigationStack {
                    PathwayFeaturePlaceholder(destination: activeDestination)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("Settings", systemImage: "gearshape", action: presentSettings)
                            }
                        }
                }

                if isMoreMenuPresented {
                    Button(action: dismissMoreMenu) {
                        Color.clear
                            .contentShape(Rectangle())
                            .ignoresSafeArea()
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss navigation menu")
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
        }

        private var activeDestination: AppDestination {
            selectedDestination ?? .dashboard
        }

        private func presentAgentOrchestrator() {
            dismissMoreMenu()
            presentedSheet = .agentOrchestrator
        }

        private func presentSettings() {
            dismissMoreMenu()
            presentedSheet = .settings
        }

        private func dismissMoreMenu() {
            withAnimation(tabBarSpring) {
                isMoreMenuPresented = false
            }
        }
    }

    private struct PathwayTabBar: View {
        @Binding var selectedDestination: AppDestination?
        @Binding var isMoreMenuPresented: Bool
        let showAgentOrchestrator: () -> Void

        @Namespace private var glassNamespace
        @Namespace private var selectionNamespace

        var body: some View {
            GlassEffectContainer(spacing: 12) {
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
                    DestinationMenuButton(
                        destination: destination,
                        isSelected: activeDestination == destination,
                        action: { select(destination) }
                    )
                }
            }
            .padding(.bottom, 10)
        }

        private var tabButtons: some View {
            HStack(spacing: 0) {
                ForEach(AppDestination.compactDestinations) { destination in
                    compactButton(destination)
                }

                Button(action: toggleMoreMenu) {
                    ZStack {
                        if !activeDestination.isCompactDestination {
                            HStack(spacing: 4) {
                                Image(systemName: activeDestination.systemImage)

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
                        if !activeDestination.isCompactDestination {
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
                    activeDestination.isCompactDestination ? Color.primary : Color.accentColor
                )
                .accessibilityLabel(moreAccessibilityLabel)
                .accessibilityValue(isMoreMenuPresented ? "Expanded" : "Collapsed")
            }
            .frame(height: compactTabBarHeight)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Main navigation")
        }

        private func compactButton(_ destination: AppDestination) -> some View {
            TabBarIconButton(
                systemImage: destination.systemImage,
                accessibilityLabel: destination.title,
                isSelected: activeDestination == destination,
                selectionNamespace: selectionNamespace,
                action: { select(destination) }
            )
        }

        private var moreAccessibilityLabel: String {
            if !activeDestination.isCompactDestination {
                return "\(activeDestination.title), choose another view"
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

        private var activeDestination: AppDestination {
            selectedDestination ?? .dashboard
        }

        private func toggleMoreMenu() {
            withAnimation(tabBarSpring) {
                isMoreMenuPresented.toggle()
            }
        }
    }

    private struct DestinationMenuButton: View {
        let destination: AppDestination
        let isSelected: Bool
        let action: () -> Void

        var body: some View {
            Button(action: action) {
                Label(destination.title, systemImage: destination.systemImage)
                    .font(.body.weight(.medium))
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                    .padding(.horizontal, 12)
                    .background {
                        if isSelected {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(Color.primary.opacity(0.07))
                        }
                    }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 6)
            .accessibilityAddTraits(isSelected ? .isSelected : [])
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
#endif
