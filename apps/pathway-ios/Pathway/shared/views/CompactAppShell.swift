import SwiftUI

enum CompactAppShellMetrics {
    static let tabBarHeight: CGFloat = 58
    static let horizontalPadding: CGFloat = 16
    static let controlSpacing: CGFloat = 12
    static let maximumWidth: CGFloat = 520
    static let tabBarBottomPadding: CGFloat = 8
    static let scrollContentClearance: CGFloat = tabBarHeight + tabBarBottomPadding + 12
    /// Shared by the tab bar surface and the thread composer so both halves of the
    /// bottom chrome interpolate on exactly the same curve. The composer's pill-to-card
    /// morph uses it too: the card grows as the tab bar leaves, and a second curve would
    /// leave the collapsed row visible underneath for part of the transition.
    static let navigationChromeAnimation = Animation.smooth(duration: 0.28)
}

#if !os(visionOS)

    private let tabBarSpring = Animation.spring(duration: 0.48, bounce: 0.22)
    private let tabSelectionSpring = Animation.spring(duration: 0.36, bounce: 0.14)

    struct CompactAppShell: View {
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @Binding var selectedDestination: AppDestination?
        @Binding var presentedSheet: MainTabSheet?
        @Binding var showsSettings: Bool
        @State private var isMoreMenuPresented = false
        @State private var isIssueDetailActive = false
        @State private var threadChrome = CompactThreadChromeState()

        var body: some View {
            ZStack(alignment: .bottom) {
                NavigationStack {
                    PathwayFeatureDestinationView(
                        destination: activeDestination,
                        newThreadAction: presentNewAgentThread
                    )
                    .navigationDestination(isPresented: $showsSettings) {
                        PathwaySettingsView()
                    }
                }
                .id(activeDestination)
                .environment(\.compactThreadChrome, threadChrome)
                .onPreferenceChange(IssueDetailNavigationActiveKey.self) { isIssueDetailActive = $0 }
                .contentShape(.rect)
                .simultaneousGesture(
                    TapGesture().onEnded { dismissMoreMenu() },
                    including: isNavigationExpanded ? .all : .subviews
                )

                if !showsSettings && !threadChrome.isComposerExpanded && !isIssueDetailActive {
                    PathwayTabBar(
                        selectedDestination: $selectedDestination,
                        isMoreMenuPresented: $isMoreMenuPresented,
                        threadChrome: threadChrome,
                        showAgentOrchestrator: presentAgentOrchestrator,
                        showSettings: presentSettings
                    )
                    .frame(maxWidth: CompactAppShellMetrics.maximumWidth)
                    .padding(.horizontal, CompactAppShellMetrics.horizontalPadding)
                    .padding(.bottom, CompactAppShellMetrics.tabBarBottomPadding)
                    .accessibilityAction(.escape, dismissMoreMenu)
                    .transition(
                        reduceMotion
                            ? .opacity
                            : .scale(scale: 0.94, anchor: .bottomTrailing).combined(with: .opacity)
                    )
                }
            }
            .onChange(of: showsSettings) { _, isPresented in
                if isPresented { dismissMoreMenu() }
            }
            .animation(
                reduceMotion ? nil : CompactAppShellMetrics.navigationChromeAnimation,
                value: threadChrome.isComposerExpanded
            )
        }

        private var activeDestination: AppDestination {
            selectedDestination ?? .dashboard
        }

        private var isNavigationExpanded: Bool {
            isMoreMenuPresented
                || (threadChrome.isThreadDetailActive && threadChrome.isNavigationExpanded)
        }

        private func presentAgentOrchestrator() {
            dismissMoreMenu()
            presentedSheet = .agentOrchestrator
        }

        private func presentNewAgentThread() {
            dismissMoreMenu()
            presentedSheet = .newAgentThread
        }

        private func presentSettings() {
            dismissMoreMenu()
            showsSettings = true
        }

        private func dismissMoreMenu() {
            let animation: Animation? = if reduceMotion {
                nil
            } else if threadChrome.isThreadDetailActive, threadChrome.isNavigationExpanded {
                CompactAppShellMetrics.navigationChromeAnimation
            } else {
                tabBarSpring
            }

            withAnimation(animation) {
                isMoreMenuPresented = false
                threadChrome.collapseNavigation()
            }
        }
    }

    private struct PathwayTabBar: View {
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @Binding var selectedDestination: AppDestination?
        @Binding var isMoreMenuPresented: Bool
        let threadChrome: CompactThreadChromeState
        let showAgentOrchestrator: () -> Void
        let showSettings: () -> Void

        @Namespace private var glassNamespace
        @Namespace private var selectionNamespace
        /// Width of the leading slot once laid out, so the collapsed circle has a concrete
        /// target to interpolate towards. `nil` until the first layout pass, which keeps the
        /// slot free-sizing exactly as it did before measurement lands.
        @State private var expandedSurfaceWidth: CGFloat?

        var body: some View {
            GlassEffectContainer(spacing: 12) {
                HStack(alignment: .bottom, spacing: CompactAppShellMetrics.controlSpacing) {
                    mainSurface
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .onGeometryChange(for: CGFloat.self) { proxy in
                            proxy.size.width
                        } action: { width in
                            expandedSurfaceWidth = width
                        }

                    agentOrchestratorButton
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .animation(
                reduceMotion ? nil : CompactAppShellMetrics.navigationChromeAnimation,
                value: isThreadNavigationCollapsed
            )
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
                navigationSurface
            }
        }

        /// One glass element that resizes, rather than two views swapped behind a shared
        /// `glassEffectID`. The conditional replacement gave the collapsed circle and the tab
        /// bar different structural identities, so SwiftUI inserted/removed them instead of
        /// interpolating a frame and the chrome popped. Keeping a single view means the width
        /// is an animatable `CGFloat` and the glass shape follows it continuously.
        private var navigationSurface: some View {
            ZStack(alignment: .leading) {
                tabButtons
                    .frame(width: expandedSurfaceWidth, alignment: .leading)
                    .opacity(isThreadNavigationCollapsed ? 0 : 1)
                    .allowsHitTesting(!isThreadNavigationCollapsed)
                    .accessibilityHidden(isThreadNavigationCollapsed)

                expandNavigationButton
                    .opacity(isThreadNavigationCollapsed ? 1 : 0)
                    .allowsHitTesting(isThreadNavigationCollapsed)
                    .accessibilityHidden(!isThreadNavigationCollapsed)
            }
            .frame(
                width: navigationSurfaceWidth,
                height: CompactAppShellMetrics.tabBarHeight,
                alignment: .leading
            )
            .clipShape(.rect(cornerRadius: CompactAppShellMetrics.tabBarHeight / 2))
            .glassEffect(
                .regular.interactive(),
                in: .rect(cornerRadius: CompactAppShellMetrics.tabBarHeight / 2)
            )
            .glassEffectID("compact-tab-bar", in: glassNamespace)
            .glassEffectTransition(.matchedGeometry)
        }

        /// A `tabBarHeight` square with a `tabBarHeight / 2` corner radius is the collapsed
        /// circle, so the same rounded rectangle describes both ends of the animation.
        private var navigationSurfaceWidth: CGFloat? {
            isThreadNavigationCollapsed
                ? CompactAppShellMetrics.tabBarHeight
                : expandedSurfaceWidth
        }

        private var isThreadNavigationCollapsed: Bool {
            threadChrome.isThreadDetailActive && !threadChrome.isNavigationExpanded
        }

        private var expandNavigationButton: some View {
            Button {
                withAnimation(
                    reduceMotion ? nil : CompactAppShellMetrics.navigationChromeAnimation
                ) {
                    threadChrome.expandNavigation()
                }
            } label: {
                Image(systemName: AppDestination.agentThreads.systemImage)
                    .font(.system(size: 23, weight: .semibold))
                    .frame(
                        width: CompactAppShellMetrics.tabBarHeight,
                        height: CompactAppShellMetrics.tabBarHeight
                    )
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
            .accessibilityLabel("Show main navigation")
            .accessibilityHint("Expands the tab bar")
        }

        private var agentOrchestratorButton: some View {
            Button(action: showAgentOrchestrator) {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.system(size: 23, weight: .medium))
                    .frame(
                        width: CompactAppShellMetrics.tabBarHeight,
                        height: CompactAppShellMetrics.tabBarHeight
                    )
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.primary)
            .glassEffect(.regular.interactive(), in: .circle)
            .glassEffectID("agent-orchestrator", in: glassNamespace)
            .accessibilityLabel("Open agent orchestrator")
            .accessibilityIdentifier("agent-orchestrator-button")
        }

        private var destinationList: some View {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Pathway")
                        .font(.headline)
                    Spacer()
                    Button(action: showSettings) {
                        Image(systemName: "gearshape")
                            .font(.title3)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Settings")
                    .accessibilityIdentifier("navigation-settings-button")
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 2)

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
            .frame(height: CompactAppShellMetrics.tabBarHeight)
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
                threadChrome.collapseNavigation()
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
#endif
